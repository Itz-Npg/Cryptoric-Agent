/**
 * Settings persistence.
 *
 * Everything a user can configure lives behind this store, and the store
 * guarantees four things the application depends on:
 *
 *  1. **Validation.** A value is parsed against the schema before it is stored.
 *     A bad setting is rejected with a readable reason, never persisted and
 *     never crashing the next launch.
 *  2. **Migration.** A file written by an older build is upgraded on load. An
 *     unrecognised or corrupt file falls back to defaults rather than throwing,
 *     because a bad settings file must never make the app unlaunchable.
 *  3. **Scoping.** Global settings are merged with the open project's overrides
 *     on read, so a project cannot mutate global state and a global default
 *     cannot silently change a project that overrode it.
 *  4. **No secrets.** The schema has no shape that can hold a credential, and
 *     export is additionally filtered, so an exported file is safe to share.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { shouldGrantSignupBonus } from '@shared/coins'

/** UTC day string, matching the format the signup bonus is stored in. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}
import {
  defaultSettings,
  SETTINGS_SECTIONS,
  SETTINGS_VERSION,
  SettingsSchema,
  scopeOf,
  type ProjectOverride,
  type SettingScope,
  type Settings,
  type SettingsSection
} from './schema'

interface Persisted {
  version: number
  updatedAt: string
  data: unknown
}

/**
 * Schema version 1 — the original flat `state.json` shape.
 *
 * Anything below this predates the grouped schema and is routed through
 * `migrateLegacyState` instead of the allowance migration.
 */
const LEGACY_FLAT_VERSION = 2

/**
 * Coin allowances that were **defaults**, not choices.
 *
 * The allowance dropped from 500 to 25 coins. A fresh install picks the new
 * default up automatically, but an install that has been running since before
 * the change has `500` persisted — and a persisted value always wins over a
 * schema default, so the user kept seeing `0 / 500` forever.
 *
 * Only the *old default* is rewritten. A user who deliberately set some other
 * number keeps it: migrating by "is it large?" would quietly discard a choice,
 * which is worse than leaving a stale value alone.
 */
const RETIRED_ALLOWANCES: { coins: number; warning: number }[] = [
  { coins: 500, warning: 50 }
]

export interface SettingsStoreOptions {
  userDataDir: string
  /** Legacy flat state, used to seed settings on first run after the upgrade. */
  legacyState?: unknown
}

export interface SettingsValidation {
  ok: boolean
  /** Dotted paths that failed, with the reason. Empty when `ok`. */
  issues: { path: string; message: string }[]
}

/** What a caller may change, given a scope. */
export type SettingsPatch = Record<string, unknown>

export class SettingsStore {
  private cache: Settings = defaultSettings()
  private readonly filePath: string
  /** True once `load()` has run, so reads before load fall back to defaults. */
  loaded = false

  constructor(private readonly options: SettingsStoreOptions) {
    this.filePath = join(options.userDataDir, 'settings.json')
  }

  // ------------------------------------------------------------------ read

  /** Load from disk, migrating or falling back as needed. Never throws. */
  async load(): Promise<Settings> {
    let parsed: Persisted | null = null
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Persisted
    } catch {
      parsed = null
    }

    if (parsed && typeof parsed.version === 'number') {
      const result = SettingsSchema.safeParse(this.migrate(parsed))
      // A file that cannot be understood is replaced by defaults, not by a
      // crash: losing preferences is annoying, being unable to launch is fatal.
      this.cache = result.success ? result.data : this.freshFromLegacy()
    } else {
      this.cache = this.freshFromLegacy()
    }

    this.loaded = true

    // Grant the one-time signup bonus the first time this profile is seen.
    //
    // It is recorded the moment it is granted rather than being recomputed from
    // a timestamp later, because "has this profile ever been granted it" has to
    // survive a reinstall, a file copy, and a schema migration. The day string
    // is what makes it expire from the allowance after one day.
    let granted = false
    if (shouldGrantSignupBonus(this.cache.usage.signupBonusGrantedOn)) {
      this.cache = {
        ...this.cache,
        usage: { ...this.cache.usage, signupBonusGrantedOn: todayUtc() }
      }
      granted = true
    }

