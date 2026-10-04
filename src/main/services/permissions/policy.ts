/**
 * Permission policy engine.
 *
 * Threat model (OWASP ASVS / LLM-agent threat surface):
 *
 *  1. **Prompt injection** — content read out of a repository, an issue, or a web
 *     page can contain instructions. The agent must therefore not be able to
 *     escalate its own authority. Tool arguments are data, never policy: a tool
 *     cannot request a higher tier than the caller granted, and permission checks
 *     always re-derive the tier from the *actual* argv, never from a
 *     caller-supplied label.
 *  2. **Destructive action** — deletion, force-push, disk/registry writes and
 *     credential access are classified by inspecting the parsed argv against
 *     explicit patterns. Classification defaults to the *higher* risk tier when
 *     the command cannot be understood.
 *  3. **Path traversal** — every filesystem path is resolved and checked against
 *     the allowed roots before any read or write.
 *
 * Design stance: **fail closed.** An unrecognised command is `ask`, never
 * `allow`; a path that escapes its root is `deny`, never `ask`.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  ApprovalRequest,
  PermissionDecision,
  PermissionDomain,
  PermissionRule,
  PermissionTier
} from '@shared/types'

/** Default posture for a fresh install: read-only, ask before acting. */
export const DEFAULT_PERMISSION_RULES: PermissionRule[] = [
  { domain: 'fs.read', default: 'allow' },
  { domain: 'fs.write', default: 'allow', scope: 'workspace' },
  { domain: 'fs.delete', default: 'ask' },
  { domain: 'terminal.safe', default: 'allow' },
  { domain: 'terminal.elevated', default: 'ask' },
  { domain: 'terminal.destructive', default: 'ask' },
  { domain: 'git.read', default: 'allow' },
  { domain: 'git.modify', default: 'allow' },
  { domain: 'git.destructive', default: 'ask' },
  { domain: 'browser.read', default: 'allow' },
  { domain: 'browser.interact', default: 'ask' },
  { domain: 'network.read', default: 'allow' },
  { domain: 'network.write', default: 'ask' },
  { domain: 'env.detect', default: 'allow' },
  { domain: 'env.install', default: 'ask' },
  { domain: 'env.modify', default: 'ask' }
]

const TIER_ORDER: PermissionTier[] = ['safe', 'ask', 'elevated', 'destructive']

export function tierRank(tier: PermissionTier): number {
  return TIER_ORDER.indexOf(tier)
}

export function maxTier(a: PermissionTier, b: PermissionTier): PermissionTier {
  return tierRank(a) >= tierRank(b) ? a : b
}

export function tierForDomain(domain: PermissionDomain): PermissionTier {
  switch (domain) {
    case 'fs.read':
    case 'git.read':
    case 'browser.read':
    case 'network.read':
    case 'env.detect':
      return 'safe'
    case 'fs.write':
    case 'git.modify':
    case 'network.write':
      return 'ask'
    case 'fs.delete':
    case 'terminal.elevated':
    case 'browser.interact':
    case 'env.install':
      return 'elevated'
    case 'terminal.destructive':
    case 'git.destructive':
    case 'env.modify':
      return 'destructive'
    default:
      return 'ask'
  }
}

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

export interface CommandVerdict {
  tier: PermissionTier
  /** Short machine-readable reason, surfaced in the approval prompt. */
  reason: string
  /** The specific argument that triggered an elevated verdict, if any. */
  trigger: string | null
}

/**
 * Classify a command by inspecting its argv.
 *
 * This is intentionally conservative: an argument we do not understand inside a
 * command we consider risky raises the tier rather than lowering it.
 */
