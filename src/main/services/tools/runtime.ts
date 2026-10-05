/**
 * Tool runtime.
 *
 * Every tool call in Cryptoric goes through here, and nowhere else. The runtime
 * is what makes the capability surface safe to extend: a tool declares *what*
 * it does, and the runtime enforces *when it may do it* — platform,
 * dependencies, permission tier, approval, timeout, cancellation, output shape,
 * redaction and audit.
 *
 * The ordering below is the security contract, not an implementation detail:
 *
 *   1. resolve        an unknown id fails before anything is executed
 *   2. platform       a POSIX-only tool is not silently run on Windows
 *   3. dependencies   a tool whose prerequisites are missing says so, rather
 *                     than failing later with a confusing error
 *   4. parse          arguments are validated; a mismatch is a tool error, never
 *                     a silent coercion
 *   5. tier clamp     a tool may never exceed the ceiling its caller granted
 *   6. policy         the permission engine decides
 *   7. approval       anything above `safe` pauses for a human, and a timeout
 *                     denies so a dismissed dialog cannot stall a task
 *   8. execute        bounded by a timeout and chained to the caller's
 *                     cancellation
 *   9. validate       the declared output contract is checked, so the agent
 *                     never reasons over a shape it did not expect
 *  10. redact + audit every execution is recorded, with arguments scrubbed
 *
 * Steps 5 and 6 are what stop a prompt injection from escalating authority:
 * a model can choose a tool, but it cannot raise a tool's tier.
 */

import { randomUUID } from 'node:crypto'
import type {
  PermissionDecision,
  PermissionTier,
  ToolArtifact,
  ToolAuditRecord,
  ToolCategory,
  ToolFailureKind,
  ToolRiskLevel
} from '@shared/types'
import type { ApprovalQueue, PermissionPolicy } from '../permissions/policy'
import { tierRank } from '../permissions/policy'
import type { ToolContext, ToolDefinition, ToolRegistry, ToolResult } from './registry'
import { redactArgs, redactText, summarizeArgs } from './redact'

/**
 * The result shape every tool call settles on.
 *
 * Tools return a partial `ToolResult`; the runtime fills in the rest, so the
 * agent reasons over one shape rather than whatever a handler happened to
 * return.
 */
export interface NormalizedToolResult extends ToolResult {
  durationMs: number
  /**
   * The effect the tool reports on the filesystem, as paths.
   *
   * This exists because `changedPathOf` in the agent used to match tool ids
   * against a four-name allowlist and read `data.path`. That is wrong in both
   * directions — a tool can name a path it never touched, and a tool that really
   * wrote something but is not on the list contributes nothing, which makes real
   * work invisible to the engine.
   *
   * These are still the *tool's* report, not an observation. The observation is
   * the before/after snapshot diff in `agent/snapshot.ts`; this is the cheap
   * per-call signal the model is shown so it reasons over the same facts the
   * engine checks.
   */
  filesChanged: string[]
  filesCreated: string[]
  filesDeleted: string[]
  filesRenamed: string[]
  /** What the tool did, for the execution log: `write`, `read`, `exec`, … */
  operation: string
  /** ISO timestamp the call settled at. */
  timestamp: string
  artifacts: ToolArtifact[]
  warnings: string[]
  metadata: Record<string, unknown>
}

export interface InvokeOptions {
  /** Owning task, for audit and artifact attribution. */
  taskId?: string | null
  /** Ceiling on the tier this caller may reach. */
  grantedTier?: PermissionTier
  /** Cooperative cancellation; the runtime chains its own timeout onto it. */
  signal?: AbortSignal
  projectRoot?: string | null
  taskEnv?: Record<string, string> | null
  workspaceRoots?: string[]
  /** Emit a timeline entry without ending the turn. */
  note?: (message: string, status?: 'ok' | 'error' | 'info') => void
}

export interface ToolRuntimeDeps {
  registry: ToolRegistry
  policy: PermissionPolicy
  approvals: ApprovalQueue
  /** Called for every completed invocation, audit or failure. */
  onRecord?: (record: ToolAuditRecord) => void
  /** Ring-buffer size for the in-memory audit trail. */
  maxAuditRecords?: number
  now?: () => number
}

const DEFAULT_TIMEOUT_MS = 120_000

export class ToolRuntime {
  private readonly records: ToolAuditRecord[] = []
  private readonly maxRecords: number
  private readonly now: () => number

  constructor(private readonly deps: ToolRuntimeDeps) {
    this.maxRecords = deps.maxAuditRecords ?? 500
    this.now = deps.now ?? (() => Date.now())
  }

