/**
 * Execution state machine, ceilings and failure classification.
 *
 * Pure on purpose: imports nothing, so every rule here is directly unit-testable
 * and none of it can be reached only through a live Electron runtime. That is the
 * same reason `updater-feed.ts` exists, and the same lesson — the line deciding
 * whether a task is finished shipped untested once because it lived inside a file
 * that could not be loaded by a test.
 *
 * The invariant this module exists to enforce:
 *
 * > Every execution ends in COMPLETED, FAILED, CANCELLED or BLOCKED.
 *
 * A task in RUNNING, VERIFYING or TESTING is only legitimate while an operation
 * is genuinely in flight. Anything else is a hang, and a hang is what this file
 * was written to make impossible.
 */

/** Every state an execution can occupy. */
export type ExecutionState =
  | 'IDLE'
  | 'QUEUED'
  | 'ANALYZING'
  | 'PLANNING'
  | 'IMPLEMENTING'
  | 'VERIFYING'
  | 'TESTING'
  | 'REVIEWING'
  | 'FIXING'
  | 'CANCELLING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'BLOCKED'

/** The states an execution may never leave on its own. */
export const TERMINAL_STATES: readonly ExecutionState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED']

export function isTerminalState(state: ExecutionState): boolean {
  return TERMINAL_STATES.includes(state)
}

/**
 * States that represent work in flight.
 *
 * The renderer uses this to decide whether a task is still live, and the test
 * suite uses it to assert the invariant above: a task left in one of these has
 * an operation behind it.
 */
export const ACTIVE_STATES: readonly ExecutionState[] = [
  'QUEUED',
  'ANALYZING',
  'PLANNING',
  'IMPLEMENTING',
  'VERIFYING',
  'TESTING',
  'REVIEWING',
  'FIXING',
  'CANCELLING'
]

