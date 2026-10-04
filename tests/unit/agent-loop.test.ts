/**
 * The agent loop, the conversation store, and the gateway's tool-call plumbing.
 *
 * The failure this suite exists to prevent is the one the product actually hit:
 * a prompt goes in, five stage names come out, and nothing happens. So the
 * assertions are about *what actually ran* — which tools were invoked, with what
 * arguments, and whether the model was told the truth about the result.
 *
 * No network. The live round-trip is `tests/live/model-check.ts`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDescriptor } from '../../src/shared/types'
import type { ConversationTurn } from '../../src/shared/types'
import type { CompletionResult, ToolSpec } from '../../src/main/services/models/gateway'
import type { ToolResult } from '../../src/main/services/tools/registry'
import { buildToolSpecs, runAgentLoop, type LoopDeps } from '../../src/main/services/agent/loop'
import { ConversationStore, deriveTitle } from '../../src/main/services/agent/conversation'
import { ModelGateway, OPENROUTER_CREDENTIAL, OPENROUTER_ENDPOINT } from '../../src/main/services/models/gateway'

const temps: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cryptoric-conv-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

// ---------------------------------------------------------------- descriptors

function descriptor(id: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id,
    label: id,
    description: `${id} does a thing`,
    dependsOn: [],
    tier: 'safe',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    ...overrides
  }
}

function completion(
  overrides: Partial<CompletionResult> & { text?: string } = {}
): CompletionResult {
  const text = overrides.text ?? ''
  return {
    ok: true,
    text,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 },
    model: 'test-model',
    error: null,
    toolCalls: [],
    assistantMessage: text ? { role: 'assistant', content: text } : null,
    ...overrides
  }
}

// ------------------------------------------------------------------- the loop

describe('tool specs offered to the model', () => {
  it('advertises the tool id as the function name, with its real schema', () => {
    const specs = buildToolSpecs([descriptor('write_file'), descriptor('run_command')])
    expect(specs.map((s) => s.function.name)).toEqual(['write_file', 'run_command'])
    expect(specs[0]?.type).toBe('function')
    expect(specs[0]?.function.parameters).toMatchObject({ type: 'object' })
    // The description is the only thing the model has to choose with, so a
    // truncated one would silently degrade every decision it makes.
    expect(specs[0]?.function.description).toBe('write_file does a thing')
  })

  it('never sends an empty parameters object, which providers reject', () => {
    const specs = buildToolSpecs([descriptor('mystery', { inputSchema: {} })])
    expect(specs[0]?.function.parameters).toMatchObject({ type: 'object' })
  })
})

describe('agent loop', () => {
  function harness(replies: CompletionResult[], invoked: ToolResult[] = []) {
    const calls: { id: string; args: Record<string, unknown> }[] = []
    const recorded: ConversationTurn[] = []
    const notes: string[] = []
    let turn = 0

    const deps: LoopDeps = {
      complete: async () => replies[Math.min(turn++, replies.length - 1)] as CompletionResult,
      listTools: () => [descriptor('write_file'), descriptor('list_directory')],
      invoke: async (id, args) => {
        calls.push({ id, args })
        return invoked.shift() ?? { ok: true, summary: `${id} ok`, data: { path: 'index.html' } }
      },
      note: (message) => notes.push(message),
      record: (role, text, tool, ok) => {
        recorded.push({ id: `t${recorded.length}`, at: '', role, text, tool, ok })
      }
    }
    return { deps, calls, recorded, notes }
  }

  it('runs the tool the model asked for, then returns the prose it wrote after', async () => {
    const { deps, calls, recorded } = harness([
      completion({
        toolCalls: [{ id: 'call_1', name: 'write_file', arguments: { path: 'index.html' }, malformed: false }],
        assistantMessage: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html"}' } }] }
      }),
      completion({ text: 'Created index.html.' })
    ])

    const outcome = await runAgentLoop(deps, {
      systemPrompt: 'sys',
      history: [],
      prompt: 'make me a website',
      signal: new AbortController().signal
    })

    expect(outcome.ok).toBe(true)
    expect(calls).toEqual([{ id: 'write_file', args: { path: 'index.html' } }])
    expect(outcome.called).toEqual(['write_file'])
    expect(outcome.text).toBe('Created index.html.')
    // The tool ran first and the reply came after it, so that is the order the
    // history records — an empty assistant turn is not persisted.
    expect(recorded.map((r) => r.role)).toEqual(['tool', 'assistant'])
    expect(recorded.find((r) => r.role === 'tool')?.tool).toBe('write_file')
  })

  it('tells the model a tool failed instead of reporting success', async () => {
    const seen: string[] = []
    const deps: LoopDeps = {
      complete: async (request) => {
        // Capture what the next turn is told about the previous tool result.
        seen.push(JSON.stringify(request.messages))
        if (seen.length === 1) {
          return completion({
            toolCalls: [{ id: 'c1', name: 'run_command', arguments: { command: 'npm' }, malformed: false }],
            assistantMessage: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"command":"npm"}' } }] }
          })
        }
        return completion({ text: 'That failed.' })
      },
      listTools: () => [descriptor('run_command')],
      invoke: async () => ({ ok: false, summary: 'npm exited 1', error: 'ENOENT: no such file' }),
      note: () => undefined,
      record: () => undefined
    }

    const outcome = await runAgentLoop(deps, {
      systemPrompt: 'sys',
      history: [],
      prompt: 'install',
      signal: new AbortController().signal
    })

    expect(seen[1]).toContain('FAILED')
    expect(seen[1]).toContain('ENOENT')
    expect(seen[1]).toContain('tool_call_id')
    expect(outcome.ok).toBe(true)
  })

  it('answers a malformed tool call rather than leaving it unanswered', async () => {
    const second: string[] = []
    const deps: LoopDeps = {
      complete: async (request) => {
        second.push(JSON.stringify(request.messages))
        if (second.length === 1) {
          return completion({
            toolCalls: [{ id: 'c1', name: 'write_file', arguments: {}, malformed: true }],
            assistantMessage: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{path: index.html' } }] }
          })
        }
        return completion({ text: 'Retrying with valid JSON.' })
      },
      listTools: () => [descriptor('write_file')],
      invoke: async () => {
        throw new Error('a malformed call must never reach the tool')
      },
      note: () => undefined,
      record: () => undefined
    }

    const outcome = await runAgentLoop(deps, {
      systemPrompt: 'sys',
      history: [],
      prompt: 'write it',
      signal: new AbortController().signal
    })

    expect(second[1]).toContain('not a JSON object')
    expect(second[1]).toContain('c1')
    expect(outcome.text).toBe('Retrying with valid JSON.')
  })

  it('echoes the assistant turn back so the tool messages are not orphaned', async () => {
    let captured: { role: string; tool_call_id?: string }[] = []
    const deps: LoopDeps = {
      complete: async (request, ) => {
        captured = request.messages as { role: string; tool_call_id?: string }[]
        if (captured.length <= 2) {
          return completion({
            toolCalls: [{ id: 'c9', name: 'list_directory', arguments: {}, malformed: false }],
            assistantMessage: { role: 'assistant', content: '', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'list_directory', arguments: '{}' } }] }
          })
        }
        return completion({ text: 'Listed.' })
      },
      listTools: () => [descriptor('list_directory')],
      invoke: async () => ({ ok: true, summary: 'ok', data: {} }),
      note: () => undefined,
      record: () => undefined
    }

    await runAgentLoop(deps, {
      systemPrompt: 'sys',
      history: [],
      prompt: 'look',
      signal: new AbortController().signal
    })

    const toolMessage = captured.find((m) => m.role === 'tool')
    expect(toolMessage?.tool_call_id).toBe('c9')
  })

  it('stops at the step ceiling and says so instead of spinning', async () => {
    let turns = 0
    const deps: LoopDeps = {
      complete: async () => {
        turns += 1
        return completion({
          toolCalls: [{ id: `c${turns}`, name: 'list_directory', arguments: {}, malformed: false }],
          assistantMessage: { role: 'assistant', content: '', tool_calls: [{ id: `c${turns}`, type: 'function', function: { name: 'list_directory', arguments: '{}' } }] }
        })
      },
      listTools: () => [descriptor('list_directory')],
      invoke: async () => ({ ok: true, summary: 'ok' }),
      note: () => undefined,
      record: () => undefined
    }

    const outcome = await runAgentLoop(deps, {
      systemPrompt: 'sys',
      history: [],
      prompt: 'loop forever',
      signal: new AbortController().signal,
      maxSteps: 3
    })

    expect(turns).toBe(3)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/3 steps/)
  })

  it('reports a provider failure rather than retrying it', async () => {
    let turns = 0
    const deps: LoopDeps = {
      complete: async () => {
        turns += 1
        return completion({ ok: false, text: '', error: 'Model endpoint returned 401. nope' })
      },
      listTools: () => [descriptor('write_file')],
      invoke: async () => ({ ok: true, summary: 'ok' }),
      note: () => undefined,
      record: () => undefined
    }

    const outcome = await runAgentLoop(deps, {
      systemPrompt: 'sys',
      history: [],
      prompt: 'hi',
      signal: new AbortController().signal,
      maxSteps: 5
    })

    expect(turns).toBe(1)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('401')
  })

  it('stops without calling the model when the task was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    let turns = 0
    const deps: LoopDeps = {
      complete: async () => {
        turns += 1
        return completion({ text: 'should not happen' })
      },
      listTools: () => [descriptor('write_file')],
      invoke: async () => ({ ok: true, summary: 'ok' }),
      note: () => undefined,
      record: () => undefined
    }

    const outcome = await runAgentLoop(deps, {
      systemPrompt: 'sys',
      history: [],
      prompt: 'hi',
      signal: controller.signal
    })

    expect(turns).toBe(0)
    expect(outcome.ok).toBe(false)
  })

  it('carries prior conversation into the model', async () => {
    // Copied on capture: the loop keeps appending to the same array, so holding
    // the reference would show the *last* turn rather than the first.
    let captured: { role: string; content: string }[] = []
    const deps: LoopDeps = {
      complete: async (request) => {
        captured = [...(request.messages as { role: string; content: string }[])]
        return completion({ text: 'ok' })
      },
      listTools: () => [],
      invoke: async () => ({ ok: true, summary: 'ok' }),
      note: () => undefined,
      record: () => undefined
    }

    await runAgentLoop(deps, {
      systemPrompt: 'sys',
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' }
      ],
      prompt: 'second',
      signal: new AbortController().signal
    })

    expect(captured.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(captured[3]?.content).toBe('second')
  })
})

// --------------------------------------------------------- gateway tool calls

describe('gateway tool-call parsing', () => {
  /** Serve one canned response body and capture what was sent. */
  function serve(body: unknown) {
    const sent: Record<string, unknown>[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')))
      return {
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body)
      }
    }) as typeof fetch

    const gateway = new ModelGateway({
      config: {
        provider: 'openrouter',
        endpoint: OPENROUTER_ENDPOINT,
        model: 'stealth/space-bunny-alpha',
        credentialKey: OPENROUTER_CREDENTIAL,
        dailyBudgetCoins: 25
      },
      getApiKey: () => 'sk-or-v1-test',
      onUsage: () => undefined
    })
    return { gateway, sent, restore: () => { globalThis.fetch = original } }
  }

  it('sends the tool catalogue and tool_choice when tools are supplied', async () => {
    const { gateway, sent, restore } = serve({ choices: [{ message: { content: 'hi' } }] })
    const tools: ToolSpec[] = buildToolSpecs([descriptor('write_file')])
    await gateway.complete({ messages: [{ role: 'user', content: 'go' }], tools })
    restore()

    expect(sent[0]?.['tool_choice']).toBe('auto')
    expect((sent[0]?.['tools'] as unknown[]).length).toBe(1)
  })

  it('omits the tools fields entirely when none are supplied', async () => {
    const { gateway, sent, restore } = serve({ choices: [{ message: { content: 'hi' } }] })
    await gateway.complete({ messages: [{ role: 'user', content: 'go' }] })
    restore()

    // An empty `tools: []` is rejected by several OpenAI-compatible servers.
    expect(sent[0]).not.toHaveProperty('tools')
    expect(sent[0]).not.toHaveProperty('tool_choice')
  })

  it('parses a tool call into arguments', async () => {
    const { gateway, restore } = serve({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'call_abc', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.html","content":"hi"}' } }
            ]
          }
        }
      ]
    })
    const r = await gateway.complete({ messages: [{ role: 'user', content: 'go' }] })
    restore()

    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]).toMatchObject({ id: 'call_abc', name: 'write_file', malformed: false })
    expect(r.toolCalls[0]?.arguments).toEqual({ path: 'a.html', content: 'hi' })
  })

  it('marks unparseable arguments rather than throwing', async () => {
    const { gateway, restore } = serve({
      choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'write_file', arguments: '{path:' } }] } }]
    })
    const r = await gateway.complete({ messages: [{ role: 'user', content: 'go' }] })
    restore()

    expect(r.ok).toBe(true)
    expect(r.toolCalls[0]?.malformed).toBe(true)
    // Still answers with an assistantMessage, so the call can be replied to.
    expect(r.assistantMessage?.tool_calls?.[0]?.id).toBe('c1')
  })

  it('gives a call without an id one, because the reply needs a key', async () => {
    const { gateway, restore } = serve({
      choices: [{ message: { tool_calls: [{ function: { name: 'list_directory', arguments: '{}' } }] } }]
    })
    const r = await gateway.complete({ messages: [{ role: 'user', content: 'go' }] })
    restore()

    expect(r.toolCalls[0]?.id).toBeTruthy()
  })

  it('returns null rather than an empty assistant turn', async () => {
    const { gateway, restore } = serve({ choices: [{ message: { content: '   ' } }] })
    const r = await gateway.complete({ messages: [{ role: 'user', content: 'go' }] })
    restore()

    expect(r.assistantMessage).toBeNull()
  })
})

