/**
 * Pure helpers for the browser subsystem.
 *
 * Everything here is deterministic and dependency-free on purpose: URL
 * normalisation, log classification and result shaping are the parts most
 * likely to be wrong in a way that only shows up as "the agent said the page
 * was fine", so they are unit-tested directly rather than exercised through
 * Electron.
 */

/**
 * Schemes a Cryptoric tab may never load.
 *
 * `javascript:` would execute agent-authored code inside a page that has the
 * developer's origin, and `data:`/`blob:` are the usual smuggling route around
 * a scheme allowlist. A dev browser has no legitimate need for any of them.
 */
const DENIED_SCHEMES = ['javascript:', 'data:', 'blob:'] as const

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
/**
 * `localhost:5173`, `127.0.0.1:8080`, `[::1]:3000`.
 *
 * These look like schemes to a regex but are host:port pairs, which is why
 * every bare host is routed through an explicit http:// prefix.
 */
const HOST_PORT_RE = /^(\[[\da-fA-F:]+]|localhost|[\w-]+(\.[\w-]+)+|\d{1,3}(\.\d{1,3}){3}):\d+(?=[/?#]|$)/

export type UrlResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * Turn whatever the agent typed into something Chromium can load.
 *
 * The agent writes `localhost:5173` far more often than `http://localhost:5173`,
 * and a bare `example.com` likewise. Rejecting those would make the tool feel
 * broken for the single most common case in local development.
 */
export function normalizeUrl(raw: string, base?: string): UrlResult {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { ok: true, url: 'about:blank' }

  const lowered = trimmed.toLowerCase()
  for (const scheme of DENIED_SCHEMES) {
    if (lowered.startsWith(scheme)) {
      return { ok: false, error: `The ${scheme} scheme is not allowed in a Cryptoric browser tab.` }
    }
  }

  const hasScheme = SCHEME_RE.test(trimmed)
  const isHostPort = HOST_PORT_RE.test(trimmed)

  // A relative reference with a base resolves against it. Prefixing `http://`
  // first would turn `settings` into the host `settings`, which is both a
  // different site and a silent failure.
  if (!hasScheme && !isHostPort && base) {
    try {
      return { ok: true, url: new URL(trimmed, base).toString() }
    } catch {
      return { ok: false, error: `Not a resolvable reference: ${trimmed}` }
    }
  }

  const candidate = hasScheme && !isHostPort ? trimmed : `http://${trimmed.replace(/^\/+/, '')}`

  try {
    const parsed = base ? new URL(candidate, base) : new URL(candidate)
    if (parsed.protocol === 'javascript:') {
      return { ok: false, error: 'javascript: URLs are not allowed.' }
    }
    return { ok: true, url: parsed.toString() }
  } catch {
    return { ok: false, error: `Not a loadable URL: ${trimmed}` }
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/** True for the developer's own machine — used to classify network results. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

const LOOPBACK_PREFIXES = ['http://localhost:', 'http://127.0.0.1:', 'http://[::1]:', 'https://localhost:']

/** Classify a URL as local development, so the agent can prioritise it. */
export function classifyTarget(url: string): 'local' | 'remote' | 'internal' {
  const lowered = url.toLowerCase()
  if (LOOPBACK_PREFIXES.some((p) => lowered.startsWith(p)) || isLoopbackUrl(url)) return 'local'
  if (lowered.startsWith('about:') || lowered.startsWith('file:') || lowered.startsWith('data:')) {
    return 'internal'
  }
  return 'remote'
}

/**
 * Chromium reports console levels numerically: 0 verbose, 1 info, 2 warning,
 * 3 error. Anything higher is an error too, so the mapping is not an equality
 * chain — a future level must degrade to the loudest bucket rather than
 * silently becoming "log".
 */
export function consoleLevel(level: number): 'error' | 'warning' | 'info' | 'log' {
  if (level >= 3) return 'error'
  if (level === 2) return 'warning'
  if (level === 1) return 'info'
  return 'log'
}

/** Console lines that indicate a real defect rather than ordinary output. */
export function isProblemEntry(entry: { level: string }): boolean {
  return entry.level === 'error' || entry.level === 'warning'
}

export interface ClipOutcome {
  value: string
  truncated: boolean
  originalLength: number
}

/** Clip with the provenance the agent needs to reason about the cut. */
export function clip(text: string, maxChars: number): ClipOutcome {
  if (text.length <= maxChars) return { value: text, truncated: false, originalLength: text.length }
  return {
    value: `${text.slice(0, maxChars)}\n… [${text.length - maxChars} more characters]`,
    truncated: true,
    originalLength: text.length
  }
}

export interface NetworkSummary {
  total: number
  byStatus: Record<string, number>
  failures: number
  slowest: { url: string; ms: number } | null
}

/**
 * Reduce a request log to the shape an agent actually reasons about.
 *
 * A dev-server page load routinely issues 60+ requests; handing all of them
 * back verbatim wastes the context window that the diagnosis needs.
 */
export function summarizeRequests(
  requests: { url: string; status: number | null }[],
  durations: Map<string, number>,
  failureCount: number
): NetworkSummary {
  const byStatus: Record<string, number> = {}
  let slowest: { url: string; ms: number } | null = null

  for (const request of requests) {
    const key = request.status === null ? 'failed' : String(request.status)
    byStatus[key] = (byStatus[key] ?? 0) + 1
    const ms = durations.get(request.url)
    if (ms !== undefined && (slowest === null || ms > slowest.ms)) slowest = { url: request.url, ms }
  }

  return { total: requests.length, byStatus, failures: failureCount, slowest }
}

/** Trailing-edge average, the number a developer actually sees in DevTools. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? 0
}