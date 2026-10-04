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
 * Three rules keep it from becoming an agent that lies:
 *
 *  - **Only tool results are reported as work.** Every "I did X" the user sees
 *    is backed by a `ToolResult` this loop actually received.
 *  - **Every tool call gets an answer.** Including malformed ones and unknown
 *    tool names. An unanswered `tool_call_id` makes the next request fail, and
 *    the failure is opaque.
 *  - **The loop is bounded.** A model that keeps asking for tools gets stopped
 *    and told so, rather than spinning until the user hits stop.
 */

import type { CompletionRequest, CompletionResult, ToolSpec } from '../models/gateway'
import type { ToolResult } from '../tools/registry'
import type { ToolDescriptor } from '@shared/types'

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
}

/** Model turns that may each request tools before the loop is cut off. */
const DEFAULT_MAX_STEPS = 12

/** Characters of a tool result handed back to the model. */
const MAX_RESULT_CHARS = 4000

export interface LoopInput {
  systemPrompt: string
  /** Prior conversation, oldest first. */
  history: { role: 'user' | 'assistant'; content: string }[]
  prompt: string
  signal: AbortSignal
  maxSteps?: number
}

export interface LoopOutcome {
  ok: boolean
  /** The model's final prose, or '' when it never produced any. */
  text: string
  steps: number
  /** How many tools were actually executed. */
  toolCalls: number
  /** Tool ids that ran, in order. */
  called: string[]
  error: string | null
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

export async function runAgentLoop(deps: LoopDeps, input: LoopInput): Promise<LoopOutcome> {
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS
  const tools = buildToolSpecs(deps.listTools())

  const messages: CompletionRequest['messages'] = [
    { role: 'system', content: input.systemPrompt },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: input.prompt }
  ]

  const called: string[] = []
  let steps = 0
  let toolCalls = 0
  let spoken = ''

  while (steps < maxSteps) {
    if (input.signal.aborted) {
      return {
        ok: false,
        text: spoken,
        steps,
        toolCalls,
        called,
        error: 'Stopped before the model finished.'
      }
    }

    steps += 1
    const turn = await deps.complete({
      messages,
      tools,
      maxTokens: 4096,
      signal: input.signal
    })

    if (!turn.ok) {
      // A provider failure ends the run and reports itself. Continuing would
      // mean re-issuing the same failing request with a longer history.
      return { ok: false, text: spoken, steps, toolCalls, called, error: turn.error }
    }

    // The assistant turn is echoed verbatim, `tool_calls` included, because the
    // tool messages that answer it are only valid alongside it.
    if (turn.assistantMessage) messages.push(turn.assistantMessage)
    if (turn.text.trim()) {
      spoken = turn.text.trim()
      deps.record('assistant', spoken)
    }

    if (turn.toolCalls.length === 0) {
      return {
        ok: true,
        text: spoken,
        steps,
        toolCalls,
        called,
        error: spoken.length === 0 ? 'The model returned no text and requested no tools.' : null
      }
    }

    for (const call of turn.toolCalls) {
      if (input.signal.aborted) {
        return { ok: false, text: spoken, steps, toolCalls, called, error: 'Stopped mid-tool-run.' }
      }

      toolCalls += 1
      called.push(call.name)

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
        messages.push({ role: 'tool', tool_call_id: call.id, content: argsText })
        continue
      }

      deps.note(`calling ${call.name}(${argsText})`, 'info')
      const result = await deps.invoke(call.name, call.arguments)
      const rendered = renderResult(call.name, result)

      deps.record('tool', rendered, call.name, result.ok)
      if (result.ok) deps.note(`${call.name}: ${result.summary}`, 'ok')
      else deps.note(`${call.name}: ${result.error ?? result.summary}`, 'error')

      messages.push({ role: 'tool', tool_call_id: call.id, content: rendered })
    }
  }

  // Out of steps. Say so plainly instead of pretending the work is finished.
  const tail =
    `I stopped after ${maxSteps} steps without reaching a conclusion. ` +
    `Tools run: ${called.length}. Narrow the request or stop me if something is looping.`

  return { ok: false, text: spoken || tail, steps, toolCalls, called, error: tail }
}

function describeArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
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