export function classifyCommand(command: string, args: string[] = []): CommandVerdict {
  const base = basenameOf(command).toLowerCase()
  const argv = args.map((a) => a.toLowerCase())
  const all = [base, ...argv]

  const has = (...needles: string[]) => needles.some((n) => argv.some((a) => a === n || a.startsWith(n)))

  // --- Unconditional destructive: filesystem wipe ---------------------------
  if (base === 'rm') {
    if (has('-r', '-rf', '-fr', '--recursive') && (has('/', '/*', '-p') || argv.includes('/*'))) {
      return { tier: 'destructive', reason: 'Recursive delete at a filesystem root', trigger: '/' }
    }
    if (has('-r', '-rf', '-fr', '--recursive', '--no-preserve-root')) {
      return { tier: 'destructive', reason: 'Recursive delete', trigger: '-rf' }
    }
  }
  if (base === 'rmdir' && has('-p', '--parents')) {
    return { tier: 'destructive', reason: 'Recursive directory delete', trigger: '-p' }
  }
  if (base === 'del' || base === 'erase') {
    if (has('/s', '/q')) return { tier: 'destructive', reason: 'Windows recursive force delete', trigger: '/s' }
    if (argv.some((a) => a.startsWith('\\') || /^[a-z]:\\?$/i.test(a))) {
      return { tier: 'destructive', reason: 'Delete targeting a drive root', trigger: 'c:\\' }
    }
  }
  if (base === 'format') return { tier: 'destructive', reason: 'Filesystem format', trigger: null }
  if (base === 'mkfs' || base.startsWith('mkfs.')) {
    return { tier: 'destructive', reason: 'Filesystem creation', trigger: null }
  }
  if (base === 'dd' && has('of=/dev/')) {
    return { tier: 'destructive', reason: 'Raw block device write', trigger: 'of=/dev/' }
  }
  if (base === 'shutdown' || base === 'reboot' || base === 'halt') {
    return { tier: 'destructive', reason: 'Host power state change', trigger: null }
  }

  // --- Git ------------------------------------------------------------------
  if (base === 'git') {
    const sub = argv[0] ?? ''
    if (sub === 'push') {
      const force = has('--force', '-f', '--force-with-lease') || argv.includes('+refs')
      if (sub === 'push' && argv.includes('--delete') && !force) {
        return { tier: 'elevated', reason: 'Deletes a remote branch', trigger: '--delete' }
      }
      if (force) return { tier: 'destructive', reason: 'Force push rewrites remote history', trigger: '--force' }
      return { tier: 'ask', reason: 'Publishes commits to a remote', trigger: null }
    }
    if (sub === 'reset' && has('--hard')) {
      return { tier: 'destructive', reason: 'Discards uncommitted work (reset --hard)', trigger: '--hard' }
    }
    if (sub === 'clean' && has('-f', '-fd', '-x')) {
      return { tier: 'destructive', reason: 'Deletes untracked files (git clean)', trigger: '-f' }
    }
    if (sub === 'rebase' || sub === 'filter-branch') {
      return { tier: 'destructive', reason: 'Rewrites history', trigger: sub }
    }
    if (['checkout', 'switch', 'restore', 'merge', 'commit', 'add', 'stash', 'tag', 'branch'].includes(sub)) {
      return { tier: 'ask', reason: `Modifies the working tree (git ${sub})`, trigger: sub }
    }
    return { tier: 'safe', reason: 'Read-only git command', trigger: null }
  }

  // --- Package managers -----------------------------------------------------
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(base)) {
    const script = argv[1] ?? ''
    if (['publish', 'unpublish', 'deprecate'].includes(script)) {
      return { tier: 'destructive', reason: `Publishes to a public registry (${base} ${script})`, trigger: script }
    }
    if (script === 'install' || script === 'i' || script === 'add') {
      const global = has('-g', '--global')
      const scriptsFlag = argv.some((a) => a === '--ignore-scripts')
      return {
        tier: global || !scriptsFlag ? 'elevated' : 'ask',
        reason: global
          ? 'Installs packages globally and may run lifecycle scripts'
          : 'Installs dependencies and may run lifecycle scripts',
        trigger: global ? '--global' : null
      }
    }
    if (['run', 'test', 'exec', 'dlx'].includes(script)) {
      return { tier: 'elevated', reason: 'Executes project-provided code', trigger: script }
    }
  }

  // --- Interpreters and runners execute arbitrary project code ---------------
  if (['python', 'python3', 'py', 'node', 'ruby', 'perl', 'php', 'sh', 'bash', 'zsh', 'pwsh', 'powershell'].includes(base)) {
    const inline = all.some((a) => a === '-c' || a === '-e' || a === '/c')
    return {
      tier: 'elevated',
      reason: inline ? 'Executes inline code' : 'Executes a script with interpreter privileges',
      trigger: inline ? '-c' : null
    }
  }

  // --- Infrastructure / system mutation --------------------------------------
  if (['winget', 'choco', 'scoop', 'brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman'].includes(base)) {
    if (argv.includes('uninstall') || argv.includes('remove')) {
      return { tier: 'destructive', reason: 'Removes a system package', trigger: 'uninstall' }
    }
    if (argv.includes('install')) {
      return { tier: 'elevated', reason: 'Modifies system-wide packages', trigger: 'install' }
    }
  }
  if (base === 'reg') return { tier: 'elevated', reason: 'Modifies the Windows registry', trigger: null }
  if (['setx', 'set'].includes(base)) {
    return { tier: 'elevated', reason: 'Persists environment/system settings', trigger: null }
  }
  if (base === 'docker') {
    if (argv[0] === 'system' && ['prune', 'rm'].includes(argv[1] ?? '')) {
      return { tier: 'destructive', reason: 'Removes docker resources', trigger: argv[1] ?? 'system prune' }
    }
    if (argv[0] === 'rm' || argv[0] === 'rmi' || argv[0] === 'volume' || argv[0] === 'compose') {
      return { tier: 'destructive', reason: 'Removes docker resources', trigger: argv[0] ?? null }
    }
    if (argv[0] === 'run') return { tier: 'elevated', reason: 'Starts a container', trigger: 'run' }
  }
  if (base === 'sudo' || base === 'doas' || base === 'runas') {
    return { tier: 'elevated', reason: 'Privilege escalation', trigger: base }
  }
  if (base === 'chmod' && has('777')) {
    return { tier: 'elevated', reason: 'Grants world-writable permissions', trigger: '777' }
  }

  // --- Read-only commands we recognise --------------------------------------
  const SAFE = [
    'ls', 'dir', 'pwd', 'cd', 'cat', 'type', 'head', 'tail', 'wc', 'echo', 'date', 'whoami',
    'which', 'where', 'find', 'fd', 'rg', 'grep', 'tree', 'stat', 'file', 'du', 'df',
    'node', 'npm', 'pnpm', 'yarn', 'bun', 'python', 'py', 'pip', 'uv', 'poetry', 'cargo',
    'rustc', 'go', 'java', 'mvn', 'gradle', 'dotnet', 'cmake', 'ninja', 'git', 'docker',
    'ps', 'tasklist', 'curl', 'jq', 'env', 'printenv', 'sleep', 'exit', 'clear', 'true', 'false'
  ]
  if (SAFE.includes(base) && !argv.some((a) => a.startsWith('--force'))) {
    return { tier: 'safe', reason: 'Read-only or well-understood command', trigger: null }
  }

  // Fail closed for anything unrecognised.
  return {
    tier: 'ask',
    reason: 'Command not in the known-safe set; requires confirmation',
    trigger: null
  }
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] ?? p
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

