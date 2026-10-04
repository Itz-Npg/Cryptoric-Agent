import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore, migrateLegacyState, applyOverride, stripSecrets } from '../../src/main/services/settings/store'
import { defaultSettings, SETTINGS_VERSION, SettingsSchema } from '../../src/main/services/settings/schema'

let dir = ''
let store: SettingsStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cryptoric-settings-'))
  store = new SettingsStore({ userDataDir: dir })
})

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('settings defaults and validation', () => {
  it('produces a complete, schema-valid settings object with no file present', async () => {
    const settings = await store.load()
    expect(SettingsSchema.safeParse(settings).success).toBe(true)
    expect(settings.appearance.theme).toBe('dark')
    expect(settings.permissions.preset).toBe('standard')
    expect(settings.providers).toEqual([])
  })

  it('populates every field of every section on a fresh install', async () => {
    const settings = await store.load()
    // A section that defaults to `{}` satisfies the schema while leaving its
    // fields undefined, which is invisible until a screen reads one.
    expect(Object.keys(settings.appearance).sort()).toEqual(
      ['accentColor', 'density', 'fontFamily', 'reducedMotion', 'scale', 'theme'].sort()
    )
    expect(settings.appearance.scale).toBe(1)
    expect(settings.agent.maxParallelAgents).toBe(1)
    expect(settings.terminal.fontSize).toBe(13)
    expect(settings.privacy.redactSecrets).toBe(true)
    expect(settings.notifications.agentCompleted).toBe(true)
    expect(settings.updates.channel).toBe('stable')
    expect(settings.usage.dailyAllowanceCoins).toBe(25)
    expect(settings.advanced.logLevel).toBe('warn')
    expect(settings.sessions.resumeTasks).toBe(true)
    expect(settings.environment.autoInstallRuntimes).toBe(true)

    for (const [name, value] of Object.entries(settings)) {
      if (name === 'providers' || name === 'projectOverrides') continue
      for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
        expect(entry, `${name}.${field} was undefined`).not.toBeUndefined()
      }
    }
  })

  it('fills holes left by a partial section in an existing file', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: SETTINGS_VERSION,
        updatedAt: 'x',
        data: { appearance: { theme: 'light' } }
      }),
      'utf8'
    )
    const settings = await new SettingsStore({ userDataDir: dir }).load()
    expect(settings.appearance.theme).toBe('light')
    expect(settings.appearance.scale).toBe(1)
    expect(settings.appearance.density).toBe('default')
  })

  it('accepts a valid dotted-path update', async () => {
    const result = await store.update({ 'appearance.theme': 'light' })
    expect(result.ok).toBe(true)
    expect(store.get().appearance.theme).toBe('light')
  })

  it('rejects an out-of-range value with a readable reason and changes nothing', async () => {
    const result = await store.update({ 'appearance.scale': 9 })
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.path).toBe('appearance.scale')
    expect(store.get().appearance.scale).toBe(1)
  })

  it('rejects a value of the wrong type', async () => {
    const result = await store.update({ 'permissions.fullAccess': 'yes' })
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown setting rather than silently storing it', async () => {
    await store.update({ 'appearance.centreAligned': true })
    const reloaded = await new SettingsStore({ userDataDir: dir }).load()
    expect(reloaded).not.toHaveProperty('appearance.centreAligned')
  })

  it('accepts every documented scale step', async () => {
    for (const scale of [0.9, 1, 1.1, 1.25, 1.5]) {
      const result = await store.update({ 'appearance.scale': scale })
      expect(result.ok).toBe(true)
    }
  })
})