  /** The audit trail, newest last. */
  audit(): ToolAuditRecord[] {
    return [...this.records]
  }

  /** Recent audit records for one tool, for post-hoc inspection. */
  auditFor(toolId: string, limit = 20): ToolAuditRecord[] {
    return this.records.filter((r) => r.toolId === toolId).slice(-limit)
  }

  clearAudit(): void {
    this.records.length = 0
  }

  /**
   * Run a tool end to end. Never throws: a tool failure is a value, because the
   * agent has to be able to read it and decide what to do next.
   */
  async invoke(toolId: string, rawArgs: unknown, options: InvokeOptions = {}): Promise<NormalizedToolResult> {
    const started = this.now()
    const note = options.note ?? (() => undefined)
    const taskId = options.taskId ?? null

    const fail = (
      summary: string,
      error: string,
      failureKind: ToolFailureKind,
      info?: { category?: ToolCategory; risk?: ToolRiskLevel; approved?: boolean },
      extra: Partial<NormalizedToolResult> = {}
    ): NormalizedToolResult => {
      const result: NormalizedToolResult = {
        ok: false,
        summary,
        error,
        failureKind,
        durationMs: this.now() - started,
        artifacts: [],
        warnings: [],
        metadata: {
          category: info?.category ?? 'files',
          risk: info?.risk ?? 'medium'
        },
        ...describeEffect(toolId, null),
        ...extra
      }
      this.record({
        taskId,
        toolId,
        category: info?.category ?? 'files',
        risk: info?.risk ?? 'medium',
        args: redactText(summarizeArgs(rawArgs)),
        ok: false,
        error: redactText(error),
        errorKind: failureKind,
        exitCode: null,
        durationMs: result.durationMs,
        approved: info?.approved ?? false,
        startedAt: new Date(started).toISOString()
      })
      return result
    }

    // 1. Resolve.
    const tool = this.deps.registry.get(toolId)
    if (!tool) {
      return fail('Unknown tool', `No tool registered with id "${toolId}".`, 'unavailable')
    }

    const category = tool.descriptor.category ?? 'files'
    const risk = tool.descriptor.risk ?? riskForTier(tool.descriptor.tier)
    const info = { category, risk }

    // 2. Platform compatibility.
    if (!platformSupported(tool.descriptor.platforms)) {
      const platforms = tool.descriptor.platforms ?? ['*']
      return fail(
        'Unsupported platform',
        `${toolId} supports ${platforms.join(', ')} and this machine is ${process.platform}.`,
        'platform-unsupported',
        info
      )
    }

    // 3. Dependencies.
    const missing = this.missingDependencies(tool)
    if (missing.length > 0) {
      return fail(
        'Missing prerequisite',
        `${toolId} requires ${missing.join(', ')}, which is not registered.`,
        'dependency-missing',
        info
      )
    }

    // 4. Parse.
    const parsed = this.deps.registry.parse(toolId, rawArgs)
    if (!parsed.ok) {
      return fail('Invalid arguments', parsed.error, 'invalid-args', info)
    }

    // 5. Tier clamp. A tool may never exceed the caller's grant.
    const grantedTier = options.grantedTier ?? 'destructive'
    const declaredTier = tool.descriptor.tier
    if (tierRank(declaredTier) > tierRank(grantedTier)) {
      return fail(
        'Not permitted for this caller',
        `${toolId} requires ${declaredTier} permission but this stage is only granted ${grantedTier}.`,
        'permission-denied',
        info
      )
    }

    // 6. Policy.
    const decision: PermissionDecision = this.deps.policy.evaluateDomain(tool.domain)
    if (decision === 'deny') {
      return fail(
        'Denied by policy',
        `${toolId} operates under ${tool.domain}, which policy denies.`,
        'permission-denied',
        info
      )
    }

    // 7. Approval.
    //
    // Two ways to run without stopping to ask:
    //
    //  - the domain allows *and* the tool is `safe`, so there is nothing to
    //    confirm; or
    //  - the user pressed "Allow for this session", which is a human granting
    //    exactly this. A default rule saying `allow` must never authorise a tool
    //    above `safe` unattended, but a session grant is precisely that
    //    authority — without this second clause the button would grant nothing
    //    and the agent would re-prompt on every file for the whole session.
    let approved =
      (decision === 'allow' && declaredTier === 'safe') ||
      // `deny` already returned above, and a session grant cannot lift one.
      this.deps.policy.hasSessionGrant(tool.domain)
    if (!approved) {
      const request = this.deps.approvals.request({
        toolId,
        tier: declaredTier,
        title: `Allow ${tool.descriptor.label}?`,
        detail: summarizeArgs(parsed.value, tool.descriptor.sensitiveArgs ?? []),
        risk: `${risk} risk · requires ${declaredTier} permission (${tool.domain}).`
      })
      note(`Waiting for approval: ${tool.descriptor.label}`, 'info')
      approved = await this.deps.approvals.wait(request.id)
    }

    if (!approved) {
      const result = fail(
        'Denied',
        decision === 'allow'
          ? 'This stage is not permitted to run a tool above the safe tier.'
          : 'The user did not approve this action.',
        'not-approved',
        info
      )
      return result
    }

    // 8. Execute, bounded.
    //
    // The race matters as much as the abort: a tool that ignores its signal
    // would otherwise keep the agent awaiting a promise that never settles,
    // which is exactly the "one broken tool freezes the agent" failure the
    // timeout is supposed to prevent.
    const timeoutMs = tool.descriptor.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const abortFromCaller = (): void => controller.abort()
    options.signal?.addEventListener('abort', abortFromCaller, { once: true })

    let timedOut = false
    let rejectRace: ((error: Error) => void) | null = null

    // One timer does both jobs: abort the tool's signal, and win the race so a
    // tool that ignores cancellation still cannot hold the agent open.
    const timeoutRace = new Promise<never>((_resolve, reject) => {
      rejectRace = reject
    })

    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      rejectRace?.(new Error('__timeout__'))
    }, timeoutMs)
    timer.unref?.()

    const cancelTimer = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abortFromCaller)
    }

    const ctx: ToolContext = {
      projectRoot: options.projectRoot ?? null,
      taskEnv: options.taskEnv ?? null,
      signal: controller.signal,
      note,
      taskId,
      grantedTier,
      recordArtifact: (artifact) => this.recordArtifact(toolId, artifact)
    }

    let raw: ToolResult
    try {
      raw = await Promise.race([tool.execute(parsed.value, ctx), timeoutRace])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      cancelTimer()
      if (timedOut || message === '__timeout__') {
        return fail(
          'Timed out',
          `${toolId} exceeded its ${timeoutMs}ms limit and was aborted.`,
          'timeout',
          info
        )
      }
      if (options.signal?.aborted) {
        return fail('Cancelled', `${toolId} was cancelled by the task.`, 'cancelled', info)
      }
      return fail(`${toolId} threw`, message, 'threw', info)
    }
    cancelTimer()

    if (timedOut) {
      return fail('Timed out', `${toolId} exceeded its ${timeoutMs}ms limit and was aborted.`, 'timeout', info)
    }
    if (options.signal?.aborted) {
      return fail('Cancelled', `${toolId} was cancelled by the task.`, 'cancelled', info)
    }

    // 9. Output contract.
    const result: NormalizedToolResult = {
        ok: raw.ok,
        summary: redactText(raw.summary ?? (raw.ok ? 'Done' : 'Failed')),
        ...(raw.data !== undefined ? { data: raw.data } : {}),
        ...(raw.error ? { error: redactText(raw.error) } : {}),
        ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
        artifacts: raw.artifacts ?? [],
        warnings: (raw.warnings ?? []).map(redactText),
        metadata: { category, risk, timeoutMs, ...(raw.metadata ?? {}) },
        durationMs: this.now() - started,
        ...describeEffect(toolId, raw),
        ...(raw.failureKind ? { failureKind: raw.failureKind } : {})
      }

    // 10. Audit.
    this.record({
      taskId,
      toolId,
      category,
      risk,
      args: summarizeArgs(parsed.value, tool.descriptor.sensitiveArgs ?? []),
      ok: result.ok,
      error: result.error ?? null,
      errorKind: result.ok ? null : (result.failureKind ?? 'failed'),
      exitCode: result.exitCode ?? null,
      durationMs: result.durationMs,
      approved: true,
      startedAt: new Date(started).toISOString()
    })

    if (!result.ok && !result.failureKind) result.failureKind = 'failed'
    return result
  }

  /**
   * Record an artifact outside a tool call (screenshots taken by the review
   * harness, reports produced by a background task, and so on).
   */
  recordArtifact(toolId: string, artifact: Omit<ToolArtifact, 'id' | 'toolId' | 'createdAt'>): ToolArtifact {
    const record: ToolArtifact = {
      ...artifact,
      id: randomUUID(),
      toolId,
      createdAt: new Date().toISOString()
    }
    this.artifacts.push(record)
    return record
  }

  artifactsFor(taskId: string): ToolArtifact[] {
    return this.artifacts.filter((a) => a.taskId === taskId)
  }

  private readonly artifacts: ToolArtifact[] = []

  private missingDependencies(tool: ToolDefinition): string[] {
    return (tool.dependsOn ?? []).filter((id) => !this.deps.registry.has(id))
  }

  private record(entry: Omit<ToolAuditRecord, 'id'>): void {
    const record: ToolAuditRecord = { ...entry, id: randomUUID() }
    this.records.push(record)
    if (this.records.length > this.maxRecords) this.records.shift()
    this.deps.onRecord?.(record)
  }
}

