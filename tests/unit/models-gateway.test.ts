/**
 * Model gateway: catalogue truth, provider wiring, budget arithmetic and the
 * BYOK rule.
 *
 * These are unit tests — no network. The live round-trip against the real
 * provider lives in `tests/live/model-check.ts`; what is asserted here is the
 * logic that decides whether a request is even allowed to leave.
 */

import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '../../src/shared/types'
import {
  MODEL_CATALOG,
  ModelGateway,
  OPENROUTER_CREDENTIAL,
  OPENROUTER_ENDPOINT,
  estimateCostUsd,
  findModel,
  toCoins,
  type ModelConfig
} from '../../src/main/services/models/gateway'
import { parseEnv } from '../../src/main/services/models/dotenv'

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    model: 'stealth/space-bunny-alpha',
    credentialKey: OPENROUTER_CREDENTIAL,
    dailyBudgetCoins: 25,
    ...overrides
  }
}

function gateway(overrides: Partial<ModelConfig> = {}, key: string | null = null) {
  const recorded: { usage: UsageRecord; cost: number }[] = []
  const g = new ModelGateway({
    config: config(overrides),
    getApiKey: () => key,
    onUsage: (usage, cost) => recorded.push({ usage, cost })
  })
  return { gateway: g, recorded }
}