export type PathVerdict =
  | { allowed: true; absolute: string }
  | { allowed: false; reason: string; attempted: string }

/**
 * Resolve `candidate` and confirm it stays inside one of `roots`.
 *
 * Rejects traversal via `..`, absolute paths outside the roots, and — on
 * Windows — alternate data streams and device paths (`\\?\`, `\\.\`).
 */
export function checkPath(candidate: string, roots: string[]): PathVerdict {
  if (/^\\\\[?.]/.test(candidate)) {
    return { allowed: false, reason: 'Windows device/UNC prefix is not permitted', attempted: candidate }
  }
  const absolute = resolve(candidate)
  if (absolute.includes('\0')) {
    return { allowed: false, reason: 'Path contains a null byte', attempted: candidate }
  }
  if (roots.length === 0) {
    return { allowed: false, reason: 'No workspace root is open', attempted: absolute }
  }
  for (const root of roots) {
    const rootAbs = resolve(root)
    const rel = relative(rootAbs, absolute)
    if (rel === '') return { allowed: true, absolute }
    if (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)) {
      return { allowed: true, absolute }
    }
  }
  return {
    allowed: false,
    reason: `Path escapes the allowed workspace roots`,
    attempted: absolute
  }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface PolicyContext {
  /** Roots the agent may touch. Empty means nothing is permitted. */
  workspaceRoots: string[]
}

export class PermissionPolicy {
  private rules: PermissionRule[]
  /** Session-scoped "always allow" grants keyed by domain + scope. */
  private readonly sessionGrants = new Map<string, PermissionDecision>()

  constructor(rules: PermissionRule[] = DEFAULT_PERMISSION_RULES) {
    this.rules = rules.map((r) => ({ ...r }))
  }

  listRules(): PermissionRule[] {
    return this.rules.map((r) => ({ ...r }))
  }

  setRule(domain: PermissionDomain, decision: PermissionDecision, scope?: string): void {
    const existing = this.rules.find((r) => r.domain === domain && r.scope === scope)
    if (existing) existing.default = decision
    else this.rules.push({ domain, default: decision, ...(scope ? { scope } : {}) })
  }