    // Rewrite when the file was absent or older than the current schema, so an
    // upgrade actually lands on disk instead of being re-migrated every launch.
    // Also when the bonus was just granted, or the grant would be made again on
    // every single launch.
    if (!parsed || parsed.version !== SETTINGS_VERSION || granted) await this.persist()
    return this.cache
  }

  /** Global settings as stored. */
  get(): Settings {
    return this.cache
  }

  /**
   * Effective settings for a project.
   *
   * Global settings with the project's overrides applied. Overrides are limited
   * to keys the schema declares, so a project cannot invent settings.
   */
  resolve(projectRoot: string | null): Settings {
    if (!projectRoot) return this.cache
    const override = this.cache.projectOverrides[projectRoot]
    if (!override) return this.cache
    return applyOverride(this.cache, override)
  }

  /** The value in force for one dotted path, honouring project scope. */
  resolvePath(path: string, projectRoot: string | null = null): unknown {
    const settings = this.resolve(projectRoot)
    let current: unknown = settings
    for (const part of path.split('.')) {
      if (current === null || typeof current !== 'object') return undefined
      current = (current as Record<string, unknown>)[part]
    }
    return current
  }

  // ----------------------------------------------------------------- write

  /**
   * Merge a patch into global settings.
   *
   * A dotted key targets a nested field. The result is validated as a whole, so
   * a patch can never leave the store holding a shape it would refuse to load.
   */
  async update(patch: SettingsPatch): Promise<SettingsValidation> {
    const candidate = structuredClone(this.cache) as Record<string, unknown>
    for (const [key, value] of Object.entries(patch)) {
      setPath(candidate, key, value)
    }

    const parsed = SettingsSchema.safeParse(candidate)
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message
        }))
      }
    }

    this.cache = parsed.data
    await this.persist()
    return { ok: true, issues: [] }
  }

  /** Set or clear one project's overrides. Keys outside the schema are rejected. */
  async setProjectOverride(projectRoot: string, override: ProjectOverride | null): Promise<SettingsValidation> {
    if (!projectRoot) return { ok: false, issues: [{ path: 'projectRoot', message: 'A project root is required' }] }
    if (override === null) {
      const next = { ...this.cache.projectOverrides }
      delete next[projectRoot]
      this.cache = { ...this.cache, projectOverrides: next }
      await this.persist()
      return { ok: true, issues: [] }
    }

    const candidate = { ...this.cache, projectOverrides: { ...this.cache.projectOverrides, [projectRoot]: override } }
    const parsed = SettingsSchema.safeParse(candidate)
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => ({
          path: `projectOverrides.${projectRoot}.${i.path.join('.')}`,
          message: i.message
        }))
      }
    }
    this.cache = parsed.data
    await this.persist()
    return { ok: true, issues: [] }
  }

  // ----------------------------------------------------------------- reset

  /** Reset one dotted path to its default. */
  async resetPath(path: string): Promise<Settings> {
    const defaults = defaultSettings() as Record<string, unknown>
    const candidate = structuredClone(this.cache) as Record<string, unknown>
    const fallback = getPath(defaults, path)
    if (fallback === undefined) {
      deletePath(candidate, path)
    } else {
      setPath(candidate, path, fallback)
    }
    const parsed = SettingsSchema.safeParse(candidate)
    if (parsed.success) this.cache = parsed.data
    await this.persist()
    return this.cache
  }

  /** Reset a whole section to its defaults. */
  async resetSection(section: SettingsSection): Promise<Settings> {
    const defaults = defaultSettings()
    this.cache = { ...this.cache, [section]: defaults[section] }
    await this.persist()
    return this.cache
  }

  /** Reset every global setting. Project overrides and providers survive. */
  async resetAll(): Promise<Settings> {
    const providers = this.cache.providers
    const projectOverrides = this.cache.projectOverrides
    this.cache = { ...defaultSettings(), providers, projectOverrides }
    await this.persist()
    return this.cache
  }

  // ----------------------------------------------------------- import/export

  /**
   * A shareable copy of the settings.
   *
   * Providers are reduced to their non-secret shape, and a second pass strips
   * anything that still looks like a credential. Defence in depth: the schema
   * already forbids one, so this guards against a future field being added
   * carelessly.
   */
  export(): Record<string, unknown> {
    const providers = this.cache.providers.map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      baseUrl: p.baseUrl,
      models: [...p.models],
      byok: p.byok,
      enabled: p.enabled
    }))

    const copy: Record<string, unknown> = {
      version: SETTINGS_VERSION,
      exportedAt: new Date().toISOString(),
      ...(this.cache as unknown as Record<string, unknown>),
      providers
    }
    return stripSecrets(copy) as Record<string, unknown>
  }

  /**
   * Import an exported settings file.
   *
   * `mode: 'merge'` keeps providers and project overrides the user already has;
   * `'replace'` adopts the file wholesale. Credentials are never imported —
   * they are not in the file, and anything shaped like one is dropped again.
   */
  async import(
    payload: unknown,
    mode: 'merge' | 'replace' = 'merge'
  ): Promise<SettingsValidation> {
    const cleaned = stripSecrets(payload)
    const data = (cleaned as { data?: unknown }).data ?? cleaned
    const parsed = SettingsSchema.safeParse(mode === 'merge' ? { ...this.cache, ...(data as object) } : data)
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message
        }))
      }
    }
    this.cache = parsed.data
    await this.persist()
    return { ok: true, issues: [] }
  }

  // ------------------------------------------------------------- internals

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const payload: Persisted = {
      version: SETTINGS_VERSION,
      updatedAt: new Date().toISOString(),
      data: this.cache
    }
    // Atomic: a crash mid-write leaves the previous file intact rather than a
    // truncated one that would fail to parse on next launch.
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.filePath)
  }

  /** Upgrade a persisted payload to the current schema version. */
  private migrate(persisted: Persisted): unknown {
    // A file from a newer build: keep what we understand rather than discard it.
    if (persisted.version > SETTINGS_VERSION) return persisted.data

    const base =
      persisted.version < LEGACY_FLAT_VERSION ? migrateLegacyState(persisted.data) : (persisted.data as object)

    return migrateAllowance(persisted.version, base)
  }

  private seedFromLegacy(): Record<string, unknown> {
    if (this.options.legacyState === undefined) return {}
    const seeded = migrateLegacyState(this.options.legacyState)
    return Object.keys(seeded).length > 0 ? (seeded as Record<string, unknown>) : {}
  }

  /**
   * Defaults with any legacy values layered on top.
   *
   * The merge must go through the schema rather than a shallow spread: the
   * legacy file contributes whole sections (`{ appearance: { theme } }`), and
   * spreading those over the defaults would replace a fully populated section
   * with a one-field stub, leaving every other field undefined on disk.
   */
  private freshFromLegacy(): Settings {
    const seeded = this.seedFromLegacy()
    // The legacy flat state carries the *old* USD budget, and
    // `migrateLegacyState` converts it to coins at the documented 1:100 — which
    // reproduces the retired 500-coin default exactly. So the retirement has to
    // run on this path too.
    //
    // It did not, and that is why an install with legacy flat state but no
    // `settings.json` yet — the ordinary first launch after an upgrade — seeded
    // straight to 500 and stayed there. `migrate()` only runs the retirement
    // when a settings file already exists, so the very path that *created* the
    // stale number was the one path that never cleaned it up. Handed the
    // pre-grouped version so `migrateAllowance` treats it as needing an upgrade.
    const retired =
      Object.keys(seeded).length > 0
        ? (migrateAllowance(LEGACY_FLAT_VERSION - 1, seeded) as Record<string, unknown>)
        : seeded

    const candidate = { ...(defaultSettings() as unknown as Record<string, unknown>), ...retired }
    const parsed = SettingsSchema.safeParse(candidate)
    return parsed.success ? parsed.data : defaultSettings()
  }
}

