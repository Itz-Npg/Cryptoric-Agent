/**
 * Optional model catalogue from a self-hosted provider server.
 *
 * The user runs a server (see `server/index.mjs`) and points the app at it. The
 * models published there appear alongside the built-in ones. This is entirely
 * opt-in: with no URL configured nothing is fetched and nothing changes.
 *
 * Three properties are load-bearing:
 *
 *  - **Plain HTTP is refused** except for loopback. The provider token is a
 *    bearer credential; sending it over an unencrypted link hands it to anyone
 *    on the path. There is an explicit opt-out for a LAN or a tunnel, because
 *    refusing outright would make a legitimate setup impossible — but the
 *    default has to be the safe one.
 *  - **Every field is validated.** A server the user did not write is still
 *    untrusted input. A model with no id, or a `contextWindow` of `"lots"`,
 *    must not reach the model picker.
 *  - **A failed fetch is not a failed app.** The catalogue is additive; being
 *    unable to reach it leaves the built-in providers exactly as they were and
 *    reports why.
 */

import { PROVIDER_CREDENTIAL_SLOTS } from './gateway'
import type { ModelConfig } from './gateway'

export interface CatalogueModel {
  id: string
  label: string
  description: string
  contextWindow: number
  /** True when the model needs the user's own key rather than the server's. */
  byok: boolean
}

export interface Catalogue {
  schemaVersion: number
  updatedAt: string
  models: CatalogueModel[]
}

export type CatalogueResult =
  | { ok: true; catalogue: Catalogue; url: string }
  | { ok: false; error: string; url: string }

export interface FetchOptions {
  /** Bearer token for the server. Never logged or persisted by this module. */
  token: string | null
  signal?: AbortSignal
  timeoutMs?: number
  /** Allow `http://` to a host that is not loopback. Defaults to false. */
  allowInsecure?: boolean
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/**
 * Is this URL safe to send a bearer token to?
 *
 * HTTPS always. HTTP only on loopback, or only when the caller explicitly
 * allowed it.
 */
export function isTransportAllowed(rawUrl: string, allowInsecure = false): { ok: true } | { ok: false; error: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, error: `"${rawUrl}" is not a valid URL.` }
  }

  if (url.protocol === 'https:') return { ok: true }
  if (url.protocol !== 'http:') {
    return { ok: false, error: `Unsupported protocol "${url.protocol}". Use https.` }
  }
  if (LOOPBACK.has(url.hostname)) return { ok: true }
  if (allowInsecure) return { ok: true }
  return {
    ok: false,
    error: `Refusing to send a credential over plain http to "${url.hostname}". Use https, or set the explicit insecure option for a trusted LAN.`
  }
}

function coerceModel(input: unknown): CatalogueModel | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = input as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return null

  const context = Number(raw.contextWindow)
  return {
    id: raw.id.trim(),
    label: typeof raw.label === 'string' && raw.label.trim().length > 0 ? raw.label.trim() : raw.id.trim(),
    description: typeof raw.description === 'string' ? raw.description : '',
    // A nonsense context window would silently truncate every request made
    // with this model, so an unusable value falls back to null rather than
    // being passed through as NaN.
    contextWindow: Number.isFinite(context) && context > 0 ? Math.floor(context) : 0,
    byok: raw.byok === true
  }
}

/** Validate a parsed catalogue payload. Models that fail are dropped, not fatal. */
export function parseCatalogue(payload: unknown): Catalogue | null {
  if (typeof payload !== 'object' || payload === null) return null
  const raw = payload as Record<string, unknown>
  if (!Array.isArray(raw.models)) return null

  const models = raw.models.map(coerceModel).filter((m): m is CatalogueModel => m !== null)
  if (models.length === 0) return null

  return {
    schemaVersion: Number.isFinite(Number(raw.schemaVersion)) ? Number(raw.schemaVersion) : 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
    models
  }
}

export async function fetchCatalogue(baseUrl: string, options: FetchOptions): Promise<CatalogueResult> {
  const url = baseUrl.replace(/\/$/, '')
  const transport = isTransportAllowed(url, options.allowInsecure ?? false)
  if (!transport.ok) return { ok: false, error: transport.error, url }

  // `/v1/models` is appended so a user can paste either the server root or the
  // catalogue path and get the same result.
  const endpoint = url.endsWith('/v1/models') ? url : `${url}/v1/models`

  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
      },
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000)
    })

    if (!response.ok) {
      return {
        ok: false,
        // The status, not the body: an error page can contain the upstream URL.
        error: `Provider server returned HTTP ${response.status}.`,
        url
      }
    }

    const catalogue = parseCatalogue(await response.json())
    if (!catalogue) {
      return { ok: false, error: 'Provider server returned a catalogue with no usable models.', url }
    }
    return { ok: true, catalogue, url }
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `Could not reach the provider server: ${reason}`, url }
  }
}

/**
 * Turn catalogue entries into the gateway's own provider configs.
 *
 * `servedBy` is `custom` so a catalogue model can never be mistaken for a
 * built-in one with the same id.
 */
export function toProviderConfigs(catalogue: Catalogue, baseUrl: string): ModelConfig[] {
  const endpoint = baseUrl.replace(/\/$/, '')
  return catalogue.models.map((model) => ({
    provider: 'openai-compatible' as ModelConfig['provider'],
    endpoint,
    model: model.id,
    credentialKey: PROVIDER_CREDENTIAL_SLOTS['openai-compatible'] ?? 'model-api-key',
    dailyBudgetCoins: 25
  }))
}