/** Legal transitions. Anything not listed here is a bug, and `assertTransition` throws. */
const TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  IDLE: ['QUEUED'],
  QUEUED: ['ANALYZING', 'PLANNING', 'CANCELLING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  ANALYZING: ['PLANNING', 'IMPLEMENTING', 'VERIFYING', 'CANCELLING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  PLANNING: ['IMPLEMENTING', 'CANCELLING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  IMPLEMENTING: ['VERIFYING', 'TESTING', 'FIXING', 'IMPLEMENTING', 'CANCELLING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  VERIFYING: ['TESTING', 'FIXING', 'IMPLEMENTING', 'CANCELLING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  TESTING: ['REVIEWING', 'FIXING', 'IMPLEMENTING', 'CANCELLING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  REVIEWING: ['COMPLETED', 'FIXING', 'TESTING', 'CANCELLING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  FIXING: ['TESTING', 'VERIFYING', 'IMPLEMENTING', 'CANCELLING', 'FAILED', 'CANCELLED', 'BLOCKED'],
  CANCELLING: ['CANCELLED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  BLOCKED: []
}

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  if (from === to) return true
  return TRANSITIONS[from].includes(to)
}

/**
 * Throwing variant, for use at the single place a state is assigned.
 *
 * Silent transition is how a task ends up reporting a state its own machine
 * forbids; catching it in development costs nothing and turns a mystery hang
 * into an immediate stack.
 */
export function assertTransition(from: ExecutionState, to: ExecutionState): void {
  if (canTransition(from, to)) return
  throw new Error(`Illegal execution transition ${from} -> ${to}`)
}

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

export interface ExecutionLimits {
  /** Model turns that may each request tools. */
  maxIterations: number
  /** Individual requests issued to the provider. */
  maxModelCalls: number
  /** Individual tool executions. */
  maxToolCalls: number
  /** Wall clock for the whole execution. */
  maxRuntimeMs: number
  /** A single model request may not exceed this. */
  modelTimeoutMs: number
  /** A single tool execution may not exceed this. */
  toolTimeoutMs: number
  /** Silence after which the UI reports the agent as inactive. */
  inactivityMs: number
  /** Identical consecutive tool results tolerated before a no-progress stop. */
  maxIdenticalToolResults: number
}

/**
 * Development defaults.
 *
 * These are ceilings, not targets. An execution that reaches one is stopped and
 * says so; none of them is allowed to silently extend the run.
 */
export const DEFAULT_LIMITS: ExecutionLimits = {
  maxIterations: 30,
  maxModelCalls: 40,
  maxToolCalls: 100,
  maxRuntimeMs: 30 * 60_000,
  modelTimeoutMs: 120_000,
  toolTimeoutMs: 120_000,
  inactivityMs: 30_000,
  maxIdenticalToolResults: 3
}

export interface ExecutionCounters {
  iterations: number
  modelCalls: number
  toolCalls: number
  elapsedMs: number
}

export type LimitName =
  | 'MAX_ITERATIONS'
  | 'MAX_MODEL_CALLS'
  | 'MAX_TOOL_CALLS'
  | 'MAX_RUNTIME'

/**
 * Which ceiling, if any, has been reached.
 *
 * Returns the *first* one tripped so the message names one limit rather than
 * listing every counter that happened to be exceeded at the same moment.
 */
export function limitTripped(counters: ExecutionCounters, limits: ExecutionLimits): LimitName | null {
  if (counters.iterations >= limits.maxIterations) return 'MAX_ITERATIONS'
  if (counters.modelCalls >= limits.maxModelCalls) return 'MAX_MODEL_CALLS'
  if (counters.toolCalls >= limits.maxToolCalls) return 'MAX_TOOL_CALLS'
  if (counters.elapsedMs >= limits.maxRuntimeMs) return 'MAX_RUNTIME'
  return null
}

/**
 * The sentence shown when a ceiling is reached.
 *
 * Fixed wording so it can be asserted, and so the user is told the truth: the
 * agent stopped itself, it did not finish.
 */
export function limitMessage(limit: LimitName, limits: ExecutionLimits): string {
  const what =
    limit === 'MAX_ITERATIONS'
      ? `${limits.maxIterations} reasoning steps`
      : limit === 'MAX_MODEL_CALLS'
        ? `${limits.maxModelCalls} model requests`
        : limit === 'MAX_TOOL_CALLS'
          ? `${limits.maxToolCalls} tool calls`
          : `${Math.round(limits.maxRuntimeMs / 60_000)} minutes of runtime`
  return `Agent execution limit reached — stopped after ${what}. Raise the limit in Settings or narrow the request.`
}

// ---------------------------------------------------------------------------
// No-progress detection
// ---------------------------------------------------------------------------

/**
 * True when the tail of `results` is the same value repeated.
 *
 * The signature is deliberately the rendered result, not the tool id: a model
 * that calls the *same tool with the same arguments* and gets a *different*
 * answer is making progress, and a check on tool names alone would stop it.
 */
export function detectNoProgress(results: string[], tolerance: number): boolean {
  if (tolerance < 2 || results.length < tolerance) return false
  const tail = results.slice(-tolerance)
  const first = tail[0]
  return tail.every((r) => r === first)
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type FailureKind =
  | 'RATE_LIMITED'
  | 'AUTH_ERROR'
  | 'NETWORK_ERROR'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'TOOL_ERROR'
  | 'UNKNOWN'

/**
 * Classify a failure so a retry decision can be made from something other than
 * guesswork.
 *
 * The order matters: "429" is checked before the generic status code, and
 * timeouts before network errors, because a timed-out fetch also tends to carry
 * a socket-flavoured message.
 */
export function classifyFailure(message: string): FailureKind {
  const m = message.toLowerCase()

  if (/\b429\b|rate.?limit|too many requests/.test(m)) return 'RATE_LIMITED'
  if (/\b(401|403)\b|unauthor|forbidden|invalid api key|api key/.test(m)) return 'AUTH_ERROR'
  if (/timed? ?out|timeout|aborted|__timeout__/.test(m)) return 'TIMEOUT'
  if (/enotfound|econnrefused|econnreset|network|fetch failed|socket|dns|tls/.test(m)) return 'NETWORK_ERROR'
  if (/unexpected token|json|parse|could not parse|malformed/.test(m)) return 'INVALID_RESPONSE'
  if (/\b(400|404|500|502|503|504)\b|endpoint returned/.test(m)) return 'PROVIDER_ERROR'
  if (/tool/.test(m)) return 'TOOL_ERROR'
  return 'UNKNOWN'
}

/** Whether re-issuing the identical request could plausibly succeed. */
export function isRetryable(kind: FailureKind): boolean {
  return kind === 'RATE_LIMITED' || kind === 'NETWORK_ERROR' || kind === 'PROVIDER_ERROR'
}

/**
 * Exponential backoff with full jitter, bounded.
 *
 * `attempt` is 1-based. Jitter is included deliberately: a fleet of agents
 * retrying in lockstep against one rate limiter is what keeps a provider
 * limited.
 */
export function backoffMs(attempt: number, base = 3_000, cap = 25_000): number {
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt - 1))
  return Math.round(raw / 2 + Math.random() * (raw / 2))
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export interface Heartbeat {
  state: ExecutionState
  /** ISO timestamp of the last real activity. */
  at: number
  operation: string | null
  tool: string | null
}

/** One line describing what the agent is doing and how long it has been quiet. */
export function heartbeatLine(
  h: { state: ExecutionState; sinceMs: number; operation: string | null; tool: string | null },
  now: number = Date.now()
): string {
  void now
  const age = (h.sinceMs / 1000).toFixed(1)
  const parts = [`State: ${h.state}`, `Last activity: ${age} seconds ago`]
  if (h.operation) parts.push(`Current operation: ${h.operation}`)
  if (h.tool) parts.push(`Tool: ${h.tool}`)
  return `Agent heartbeat\n${parts.join('\n')}`
}

/** Silence past the threshold. Displayed; it never resumes the agent by itself. */
export function isInactivityBreach(sinceMs: number, limitMs: number): boolean {
  return sinceMs >= limitMs
}

/** Keep only the newest heartbeat — exactly one is ever live. */
export function mergeHeartbeats(hb: Heartbeat[], _now: number = Date.now()): Heartbeat[] {
  void _now
  if (hb.length === 0) return []
  return [hb.reduce((newest, h) => (h.at >= newest.at ? h : newest))]
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

/**
 * One greppable execution log line.
 *
 * `[03:45:02] TOOL_STARTED run_command` — the shape the whole point of this
 * file is to produce. The reported hang was undiagnosable because nothing in the
 * log said what the agent was waiting for; every wait now names itself.
 */
export function formatExecutionLog(event: string, detail?: string | null): string {
  const stamp = new Date().toISOString().slice(11, 19)
  return detail ? `[${stamp}] ${event} ${detail}` : `[${stamp}] ${event}`
}

/**
 * The usage block shown in execution details.
 *
 * Token counts are summed only from calls that actually reported usage. A
 * provider that returns no usage block is reported as unavailable — never as
 * zero, because "zero tokens" and "not reported" are different facts and
 * conflating them makes a free tier look like a broken meter.
 */
export function formatUsage(calls: { usageAvailable: boolean; inputTokens: number | null; outputTokens: number | null }[]): string {
  const reported = calls.filter((c) => c.usageAvailable)
  if (reported.length === 0) return 'Model usage — Usage unavailable (the provider reported none).'

  const input = reported.reduce((n, c) => n + (c.inputTokens ?? 0), 0)
  const output = reported.reduce((n, c) => n + (c.outputTokens ?? 0), 0)
  const unaccounted = calls.length - reported.length
  const suffix = unaccounted > 0 ? ` · ${unaccounted} call(s) reported no usage` : ''
  return `Model usage — requests: ${calls.length}, input tokens: ${input.toLocaleString()}, output tokens: ${output.toLocaleString()}, total: ${(input + output).toLocaleString()}${suffix}`
}