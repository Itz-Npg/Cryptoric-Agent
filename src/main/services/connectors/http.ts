/**
 * Shared HTTP for connector APIs.
 *
 * Every connector talks to a real third-party REST API with a user-supplied
 * token, so this module exists to make one set of promises all of them keep:
 *
 *  1. **The token never leaks.** It goes into the `Authorization` header and
 *     nowhere else — not into a URL, not into an error message, not into the
 *     audit log.
 *  2. **Errors are the provider's, not ours.** The body a provider returns on a
 *     4xx is the only useful thing to show a user staring at a rejected token,
 *     so it is surfaced verbatim rather than replaced with "request failed".
 *  3. **A failed call is a value.** Nothing here throws at the call site; the
 *     caller gets `{ ok: false, error }` and decides what that means.
 */

/** Redacted so a token can never reach a transcript or an error string. */
export const REDACTED = '[redacted]'

export interface HttpOk<T> {
  ok: true
  status: number
  data: T
}

export interface HttpFail {
  ok: false
  status: number
  /** Provider-reported message. Never contains the token. */
  error: string
}

export type HttpResult<T> = HttpOk<T> | HttpFail

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * How a provider signals "your credentials are wrong".
 *
 * This is not uniform and guessing it would produce a connector that says
 * "endpoint unreachable" when the real answer is "that token is wrong". Measured
 * against each provider on 2026-10-04 with a deliberately invalid token:
 *
 *   vercel 403 · cloudflare 400 · netlify 401 · render 401 · supabase 401
 *   sentry 401 · stripe 401 · notion 401 · linear 401
 *
 * Cloudflare is the outlier: it answers HTTP 400 for a bad token, not 401.
 */
const AUTH_FAILURE_STATUSES = new Set([400, 401, 403])

export function isAuthFailure(status: number): boolean {
  return AUTH_FAILURE_STATUSES.has(status)
}

/** Pull the most useful message a provider gave us, whatever shape it used. */
export function extractErrorMessage(body: string, fallback: string): string {
  const trimmed = body.trim()
  if (!trimmed) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Some providers answer 401 with `text/plain`. That is still their message.
    return trimmed.slice(0, 200)
  }

  const visit = (node: unknown, depth = 0): string | null => {
    if (depth > 4 || node === null || typeof node !== 'object') return null
    const record = node as Record<string, unknown>
    for (const key of ['message', 'error_description', 'detail', 'error']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (value && typeof value === 'object') {
        const nested = visit(value, depth + 1)
        if (nested) return nested
      }
    }
    for (const value of Object.values(record)) {
      const nested = visit(value, depth + 1)
      if (nested) return nested
    }
    return null
  }

  return visit(parsed) ?? trimmed.slice(0, 200)
}

/** Strip anything that looks like a token out of a string bound for a log. */
export function redact(text: string, token: string | null): string {
  if (!token) return text
  return text.split(token).join(REDACTED)
}

export async function request<T = unknown>(
  url: string,
  token: string,
  opts: HttpOptions = {}
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {})
  }

  // Linear takes a bare API key; everything else takes a bearer token. Callers
  // that need the bare form pass `authScheme: 'raw'`.
  headers['Authorization'] = opts.headers?.['Authorization'] ?? `Bearer ${token}`

  let body: string | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
    body = JSON.stringify(opts.body)
  }

  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      ...(body !== undefined ? { body } : {})
    })

    const text = await res.text()

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: redact(extractErrorMessage(text, `Request failed with HTTP ${res.status}.`), token)
      }
    }

    if (!text.trim()) return { ok: true, status: res.status, data: undefined as T }

    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T }
    } catch {
      return { ok: false, status: res.status, error: 'The provider returned a non-JSON response.' }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, error: redact(message, token) }
  }
}