// ----------------------------------------------------------------- conversation

describe('conversation store', () => {
  it('starts empty when there is no file yet', () => {
    const store = new ConversationStore(join(tempDir(), 'conversation.json'))
    expect(store.all()).toEqual([])
  })

  it('survives a restart', async () => {
    const file = join(tempDir(), 'conversation.json')
    const first = new ConversationStore(file)
    first.appendUser('make me a website')
    first.appendTool('write_file', 'Created index.html', true)
    first.appendAssistant('Done — index.html is there.')
    await first.flush()

    const second = new ConversationStore(file)
    expect(second.all().map((t) => t.role)).toEqual(['user', 'tool', 'assistant'])
    expect(second.all()[0]?.text).toBe('make me a website')
  })

  it('keeps the same conversation id across restarts and changes it on clear', async () => {
    const file = join(tempDir(), 'conversation.json')
    const first = new ConversationStore(file)
    first.appendUser('hi')
    await first.flush()

    const second = new ConversationStore(file)
    expect(second.conversationId).toBe(first.conversationId)
    second.clear()
    await second.flush()
    expect(new ConversationStore(file).conversationId).not.toBe(first.conversationId)
  })

  it('starts empty rather than refusing to boot on a corrupt file', () => {
    const dir = tempDir()
    const file = join(dir, 'conversation.json')
    writeFileSync(file, '{ this is not json', 'utf8')
    const store = new ConversationStore(file)
    expect(store.all()).toEqual([])
    // The damaged file is left alone so it can be inspected.
    expect(readFileSync(file, 'utf8')).toContain('not json')
  })

  it('drops turns that are not shaped like turns', () => {
    const dir = tempDir()
    const file = join(dir, 'conversation.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        id: 'x',
        updatedAt: '',
        turns: [
          { id: 'a', at: 'now', role: 'user', text: 'keep me' },
          { id: 'b', at: 'now', role: 'wizard', text: 'drop me' },
          { nope: true }
        ]
      }),
      'utf8'
    )
    expect(new ConversationStore(file).all().map((t) => t.text)).toEqual(['keep me'])
  })

  it('folds tool outcomes into the assistant turn that reported them', () => {
    const store = new ConversationStore(join(tempDir(), 'conversation.json'))
    store.appendUser('build it')
    store.appendTool('write_file', 'Created index.html (900 chars)', true)
    store.appendAssistant('Created index.html.')

    const messages = store.contextMessages()
    // One assistant message, not two: the tool result belongs to the turn that
    // reported it, and a standalone `tool` role is rejected by some providers.
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1]?.content).toContain('Created index.html.')
    // The tool outcome has to reach the model, or it forgets what it did.
    expect(messages[1]?.content).toContain('[ok] write_file')
  })

  it('reports an interrupted run\u2019s tool results before the next user turn', () => {
    const store = new ConversationStore(join(tempDir(), 'conversation.json'))
    store.appendUser('build it')
    store.appendTool('write_file', 'Created index.html', true)
    store.appendUser('now add a dark mode')

    const messages = store.contextMessages()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]?.content).toContain('[ok] write_file')
  })

  it('marks a failed tool as failed in the model context', () => {
    const store = new ConversationStore(join(tempDir(), 'conversation.json'))
    store.appendTool('run_command', 'npm exited 1', false)
    expect(store.contextMessages()[0]?.content).toContain('[failed] run_command')
  })

  it('does not send an orphan tool role message', () => {
    const store = new ConversationStore(join(tempDir(), 'conversation.json'))
    store.appendUser('go')
    store.appendTool('write_file', 'ok', true)
    store.appendAssistant('done')
    // A `tool` message without a matching `tool_call_id` makes providers reject
    // the whole request, so the context must contain none.
    expect(store.contextMessages().some((m) => (m as { role: string }).role === 'tool')).toBe(false)
  })

  it('bounds the history it keeps on disk', async () => {
    const file = join(tempDir(), 'conversation.json')
    const store = new ConversationStore(file)
    for (let i = 0; i < 1100; i += 1) store.appendUser(`line ${i}`)
    await store.flush()

    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      scopes: Record<string, { turns: unknown[] }>
    }
    const turns = Object.values(parsed.scopes)[0]?.turns ?? []
    expect(turns.length).toBe(1000)
  })

  it('writes atomically, leaving no partial file behind', async () => {
    const dir = tempDir()
    const file = join(dir, 'nested', 'conversation.json')
    const store = new ConversationStore(file)
    store.appendUser('hi')
    await store.flush()

    expect(readFileSync(file, 'utf8')).toContain('"version": 2')
    // The temp file the write goes through must not survive.
    expect(() => readFileSync(`${file}.tmp`, 'utf8')).toThrow()
  })
})

