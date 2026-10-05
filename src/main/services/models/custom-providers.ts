/**
 * Custom providers the user brings themselves.
 *
 * "Add my own API" means three separate things that the app has to keep
 * distinct, because conflating any two of them produces a bug that only shows
 * up on someone else's machine:
 *
 *  - **the base URL** — where requests go. Configuration, not a secret, but
 *    still validated: a malformed URL would otherwise fail later as an opaque
 *    network error.
 *  - **the API key** — a secret. It goes to its own credential slot, named after
 *    the provider, and never into the settings file. Two providers must not
 *    share a slot, or removing one would take the other's key with it.
 *  - **the models** — free text the user controls, because nobody knows their
 *    provider's model list better than they do, and no built-in catalogue
 *    covers a private endpoint.
 *
 * Pure functions only: no IPC, no filesystem. The route wires them.
 */

import type { ModelConfig } from './gateway'
import type { ProviderConfig } from '../settings/schema'

/** Prefix for per-provider credential slots. */
export const CUSTOM_CREDENTIAL_PREFIX = 'custom-provider-'

/** Credential slot holding one custom provider's key. */
export function credentialSlotFor(providerId: string): string {
  return `${CUSTOM_CREDENTIAL_PREFIX}${providerId}`
}

/**
 * Presets live in `shared` so the renderer dropdown and this validation read one
 * list. Re-exported here so main-process code has a single import for them.
 */
export { PROVIDER_PRESETS, findPreset, searchPresets } from '@shared/provider-presets'
export type { ProviderPreset } from '@shared/provider-presets'

export interface CustomProviderInput {
  id?: string
  label: string
  baseUrl: string
  /** Never persisted here; the caller writes it to the credential slot. */
  apiKey?: string
  models: string[]
  kind?: ProviderConfig['kind']
  /** User-declared context window, in tokens. A budget, not a capability. */
  contextWindow?: number | null
  /** Ceiling on one reply, in tokens. */
  maxOutputTokens?: number | null
}

/**
 * Largest limits worth accepting.
 *
 * A context window of a hundred million tokens is not a real model, it is a
 * typo in a text box. Rejecting it here keeps the gateway's arithmetic honest
 * instead of storing a number nothing can ever reach.
 */
export const MAX_CONTEXT_WINDOW = 10_000_000
export const MAX_OUTPUT_TOKENS = 1_000_000

/**
 * Read one optional positive-integer limit.
 *
 * `undefined`, `null` and an empty box all mean "not declared", which is the
 * honest default: a provider we know nothing about must not be silently capped
 * at a number someone else guessed.
 */
export function readTokenLimit(
  value: unknown,
  max: number,
  label: string
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined }
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return { ok: false, error: `${label} must be a number of tokens.` }
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: `${label} must be a whole number above zero, or left blank.` }
  }
  if (n > max) return { ok: false, error: `${label} above ${max.toLocaleString('en-US')} is not a real model.` }
  return { ok: true, value: n }
}

export type NormaliseResult =
  | { ok: true; provider: ProviderConfig; apiKey: string | null }
  | { ok: false; error: string }

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/**
 * Validate and normalise one custom provider.
 *
 * The id is derived from the label so re-adding the same provider updates it
 * rather than accumulating duplicates every time the user presses Save. An
 * explicit id wins when editing an existing entry.
 */
