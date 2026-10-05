/**
 * The hanging-task regression suite.
 *
 * Every test here corresponds to a way an execution could previously end up
 * stuck in RUNNING with no work happening. They are written against the pure
 * modules and against real timers, not mocks of the thing under test.
 *
 * The original report: the UI showed three completed stages, "Running —
 * running", and nothing further, indefinitely.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIMITS,
  classifyFailure,
  isTerminalState,
  limitTripped,
  detectNoProgress,
  isInactivityBreach,
  heartbeatLine,
  mergeHeartbeats,
  type ExecutionCounters
} from '../../src/main/services/agent/execution'
import { runAgentLoop, type LoopDeps } from '../../src/main/services/agent/loop'
import type { CompletionResult, ToolSpec } from '../../src/main/services/models/gateway'
import type { ToolResult } from '../../src/main/services/tools/registry'
import { ModelGateway } from '../../src/main/services/models/gateway'
import { buildPipeline } from '../../src/main/services/agent/stages'

const NO_TOOLS: ToolSpec[] = []

function deps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    complete: async (): Promise<CompletionResult> => ({
      ok: true,
      text: 'done',
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, estimatedCostUsd: 0 },
      model: 'test',
      error: null,
      toolCalls: [],
      assistantMessage: null
    }),
    listTools: () => [],
    invoke: async (): Promise<ToolResult> => ({ ok: true, summary: 'fine', data: {} }),
    note: () => undefined,
    record: () => undefined,
    ...over
  }
}

function input(over: Partial<Parameters<typeof runAgentLoop>[1]> = {}): Parameters<typeof runAgentLoop>[1] {
  return {
    systemPrompt: 'you are an agent',
    history: [],
    prompt: 'do the thing',
    signal: new AbortController().signal,
    ...over
  }
}

afterEach(() => {
  // A leaked timer in a test is a hung suite, which is the very thing this file
  // exists to prevent.
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 1. Model watchdog
// ---------------------------------------------------------------------------

describe('model call watchdog', () => {
  it('times out a model call that never resolves instead of waiting forever', async () => {
    const out = await runAgentLoop(
      deps({ complete: () => new Promise<CompletionResult>(() => undefined) }),
      input({ limits: { modelTimeoutMs: 40 } })
    )

    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/MODEL_TIMEOUT|timed out/i)
    expect(out.finalState).toBe('FAILED')
  })

  it('reports how long the model was given before giving up', async () => {
    const out = await runAgentLoop(
      deps({ complete: () => new Promise<CompletionResult>(() => undefined) }),
      input({ limits: { modelTimeoutMs: 30 } })
    )

    expect(out.calls[0]?.status).toBe('TIMEOUT')
    expect(out.calls[0]?.durationMs).toBeGreaterThanOrEqual(20)
  })
})

// ---------------------------------------------------------------------------
// 2. Tool watchdog
// ---------------------------------------------------------------------------

describe('tool call watchdog', () => {
  it('times out a tool that never resolves', async () => {
    let call = 0
    const out = await runAgentLoop(
      deps({
        complete: async () => {
          call += 1
          if (call > 1) {
            return done('recovered')
          }
          return {
            ...done(''),
            toolCalls: [{ id: 'c1', name: 'run_command', arguments: {}, malformed: false }],
            assistantMessage: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{}' } }]
            }
          }
        },
        invoke: () => new Promise<ToolResult>(() => undefined)
      }),
      input({ limits: { toolTimeoutMs: 40, modelTimeoutMs: 500 } })
    )

    const toolCall = out.toolRecords.find((r) => r.toolId === 'run_command')
    expect(toolCall).toBeDefined()
    expect(toolCall?.status).toBe('TIMEOUT')
  })
})

// ---------------------------------------------------------------------------
// 3. Cancellation
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('reaches CANCELLED, never RUNNING, when the user stops mid-model-call', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)

    const out = await runAgentLoop(
      deps({ complete: () => new Promise<CompletionResult>(() => undefined) }),
      input({ signal: controller.signal })
    )

    expect(out.finalState).toBe('CANCELLED')
    expect(out.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. Repeated tool calls
// ---------------------------------------------------------------------------

describe('no-progress loop detection', () => {
  it('stops when the model repeats the same call and gets the same answer', async () => {
    let turn = 0
    const out = await runAgentLoop(
      deps({
        complete: async () => {
          turn += 1
          return {
            ...done(''),
            toolCalls: [{ id: `c${turn}`, name: 'read_file', arguments: { path: 'a.txt' }, malformed: false }],
            assistantMessage: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: `c${turn}`,
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"a.txt"}' }
                }
              ]
            }
          }
        },
        invoke: async () => ({ ok: true, summary: 'contents', data: { text: 'same' } })
      }),
      input({ limits: { maxIdenticalToolResults: 3, modelTimeoutMs: 500 } })
    )

    expect(out.error).toMatch(/NO_PROGRESS_LOOP|no progress/i)
    expect(out.finalState).toBe('FAILED')
  })

  it('does not fire when the tool result actually changes', () => {
    expect(detectNoProgress(['a', 'a', 'b', 'b', 'a', 'b'], 3)).toBe(false)
  })

  it('fires on a run of identical results', () => {
    expect(detectNoProgress(['a', 'a', 'a'], 3)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Iteration, call and runtime ceilings
// ---------------------------------------------------------------------------

describe('execution limits', () => {
  it('stops at maxIterations and says the limit was reached', async () => {
    let turn = 0
    const out = await runAgentLoop(
      deps({
        complete: async () => {
          turn += 1
          return {
            ...done(''),
            toolCalls: [{ id: `c${turn}`, name: 'noop', arguments: {}, malformed: false }],
            assistantMessage: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: `c${turn}`, type: 'function', function: { name: 'noop', arguments: '{}' } }]
            }
          }
        },
        // A counter in the result so the no-progress guard does not fire first:
        // this test is about the iteration ceiling, not about repetition.
        invoke: async () => ({ ok: true, summary: 'contents', data: { n: turn } })
      }),
      input({ limits: { maxIterations: 3 } })
    )

    expect(out.error).toMatch(/Agent execution limit reached/i)
    expect(out.iterations).toBeLessThanOrEqual(3)
  })

  it('stops at maxToolCalls even when iterations remain', () => {
    const tripped = limitTripped(
      { iterations: 1, modelCalls: 9, toolCalls: 100, elapsedMs: 10 },
      { ...DEFAULT_LIMITS, maxToolCalls: 100 }
    )
    expect(tripped).toBe('MAX_TOOL_CALLS')
  })

  it('stops at maxRuntimeMs', () => {
    const tripped = limitTripped(
      { iterations: 1, modelCalls: 1, toolCalls: 1, elapsedMs: 31 * 60_000 },
      DEFAULT_LIMITS
    )
    expect(tripped).toBe('MAX_RUNTIME')
  })

  it('reports nothing when under every ceiling', () => {
    expect(limitTripped({ iterations: 1, modelCalls: 1, toolCalls: 1, elapsedMs: 10 }, DEFAULT_LIMITS)).toBe(
      null
    )
  })
})

// ---------------------------------------------------------------------------
// 6. Provider failure
// ---------------------------------------------------------------------------

describe('failure classification', () => {
  it.each([
    ['429 rate limited', 'RATE_LIMITED'],
    ['401 Invalid API key', 'AUTH_ERROR'],
    ['fetch failed ECONNREFUSED', 'NETWORK_ERROR'],
    ['Model endpoint returned 503.', 'PROVIDER_ERROR'],
    ['The operation timed out', 'TIMEOUT'],
    ['Unexpected token < in JSON', 'INVALID_RESPONSE'],
    ['tool exploded', 'TOOL_ERROR']
  ])('classifies %s as %s', (message, expected) => {
    expect(classifyFailure(message)).toBe(expected)
  })

  it('falls back to UNKNOWN rather than guessing', () => {
    expect(classifyFailure('something else entirely')).toBe('UNKNOWN')
  })
})

// ---------------------------------------------------------------------------
// 7. Successful completion
// ---------------------------------------------------------------------------

describe('successful completion', () => {
  it('reaches COMPLETED with the model prose', async () => {
    const out = await runAgentLoop(deps(), input())

    expect(out.ok).toBe(true)
    expect(out.finalState).toBe('COMPLETED')
    expect(out.text).toBe('done')
  })

  it('records usage, or marks it unavailable rather than inventing it', async () => {
    const out = await runAgentLoop(deps(), input())
    expect(out.calls[0]?.usageAvailable).toBe(true)
    expect(out.calls[0]?.inputTokens).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 8/9. Terminality
// ---------------------------------------------------------------------------

describe('terminal state guarantee', () => {
  it.each(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'])('%s is terminal', (s) => {
    expect(isTerminalState(s as never)).toBe(true)
  })

  it.each(['RUNNING', 'TESTING', 'VERIFYING', 'IMPLEMENTING'])('%s is not terminal', (s) => {
    expect(isTerminalState(s as never)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 10. Heartbeat
// ---------------------------------------------------------------------------

describe('heartbeat', () => {
  it('summarises the live state, its age and the current operation', () => {
    const line = heartbeatLine({
      state: 'VERIFYING',
      sinceMs: 4200,
      operation: 'npm verification',
      tool: 'run_command'
    })
    expect(line).toContain('VERIFYING')
    expect(line).toContain('4.2 seconds ago')
    expect(line).toContain('npm verification')
    expect(line).toContain('run_command')
  })

  it('flags inactivity past the threshold', () => {
    expect(isInactivityBreach(31_000, 30_000)).toBe(true)
    expect(isInactivityBreach(4_000, 30_000)).toBe(false)
  })

  it('merges the newest heartbeat so only one is ever live', () => {
    const merged = mergeHeartbeats(
      [
        { state: 'IMPLEMENTING', at: 1000, operation: null, tool: null },
        { state: 'TESTING', at: 2000, operation: null, tool: null }
      ],
      2500
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.state).toBe('TESTING')
  })
})

function done(text: string): CompletionResult {
  return {
    ok: true,
    text,
    usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, estimatedCostUsd: 0 },
    model: 'test',
    error: null,
    toolCalls: [],
    assistantMessage: null
  }
}

export type { ExecutionCounters }
export { NO_TOOLS }
// ---------------------------------------------------------------------------
// The reported hang, at the layer it actually happened
// ---------------------------------------------------------------------------

describe('gateway model request is always bounded', () => {
  it('gives up on an endpoint that accepts the connection and never answers', async () => {
    // The exact failure that was reported: the agent sits in RUNNING forever
    // because nothing ever comes back. `fetch` here resolves to a connection
    // that is established and then goes silent — the shape of a provider that
    // has taken the request and stalled.
    const original = globalThis.fetch
    let sawSignal = false
    // Behaves like undici, which is what Node's global fetch is: the promise
    // stays pending until the signal fires, and *then* rejects with an
    // AbortError. A mock that simply never settled would test a fetch
    // implementation nobody ships.
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      sawSignal = Boolean(init?.signal)
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return
        if (signal.aborted) {
          reject(new DOMException('This operation was aborted', 'AbortError'))
          return
        }
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('This operation was aborted', 'AbortError')),
          { once: true }
        )
      })
    }) as typeof fetch

    try {
      const gateway = new ModelGateway({
        config: {
          provider: 'openrouter',
          endpoint: 'https://example.invalid/v1',
          model: 'test-model',
          credentialKey: null,
          dailyBudgetCoins: 25
        },
        getApiKey: () => 'sk-or-v1-test',
        onUsage: () => undefined,
        // The production default is 120s, which is right for a reasoning model
        // and far too long to assert on. Injecting it is what makes this bound
        // testable at all.
        attemptTimeoutMs: 60
      })

      // A caller-supplied signal is what the agent loop always passes, and its
      // presence used to be the reason there was no deadline at all.
      const controller = new AbortController()
      const result = await gateway.complete({
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal
      })

      expect(sawSignal).toBe(true)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/returned 504|No answer within/i)
    } finally {
      globalThis.fetch = original
    }
  }, 15_000)

  it('cancels in-flight when the caller stops the task, without waiting out the deadline', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }) as typeof fetch

    try {
      const gateway = new ModelGateway({
        config: {
          provider: 'openrouter',
          endpoint: 'https://example.invalid/v1',
          model: 'test-model',
          credentialKey: null,
          dailyBudgetCoins: 25
        },
        getApiKey: () => 'sk-or-v1-test',
        onUsage: () => undefined,
        attemptTimeoutMs: 60_000
      })

      const controller = new AbortController()
      const pending = gateway.complete({
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal
      })
      setTimeout(() => controller.abort(), 30)

      const started = Date.now()
      const result = await pending
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(result.ok).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  }, 15_000)
})

// ---------------------------------------------------------------------------
// The verify stage must actually verify
// ---------------------------------------------------------------------------

function project(scripts: Record<string, string>): never {
  return {
    root: 'C:/proj',
    name: 'proj',
    kind: 'node',
    manifests: [],
    requiredTools: [],
    packageManager: 'npm',
    scripts,
    devServerPort: null,
    isGitRepo: true,
    detectedAt: '2026-01-01T00:00:00.000Z'
  } as never
}

function verifyRun(scripts: Record<string, string>, exitFor: (cmd: string) => number) {
  const ran: string[] = []
  const pipeline = buildPipeline({
    tools: { call: async () => ({ ok: true, summary: 'unused' }), hasTool: () => false },
    getProject: () => project(scripts),
    probeRuntime: async () => ({ state: 'present', version: '1', detail: '' })
  })
  const verify = pipeline.find((s) => s.name === 'verify')!

  const notes: string[] = []
  return verify
    .run({
      task: { id: 't', prompt: 'p', changedPaths: [], title: 't' } as never,
      signal: new AbortController().signal,
      maxTier: 'ask',
      note: (m: string) => notes.push(m),
      call: async (id: string, args: Record<string, unknown>) => {
        ran.push(`${id} ${JSON.stringify(args.args ?? [])}`)
        const code = exitFor(JSON.stringify(args.args ?? []))
        return { ok: true, summary: `exit ${code}`, data: { exitCode: code, stdout: code === 0 ? '' : 'boom' } }
      },
      // No browser in this fake. Saying so honestly is what the verify stage
      // needs in order to report NOT RUN rather than invent a pass.
      hasTool: () => false,
      workspaceRoots: [],
      skillContext: '',
      selectedSkills: []
    })
    .then((outcome) => ({ outcome, ran, notes }))
}

describe('verification runs real checks', () => {
  it('runs the project\'s declared scripts and reports them as passed', async () => {
    const { outcome, ran } = await verifyRun({ typecheck: 'tsc', test: 'vitest run' }, () => 0)

    expect(ran.some((r) => r.includes('typecheck'))).toBe(true)
    expect(ran.some((r) => r.includes('test'))).toBe(true)
    expect(outcome.continue).toBe(true)
    expect(outcome.summary).toContain('typecheck: passed')
    expect(outcome.summary).toContain('test: passed')
  })

  it('fails the task when a check actually fails, rather than reporting success', async () => {
    const { outcome } = await verifyRun({ test: 'vitest run' }, (args) =>
      args.includes('test') ? 1 : 0
    )

    expect(outcome.continue).toBe(false)
    expect(outcome.status).toBe('FAILED')
    expect(outcome.summary).toContain('test: FAILED')
  })

  it('reports a check the project does not declare as skipped, not passed', async () => {
    const { outcome } = await verifyRun({ test: 'vitest run' }, () => 0)

    expect(outcome.summary).toContain('lint: SKIPPED')
    expect(outcome.summary).toContain('build: SKIPPED')
    // The crucial part: skipped is never quietly counted as a pass.
    expect(outcome.summary).not.toContain('lint: passed')
  })

  it('reports browser verification as not run — there are no browser tools', async () => {
    const { outcome } = await verifyRun({ test: 'x' }, () => 0)

    expect(outcome.summary).toMatch(/browser: NOT RUN/)
    expect(outcome.summary).not.toMatch(/browser: passed/)
  })

  it('refuses to claim success when there is no project at all', async () => {
    const pipeline = buildPipeline({
      tools: { call: async () => ({ ok: true, summary: 'unused' }), hasTool: () => false },
      getProject: () => null,
      probeRuntime: async () => ({ state: 'present', version: '1', detail: '' })
    })
    const outcome = await pipeline
      .find((s) => s.name === 'verify')!
      .run({
        task: { id: 't', prompt: 'p' } as never,
        signal: new AbortController().signal,
        maxTier: 'ask',
        note: () => undefined,
        call: async () => ({ ok: true, summary: '' }),
        hasTool: () => false,
        workspaceRoots: [],
        skillContext: '',
        selectedSkills: []
      })

    expect(outcome.continue).toBe(false)
    expect(outcome.status).toBe('FAILED')
  })
})