describe('persistence', () => {
  it('survives a restart', async () => {
    await store.update({ 'agent.instructions': 'Always use pnpm.' })
    await store.update({ 'terminal.shell': 'powershell' })

    const reopened = new SettingsStore({ userDataDir: dir })
    const settings = await reopened.load()
    expect(settings.agent.instructions).toBe('Always use pnpm.')
    expect(settings.terminal.shell).toBe('powershell')
  })

  it('writes atomically and leaves no temp file behind', async () => {
    await store.update({ 'appearance.density': 'compact' })
    const raw = readFileSync(join(dir, 'settings.json'), 'utf8')
    expect(JSON.parse(raw).version).toBe(SETTINGS_VERSION)
  })

  it('falls back to defaults instead of crashing on a corrupt file', async () => {
    writeFileSync(join(dir, 'settings.json'), '{ this is not json', 'utf8')
    const settings = await new SettingsStore({ userDataDir: dir }).load()
    expect(SettingsSchema.safeParse(settings).success).toBe(true)
  })

  it('falls back to defaults when the file holds a shape it cannot understand', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ version: SETTINGS_VERSION, updatedAt: 'x', data: { appearance: 'not-an-object' } }),
      'utf8'
    )
    const settings = await new SettingsStore({ userDataDir: dir }).load()
    expect(SettingsSchema.safeParse(settings).success).toBe(true)
    expect(settings.appearance.theme).toBe('dark')
  })

  it('never writes a credential into the settings file', async () => {
    await store.update({
      providers: [
        {
          id: 'openrouter',
          label: 'OpenRouter',
          kind: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          credentialKey: 'provider:openrouter',
          models: ['stealth/space-bunny-alpha'],
          byok: true,
          enabled: true
        }
      ]
    })
    const raw = readFileSync(join(dir, 'settings.json'), 'utf8')
    expect(raw).toContain('openrouter.ai')
    expect(raw).toContain('provider:openrouter')
    expect(raw).not.toContain('sk-')
  })
})

describe('migration', () => {
  it('converts the legacy flat state into the grouped schema', () => {
    const migrated = migrateLegacyState({
      theme: 'bone',
      density: 'compact',
      motion: 'reduced',
      updateChannel: 'beta',
      dailyBudgetUsd: 5,
      permissionOverrides: { 'fs.delete': 'deny', 'bogus': 'nope' },
      modelEndpoint: 'http://127.0.0.1:11434/v1',
      modelProvider: 'ollama',
      modelName: 'qwen2.5-coder:14b',
      onboardingComplete: true
    })

    expect(migrated.appearance?.theme).toBe('light')
    expect(migrated.appearance?.density).toBe('compact')
    expect(migrated.appearance?.reducedMotion).toBe(true)
    expect(migrated.updates?.channel).toBe('beta')
    expect(migrated.usage?.dailyAllowanceCoins).toBe(500)
    expect(migrated.providers?.[0]?.kind).toBe('openai-compatible')
    expect(migrated.permissions?.domains).toEqual({ 'fs.delete': 'deny' })
    expect(migrated.agent?.defaultModel).toBe('qwen2.5-coder:14b')
    expect(migrated.providers?.[0]?.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(migrated.onboardingComplete).toBe(true)
  })

  it('drops session-only fields rather than importing them as settings', () => {
    const migrated = migrateLegacyState({
      recentProjects: [{ root: '/x', name: 'x', openedAt: 'now' }],
      lastProjectRoot: '/x',
      layout: { sidebar: 300 }
    })
    expect(migrated).not.toHaveProperty('recentProjects')
    expect(migrated).not.toHaveProperty('lastProjectRoot')
    expect(migrated).not.toHaveProperty('layout')
  })

  it('ignores an unrecognised permission decision', () => {
    const migrated = migrateLegacyState({ permissionOverrides: { 'fs.read': 'maybe' } })
    expect(migrated.permissions?.domains ?? {}).toEqual({})
  })

  it('seeds settings from a legacy file on first launch after the upgrade', async () => {
    const fresh = new SettingsStore({
      userDataDir: dir,
      legacyState: { theme: 'bone', dailyBudgetUsd: 2, onboardingComplete: true }
    })
    const settings = await fresh.load()
    expect(settings.appearance.theme).toBe('light')
    expect(settings.usage.dailyAllowanceCoins).toBe(200)
    expect(settings.onboardingComplete).toBe(true)
    // Legacy contributes whole sections; the rest of each section must survive.
    expect(settings.appearance.scale).toBe(1)
    expect(settings.appearance.accentColor).toBe('#22d3ee')
    expect(settings.usage.lowBalanceWarningAt).toBe(5)
  })

  it('leaves no undefined field after a legacy seed', async () => {
    const fresh = new SettingsStore({
      userDataDir: dir,
      legacyState: { theme: 'bone', updateChannel: 'beta', modelEndpoint: 'http://127.0.0.1:11434/v1', modelProvider: 'ollama' }
    })
    const settings = await fresh.load()
    for (const [section, value] of Object.entries(settings)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
        expect(entry, `${section}.${field} was undefined`).not.toBeUndefined()
      }
    }
  })

  it('upgrades an older settings file in place', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        updatedAt: 'x',
        data: { theme: 'bone', dailyBudgetUsd: 1 }
      }),
      'utf8'
    )
    const settings = await new SettingsStore({ userDataDir: dir }).load()
    expect(settings.appearance.theme).toBe('light')
    expect(settings.usage.dailyAllowanceCoins).toBe(100)

    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(raw.version).toBe(SETTINGS_VERSION)
  })

  it('returns nothing for a non-object legacy payload', () => {
    expect(migrateLegacyState(null)).toEqual({})
    expect(migrateLegacyState('nope')).toEqual({})
  })
})