// ------------------------------------------------------------- migration

/**
 * Convert the original flat `state.json` into the grouped schema.
 *
 * Lossy by design and honest about it: `recentProjects`, `lastProjectRoot` and
 * `layout` are session data and stay in their own store. This function returns
 * only what maps cleanly, and anything unrecognised is dropped rather than
 * guessed at.
 */
export function migrateLegacyState(legacy: unknown): Partial<Settings> {
  if (!legacy || typeof legacy !== 'object') return {}
  const source = legacy as Record<string, unknown>
  const out: Record<string, unknown> = {}

  const appearance: Record<string, unknown> = {}
  if (source['theme'] === 'bone') appearance['theme'] = 'light'
  else if (source['theme'] === 'graphite') appearance['theme'] = 'dark'
  if (typeof source['density'] === 'string') appearance['density'] = source['density']
  if (source['motion'] === 'reduced') appearance['reducedMotion'] = true
  if (Object.keys(appearance).length > 0) out['appearance'] = appearance

  const updates: Record<string, unknown> = {}
  if (typeof source['updateChannel'] === 'string') updates['channel'] = source['updateChannel']
  if (Object.keys(updates).length > 0) out['updates'] = updates

  const usage: Record<string, unknown> = {}
  // The old budget was USD; the new one is coins, at the documented 1:100.
  if (typeof source['dailyBudgetUsd'] === 'number' && Number.isFinite(source['dailyBudgetUsd'])) {
    usage['dailyAllowanceCoins'] = Math.round(source['dailyBudgetUsd'] * 100)
  }
  if (Object.keys(usage).length > 0) out['usage'] = usage

  const permissions: Record<string, unknown> = {}
  const overrides = source['permissionOverrides']
  if (overrides && typeof overrides === 'object') {
    const domains: Record<string, string> = {}
    for (const [domain, decision] of Object.entries(overrides as Record<string, unknown>)) {
      if (decision === 'allow' || decision === 'ask' || decision === 'deny') domains[domain] = decision
    }
    if (Object.keys(domains).length > 0) permissions['domains'] = domains
  }
  if (Object.keys(permissions).length > 0) out['permissions'] = permissions

  const agent: Record<string, unknown> = {}
  if (typeof source['modelName'] === 'string' && source['modelName']) agent['defaultModel'] = source['modelName']

  // A configured endpoint becomes a provider entry, minus any secret.
  if (typeof source['modelEndpoint'] === 'string' && source['modelEndpoint']) {
    const provider = typeof source['modelProvider'] === 'string' ? source['modelProvider'] : ''
    // OpenRouter is OpenAI-compatible on the wire, which is what the `kind`
    // describes; `id`/`label` keep the specific provider visible.
    const kind = 'openai-compatible'
    const named = provider === 'ollama' || provider === 'openrouter' || provider === 'apinex'
    const PROVIDER_LABELS: Record<string, string> = {
      ollama: 'Ollama',
      openrouter: 'OpenRouter',
      apinex: 'APINEX'
    }
    const PROVIDER_CREDENTIALS: Record<string, string> = {
      openrouter: 'openrouter-api-key',
      apinex: 'apinex-api-key'
    }
    out['providers'] = [
      {
        id: named ? provider : 'custom',
        label: PROVIDER_LABELS[provider] ?? 'Custom endpoint',
        kind,
        baseUrl: source['modelEndpoint'],
        credentialKey: PROVIDER_CREDENTIALS[provider] ?? null,
        models: typeof source['modelName'] === 'string' ? [source['modelName']] : [],
        byok: true,
        enabled: provider !== 'none'
      }
    ]
  }
  if (Object.keys(agent).length > 0) out['agent'] = agent

  if (typeof source['onboardingComplete'] === 'boolean') out['onboardingComplete'] = source['onboardingComplete']

  return out as Partial<Settings>
}

