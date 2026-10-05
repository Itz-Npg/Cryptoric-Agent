/**
 * The agent loop.
 *
 * This is what makes Cryptoric Chan an agent rather than a narrator. The model
 * is given the real tool registry, asks for a tool, the tool runs through the
 * existing `ToolRuntime` — so policy, approval prompts, redaction, timeouts and
 * cancellation all still apply — and the real result goes back to the model,
 * which decides what to do next. It repeats until the model answers in prose
 * instead of asking for another tool.
 *
 * Four rules keep it from becoming an agent that lies, or one that never stops:
 *
 *  - **Only tool results are reported as work.** Every "I did X" the user sees
 *    is backed by a `ToolResult` this loop actually received.
 *  - **Every tool call gets an answer.** Including malformed ones and unknown
 *    tool names. An unanswered `tool_call_id` makes the next request fail, and
 *    the failure is opaque.
 *  - **Nothing is awaited forever.** Every model request and every tool call is
 *    raced against a deadline. An unbounded `await` is not patience, it is a
 *    task stuck in RUNNING with no work behind it, which is exactly the defect
 *    this file was rewritten to eliminate.
 *  - **The loop is bounded.** Iterations, model calls, tool calls and wall clock
 *    each have a ceiling, and repeating the same call without changing anything
 *    is caught before it burns the whole budget.
 */

import type { CompletionRequest, CompletionResult, ToolSpec } from '../models/gateway'
import type { ToolResult } from '../tools/registry'
import type { ToolDescriptor } from '@shared/types'
import {
  DEFAULT_LIMITS,
  detectNoProgress,
  formatExecutionLog,
  formatUsage,
  limitMessage,
  limitTripped,
  type ExecutionLimits,
  type ExecutionState
} from './execution'

export interface LoopDeps {
  /** One chat turn against the configured model. */
  complete(request: CompletionRequest): Promise<CompletionResult>
  /** The live tool registry; this is the capability surface offered to the model. */
  listTools(): ToolDescriptor[]
  /**
   * Run a tool. This must be the policy-enforcing path (`AgentRuntime.invoke`),
   * not a direct `registry.get(id).execute()` — otherwise this loop would be a
   * second, unaudited way to touch the filesystem.
   */
  invoke(toolId: string, args: Record<string, unknown>): Promise<ToolResult>
  /** Timeline note. */
  note(message: string, status?: 'ok' | 'error' | 'info'): void
  /** Append a line to the persisted conversation. */
  record(role: 'assistant' | 'tool', text: string, tool?: string, ok?: boolean): void
  /** Told what the loop is doing, and how long it has been quiet. */
  heartbeat?(beat: { state: ExecutionState; operation: string | null; tool: string | null; sinceMs: number }): void
}

/** Characters of a tool result handed back to the model. */
const MAX_RESULT_CHARS = 4000

export interface LoopInput {
  systemPrompt: string
  /** Prior conversation, oldest first. */
  history: { role: 'user' | 'assistant'; content: string }[]
  prompt: string
  signal: AbortSignal
  maxSteps?: number
  /** Overrides for the execution ceilings. Defaults are development values. */
  limits?: Partial<ExecutionLimits>
}

/** One provider request, recorded whether it succeeded, failed or timed out. */
export interface ModelCallRecord {
  requestId: string
  provider: string
  model: string
  status: 'QUEUED' | 'SENT' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT'
  startedAt: string
  completedAt: string | null
  durationMs: number
  inputTokens: number | null
  outputTokens: number | null
  /** False when the provider returned no usage block. Never a fabricated zero. */
  usageAvailable: boolean
  finishReason: string | null
  error: string | null
}

/** One tool execution, recorded the same way. */
export interface ToolCallRecord {
  toolId: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT'
  startedAt: string
  durationMs: number
  error: string | null
}