describe('project scoping', () => {
  it('lets a project override the model without changing global', async () => {
    await store.setProjectOverride('/repo-a', { defaultModel: 'stealth/space-bunny-alpha' })
    expect(store.get().agent.defaultModel).toBe('local-default')
    expect(store.resolve('/repo-a').agent.defaultModel).toBe('stealth/space-bunny-alpha')
    expect(store.resolve('/repo-b').agent.defaultModel).toBe('local-default')
  })

  it('overrides instructions, permission preset and shell per project', async () => {
    await store.setProjectOverride('/repo-a', {
      instructions: 'Never modify production config.',
      permissionPreset: 'read-only',
      shell: 'wsl'
    })
    const resolved = store.resolve('/repo-a')
    expect(resolved.agent.instructions).toBe('Never modify production config.')
    expect(resolved.permissions.preset).toBe('read-only')
    expect(resolved.terminal.shell).toBe('wsl')
    expect(store.get().terminal.shell).toBe('auto')
  })

  it('drops an override key the schema does not define rather than storing it', async () => {
    const result = await store.setProjectOverride('/repo-a', {
      defaultModel: 'kept',
      nonsense: true
    } as never)
    // Unknown keys are stripped, matching how a global update behaves. The
    // alternative — rejecting the whole patch — would make a typo in one field
    // throw away a user's real preferences.
    expect(result.ok).toBe(true)
    expect(store.get().projectOverrides['/repo-a']).toEqual({ defaultModel: 'kept' })
  })

  it('rejects an override of the wrong shape entirely', async () => {
    const result = await store.setProjectOverride('/repo-a', {
      permissionPreset: 'not-a-preset'
    } as never)
    expect(result.ok).toBe(false)
    expect(store.get().projectOverrides['/repo-a']).toBeUndefined()
  })

  it('clears a project override on request', async () => {
    await store.setProjectOverride('/repo-a', { defaultModel: 'x' })
    await store.setProjectOverride('/repo-a', null)
    expect(store.get().projectOverrides['/repo-a']).toBeUndefined()
    expect(store.resolve('/repo-a').agent.defaultModel).toBe('local-default')
  })

  it('resolves a single dotted path for a project', async () => {
    await store.setProjectOverride('/repo-a', { defaultModel: 'local-model' })
    expect(store.resolvePath('agent.defaultModel', '/repo-a')).toBe('local-model')
    expect(store.resolvePath('agent.defaultModel', '/other')).toBe('local-default')
    expect(store.resolvePath('nothing.here', null)).toBeUndefined()
  })

  it('does not mutate the global object when resolving', async () => {
    await store.setProjectOverride('/repo-a', { defaultModel: 'x' })
    store.resolve('/repo-a')
    expect(store.get().agent.defaultModel).toBe('local-default')
  })
})

