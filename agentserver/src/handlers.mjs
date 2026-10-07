/**
 * The agent server's HTTP surface.
 *
 * Framework-free and handler-shaped on purpose: `index.mjs` mounts it on a plain
 * `node:http` server for self-hosting, and `api/index.mjs` hands the same
 * function to Vercel. One implementation, two hosts, and no behaviour that only
 * exists in one of them.
 *
 * What the client may and may not decide:
 *
 *  - **The client may ask to be charged.** It may not state its own balance, its
 *    own price, or its own expiry — the server prices the session and the client
 *    receives what it is owed. A client that can post its own number has no
 *    balance system at all.
 *  - **Charging is idempotent** on the grant id, because a client that times out
 *    and retries is ordinary, not an attack.
 *  - **A banned account is refused everywhere**, including the balance endpoint,
 *    so a ban cannot be side-stepped by asking a different question.
 *  - **The client may not ban anyone.** A ban is the most destructive thing this
 *    server does, and the client token is baked into every installed copy of the
 *    app — so posting to the integrity endpoint takes a *second*, operator-only
 *    credential, and a server that was never given one has that endpoint
 *    switched off rather than left open. See `POST /v1/integrity` below.
 *  - **Repeating a request does not get cheaper.** Every route but `/health` is
 *    rate limited per caller (`limits.mjs`), because a shared token is the only
 *    credential this server has and guessing one is a matter of volume.
 */

import { createHash } from 'node:crypto'

import { availableBalance, DAILY_COINS } from './store.mjs'
import { createRateLimiter } from './limits.mjs'

/** Coins a model costs, and the minutes they buy. Kept in step with the app. */
export const PRICES = { own: 5, hosted: 10 }
export const MINUTES_PER_COIN = 6

/** Requests one caller may make per window, and how long the window is. */
export const GENERAL_LIMIT = 240
export const MUTATING_LIMIT = 60
export const RATE_WINDOW_MS = 60_000

export function json(res, status, body, { allowOrigin = '', headers = {} } = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
    ...(allowOrigin ? { 'access-control-allow-origin': allowOrigin } : {})
  })
  res.end(payload)
}

/**
 * Constant-time comparison.
 *
 * A check that returns early on the first differing byte leaks the token one
 * character at a time to anyone able to measure. Cheap to avoid.
 */
export function tokenMatches(provided, expected) {
  const a = Buffer.from(provided ?? '', 'utf8')
  const b = Buffer.from(expected ?? '', 'utf8')
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

export function bearerOf(req) {
  const header = req.headers?.authorization ?? ''
  if (header.startsWith('Bearer ')) return header.slice(7)
  const alt = req.headers?.['x-agent-token']
  return typeof alt === 'string' ? alt : ''
}

export function isAuthorized(req, expectedToken) {
  return tokenMatches(bearerOf(req), expectedToken)
}

/**
 * The address a request came from, as far as this process can honestly tell.
 *
 * `x-forwarded-for` is deliberately ignored. It is a header the caller writes,
 * so trusting it would let one caller present as thousands — and a rate-limit
 * key chosen by the party being limited is not a limit. Behind a proxy this
 * collapses every caller into one bucket, which throttles too broadly rather
 * than not at all; that is a proxy-configuration problem, not one a header this
 * server cannot verify should be allowed to solve.
 */
export function clientAddress(req) {
  return req.socket?.remoteAddress ?? 'unknown'
}

/** Read a body with a hard ceiling, so one request cannot exhaust memory. */
export async function readBody(req, limitBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('body is not JSON')
  }
}

/** Is this id shaped like something we issued? Anything else is a 400. */
export function looksLikeAccountId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value)
}

/**
 * Price a session and record the charge.
 *
 * The price comes from the tier the server maps the model to, never from the
 * request body. `modelId` is passed in by the caller from the catalogue, so a
 * client cannot invent a model priced at zero.
 */
