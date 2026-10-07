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

import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
    // The subcommand is argv[0]; anything after it is an argument to it.
    const script = argv[0] ?? ''
    if (['publish', 'unpublish', 'deprecate'].includes(script)) {
      return { tier: 'destructive', reason: `Publishes to a public registry (${base} ${script})`, trigger: script }
    }
    if (['install', 'i', 'ci', 'add'].includes(script)) {
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
    // `node --version` runs nothing, so it stays safe; anything else executes code.
    const PROBES = new Set(['--version', '-v', '-V', '--help', '-h', '-?', '--usage'])
    if (argv.length > 0 && argv.every((a) => PROBES.has(a))) {
      return { tier: 'safe', reason: 'Reports the runtime version or usage; executes nothing', trigger: null }
    }
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

/**
 * Executable base name, lower-cased and stripped of its Windows extension.
 *
 * `C:\Windows\System32\del.exe` and `/usr/bin/rm` must classify identically to
 * `del` and `rm`, otherwise a full path becomes a trivial disguise.
 */
function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/)
  const name = parts[parts.length - 1] ?? p
  return name.replace(/\.(exe|cmd|bat|com|scr|ps1)$/i, '').toLowerCase()
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

export type PathVerdict =
  | { allowed: true; absolute: string }
  | { allowed: false; reason: string; attempted: string }

/**
 * Resolve `candidate` to its real location on disk, following symlinks.
 *
 * The kernel follows links, not text: a path that *reads* as inside the
 * workspace can open a file anywhere on the machine if any component is a
 * symlink. `realpath` alone is not enough, because it throws `ENOENT` for a
 * path that does not exist yet — the normal case for `write_file` — and for a
 * dangling symlink, which is the classic escape (a link inside the project
 * whose target is outside it). So:
 *
 *  - `ENOENT`/`ENOTDIR` → the deepest existing ancestor is resolved and the
 *    missing tail is re-appended;
 *  - a symlink whose target is missing → the link is read explicitly and its
 *    *target* becomes the path to resolve, so containment is judged on where
 *    the link would actually write;
 *  - anything else (`ELOOP`, `EACCES`, …) → `null`, and the caller fails
 *    closed: an unverifiable path is not an allowed path.
 */
function canonicalize(input: string, linkDepth = 0): string | null {
  if (linkDepth > 32) return null
  const path = resolve(input)

  try {
    return realpathSync(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
  }

  // The path (or a component of it) does not exist. If it is a symlink with a
  // missing target, containment must be judged on the target, not the link.
  try {
    if (lstatSync(path).isSymbolicLink()) {
      const target = readlinkSync(path)
      const next = isAbsolute(target) ? resolve(target) : resolve(dirname(path), target)
      return canonicalize(next, linkDepth + 1)
    }
  } catch {
    // lstat failed with ENOENT/ENOTDIR: genuinely missing, handled below.
  }

  const parent = dirname(path)
  if (parent === path) return path
  const resolvedParent = canonicalize(parent, linkDepth + 1)
  if (resolvedParent === null) return null
  return join(resolvedParent, basename(path))
}

/**
 * Resolve `candidate` and confirm it stays inside one of `roots`.
 *
 * A relative path is resolved against the **first workspace root**, not against
 * `process.cwd()`. That distinction is the whole difference between a working
 * agent and one that rejects every `index.html` the model asks to write: the
 * model's natural phrasing is "index.html" or "src/app.ts", and resolving that
 * against the app's own working directory — which is the install directory, not
 * the user's project — escapes the roots every single time.
 *
 * Rejects traversal via `..`, absolute paths outside the roots, and — on
 * Windows — alternate data streams and device paths (`\\?\`, `\\.\`).
 *
 * Containment is then re-checked on the **real** path of both the candidate
 * and every root, because the lexical check proves only what the *text* of the
 * path says: a symlink inside the workspace pointing outside it passes the
 * textual check and the kernel follows it regardless. The lexical absolute is
 * what gets returned — it is already collapsed, so it can never re-traverse a
 * link on the way to the file — but the verdict is only `allowed` when the
 * resolved form also lands inside a resolved root.
 */
export function checkPath(candidate: string, roots: string[]): PathVerdict {
  if (/^\\\\[?.]/.test(candidate)) {
    return { allowed: false, reason: 'Windows device/UNC prefix is not permitted', attempted: candidate }
  }
  if (candidate.includes('\0')) {
    return { allowed: false, reason: 'Path contains a null byte', attempted: candidate }
  }
  if (roots.length === 0) {
    return { allowed: false, reason: 'No workspace root is open', attempted: candidate }
  }

  const base = resolve(roots[0] as string)
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate)

  // Lexical containment: no root contains the text of the path.
  const contained = (path: string): boolean =>
    roots.some((root) => {
      const rel = relative(resolve(root), path)
      return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
    })
  if (!contained(absolute)) {
    return {
      allowed: false,
      reason: `Path escapes the allowed workspace roots`,
      attempted: absolute
    }
  }

  // Real-path containment: the kernel will follow any symlink in the path, so
  // the resolved form must also land inside a resolved root. Roots that cannot
  // be verified cannot authorise anything; if none can, nothing is allowed.
  const resolved = canonicalize(absolute)
  if (resolved === null) {
    return {
      allowed: false,
      reason: 'Path cannot be resolved to a real location on disk',
      attempted: absolute
    }
  }
  for (const root of roots) {
    const resolvedRoot = canonicalize(resolve(root))
    if (resolvedRoot === null) continue
    const rel = relative(resolvedRoot, resolved)
    if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) {
      return { allowed: true, absolute }
    }
  }
  return {
    allowed: false,
    reason: `Path resolves outside the allowed workspace roots (symlink)`,
    attempted: resolved
  }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface PolicyContext {
  /** Roots the agent may touch. Empty means nothing is permitted. */
  workspaceRoots: string[]
}