describe('model catalogue', () => {
  it('offers Space Bunny Alpha with the identifier the provider actually accepts', () => {
    const model = MODEL_CATALOG.find((m) => m.id === 'space-bunny-alpha')
    expect(model).toBeDefined()
    expect(model?.providerModelId).toBe('stealth/space-bunny-alpha')
    expect(model?.servedBy).toBe('openrouter')
    expect(model?.endpoint).toBe('https://openrouter.ai/api/v1')
    expect(model?.contextWindow).toBe(1_000_000)
  })

  it('records where each declared price came from', () => {
    const model = MODEL_CATALOG.find((m) => m.id === 'space-bunny-alpha')
    // A price with no provenance is a guess. OpenRouter reports this model at
    // prompt "0" / completion "0"; that is a declared price, so it must say so.
    expect(model?.pricingSource).toContain('openrouter.ai')
    expect(model?.pricingFetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('resolves a model by its UI key and by its wire id', () => {
    expect(findModel('space-bunny-alpha')?.id).toBe('space-bunny-alpha')
    expect(findModel('stealth/space-bunny-alpha')?.id).toBe('space-bunny-alpha')
    expect(findModel('no-such-model')).toBeUndefined()
  })

  it('prices a namespaced id exactly like its UI key', () => {
    const usage: UsageRecord = { inputTokens: 1000, outputTokens: 1000, cachedTokens: 0, estimatedCostUsd: 0 }
    expect(estimateCostUsd('stealth/space-bunny-alpha', usage)).toBe(estimateCostUsd('space-bunny-alpha', usage))
    expect(estimateCostUsd('space-bunny-alpha', usage)).toBe(0)
  })

  it('reports an unknown model as unpriced rather than free', () => {
    const usage: UsageRecord = { inputTokens: 1000, outputTokens: 1000, cachedTokens: 0, estimatedCostUsd: 0 }
    expect(estimateCostUsd('a-model-that-does-not-exist', usage)).toBeNull()
  })
})

describe('provider resolution', () => {
  it('turns a catalogue entry into a working configuration', () => {
    const { gateway: g } = gateway()
    const resolved = g.resolveModel('space-bunny-alpha')
    expect(resolved).not.toBeNull()
    expect(resolved?.provider).toBe('openrouter')
    expect(resolved?.endpoint).toBe('https://openrouter.ai/api/v1')
    expect(resolved?.model).toBe('stealth/space-bunny-alpha')
  })

  it('leaves the configuration alone for a model that names no provider', () => {
    const { gateway: g } = gateway({ endpoint: 'http://127.0.0.1:11434/v1' })
    expect(g.resolveModel('local-default')).toBeNull()
  })

  it('reports the active entry whether the config holds the key or the wire id', () => {
    const { gateway: g } = gateway({ model: 'space-bunny-alpha' })
    const model = MODEL_CATALOG.find((m) => m.id === 'space-bunny-alpha')!
    expect(g.isActive(model)).toBe(true)
    const { gateway: g2 } = gateway({ model: 'stealth/space-bunny-alpha' })
    expect(g2.isActive(model)).toBe(true)
  })
})

describe('budget', () => {
  it('converts one cent of modelled cost to one coin', () => {
    expect(toCoins(1)).toBe(100)
    expect(toCoins(0.01)).toBe(1)
    expect(toCoins(0)).toBe(0)
  })

  it('starts at zero and reports the configured ceiling', () => {
    const { gateway: g } = gateway()
    const b = g.budget()
    expect(b.usedCoins).toBe(0)
    expect(b.budgetCoins).toBe(25)
    expect(b.exceeded).toBe(false)
  })

  it('is metered when no user key is stored', () => {
    const { gateway: g } = gateway({}, null)
    expect(g.usesUserKey()).toBe(false)
    expect(g.budget().metered).toBe(true)
  })

  it('does not draw the allowance when the user pays the provider directly', () => {
    // BYOK: the user already pays OpenRouter on their own card. Charging the
    // daily allowance on top of that is the double-charge this rule prevents.
    const { gateway: g } = gateway({}, 'sk-or-v1-test')
    const b = g.budget()
    expect(g.usesUserKey()).toBe(true)
    expect(b.metered).toBe(false)
    expect(b.usedCoins).toBe(0)
    expect(b.exceeded).toBe(false)
  })

  it('refuses every call when the provider is none', async () => {
    const { gateway: g } = gateway({ provider: 'none' }, null)
    expect(g.isEnabled()).toBe(false)
    const r = await g.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('No model provider')
  })

  it('refuses a metered call once the daily ceiling is reached', async () => {
    const { gateway: g } = gateway({ dailyBudgetCoins: 0 }, null)
    expect(g.budget().exceeded).toBe(true)
    const r = await g.complete({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Daily budget reached')
  })

  it('still allows a BYOK call at a zero ceiling — the ceiling is not the user\'s money', async () => {
    const { gateway: g } = gateway({ dailyBudgetCoins: 0 }, 'sk-or-v1-test')
    // Not exercised against the network: the point is that checkBudget passes,
    // so the request is allowed to leave and only then fail on the endpoint.
    const r = await g.complete({ messages: [{ role: 'user', content: 'hi' }], signal: AbortSignal.timeout(1) })
    expect(r.error ?? '').not.toContain('Daily budget reached')
  })
})

describe('.env reader', () => {
  it('reads plain assignments and skips comments', () => {
    const out = parseEnv('# a comment\nOPENROUTER_API_KEY=sk-or-v1-abc\n\nEMPTY=\n')
    expect(out.OPENROUTER_API_KEY).toBe('sk-or-v1-abc')
    expect(out).not.toHaveProperty('EMPTY')
  })

  it('does not expand a variable reference inside a value', () => {
    // An API key must never be able to interpolate another secret.
    expect(parseEnv('KEY=$OTHER\n')).toEqual({ KEY: '$OTHER' })
  })

  it('strips one matched pair of surrounding quotes', () => {
    expect(parseEnv('KEY="abc"\n').KEY).toBe('abc')
    expect(parseEnv("KEY='abc'\n").KEY).toBe('abc')
    expect(parseEnv('KEY="abc\n').KEY).toBe('"abc')
  })

  it('keeps a value that contains an unbalanced quote verbatim', () => {
    expect(parseEnv('KEY=ab"cd\n').KEY).toBe('ab"cd')
  })

  it('skips a line it cannot parse rather than failing the whole file', () => {
    const out = parseEnv('not an assignment\nGOOD=1\n')
    expect(out).toEqual({ GOOD: '1' })
  })
})