export function normaliseCustomProvider(input: CustomProviderInput): NormaliseResult {
  const label = typeof input.label === 'string' ? input.label.trim() : ''
  if (label.length === 0) return { ok: false, error: 'Give this provider a name.' }
  if (label.length > 80) return { ok: false, error: 'That name is too long.' }

  const rawUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  if (rawUrl.length === 0) return { ok: false, error: 'Enter the base URL for this provider.' }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, error: `"${rawUrl}" is not a valid URL.` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: `Unsupported protocol "${url.protocol}". Use https, or http for a local server.` }
  }

  const baseUrl = rawUrl.replace(/\/$/, '')

  const models = Array.from(
    new Set(
      (Array.isArray(input.models) ? input.models : [])
        .map((m) => (typeof m === 'string' ? m.trim() : ''))
        .filter((m) => m.length > 0)
        .slice(0, 200)
    )
  )
  if (models.length === 0) {
    // A provider with no models is a provider the user cannot select anything
    // from. Saying so beats storing an entry that silently does nothing.
    return { ok: false, error: 'Add at least one model id, exactly as the provider spells it.' }
  }

  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''

  // A local endpoint needs no key, and demanding one would make Ollama and
  // LM Studio impossible to add.
  const needsKey = url.protocol === 'https:'
  if (needsKey && apiKey.length === 0 && input.apiKey !== undefined) {
    return { ok: false, error: 'This provider needs an API key.' }
  }

  const id = (input.id && input.id.trim().length > 0 ? input.id.trim() : slug(label)) || `provider-${Date.now()}`

  const context = readTokenLimit(input.contextWindow, MAX_CONTEXT_WINDOW, 'Context window tokens')
  if (!context.ok) return { ok: false, error: context.error }
  const output = readTokenLimit(input.maxOutputTokens, MAX_OUTPUT_TOKENS, 'Maximum output tokens')
  if (!output.ok) return { ok: false, error: output.error }
  // A reply longer than the whole window is arithmetically impossible, so one
  // of the two numbers is wrong. Saying which combination is impossible is more
  // useful than clamping silently and letting the provider reject it later.
  if (context.value !== undefined && output.value !== undefined && output.value > context.value) {
    return {
      ok: false,
      error: 'Maximum output tokens cannot be larger than the context window.'
    }
  }

  return {
    ok: true,
    provider: {
      id,
      label,
      // https is the default; `custom` is what the user means by "mine".
      kind: input.kind ?? 'custom',
      baseUrl,
      // Null for a keyless local endpoint, so the gateway never prompts for a
      // key that does not exist.
      credentialKey: needsKey || apiKey.length > 0 ? credentialSlotFor(id) : null,
      models,
      byok: true,
      enabled: true,
      // Omitted rather than null when undeclared, so a settings file only ever
      // carries a limit the user actually typed.
      ...(context.value !== undefined ? { contextWindow: context.value } : {}),
      ...(output.value !== undefined ? { maxOutputTokens: output.value } : {})
    },
    apiKey: apiKey.length > 0 ? apiKey : null
  }
}

/**
 * Upsert into an existing list.
 *
 * Upsert rather than append so that saving a provider the user is editing does
 * not create a second copy of it with the same name.
 */
export function upsertCustomProvider(
  existing: readonly ProviderConfig[],
  provider: ProviderConfig
): ProviderConfig[] {
  const without = existing.filter((p) => p.id !== provider.id)
  return [...without, provider]
}

export function removeCustomProvider(
  existing: readonly ProviderConfig[],
  id: string
): { providers: ProviderConfig[]; removed: ProviderConfig | null } {
  const removed = existing.find((p) => p.id === id) ?? null
  return { providers: existing.filter((p) => p.id !== id), removed }
}

/**
 * Gateway configs for every enabled custom provider's models.
 *
 * The credential *key* is carried, never the credential: resolving the secret
 * is the gateway's job, so building a config here cannot leak a key into a
 * settings file or an IPC payload.
 */
export function customModelConfigs(providers: readonly ProviderConfig[]): ModelConfig[] {
  const configs: ModelConfig[] = []
  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of provider.models) {
      configs.push({
        provider: isLocalEndpoint(provider.baseUrl) ? 'ollama' : 'openai-compatible',
        endpoint: provider.baseUrl,
        model,
        credentialKey: provider.credentialKey,
        dailyBudgetCoins: 25,
        // Carried so the gateway can enforce what the user declared. Without
        // this the two numbers in the settings form would be decoration.
        ...(provider.contextWindow !== undefined ? { contextWindow: provider.contextWindow } : {}),
        ...(provider.maxOutputTokens !== undefined ? { maxOutputTokens: provider.maxOutputTokens } : {})
      })
    }
  }
  return configs
}

/**
 * Is this endpoint on this machine?
 *
 * Decides whether a key is required: a local Ollama or LM Studio needs none,
 * and demanding one there would make the most common local setup unusable.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    // `URL.hostname` keeps the brackets on an IPv6 literal, so `::1` arrives as
    // `[::1]`. Comparing against the bare form alone would miss every user whose
    // local server binds IPv6 loopback and prompt them for a key that the
    // server will never need.
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
  } catch {
    return false
  }
}

/** Did the user enter something that looks like a secret into a URL? */
export function urlLeaksSecret(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.username.length > 0 || url.password.length > 0 || /[?&](key|token|api_key|apikey)=/i.test(url.search)
  } catch {
    return false
  }
}

export { slug as providerSlug }