/**
 * Replace a coin allowance that was an old **default** with the current one.
 *
 * No-op for a file already at the current version, and no-op for a value the
 * user chose themselves. Returns a new object; the input is never mutated,
 * because a failed schema parse downstream must not have already corrupted
 * what was on disk.
 */
export function migrateAllowance(fromVersion: number, data: object): object {
  if (fromVersion >= SETTINGS_VERSION || !data || typeof data !== 'object') return data
  const source = data as Record<string, unknown>
  const usage = source['usage']
  if (!usage || typeof usage !== 'object') return data

  const current = (usage as Record<string, unknown>)['dailyAllowanceCoins']
  const retired = RETIRED_ALLOWANCES.find((r) => r.coins === current)
  if (!retired) return data

  const defaults = defaultSettings().usage
  const out = { ...source, usage: { ...(usage as Record<string, unknown>) } }
  const target = out['usage'] as Record<string, unknown>

  target['dailyAllowanceCoins'] = defaults.dailyAllowanceCoins
  // Only move the warning threshold if it is still the one that shipped with
  // the old allowance; a user who lowered it on purpose keeps their value.
  if (target['lowBalanceWarningAt'] === retired.warning) {
    target['lowBalanceWarningAt'] = defaults.lowBalanceWarningAt
  }
  return out
}