export interface LoopOutcome {
  ok: boolean
  /** The model's final prose, or '' when it never produced any. */
  text: string
  steps: number
  /** Reasoning turns actually taken. */
  iterations: number
  /** How many tools were actually executed. */
  toolCalls: number
  /** Tool ids that ran, in order. */
  called: string[]
  error: string | null
  /** The state the execution ended in. Never RUNNING. */
  finalState: ExecutionState
  calls: ModelCallRecord[]
  toolRecords: ToolCallRecord[]
  /** Why the loop stopped, when it was not a clean finish. */
  stopReason:
    | null
    | 'MODEL_TIMEOUT'
    | 'TOOL_TIMEOUT'
    | 'CANCELLED'
    | 'NO_PROGRESS_LOOP'
    | 'MAX_ITERATIONS'
    | 'MAX_MODEL_CALLS'
    | 'MAX_TOOL_CALLS'
    | 'MAX_RUNTIME'
    | 'PROVIDER_FAILURE'
}

/**
 * Offer the registry to the model.
 *
 * Descriptions are the only thing the model has to go on when choosing between
 * 50-odd tools, so they are sent in full rather than truncated — the context
 * window is a million tokens and a clipped description costs far more than it
 * saves. `inputSchema` is the tool's own declared JSON Schema, not a hand-written
 * summary, so the model cannot invent arguments the tool will reject.
 */
export function buildToolSpecs(descriptors: ToolDescriptor[]): ToolSpec[] {
  return descriptors.map((d) => ({
    type: 'function' as const,
    function: {
      name: d.id,
      description: d.description,
      parameters: normaliseSchema(d.inputSchema)
    }
  }))
}

/**
 * Coerce a described schema into something every provider accepts.
 *
 * `describeSchema` returns `{}` for shapes it does not model, and an empty
 * `parameters` object is rejected by the OpenAI schema validator. Falling back
 * to a permissive string map keeps a usable-but-loose schema rather than a
 * request that fails outright.
 */
function normaliseSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && Object.keys(schema as object).length > 0) {
    const s = schema as Record<string, unknown>
    return s['type'] === undefined ? { type: 'object', properties: s, required: [] } : s
  }
  return { type: 'object', properties: {}, additionalProperties: true }
}

/**
 * Race a promise against a deadline.
 *
 * This is the whole point of the rewrite. The previous version had
 * `await deps.complete(...)` bare, so a provider that accepted the connection
 * and then never answered held the task in RUNNING indefinitely — and the UI,
 * which ticks a stage when it *starts*, showed that stage as finished the entire
 * time.
 *
 * The timer is always cleared, including on the success path. A leaked timer per
 * call is a leaked handle per call, and in a loop of forty that is forty live
 * timers keeping the event loop warm after the work is done.
 */
