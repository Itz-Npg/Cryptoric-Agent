/**
 * Custom providers the user adds themselves.
 *
 * The rules here all exist because of a way this silently goes wrong: a key that
 * lands in the settings file, two providers sharing one credential slot, a
 * provider that saves but offers nothing to select, or a "secret" that was
 * actually pasted into the URL and ends up in every log file afterwards.
 */

import { describe, expect, it } from 'vitest'

import {
  credentialSlotFor,
  customModelConfigs,
  isLocalEndpoint,
  normaliseCustomProvider,
  providerSlug,
  removeCustomProvider,
  upsertCustomProvider,
  urlLeaksSecret
} from '../../src/main/services/models/custom-providers'
import { SettingsSchema } from '../../src/main/services/settings/schema'
import { PROVIDER_PRESETS, findPreset, searchPresets } from '../../src/shared/provider-presets'

const valid = {
  label: 'My provider',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-1234567890',
  models: ['model-a', 'model-b']
}

describe('normaliseCustomProvider', () => {
  it('accepts a complete provider', () => {
    const result = normaliseCustomProvider(valid)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.provider.label).toBe('My provider')
    expect(result.provider.baseUrl).toBe('https://api.example.com/v1')
    expect(result.provider.models).toEqual(['model-a', 'model-b'])
    expect(result.provider.byok).toBe(true)
  })

  it('keeps the key out of the provider record', () => {
    const result = normaliseCustomProvider(valid)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The settings file must never contain the secret. Only a slot reference.
    expect(JSON.stringify(result.provider)).not.toContain('sk-test-1234567890')
    expect(result.provider.credentialKey).toBe(credentialSlotFor(result.provider.id))
    // It comes back separately, for the caller to write to the credential store.
    expect(result.apiKey).toBe('sk-test-1234567890')
  })

  it('gives each provider its own credential slot', () => {
    const a = normaliseCustomProvider({ ...valid, label: 'One' })
    const b = normaliseCustomProvider({ ...valid, label: 'Two' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    // A shared slot would mean removing one provider deletes the other's key.
    expect(a.provider.credentialKey).not.toBe(b.provider.credentialKey)
  })

  it('rejects a provider with no name, URL or models', () => {
    expect(normaliseCustomProvider({ ...valid, label: '  ' }).ok).toBe(false)
    expect(normaliseCustomProvider({ ...valid, baseUrl: '' }).ok).toBe(false)
    // A provider that saves but offers nothing to select is worse than an error.
    expect(normaliseCustomProvider({ ...valid, models: [] }).ok).toBe(false)
    expect(normaliseCustomProvider({ ...valid, models: ['  ', ''] }).ok).toBe(false)
  })

  it('rejects a malformed or unsupported URL', () => {
    expect(normaliseCustomProvider({ ...valid, baseUrl: 'not a url' }).ok).toBe(false)
    expect(normaliseCustomProvider({ ...valid, baseUrl: 'ftp://example.com' }).ok).toBe(false)
  })

  it('strips a trailing slash so endpoints do not double up', () => {
    const result = normaliseCustomProvider({ ...valid, baseUrl: 'https://api.example.com/v1/' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider.baseUrl).toBe('https://api.example.com/v1')
  })

  it('does not require a key from a local server', () => {
    // Ollama and LM Studio are the most common local setup; demanding a key
    // there would make them impossible to add.
    const result = normaliseCustomProvider({
      label: 'Local',
      baseUrl: 'http://localhost:11434/v1',
      models: ['llama3']
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.provider.credentialKey).toBeNull()
      expect(result.apiKey).toBeNull()
    }
  })

  it('does not require a key when none was supplied at all', () => {
    // Editing an existing provider must not demand re-typing its key.
    const result = normaliseCustomProvider({
      id: 'existing',
      label: 'Mine',
      baseUrl: 'https://api.example.com/v1',
      models: ['m']
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.apiKey).toBeNull()
  })

  it('requires a key when one is supplied as blank for a remote host', () => {
    const result = normaliseCustomProvider({ ...valid, apiKey: '   ' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('needs an API key')
  })

  it('trims, dedupes and drops blank model ids', () => {
    const result = normaliseCustomProvider({
      ...valid,
      models: [' a ', 'a', '', '  ', 'b']
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider.models).toEqual(['a', 'b'])
  })

  it('derives a stable id from the label and honours an explicit one', () => {
    const first = normaliseCustomProvider({ ...valid, label: 'My Provider!' })
    const again = normaliseCustomProvider({ ...valid, label: 'My Provider!' })
    expect(first.ok && again.ok).toBe(true)
    if (first.ok && again.ok) expect(first.provider.id).toBe(again.provider.id)

    const explicit = normaliseCustomProvider({ ...valid, id: 'fixed-id' })
    expect(explicit.ok).toBe(true)
    if (explicit.ok) expect(explicit.provider.id).toBe('fixed-id')
  })

  it('never lets an id contain path separators', () => {
    // The id becomes part of a credential slot name; a separator would let a
    // crafted label address another provider's credential.
    const result = normaliseCustomProvider({ ...valid, label: '../../etc/passwd' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.provider.id).not.toContain('/')
      expect(result.provider.id).not.toContain('..')
    }
    expect(providerSlug('../../etc/passwd')).not.toContain('/')
  })
})

describe('urlLeaksSecret', () => {
  it('spots a key pasted into a URL', () => {
    expect(urlLeaksSecret('https://api.example.com/v1?api_key=sk-abc')).toBe(true)
    expect(urlLeaksSecret('https://user:pass@api.example.com/v1')).toBe(true)
    expect(urlLeaksSecret('https://api.example.com/v1?token=abc')).toBe(true)
  })

  it('leaves an ordinary base URL alone', () => {
    expect(urlLeaksSecret('https://api.example.com/v1')).toBe(false)
    expect(urlLeaksSecret('http://localhost:11434/v1')).toBe(false)
  })
})

describe('isLocalEndpoint', () => {
  it('recognises loopback in its common spellings', () => {
    expect(isLocalEndpoint('http://localhost:11434/v1')).toBe(true)
    expect(isLocalEndpoint('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isLocalEndpoint('http://[::1]:1234/v1')).toBe(true)
  })

  it('does not treat a remote host as local', () => {
    expect(isLocalEndpoint('https://api.example.com/v1')).toBe(false)
    // A hostname that merely contains "localhost" is not loopback.
    expect(isLocalEndpoint('https://localhost.evil.test/v1')).toBe(false)
  })
})

describe('upsert and remove', () => {
  const one = normaliseCustomProvider({ ...valid, label: 'One' })
  const two = normaliseCustomProvider({ ...valid, label: 'Two' })
  if (!one.ok || !two.ok) throw new Error('fixtures must be valid')

  it('adds without duplicating', () => {
    const first = upsertCustomProvider([], one.provider)
    const second = upsertCustomProvider(first, two.provider)
    expect(second).toHaveLength(2)
  })

  it('replaces rather than appends when saving the same provider again', () => {
    const list = upsertCustomProvider([], one.provider)
    const edited = { ...one.provider, label: 'One renamed' }
    const updated = upsertCustomProvider(list, edited)
    expect(updated).toHaveLength(1)
    expect(updated[0]?.label).toBe('One renamed')
  })

  it('removes by id and reports what went', () => {
    const list = upsertCustomProvider(upsertCustomProvider([], one.provider), two.provider)
    const result = removeCustomProvider(list, two.provider.id)
    expect(result.providers).toHaveLength(1)
    expect(result.removed?.label).toBe('Two')
  })

  it('reports null when removing something that is not there', () => {
    const result = removeCustomProvider([one.provider], 'missing')
    expect(result.removed).toBeNull()
  })
})

describe('customModelConfigs', () => {
  const provider = normaliseCustomProvider(valid)
  if (!provider.ok) throw new Error('fixture must be valid')

  it('produces one config per model, pointed at the provider', () => {
    const configs = customModelConfigs([provider.provider])
    expect(configs).toHaveLength(2)
    for (const config of configs) {
      expect(config.endpoint).toBe('https://api.example.com/v1')
      expect(config.provider).toBe('openai-compatible')
      expect(config.credentialKey).toBe(provider.provider.credentialKey)
    }
  })

  it('never carries the key itself', () => {
    expect(JSON.stringify(customModelConfigs([provider.provider]))).not.toContain('sk-test-1234567890')
  })

  it('uses the ollama wire kind for a local endpoint', () => {
    const local = normaliseCustomProvider({
      label: 'Local',
      baseUrl: 'http://localhost:11434/v1',
      models: ['llama3']
    })
    if (!local.ok) throw new Error('fixture must be valid')
    expect(customModelConfigs([local.provider])[0]?.provider).toBe('ollama')
  })

  it('skips a disabled provider', () => {
    const disabled = { ...provider.provider, enabled: false }
    expect(customModelConfigs([disabled])).toEqual([])
  })
})

describe('a key cannot reach the settings file by any route', () => {
  it('is stripped even if smuggled in through the generic settings route', () => {
    // The custom-provider route never passes a key to `settings.update`, but
    // `settings:update` accepts an arbitrary patch from the renderer. If the
    // schema kept unknown keys, a renderer could persist a secret straight
    // into a world-readable settings file and the isolation would be a
    // convention rather than a guarantee.
    const parsed = SettingsSchema.parse({
      providers: [
        {
          id: 'mine',
          label: 'Mine',
          kind: 'custom',
          baseUrl: 'https://api.example.com/v1',
          credentialKey: 'custom-provider-mine',
          models: ['m'],
          byok: true,
          enabled: true,
          apiKey: 'sk-should-never-persist'
        }
      ]
    })

    expect(JSON.stringify(parsed)).not.toContain('sk-should-never-persist')
    expect((parsed.providers[0] as Record<string, unknown>).apiKey).toBeUndefined()
  })
})

describe('provider presets', () => {
  it('offers a Custom entry so a hand-typed URL is never blocked', () => {
    // Presets are a shortcut, not a whitelist: someone pointing this at their
    // own gateway must still be able to.
    expect(findPreset('custom')).not.toBeNull()
    expect(findPreset('custom')?.baseUrl).toBe('')
  })

  it('gives local presets no key requirement', () => {
    expect(findPreset('ollama')?.needsKey).toBe(false)
    expect(findPreset('lmstudio')?.needsKey).toBe(false)
    expect(findPreset('openrouter')?.needsKey).toBe(true)
  })

  it('every preset ships a model hint that is a real id', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === 'custom') continue
      // An empty model field is the thing people get wrong most often, so a
      // preset that cannot prefill one is not worth shipping.
      expect(preset.modelHint.length).toBeGreaterThan(0)
    }
  })

  it('lists every preset when the search box is empty', () => {
    expect(searchPresets('')).toHaveLength(PROVIDER_PRESETS.length)
    expect(searchPresets('   ')).toHaveLength(PROVIDER_PRESETS.length)
  })

  it('ranks prefix matches above substring matches', () => {
    const results = searchPresets('o')
    const openRouter = results.findIndex((p) => p.id === 'openrouter')
    expect(openRouter).toBeGreaterThanOrEqual(0)
    // Anything merely containing "o" must come after the prefix matches.
    for (let i = 0; i < openRouter; i += 1) {
      expect(results[i]?.label.toLowerCase().startsWith('o') || results[i]?.id.startsWith('o')).toBe(true)
    }
  })

  it('matches case-insensitively', () => {
    expect(searchPresets('OPEN').map((p) => p.id)).toContain('openrouter')
    expect(searchPresets('mistral').map((p) => p.id)).toContain('mistral')
  })

  it('returns nothing for a query that matches nothing', () => {
    expect(searchPresets('zzzzz')).toEqual([])
  })

  it('uses http for local presets and https for remote ones', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.baseUrl.length === 0) continue
      const url = new URL(preset.baseUrl)
      const local = ['localhost', '127.0.0.1'].includes(url.hostname)
      // A remote preset over plain http would send the key in the clear, which
      // is the single thing this whole feature must not do.
      expect(url.protocol).toBe(local ? 'http:' : 'https:')
    }
  })
})