/** True when a tool may run on this machine. `['*']` means every platform. */
export function platformSupported(declared: NodeJS.Platform[] | ['*'] | undefined): boolean {
  if (!declared) return true
  if ((declared as string[])[0] === '*') return true
  return (declared as NodeJS.Platform[]).includes(process.platform)
}

/** Default risk for a tool that does not declare one: derived from its tier. */
export function riskForTier(tier: PermissionTier): ToolRiskLevel {
  switch (tier) {
    case 'safe':
      return 'safe'
    case 'ask':
      return 'low'
    case 'elevated':
      return 'medium'
    case 'destructive':
      return 'high'
    default:
      return 'medium'
  }
}

export { redactArgs, redactText, summarizeArgs }
/**
 * Tools that write, by id.
 *
 * Used only to classify the operation name and to read the effect a tool reports.
 * It is deliberately not an allowlist for *whether* something changed — the
 * engine decides that from a filesystem snapshot — and `delete_file` and
 * `move_file` are here for the first time, which is the class of tool the old
 * four-name list silently ignored.
 */
const MUTATING_TOOL_IDS = new Set([
  'write_file',
  'append_file',
  'edit_file',
  'patch_file',
  'create_file',
  'delete_file',
  'move_file',
  'rename_file',
  'create_directory',
  'run_command'
])

