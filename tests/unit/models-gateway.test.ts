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
  APINEX_CREDENTIAL,
  APINEX_ENDPOINT,
  PROVIDER_CREDENTIAL_SLOTS,
  REJECTED_OPENROUTER_MODELS,
  estimateCostUsd,
  findModel,
  toCoins,
  type ModelConfig
} from '../../src/main/services/models/gateway'
import { parseEnv, readEnvFile } from '../../src/main/services/models/dotenv'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

describe('rejected OpenRouter models', () => {
  const shipped = new Set(MODEL_CATALOG.map((m) => m.providerModelId ?? m.id))

  it('keeps every rejected id out of the catalogue', () => {
    // A catalogue entry that 400s on first use is worse than no entry, so the
    // ids measured on 2026-10-05 must never quietly reappear in the picker.
    const leaked = REJECTED_OPENROUTER_MODELS.filter((m) => shipped.has(m.id)).map((m) => m.id)
    expect(leaked).toEqual([])
  })

  it('records a reason for every rejection', () => {
    // A rejection with no stated reason is indistinguishable from an oversight.
    expect(REJECTED_OPENROUTER_MODELS.length).toBeGreaterThan(0)
    for (const model of REJECTED_OPENROUTER_MODELS) {
      expect(model.reason.trim().length).toBeGreaterThan(10)
    }
  })

  it('ships Laguna XS, which a 32-token sample wrongly called broken', () => {
    // `poolside/laguna-xs-2.1:free` is a reasoning model: at 32 tokens it returns
    // `content: ""`. At the app's default 2048 it answered 3/3. It was rejected
    // upstream in error and is now shipped.
    expect(shipped.has('poolside/laguna-xs-2.1:free')).toBe(true)
    expect(REJECTED_OPENROUTER_MODELS.map((m) => m.id)).not.toContain('poolside/laguna-xs-2.1:free')
  })

  it('does not ship the TTS model, because chat/completions refuses it', () => {
    // `fish-audio/s2.1-pro-free:free` works — POST /api/v1/audio/speech returned
    // 208,896 bytes of audio/pcm — but a chat row calling it gets HTTP 400.
    const entry = REJECTED_OPENROUTER_MODELS.find((m) => m.id === 'fish-audio/s2.1-pro-free:free')
    expect(entry).toBeDefined()
    expect(shipped.has('fish-audio/s2.1-pro-free:free')).toBe(false)
  })
})

describe('APINEX catalogue', () => {
  const apinex = MODEL_CATALOG.filter((m) => m.servedBy === 'apinex')

  it('ships exactly the five models that answer on a plain API key', () => {
    // Eleven other `free/`-prefixed ids on this provider answer HTTP 402
    // "subscription only" with the same key, so they are deliberately absent.
    expect(apinex.map((m) => m.providerModelId).sort()).toEqual([
      'free/deepseek-v4-pro-0813',
      'free/deepseek-v4.1-flash',
      'free/glm-5.3-flash',
      'free/gpt-6-luna',
      'free/mimo-v2.6-pro'
    ])
  })

  it('never ships an id the provider does not serve', () => {
    // Both of these appear in APINEX's own material. The Quick start snippet
    // uses the first and a truncated model card suggests the second; both 404.
    const wireIds = new Set(apinex.map((m) => m.providerModelId))
    expect(wireIds.has('free/gpt-5.6-luna')).toBe(false)
    expect(wireIds.has('free/deepseek-v4-pro')).toBe(false)
  })

  it('declares a context window only where the provider reports one', () => {
    // GET /v1/models returns no context_length for these. The cards claim 1M,
    // but an unverifiable number presented as fact is worse than null.
    for (const model of apinex) {
      expect(model.contextWindow).toBeNull()
    }
  })

  it('prices the verified-free models at zero with provenance', () => {
    for (const model of apinex) {
      expect(model.inputPerMillion).toBe(0)
      expect(model.outputPerMillion).toBe(0)
      expect(model.pricingSource).toBeTruthy()
      expect(model.pricingFetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('provider resolution', () => {
  it('points an APINEX model at the APINEX endpoint and credential slot', () => {
    const { gateway: g } = gateway()
    const resolved = g.resolveModel('apinex-gpt-6-luna')
    expect(resolved?.provider).toBe('apinex')
    expect(resolved?.endpoint).toBe(APINEX_ENDPOINT)
    expect(resolved?.model).toBe('free/gpt-6-luna')
    expect(resolved?.credentialKey).toBe(APINEX_CREDENTIAL)
  })

  it('keeps each provider on its own credential slot', () => {
    // Moving providers must move the key with it, or one provider's key would
    // be sent to another provider's endpoint.
    expect(PROVIDER_CREDENTIAL_SLOTS.openrouter).toBe(OPENROUTER_CREDENTIAL)
    expect(PROVIDER_CREDENTIAL_SLOTS.apinex).toBe(APINEX_CREDENTIAL)
    expect(PROVIDER_CREDENTIAL_SLOTS.ollama).toBeUndefined()
    expect(PROVIDER_CREDENTIAL_SLOTS['openai-compatible']).toBeUndefined()
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
    expect(r.error).toMatch(/no coins left/i)
  })

  it('still allows a BYOK call at a zero ceiling — the ceiling is not the user\'s money', async () => {
    const { gateway: g } = gateway({ dailyBudgetCoins: 0 }, 'sk-or-v1-test')
    // Not exercised against the network: the point is that checkBudget passes,
    // so the request is allowed to leave and only then fail on the endpoint.
    const r = await g.complete({ messages: [{ role: 'user', content: 'hi' }], signal: AbortSignal.timeout(1) })
    expect(r.error ?? '').not.toMatch(/no coins left/i)
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
/**
 * Key-file discovery.
 *
 * `readEnvFile` decides where a packaged app looks for the provider key, and
 * had no test at all until the staged `cryptoric-keys.env` name was added — the
 * filename had to change because electron-builder's `out` glob does not match
 * dotfiles, so the original `.env` could be silently dropped from a package.
 */
describe('readEnvFile', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'cryptoric-env-'))
  const write = (d: string, name: string, body: string): void =>
    writeFileSync(join(d, name), body, 'utf8')

  it('reads a developer .env', () => {
    const d = dir()
    write(d, '.env', 'OPENROUTER_API_KEY=sk-or-v1-dev\n')
    expect(readEnvFile([d]).OPENROUTER_API_KEY).toBe('sk-or-v1-dev')
  })

  it('reads the staged file a packaged build ships', () => {
    const d = dir()
    write(d, 'cryptoric-keys.env', 'OPENROUTER_API_KEY=sk-or-v1-staged\nAPINEX_API_KEY=ap-staged\n')
    const out = readEnvFile([d])
    expect(out.OPENROUTER_API_KEY).toBe('sk-or-v1-staged')
    expect(out.APINEX_API_KEY).toBe('ap-staged')
  })

  it('prefers a real .env over the staged copy', () => {
    // The developer's own file is the more specific intent, so it must win in
    // the same directory rather than being silently shadowed.
    const d = dir()
    write(d, '.env', 'OPENROUTER_API_KEY=sk-or-v1-dev\n')
    write(d, 'cryptoric-keys.env', 'OPENROUTER_API_KEY=sk-or-v1-staged\n')
    expect(readEnvFile([d]).OPENROUTER_API_KEY).toBe('sk-or-v1-dev')
  })

  it('returns nothing rather than throwing when no file exists', () => {
    const missing = join(dir(), 'does-not-exist')
    expect(readEnvFile([missing, ''])).toEqual({})
  })
})