describe('per-project scoping', () => {
  // The transcript used to be one global list, so opening a second project
  // showed the first project's conversation and fed it to the model as if it
  // were about the wrong codebase.
  it('keeps a separate transcript per project', () => {
    const store = new ConversationStore(join(tempDir(), 'conversation.json'))

    store.setProject('C:\\work\\alpha')
    store.appendUser('alpha: add a login page')

    store.setProject('C:\\work\\beta')
    store.appendUser('beta: write a migration')
    expect(store.all().map((t) => t.text)).toEqual(['beta: write a migration'])

    store.setProject('C:\\work\\alpha')
    expect(store.all().map((t) => t.text)).toEqual(['alpha: add a login page'])
  })

  it('gives the model only the current project\u2019s history', () => {
    const store = new ConversationStore(join(tempDir(), 'conversation.json'))
    store.setProject('C:\\work\\alpha')
    store.appendUser('alpha question')
    store.setProject('C:\\work\\beta')
    store.appendUser('beta question')

    store.setProject('C:\\work\\alpha')
    const context = store.contextMessages().map((m) => m.content)
    expect(context).toEqual(['alpha question'])
    expect(context.join(' ')).not.toContain('beta question')
  })

  it('treats the same project at a different case as one scope', () => {
    // Windows paths are case-insensitive; two transcripts for one project would
    // be a bug that only shows up on Windows and only sometimes.
    const store = new ConversationStore(join(tempDir(), 'conversation.json'))
    store.setProject('C:\\Work\\Alpha')
    store.appendUser('hello')
    store.setProject('c:\\work\\alpha')
    expect(store.all()).toHaveLength(1)
  })

  it('keeps "no project" separate from every real project', () => {
    const store = new ConversationStore(join(tempDir(), 'conversation.json'))
    store.setProject('C:\\work\\alpha')
    store.appendUser('alpha')
    store.setProject(null)
    expect(store.all()).toHaveLength(0)
    store.appendUser('no project open')
    store.setProject('C:\\work\\alpha')
    expect(store.all().map((t) => t.text)).toEqual(['alpha'])
  })

  it('clears only the current project', () => {
    const store = new ConversationStore(join(tempDir(), 'conversation.json'))
    store.setProject('C:\\work\\alpha')
    store.appendUser('alpha')
    store.setProject('C:\\work\\beta')
    store.appendUser('beta')

    store.clear()
    expect(store.all()).toHaveLength(0)
    store.setProject('C:\\work\\alpha')
    expect(store.all().map((t) => t.text)).toEqual(['alpha'])
  })

  it('survives a restart with the scopes intact', async () => {
    const file = join(tempDir(), 'conversation.json')
    const first = new ConversationStore(file)
    first.setProject('C:\\work\\alpha')
    first.appendUser('alpha turn')
    first.setProject('C:\\work\\beta')
    first.appendUser('beta turn')
    await first.flush()

    const second = new ConversationStore(file)
    second.setProject('C:\\work\\beta')
    expect(second.all().map((t) => t.text)).toEqual(['beta turn'])
    second.setProject('C:\\work\\alpha')
    expect(second.all().map((t) => t.text)).toEqual(['alpha turn'])
  })

  it('carries a version 1 transcript forward rather than discarding it', async () => {
    const file = join(tempDir(), 'conversation.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        id: 'legacy',
        updatedAt: '',
        turns: [{ id: 'a', at: 'now', role: 'user', text: 'pre-upgrade message' }]
      }),
      'utf8'
    )
    const store = new ConversationStore(file)
    expect(store.all().map((t) => t.text)).toEqual(['pre-upgrade message'])
  })
})

