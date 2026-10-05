/**
 * Cryptoric model provider server.
 *
 * Publishes a catalogue of models to every Cryptoric install that points at
 * this URL, and optionally proxies chat completions to whatever upstream you
 * run. No dependencies: `node:http` only, so it deploys anywhere Node runs and
 * the repository grows no supply chain.
 *
 * Endpoints:
 *   GET  /v1/models            the catalogue
 *   POST /v1/chat/completions  proxied upstream, when UPSTREAM_BASE_URL is set
 *   GET  /healthz              liveness, unauthenticated
 *
 * Security, stated because it is the whole risk of running this:
 *
 *  - **The token is mandatory.** There is no default secret. If `PROVIDER_TOKEN`
 *    is unset the server refuses to start rather than serving an open catalogue
 *    and an open proxy to anyone who found the address.
 *  - **The upstream key never reaches a client.** When proxying, the upstream
 *    credential stays here. Clients receive a catalogue and a bearer token for
 *    this server, not your upstream key.
 *  - **CORS is off by default.** A browser on another origin cannot read the
 *    catalogue unless you set `ALLOW_ORIGIN`.
 *
 * Run:
 *   PROVIDER_TOKEN=... UPSTREAM_BASE_URL=https://... node server/index.mjs
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8788)
const TOKEN = process.env.PROVIDER_TOKEN ?? ''
const UPSTREAM = process.env.UPSTREAM_BASE_URL ?? ''
const UPSTREAM_KEY = process.env.UPSTREAM_API_KEY ?? ''
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? ''

/**
 * The catalogue. Override with `CATALOGUE_PATH=/path/to/catalogue.json` to
 * publish your own without editing this file.
 */
const DEFAULT_CATALOGUE = {
  schemaVersion: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  models: [
    {
      id: 'cryptoric-mini',
      label: 'Cryptoric Mini',
      description: 'Fast, cheap, good for routine edits.',
      contextWindow: 128000,
      byok: false
    },
    {
      id: 'cryptoric-max',
      label: 'Cryptoric Max',
      description: 'The strongest model on this server.',
      contextWindow: 200000,
      byok: false
    }
  ]
}

if (!TOKEN) {
  console.error('refusing to start: PROVIDER_TOKEN is required.')
  console.error('An unauthenticated provider server is an open proxy to your upstream key.')
  process.exit(1)
}

let catalogue = DEFAULT_CATALOGUE

if (process.env.CATALOGUE_PATH) {
  const { readFileSync } = await import('node:fs')
  const raw = JSON.parse(readFileSync(process.env.CATALOGUE_PATH, 'utf8'))
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    console.error('refusing to start: CATALOGUE_PATH has no models.')
    process.exit(1)
  }
  catalogue = raw
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...(ALLOW_ORIGIN ? { 'access-control-allow-origin': ALLOW_ORIGIN } : {})
  })
  res.end(payload)
}

/**
 * Constant-time comparison.
 *
 * A token check that returns early on the first differing byte leaks the token
 * one character at a time to anyone who can measure. Cheap to avoid.
 */
function tokenMatches(provided) {
  const a = Buffer.from(provided ?? '', 'utf8')
  const b = Buffer.from(TOKEN, 'utf8')
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

function authorized(req) {
  const header = req.headers.authorization ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const alt = typeof req.headers['x-provider-token'] === 'string' ? req.headers['x-provider-token'] : ''
  return tokenMatches(bearer) || tokenMatches(alt)
}

async function readBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // Without a ceiling, one request can exhaust the server's memory.
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function handleCompletions(req, res) {
  if (!UPSTREAM) {
    return json(res, 501, {
      error: 'This server publishes a catalogue only; set UPSTREAM_BASE_URL to enable proxying.'
    })
  }

  let body
  try {
    body = await readBody(req)
  } catch (e) {
    return json(res, 413, { error: e instanceof Error ? e.message : String(e) })
  }

  try {
    const upstream = await fetch(`${UPSTREAM.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(UPSTREAM_KEY ? { authorization: `Bearer ${UPSTREAM_KEY}` } : {})
      },
      body,
      signal: AbortSignal.timeout(120_000)
    })
    const payload = await upstream.text()
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'content-length': Buffer.byteLength(payload)
    })
    res.end(payload)
  } catch (e) {
    // The upstream's message is not echoed to the client: it can contain the
    // upstream key in a URL or a header dump.
    json(res, 502, { error: 'Upstream request failed', detail: e instanceof Error ? e.name : 'unknown' })
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/healthz') {
    return json(res, 200, { ok: true, proxying: Boolean(UPSTREAM), models: catalogue.models.length })
  }

  if (!authorized(req)) {
    // 401 rather than 403: the credential is absent or wrong, not merely
    // insufficient.
    return json(res, 401, { error: 'unauthorized' })
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return json(res, 200, catalogue)
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return handleCompletions(req, res)
  }

  return json(res, 404, { error: 'not found' })
})

server.listen(PORT, () => {
  console.log(`cryptoric provider server on :${PORT}`)
  console.log(`  models   ${catalogue.models.length}`)
  console.log(`  proxying ${UPSTREAM ? UPSTREAM : 'no (catalogue only)'}`)
})