  /** Remember a decision for the remainder of the session. */
  grantSession(domain: PermissionDomain, decision: PermissionDecision, scope?: string): void {
    this.sessionGrants.set(`${domain}::${scope ?? ''}`, decision)
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear()
  }

  private decide(domain: PermissionDomain, scope?: string): PermissionDecision {
    const session = this.sessionGrants.get(`${domain}::${scope ?? ''}`)
    if (session) return session

    // The most specific matching rule wins; an exact scope beats a global rule.
    const scoped = this.rules.filter((r) => r.domain === domain && r.scope && scope && matchScope(r.scope, scope))
    if (scoped.length > 0) return highestDecision(scoped.map((r) => r.default))
    const global = this.rules.find((r) => r.domain === domain && !r.scope)
    return global?.default ?? 'ask'
  }

  /**
   * Evaluate a filesystem operation. Denials are absolute — the UI may not
   * escalate a `deny` into an `ask`.
   */
  evaluatePath(
    operation: 'fs.read' | 'fs.write' | 'fs.delete',
    path: string,
    ctx: PolicyContext
  ): { decision: PermissionDecision; reason: string } {
    const verdict = checkPath(path, ctx.workspaceRoots)
    if (!verdict.allowed) return { decision: 'deny', reason: verdict.reason }

    const decision = this.decide(operation, verdict.absolute)
    return { decision, reason: decision === 'deny' ? 'Denied by policy' : 'Within workspace policy' }
  }

  /** Evaluate a command by re-deriving its tier from argv. */
  evaluateCommand(
    command: string,
    args: string[],
    ctx: PolicyContext
  ): { decision: PermissionDecision; tier: PermissionTier; reason: string } {
    const verdict = classifyCommand(command, args)
    const domain: PermissionDomain =
      verdict.tier === 'safe' ? 'terminal.safe' : verdict.tier === 'destructive' ? 'terminal.destructive' : 'terminal.elevated'

    // A command whose cwd is outside the workspace cannot be auto-approved even
    // if it is read-only; the agent should not be wandering the filesystem.
    if (!ctx.workspaceRoots.length) {
      return { decision: 'ask', tier: verdict.tier, reason: 'No workspace root is open' }
    }

    const decision = this.decide(domain)
    if (decision === 'allow' && verdict.tier !== 'safe') {
      // Global `allow` must not silently authorise an elevated command.
      return { decision: 'ask', tier: verdict.tier, reason: verdict.reason }
    }
    return { decision, tier: verdict.tier, reason: verdict.reason }
  }

  /** Evaluate a tool invocation's declared domain. */
  evaluateDomain(domain: PermissionDomain, scope?: string): PermissionDecision {
    return this.decide(domain, scope)
  }

  /** Effective tier for a domain, used to gate installers and tools. */
  requiredTier(domain: PermissionDomain): PermissionTier {
    return tierForDomain(domain)
  }
}

function highestDecision(decisions: PermissionDecision[]): PermissionDecision {
  const rank: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 }
  return decisions.reduce((worst, d) => (rank[d] > rank[worst] ? d : worst), 'allow')
}

/** Glob-ish scope matching supporting `*` within a single path segment. */
export function matchScope(pattern: string, value: string): boolean {
  if (pattern === value) return true
  if (pattern === '**') return true
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, ' ').replace(/\*/g, '[^/\\\\]*').replace(/ /g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** Pending approval requests, resolved by the renderer. */
export class ApprovalQueue {
  private readonly pending = new Map<string, ApprovalRequest>()
  private readonly waiters = new Map<string, (approved: boolean) => void>()
  private counter = 0

  request(input: Omit<ApprovalRequest, 'id' | 'createdAt'>): ApprovalRequest {
    const id = `approval-${Date.now()}-${++this.counter}`
    const request: ApprovalRequest = { ...input, id, createdAt: new Date().toISOString() }
    this.pending.set(id, request)
    return request
  }

  /** Await a user decision. Timeouts deny, so a dismissed dialog cannot hang a task. */
  wait(id: string, timeoutMs = 120_000): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        this.pending.delete(id)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()

      this.waiters.set(id, (approved) => {
        clearTimeout(timer)
        this.waiters.delete(id)
        this.pending.delete(id)
        resolve(approved)
      })
    })
  }

  resolve(id: string, approved: boolean): boolean {
    const waiter = this.waiters.get(id)
    if (!waiter) return false
    waiter(approved)
    return true
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()]
  }

  /** Deny everything still outstanding; used on shutdown. */
  denyAll(): void {
    for (const id of [...this.waiters.keys()]) this.resolve(id, false)
  }
}