export async function chargeForSession({ store, accountId, grantId, tier, model, now }) {
  const day = new Date(now).toISOString().slice(0, 10)
  const price = tier === 'own' ? PRICES.own : PRICES.hosted
  const account = await store.getAccount(accountId)
  if (!account) return { ok: false, status: 404, error: 'no such account' }
  if (await store.isBanned(accountId)) {
    return { ok: false, status: 403, error: 'This account is suspended.' }
  }

  const charges = await store.chargesFor(accountId)
  const already = charges.find((c) => c.id === grantId)
  if (already) {
    // Idempotent: the same grant is never charged twice, whatever the client
    // does. Reporting the original keeps the client's view of its own time true.
    return { ok: true, duplicate: true, charge: already, balance: availableBalance({ ...account, today: day, charges }) }
  }

  const balance = availableBalance({ ...account, today: day, charges })
  if (balance <= 0) {
    return { ok: false, status: 402, error: 'No coins left today. Your allowance refreshes tomorrow.' }
  }

  // A balance smaller than the price buys what it can pay for. Refusing outright
  // would leave someone with three coins unable to do anything at all.
  const charged = Math.min(price, balance)
  const charge = {
    id: grantId,
    accountId,
    coins: charged,
    minutes: charged * MINUTES_PER_COIN,
    model,
    day,
    at: new Date(now).toISOString()
  }
  await store.recordCharge(charge)
  return {
    ok: true,
    duplicate: false,
    charge,
    balance: availableBalance({ ...account, today: day, charges: [...charges, charge] })
  }
}

/**
 * Build the request handler.
 *
 * `routes` is injected so the same handler serves any store and any catalogue,
 * which is what lets the tests drive the real thing against a fake upstream.
 */
/**
 * @param {object} options
 * @param {import('./store.mjs').AccountStore} options.store
 * @param {string} options.token         Client credential, shipped in the app.
 * @param {any[]} [options.models]
 * @param {string} [options.allowOrigin]
 * @param {() => number} [options.now]
 * @param {string} [options.adminToken]  Operator credential. Required for bans.
 * @param {number} [options.generalLimit]
 * @param {number} [options.mutatingLimit]
 */
