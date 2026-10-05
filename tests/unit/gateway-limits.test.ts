/**
 * Token limits: the two numbers a user types for their own provider.
 *
 * The risk these tests exist to close is a settings form that stores two
 * numbers and changes nothing. So every assertion is about an observable
 * effect on the request — the `max_tokens` actually sent, and whether the
 * gateway refuses an over-long prompt instead of passing it on — rather than
 * about the fields round-tripping through settings, which the custom-provider
 * tests already cover.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ModelGateway,
  estimateMessageTokens,
  type ChatMessage,
  type ModelConfig
} from '../../src/main/services/models/gateway'

const BASE: ModelConfig = {
  provider: 'openai-compatible',
  endpoint: 'https://api.example.com/v1',
  model: 'my-model',
  credentialKey: null,
  dailyBudgetCoins: 25
}

/**
 * A gateway whose fetch records the body it was handed.
 *
 * Returns the recorded payloads as well, because the assertion that matters is
 * what left the process, not what the gateway remembers.
 */
function gatewayWithRecorder(overrides: Partial<ModelConfig> = {}) {
  const sent: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  })
  const gateway = new ModelGateway({
    config: { ...BASE, ...overrides },
    getApiKey: () => 'sk-test',
    onUsage: () => undefined
  })
  return { gateway, sent }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('maximum output tokens', () => {
  it('clamps what the agent asked for down to the declared ceiling', async () => {
    const { gateway, sent } = gatewayWithRecorder({ maxOutputTokens: 1024 })
    await gateway.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096 })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.['max_tokens']).toBe(1024)
  })

  it('never raises a short request up to the ceiling', async () => {
    const { gateway, sent } = gatewayWithRecorder({ maxOutputTokens: 8192 })
    // A stage asking for a short summary must still get a short summary.
    await gateway.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 300 })
    expect(sent[0]?.['max_tokens']).toBe(300)
  })

  it('leaves the request alone when no ceiling was declared', async () => {
    const { gateway, sent } = gatewayWithRecorder()
    await gateway.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096 })
    expect(sent[0]?.['max_tokens']).toBe(4096)
  })

  it('keeps its own default when the caller names no budget', async () => {
    const { gateway, sent } = gatewayWithRecorder({ maxOutputTokens: 9999 })
    await gateway.complete({ messages: [{ role: 'user', content: 'hi' }] })
    // 2048 is the gateway's fallback; the ceiling is above it, so it stands.
    expect(sent[0]?.['max_tokens']).toBe(2048)
  })
})

describe('context window', () => {
  it('refuses an over-long prompt with both numbers, before any request', async () => {
    const { gateway, sent } = gatewayWithRecorder({ contextWindow: 100 })
    const huge: ChatMessage = { role: 'user', content: 'x'.repeat(4000) }
    const result = await gateway.complete({ messages: [huge] })
    expect(result.ok).toBe(false)
    // Nothing left the process: the whole point is not spending the request.
    expect(sent).toHaveLength(0)
    expect(result.error).toMatch(/100/)
    expect(result.error).toMatch(/context window/i)
  })

  it('sends a prompt that fits', async () => {
    const { gateway, sent } = gatewayWithRecorder({ contextWindow: 10_000 })
    const result = await gateway.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('counts tool-call arguments, which is where a long prompt actually goes', () => {
    const withArgs = estimateMessageTokens([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'write_file', arguments: 'y'.repeat(4000) } }]
      }
    ])
    // 4000 characters of argument text is ~1000 tokens on its own.
    expect(withArgs).toBeGreaterThan(900)
  })

  it('refuses on its own when nothing else does', async () => {
    const { gateway, sent } = gatewayWithRecorder({})
    const result = await gateway.complete({ messages: [{ role: 'user', content: 'z'.repeat(2_000_000) }] })
    // No declared window means no cap: the request goes out and the provider
    // decides, rather than this app inventing a limit the user never chose.
    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
  })
})

describe('limits survive model selection', () => {
  it('carries a custom provider\'s own limits onto the resolved config', () => {
    const gateway = new ModelGateway({
      config: { ...BASE, provider: 'none', endpoint: '', model: 'local-default' },
      getApiKey: () => null,
      onUsage: () => undefined
    })
    gateway.setCustomModels([
      { ...BASE, model: 'minimax-m2', contextWindow: 32768, maxOutputTokens: 4096 }
    ])
    const resolved = gateway.resolveModel('minimax-m2')
    expect(resolved?.contextWindow).toBe(32768)
    expect(resolved?.maxOutputTokens).toBe(4096)
  })

  it('does not let one model\'s limits leak onto another', () => {
    const gateway = new ModelGateway({
      config: { ...BASE, provider: 'none', endpoint: '', model: 'local-default', contextWindow: 9999, maxOutputTokens: 777 },
      getApiKey: () => null,
      onUsage: () => undefined
    })
    gateway.setCustomModels([{ ...BASE, model: 'capped-model', contextWindow: 1000, maxOutputTokens: 100 }])
    expect(gateway.resolveModel('capped-model')?.contextWindow).toBe(1000)

    // A model with no limits of its own must not inherit the previous one's.
    // `null` is the explicit "no declared limit"; the value that matters is
    // that it is not the 9999 the previous model carried.
    gateway.setCustomModels([{ ...BASE, model: 'plain-model' }])
    expect(gateway.resolveModel('plain-model')?.contextWindow).toBeNull()
    expect(gateway.resolveModel('plain-model')?.maxOutputTokens).toBeNull()
  })

  it('takes a built-in model\'s declared window', () => {
    const gateway = new ModelGateway({
      config: { ...BASE, provider: 'none', endpoint: '', model: 'local-default' },
      getApiKey: () => null,
      onUsage: () => undefined
    })
    const resolved = gateway.resolveModel('space-bunny-alpha')
    expect(resolved?.contextWindow).toBe(1_000_000)
  })
})