describe('task title derivation', () => {
  it('keeps a plain prompt intact', () => {
    expect(deriveTitle('Add a login page')).toBe('Add a login page')
  })

  it('drops the pasted rule the old slice(0, 60) put in the task list', () => {
    // This is the actual failure: a prompt pasted from a code block started
    // with a run of '=' and it became the task title verbatim.
    const pasted = 'id="qv7k3r" ================================================\n\nBuild a landing page'
    const title = deriveTitle(pasted)
    expect(title).not.toContain('====')
    expect(title).not.toContain('id="qv7k3r"')
    expect(title).toBe('Build a landing page')
  })

  it('drops fenced code, which is structure rather than prose', () => {
    const title = deriveTitle('Fix this:\n```js\nconst a = 1\nconst b = 2\n```\nThe second line is wrong')
    expect(title).not.toContain('const a')
    expect(title).toContain('Fix this')
  })

  it('drops HTML attributes from a pasted snippet', () => {
    expect(deriveTitle('<div class="x">Hello</div> please rename')).toBe('Hello please rename')
  })

  it('cuts at a word boundary and never runs past the limit', () => {
    const long = 'word '.repeat(60)
    const title = deriveTitle(long)
    expect(title.length).toBeLessThanOrEqual(73)
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toMatch(/wor…$/)
  })

  it('falls back to a neutral label when the prompt is all structure', () => {
    expect(deriveTitle('================\n----------------\n####')).toBe('Untitled task')
  })

  it('keeps a prompt that mentions a divider inline', () => {
    // Only a line that is *entirely* a separator is dropped; prose that merely
    // contains "=" must survive.
    expect(deriveTitle('Set x = 1 and y = 2')).toBe('Set x = 1 and y = 2')
  })
})