// ---------------------------------------------------------------- helpers

/** Deep-merge a project override onto global settings. */
export function applyOverride(settings: Settings, override: ProjectOverride): Settings {
  const merged = structuredClone(settings) as Record<string, unknown>
  if (override.defaultModel !== undefined) {
    const agent = { ...(merged['agent'] as Record<string, unknown>), defaultModel: override.defaultModel }
    merged['agent'] = agent
  }
  if (override.instructions !== undefined) {
    const agent = { ...(merged['agent'] as Record<string, unknown>), instructions: override.instructions }
    merged['agent'] = agent
  }
  if (override.permissionPreset !== undefined) {
    const permissions = { ...(merged['permissions'] as Record<string, unknown>), preset: override.permissionPreset }
    merged['permissions'] = permissions
  }
  if (override.shell !== undefined) {
    merged['terminal'] = { ...(merged['terminal'] as Record<string, unknown>), shell: override.shell }
  }
  return SettingsSchema.parse(merged)
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor: Record<string, unknown> = target
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (next === null || typeof next !== 'object') cursor[part] = {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1] as string] = value
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

function deletePath(target: Record<string, unknown>, path: string): void {
  const parts = path.split('.')
  let cursor: Record<string, unknown> = target
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (next === null || typeof next !== 'object') return
    cursor = next as Record<string, unknown>
  }
  delete cursor[parts[parts.length - 1] as string]
}

const SECRET_KEY = /(key|secret|token|password|credential|authorization)/i

/** Drop anything shaped like a credential, wherever it appears. */
export function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 10) return null
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1))
  if (value === null || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    // `credentialKey` is a *reference* and must survive; it holds no secret.
    if (key === 'credentialKey') {
      out[key] = inner
      continue
    }
    if (SECRET_KEY.test(key)) continue
    out[key] = stripSecrets(inner, depth + 1)
  }
  return out
}

/** Scopes a caller may set, used to reject an illegal override. */
export function isScopeAllowed(path: string, scope: SettingScope): boolean {
  return scopeOf(path) === scope || scopeOf(path) === 'global'
}

export { SETTINGS_SECTIONS, SettingsSchema, defaultSettings, scopeOf, z }
export type { Settings, SettingsSection, SettingScope, ProjectOverride }