function operationOf(toolId: string): string {
  if (toolId.startsWith('read_') || toolId.startsWith('list_') || toolId.startsWith('search_')) return 'read'
  if (toolId === 'run_command') return 'exec'
  if (toolId.startsWith('install_') || toolId.startsWith('refresh_')) return 'provision'
  if (MUTATING_TOOL_IDS.has(toolId)) return 'write'
  return 'query'
}

/**
 * The filesystem effect a tool reports, read from its own return value.
 *
 * Every array is empty unless the tool actually said so. An absent field is not
 * evidence of anything, so it produces an empty list rather than a guess — the
 * snapshot diff remains the authority on what really changed.
 */
function describeEffect(
  toolId: string,
  raw: { data?: unknown } | null
): Pick<NormalizedToolResult, 'filesChanged' | 'filesCreated' | 'filesDeleted' | 'filesRenamed' | 'operation' | 'timestamp'> {
  const operation = operationOf(toolId)
  const base = {
    filesChanged: [] as string[],
    filesCreated: [] as string[],
    filesDeleted: [] as string[],
    filesRenamed: [] as string[],
    operation,
    timestamp: new Date().toISOString()
  }
  // Only a tool that writes may report a change. `read_file` returns a `path`
  // like every other tool, and treating that as a modification made a pure read
  // report `filesChanged: [...]` — the exact false positive this whole exercise
  // exists to eliminate, introduced by the fix for it.
  if (!raw || operation !== 'write') return base

  const data = raw.data as
    | {
        path?: unknown
        to?: unknown
        from?: unknown
        created?: unknown
        deleted?: unknown
        paths?: unknown
      }
    | undefined
  if (!data) return base

  const asPath = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  const renamed: string[] = []

  const to = asPath(data.to)
  const from = asPath(data.from)
  if (to) {
    // A move is a rename, not two independent edits: counting it as a create
    // plus a delete loses the fact that the file survived.
    if (from) renamed.push(to)
    else if (data.created === true) created.push(to)
    else modified.push(to)
  }

  const path = asPath(data.path)
  if (path && path !== to) {
    if (data.created === true) created.push(path)
    else if (data.deleted === true) deleted.push(path)
    // A write tool that names a path it did not create or delete overwrote it.
    // `write_file` reports `created: false` for exactly that case.
    else modified.push(path)
  }

  if (Array.isArray(data.paths)) {
    for (const p of data.paths) {
      const one = asPath(p)
      if (one && !modified.includes(one) && !created.includes(one) && !deleted.includes(one)) {
        modified.push(one)
      }
    }
  }

  return {
    ...base,
    filesCreated: created,
    filesDeleted: deleted,
    filesRenamed: renamed,
    filesChanged: [...new Set([...created, ...modified, ...deleted, ...renamed])].sort()
  }
}