export function createHandler({
  store,
  token,
  models = [],
  allowOrigin = '',
  now = () => Date.now(),
  adminToken = '',
  generalLimit = GENERAL_LIMIT,
  mutatingLimit = MUTATING_LIMIT
}) {
  const tierFor = (modelId) => {
    const found = models.find((m) => m.id === modelId)
    return found?.byok === false ? 'hosted' : 'own'
  }

  const general = createRateLimiter({ limit: generalLimit, windowMs: RATE_WINDOW_MS, now })
  const mutating = createRateLimiter({ limit: mutatingLimit, windowMs: RATE_WINDOW_MS, now })

  /**
   * A ban needs a credential that is not the one every install carries.
   *
   * An admin token equal to the client token is not a second credential, it is
   * the same one under another name, so it counts as unconfigured.
   */
  const adminConfigured = typeof adminToken === 'string' && adminToken.length > 0
  const adminSeparate = adminConfigured && !tokenMatches(adminToken, token)

  /**
   * Which bucket this caller's requests are counted in.
   *
   * An authenticated caller is counted by *credential* and an anonymous one by
   * address, because those are the two things an attempt can honestly be
   * attributed to: counting a wrong guess by address is what makes a search
   * slow, and counting real traffic by credential is what makes abuse visible.
   * The token is hashed rather than stored, so the limiter's map never becomes a
   * list of live credentials.
   */
  const bucketFor = (req) => {
    const provided = bearerOf(req)
    const known = tokenMatches(provided, token) || (adminSeparate && tokenMatches(provided, adminToken))
    if (provided.length > 0 && known) {
      return `t:${createHash('sha256').update(provided).digest('hex').slice(0, 16)}`
    }
    return `a:${clientAddress(req)}`
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const send = (status, body, headers) =>
      json(res, status, body, { allowOrigin, ...(headers ? { headers } : {}) })

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...(allowOrigin ? { 'access-control-allow-origin': allowOrigin } : {}),
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS'
      })
      res.end()
      return
    }

    // Health is open on purpose: a host that cannot answer is not a reason to
    // issue a token to an anonymous caller. It is also the one route left
    // unmetered, so a platform health check cannot fail because the service is
    // busy serving someone else.
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      send(200, { ok: true, service: 'cryptoric-agent-server', models: models.length })
      return
    }

    // Metered *before* it is authorised: the counter must not depend on the
    // guess being right, or the search this exists to slow down is precisely the
    // traffic it never sees. Mutations get their own, tighter budget because
    // they are the ones that write.
    const key = bucketFor(req)
    const budget = general.check(key)
    if (!budget.allowed) {
      return send(429, { error: 'too many requests' }, { 'retry-after': String(budget.retryAfterSeconds) })
    }
    if (req.method === 'POST') {
      const mutation = mutating.check(`${key}:post`)
      if (!mutation.allowed) {
        return send(429, { error: 'too many requests' }, { 'retry-after': String(mutation.retryAfterSeconds) })
      }
    }

    const authorizedAsClient = isAuthorized(req, token)
    const authorizedAsAdmin = adminSeparate && isAuthorized(req, adminToken)
    const authorized = authorizedAsClient || authorizedAsAdmin

    if (req.method === 'GET' && path === '/v1/models') {
      if (!authorized) return send(401, { error: 'unauthorized' })
      send(200, { schemaVersion: 1, updatedAt: new Date(now()).toISOString(), models })
      return
    }

    if (!authorized) return send(401, { error: 'unauthorized' })

    try {
      if (req.method === 'POST' && path === '/v1/accounts') {
        const body = await readBody(req)
        if (!looksLikeAccountId(body.accountId)) {
          return send(400, { error: 'accountId must be 8-128 characters of A-Z a-z 0-9 _ -' })
        }
        const account = await store.ensureAccount({ id: body.accountId, displayName: body.displayName })
        if (await store.isBanned(account.id)) return send(403, { error: 'This account is suspended.' })
        const today = new Date(now()).toISOString().slice(0, 10)
        const charges = await store.chargesFor(account.id)
        return send(200, {
          accountId: account.id,
          balance: availableBalance({ ...account, today, charges }),
          dailyCoins: account.dailyCoins ?? DAILY_COINS
        })
      }

      if (req.method === 'GET' && path === '/v1/balance') {
        const accountId = url.searchParams.get('accountId') ?? ''
        if (!looksLikeAccountId(accountId)) return send(400, { error: 'accountId is required' })
        const account = await store.getAccount(accountId)
        if (!account) return send(404, { error: 'no such account' })
        if (await store.isBanned(accountId)) return send(403, { error: 'This account is suspended.' })
        const today = new Date(now()).toISOString().slice(0, 10)
        const charges = await store.chargesFor(accountId)
        return send(200, {
          accountId,
          balance: availableBalance({ ...account, today, charges }),
          dailyCoins: account.dailyCoins ?? DAILY_COINS
        })
      }

      if (req.method === 'POST' && path === '/v1/charge') {
        const body = await readBody(req)
        if (!looksLikeAccountId(body.accountId)) return send(400, { error: 'accountId is required' })
        if (typeof body.grantId !== 'string' || body.grantId.length < 8) {
          return send(400, { error: 'grantId is required so a retry cannot charge twice' })
        }
        if (typeof body.modelId !== 'string' || body.modelId.length === 0) {
          return send(400, { error: 'modelId is required' })
        }
        const result = await chargeForSession({
          store,
          accountId: body.accountId,
          grantId: body.grantId,
          tier: tierFor(body.modelId),
          model: body.modelId,
          now: now()
        })
        if (!result.ok) return send(result.status, { error: result.error })
        return send(200, {
          coins: result.charge.coins,
          minutes: result.charge.minutes,
          balance: result.balance,
          duplicate: result.duplicate
        })
      }

      if (req.method === 'POST' && path === '/v1/integrity') {
        // The watcher posts what it saw. A report is evidence, not a verdict:
        // it is recorded with its reasons and the ban is applied here, on the
        // server, because a client that can be patched cannot be trusted to
        // punish itself.
        //
        // Which is exactly why the client is not allowed to post it. This route
        // deletes an account, the client token is identical in every installed
        // copy of the app, and a secret that everyone holds authorises nobody —
        // otherwise anyone who read it out of their own copy could ban any other
        // user. The operator's separate token is required, and a server that was
        // never given one has this route switched off instead of open.
        if (!adminConfigured) {
          return send(403, {
            error: 'integrity reports are disabled on this server: no admin token is configured'
          })
        }
        if (!adminSeparate) {
          return send(403, {
            error: 'integrity reports are disabled on this server: the admin token must differ from the client token'
          })
        }
        if (!authorizedAsAdmin) return send(401, { error: 'unauthorized' })

        const body = await readBody(req)
        if (!looksLikeAccountId(body.accountId)) return send(400, { error: 'accountId is required' })
        const reasons = Array.isArray(body.reasons) ? body.reasons.slice(0, 10).map(String) : []
        if (reasons.length === 0) return send(400, { error: 'at least one reason is required' })
        await store.ban(body.accountId, reasons.join('; '))
        return send(200, { banned: true, reasons })
      }

      return send(404, { error: 'not found' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return send(message.includes('too large') ? 413 : 400, { error: message })
    }
  }
}