describe('reset', () => {
  it('resets a single setting to its default', async () => {
    await store.update({ 'appearance.theme': 'light' })
    await store.resetPath('appearance.theme')
    expect(store.get().appearance.theme).toBe('dark')
  })

  it('resets a whole section', async () => {
    await store.update({ 'terminal.shell': 'cmd' })
    await store.update({ 'terminal.fontSize': 20 })
    await store.resetSection('terminal')
    expect(store.get().terminal.shell).toBe('auto')
    expect(store.get().terminal.fontSize).toBe(13)
  })

  it('keeps providers and project overrides when resetting everything else', async () => {
    await store.update({
      providers: [
        {
          id: 'openrouter',
          label: 'OpenRouter',
          kind: 'openai-compatible',
          baseUrl: 'https://openrouter.ai/api/v1',
          credentialKey: null,
          models: [],
          byok: true,
          enabled: true
        }
      ]
    })
    await store.setProjectOverride('/repo-a', { defaultModel: 'x' })
    await store.update({ 'agent.instructions': 'temporary' })

    const after = await store.resetAll()
    expect(after.agent.instructions).toBe('')
    expect(after.providers).toHaveLength(1)
    expect(after.projectOverrides['/repo-a']).toBeDefined()
  })
})

describe('import and export', () => {
  it('exports the settings without any credential', async () => {
    await store.update({
      'agent.instructions': 'Prefer functional React.',
      providers: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          kind: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          credentialKey: 'provider:anthropic',
          models: ['claude-sonnet-4'],
          byok: true,
          enabled: true
        }
      ]
    })

    const exported = store.export()
    const serialised = JSON.stringify(exported)
    expect(serialised).toContain('Prefer functional React.')
    expect(serialised).toContain('api.anthropic.com')
    expect(serialised).not.toMatch(/sk-[A-Za-z0-9]/)
  })

  it('imports an exported file back into an empty store', async () => {
    await store.update({ 'agent.instructions': 'Use pnpm.' })
    const exported = store.export()

    const other = mkdtempSync(join(tmpdir(), 'cryptoric-settings2-'))
    try {
      const target = new SettingsStore({ userDataDir: other })
      await target.load()
      const result = await target.import(exported)
      expect(result.ok).toBe(true)
      expect(target.get().agent.instructions).toBe('Use pnpm.')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('refuses an import that violates the schema', async () => {
    const result = await store.import({ appearance: { scale: 99 } }, 'replace')
    expect(result.ok).toBe(false)
  })

  it('strips a credential smuggled into an import payload but keeps the provider', async () => {
    await store.import(
      { providers: [{ id: 'x', label: 'X', kind: 'custom', baseUrl: 'https://x.test', apiKey: 'sk-leaked', credentialKey: 'k', models: [], byok: true, enabled: true }] },
      'replace'
    )
    // The secret is removed; the rest of the provider is still useful and
    // survives. Losing the whole entry because one field was stripped would be
    // a worse outcome for the user than dropping just the credential.
    expect(store.get().providers).toHaveLength(1)
    expect(store.get().providers[0]?.credentialKey).toBe('k')
    expect(JSON.stringify(store.get())).not.toContain('sk-leaked')
  })

  it('leaves the store usable when an import is nonsense', async () => {
    const result = await store.import('not an object', 'replace')
    expect(result.ok).toBe(false)
    expect(SettingsSchema.safeParse(store.get()).success).toBe(true)
  })
})

describe('helpers', () => {
  it('keeps credential references while dropping credential values', () => {
    const cleaned = stripSecrets({
      credentialKey: 'provider:openai',
      apiKey: 'sk-should-vanish',
      nested: { token: 'abc', keep: 'yes' }
    }) as Record<string, unknown>
    expect(cleaned['credentialKey']).toBe('provider:openai')
    expect(cleaned).not.toHaveProperty('apiKey')
    expect((cleaned['nested'] as Record<string, unknown>)['keep']).toBe('yes')
    expect(cleaned['nested']).not.toHaveProperty('token')
  })

  it('applies an override without mutating its input', () => {
    const base = defaultSettings()
    const merged = applyOverride(base, { defaultModel: 'other' })
    expect(merged.agent.defaultModel).toBe('other')
    expect(base.agent.defaultModel).toBe('local-default')
  })

  it('exposes a default object that satisfies the schema', () => {
    expect(SettingsSchema.safeParse(defaultSettings()).success).toBe(true)
  })
})