/** Default lifetime of a session grant: long enough for a real task, bounded. */
export const SESSION_GRANT_TTL_MS = 4 * 60 * 60 * 1000

interface SessionGrant {
  decision: PermissionDecision
  /** Epoch millis after which the grant no longer applies. */
  expiresAt: number
  /**
   * Highest tier this grant may authorise.
   *
   * "Allow for this session" on an `ask`-tier tool must not silently cover an
   * `elevated` or `destructive` tool that happens to share the domain — the
   * tier the human saw in the approval dialog is the authority they gave.
   * Callers that do not state a tier (test harnesses, live checks) keep the
   * unrestricted behaviour they had before this field existed.
   */
  maxTier: PermissionTier
}

export class PermissionPolicy {
  private rules: PermissionRule[]
  /** Session-scoped "always allow" grants keyed by domain + scope. */
  private readonly sessionGrants = new Map<string, SessionGrant>()
  private readonly now: () => number

  constructor(rules: PermissionRule[] = DEFAULT_PERMISSION_RULES, options: { now?: () => number } = {}) {
    this.rules = rules.map((r) => ({ ...r }))
    this.now = options.now ?? (() => Date.now())
  }

  listRules(): PermissionRule[] {
    return this.rules.map((r) => ({ ...r }))
  }

  setRule(domain: PermissionDomain, decision: PermissionDecision, scope?: string): void {
    const existing = this.rules.find((r) => r.domain === domain && r.scope === scope)
    if (existing) existing.default = decision
    else this.rules.push({ domain, default: decision, ...(scope ? { scope } : {}) })
  }

  /**
   * Remember a decision for the remainder of the session.
   *
   * Grants expire (`SESSION_GRANT_TTL_MS` by default) and are capped at the
   * tier the caller states, because a session is a long time: an app left open
   * over a weekend should not still be running on a Friday afternoon click.
   */
  grantSession(
    domain: PermissionDomain,
    decision: PermissionDecision,
    options: { scope?: string; ttlMs?: number; maxTier?: PermissionTier } = {}
  ): void {
    this.sessionGrants.set(`${domain}::${options.scope ?? ''}`, {
      decision,
      expiresAt: this.now() + (options.ttlMs ?? SESSION_GRANT_TTL_MS),
      maxTier: options.maxTier ?? 'destructive'
    })
  }

  /** A live grant for this exact key, or undefined when absent or expired. */
  private liveGrant(key: string): SessionGrant | undefined {
    const grant = this.sessionGrants.get(key)
    if (!grant) return undefined
    if (grant.expiresAt <= this.now()) {
      this.sessionGrants.delete(key)
      return undefined
    }
    return grant
  }

  /**
   * True when the user explicitly allowed this domain for the session.
   *
   * Distinct from `evaluateDomain() === 'allow'`, which a *default rule* can also
   * produce. The tool runtime needs the difference: a default `allow` must not
   * let a tool above the `safe` tier run unattended, but a human pressing "Allow
   * for this session" is exactly the authority that should stop the prompts.
   * Without this distinction the button grants nothing and the agent asks
   * again on every single file.
   */
  hasSessionGrant(domain: PermissionDomain, tier?: PermissionTier): boolean {
    const grant = this.liveGrant(`${domain}::`)
    if (!grant || grant.decision !== 'allow') return false
    if (tier !== undefined && tierRank(tier) > tierRank(grant.maxTier)) return false
    return true
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear()
  }

  private decide(domain: PermissionDomain, scope?: string): PermissionDecision {
    // The most specific matching rule wins; an exact scope beats a global rule.
    const scoped = this.rules.filter((r) => r.domain === domain && r.scope && scope && matchScope(r.scope, scope))
    const global = this.rules.find((r) => r.domain === domain && !r.scope)
    const ruleDecision =
      scoped.length > 0 ? highestDecision(scoped.map((r) => r.default)) : global?.default ?? 'ask'

    // A configured `deny` is absolute. It outranks a session grant, because a
    // grant is a transient convenience ("stop asking about writes") while a deny
    // is the user saying a capability is off. Letting "Allow for this session"
    // lift a denial would turn one button press into a way around the policy.
    if (ruleDecision === 'deny') return 'deny'

    // A grant recorded for the exact path wins, then a domain-wide "always
    // allow" for the rest of the session. Expired grants are treated as never
    // having existed — lazily evicted so a long-lived policy object does not
    // accumulate grants that can never match again.
    if (scope) {
      const exact = this.liveGrant(`${domain}::${scope}`)
      if (exact) return exact.decision
    }
    const domainWide = this.liveGrant(`${domain}::`)
    if (domainWide) return domainWide.decision

    return ruleDecision
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