async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  signal: AbortSignal
): Promise<{ ok: true; value: T } | { ok: false; reason: 'TIMEOUT' | 'CANCELLED' }> {
  let timer: ReturnType<typeof setTimeout> | undefined

  const onAbort = (): void => {
    if (timer) clearTimeout(timer)
  }
  signal.addEventListener('abort', onAbort, { once: true })

  const timerPromise = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), deadlineMs)
  })
  const abortPromise = new Promise<'CANCELLED'>((resolve) => {
    if (signal.aborted) resolve('CANCELLED')
    else signal.addEventListener('abort', () => resolve('CANCELLED'), { once: true })
  })

  try {
    const winner = await Promise.race([
      work.then((value) => ({ kind: 'value' as const, value })),
      timerPromise.then((kind) => ({ kind })),
      abortPromise.then((kind) => ({ kind }))
    ])
    if (winner.kind === 'value') return { ok: true, value: winner.value }
    return { ok: false, reason: winner.kind }
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

let requestSeq = 0
function nextRequestId(): string {
  requestSeq += 1
  return `mc_${Date.now().toString(36)}_${requestSeq}`
}

export async function runAgentLoop(deps: LoopDeps, input: LoopInput): Promise<LoopOutcome> {
  const limits: ExecutionLimits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) }
  // `maxSteps` is the loop's own historical knob. It narrows the iteration
  // ceiling rather than replacing it, so a caller cannot accidentally raise the
  // global limit by passing a big number.
  const maxSteps = Math.min(input.maxSteps ?? limits.maxIterations, limits.maxIterations)

  const tools = buildToolSpecs(deps.listTools())

  const messages: CompletionRequest['messages'] = [
    { role: 'system', content: input.systemPrompt },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: input.prompt }
  ]

  const called: string[] = []
  const calls: ModelCallRecord[] = []
  const toolRecords: ToolCallRecord[] = []
  const toolResults: string[] = []

  let steps = 0
  let iterations = 0
  let toolCalls = 0
  let spoken = ''
  let lastActivity = Date.now()
  let state: ExecutionState = 'IMPLEMENTING'
  let currentTool: string | null = null

  const touch = (): void => {
    lastActivity = Date.now()
  }
  const beat = (operation: string | null = null): void => {
    deps.heartbeat?.({ state, operation, tool: currentTool, sinceMs: Date.now() - lastActivity })
  }

  const finish = (
    finalState: ExecutionState,
    error: string | null,
    stopReason: LoopOutcome['stopReason']
  ): LoopOutcome => ({
    ok: finalState === 'COMPLETED',
    text: spoken,
    steps,
    iterations,
    toolCalls,
    called,
    error,
    finalState,
    calls,
    toolRecords,
    stopReason
  })

  const startedAt = Date.now()
  const elapsed = (): number => Date.now() - startedAt

  while (iterations < maxSteps) {
    if (input.signal.aborted) {
      return finish('CANCELLED', 'Stopped before the model finished.', 'CANCELLED')
    }

    const check: ReturnType<typeof limitTripped> = limitTripped(
      { iterations, modelCalls: calls.length, toolCalls, elapsedMs: elapsed() },
      limits
    )
    if (check) {
      return finish('FAILED', limitMessage(check, limits), check)
    }

    if (elapsed() >= limits.maxRuntimeMs) {
      return finish('FAILED', limitMessage('MAX_RUNTIME', limits), 'MAX_RUNTIME')
    }

    iterations += 1
    steps += 1
    touch()
    beat('waiting for the model')

    const requestId = nextRequestId()
    const record: ModelCallRecord = {
      requestId,
      provider: 'unknown',
      model: 'unknown',
      status: 'SENT',
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationMs: 0,
      inputTokens: null,
      outputTokens: null,
      usageAvailable: false,
      finishReason: null,
      error: null
    }
    calls.push(record)

    const callStarted = Date.now()
    const raced = await withDeadline(
      deps.complete({ messages, tools, maxTokens: 4096, signal: input.signal }),
      limits.modelTimeoutMs,
      input.signal
    )
    record.durationMs = Date.now() - callStarted
    record.completedAt = new Date().toISOString()

    if (!raced.ok) {
      if (raced.reason === 'CANCELLED') {
        record.status = 'CANCELLED'
        return finish('CANCELLED', 'Stopped while the model was answering.', 'CANCELLED')
      }
      // The provider accepted the connection and then never answered. Without
      // this the task stays in RUNNING forever and nothing reports it.
      record.status = 'TIMEOUT'
      record.error = `MODEL_TIMEOUT after ${limits.modelTimeoutMs}ms`
      deps.note(`model did not answer within ${Math.round(limits.modelTimeoutMs / 1000)}s`, 'error')
      return finish('FAILED', `MODEL_TIMEOUT: the model did not answer within ${limits.modelTimeoutMs}ms.`, 'MODEL_TIMEOUT')
    }

    const turn = raced.value
    record.model = turn.model
    record.usageAvailable =
      turn.usage.inputTokens > 0 || turn.usage.outputTokens > 0 || turn.usage.cachedTokens > 0
    record.inputTokens = record.usageAvailable ? turn.usage.inputTokens : null
    record.outputTokens = record.usageAvailable ? turn.usage.outputTokens : null

    if (!turn.ok) {
      record.status = 'FAILED'
      record.error = turn.error
      // A provider failure ends the run and reports itself. Continuing would
      // mean re-issuing the same failing request with a longer history.
      return finish('FAILED', turn.error, 'PROVIDER_FAILURE')
    }
    record.status = 'COMPLETED'
    touch()

    // The assistant turn is echoed verbatim, `tool_calls` included, because the
    // tool messages that answer it are only valid alongside it.
    if (turn.assistantMessage) messages.push(turn.assistantMessage)
    if (turn.text.trim()) {
      spoken = turn.text.trim()
      deps.record('assistant', spoken)
    }

    if (turn.toolCalls.length === 0) {
      return finish('COMPLETED', spoken.length === 0 ? 'The model returned no text and requested no tools.' : null, null)
    }

    for (const call of turn.toolCalls) {
      if (input.signal.aborted) {
        return finish('CANCELLED', 'Stopped mid-tool-run.', 'CANCELLED')
      }

      toolCalls += 1
      called.push(call.name)
      currentTool = call.name || null

      const toolBudget = limitTripped(
        { iterations, modelCalls: calls.length, toolCalls, elapsedMs: elapsed() },
        limits
      )
      if (toolBudget) {
        return finish('FAILED', limitMessage(toolBudget, limits), toolBudget)
      }

      if (call.name.length === 0) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: 'That call had no tool name. Call one of the listed tools.'
        })
        continue
      }

      const argsText = call.malformed
        ? `"arguments" was not a JSON object, so the call was not run. Send arguments as a JSON object matching the tool's schema.`
        : describeArgs(call.arguments)

      if (call.malformed) {
        deps.note(`${call.name}: malformed arguments, not run`, 'error')
        toolRecords.push({
          toolId: call.name,
          status: 'FAILED',
          startedAt: new Date().toISOString(),
          durationMs: 0,
          error: 'malformed arguments'
        })
        messages.push({ role: 'tool', tool_call_id: call.id, content: argsText })
        continue
      }

      deps.note(`calling ${call.name}(${argsText})`, 'info')
      touch()
      beat(`running ${call.name}`)

      const toolStarted = Date.now()
      const toolRaced = await withDeadline(
        deps.invoke(call.name, call.arguments),
        limits.toolTimeoutMs,
        input.signal
      )
      const toolDuration = Date.now() - toolStarted
      currentTool = null

      if (!toolRaced.ok) {
        const cancelled = toolRaced.reason === 'CANCELLED'
        toolRecords.push({
          toolId: call.name,
          status: cancelled ? 'CANCELLED' : 'TIMEOUT',
          startedAt: new Date(toolStarted).toISOString(),
          durationMs: toolDuration,
          error: cancelled ? 'cancelled' : `TOOL_TIMEOUT after ${limits.toolTimeoutMs}ms`
        })
        const text = cancelled
          ? `${call.name}: cancelled by the user.`
          : `${call.name}: TOOL_TIMEOUT — did not finish within ${limits.toolTimeoutMs}ms and was abandoned.`
        deps.record('tool', text, call.name, false)
        messages.push({ role: 'tool', tool_call_id: call.id, content: text })

        if (cancelled) return finish('CANCELLED', 'Stopped during a tool call.', 'CANCELLED')
        // A timed-out tool is reported to the model, not swallowed: it may
        // legitimately be a slow test. But an unbounded wait is never the answer.
        touch()
        continue
      }

      const result = toolRaced.value
      const rendered = renderResult(call.name, result)

      toolRecords.push({
        toolId: call.name,
        status: result.ok ? 'COMPLETED' : 'FAILED',
        startedAt: new Date(toolStarted).toISOString(),
        durationMs: toolDuration,
        error: result.ok ? null : (result.error ?? result.summary)
      })
      toolResults.push(rendered)

      deps.record('tool', rendered, call.name, result.ok)
      if (result.ok) deps.note(`${call.name}: ${result.summary}`, 'ok')
      else deps.note(`${call.name}: ${result.error ?? result.summary}`, 'error')

      messages.push({ role: 'tool', tool_call_id: call.id, content: rendered })
      touch()

      // Same answer over and over is not progress. Stopping here is what keeps a
      // confused model from spending the entire tool budget re-reading one file.
      if (detectNoProgress(toolResults, limits.maxIdenticalToolResults)) {
        const text =
          `NO_PROGRESS_LOOP: ${call.name} returned an identical result ${limits.maxIdenticalToolResults} times in a row. ` +
          `Stopping rather than repeating it again.`
        deps.note(text, 'error')
        return finish('FAILED', text, 'NO_PROGRESS_LOOP')
      }
    }
  }

  // Out of steps. Say so plainly instead of pretending the work is finished.
  const tail =
    `I stopped after ${maxSteps} steps without reaching a conclusion. ` +
    `Tools run: ${called.length}. Narrow the request or stop me if something is looping.`

  return finish('FAILED', tail, 'MAX_ITERATIONS')
}

function describeArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * The execution's own log, rendered as lines.
 *
 * Every model call and every tool call, in order, with the state it reached and
 * how long it took — then the final state and the reason for it. This is the
 * record that makes the next hang diagnosable rather than mysterious.
 */
export function describeExecution(outcome: LoopOutcome): string[] {
  const lines: string[] = []

  lines.push(formatExecutionLog('EXECUTION_STARTED', `limits ${JSON.stringify(DEFAULT_LIMITS)}`))

  for (const call of outcome.calls) {
    lines.push(
      formatExecutionLog(
        `MODEL_${call.status}`,
        [
          call.requestId,
          call.model,
          `${call.durationMs}ms`,
          call.usageAvailable
            ? `in=${call.inputTokens ?? 0} out=${call.outputTokens ?? 0}`
            : 'usage unavailable',
          call.error ?? ''
        ]
          .filter(Boolean)
          .join(' ')
      )
    )
  }

  for (const tool of outcome.toolRecords) {
    lines.push(
      formatExecutionLog(`TOOL_${tool.status}`, [tool.toolId, `${tool.durationMs}ms`, tool.error ?? ''].filter(Boolean).join(' '))
    )
  }

  lines.push(formatUsage(outcome.calls))
  lines.push(
    formatExecutionLog(
      'EXECUTION_FINISHED',
      [
        outcome.finalState,
        outcome.stopReason ? `reason=${outcome.stopReason}` : null,
        `iterations=${outcome.iterations}`,
        `model_calls=${outcome.calls.length}`,
        `tool_calls=${outcome.toolCalls}`
      ]
        .filter(Boolean)
        .join(' ')
    )
  )

  return lines
}

/**
 * What the model sees when a tool returns.
 *
 * A failure is stated as a failure. Feeding a failed tool back as success is how
 * an agent ends up reporting a build that never passed, and the whole point of
 * routing tools through a real runtime is that the answer is trustworthy.
 */
function renderResult(name: string, result: ToolResult): string {
  const header = result.ok ? `${name}: ok — ${result.summary}` : `${name}: FAILED — ${result.error ?? result.summary}`
  const payload = result.ok ? result.data : { error: result.error ?? result.summary }
  if (payload === undefined) return header

  let body: string
  try {
    body = JSON.stringify(payload, null, 2) ?? ''
  } catch {
    body = String(payload)
  }
  if (body.length > MAX_RESULT_CHARS) {
    body = `${body.slice(0, MAX_RESULT_CHARS)}\n… (truncated; ${body.length} chars total)`
  }
  return `${header}\n${body}`
}

/** Re-export so the stage layer can name the outcome type. */
export type { CompletionResult }