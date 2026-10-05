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
 */

import { availableBalance, DAILY_COINS } from './store.mjs'

/** Coins a model costs, and the minutes they buy. Kept in step with the app. */
export const PRICES = { own: 5, hosted: 10 }
export const MINUTES_PER_COIN = 6

export function json(res, status, body, { allowOrigin = '' } = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
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
 * @param {string} options.token
 * @param {any[]} [options.models]
 * @param {string} [options.allowOrigin]
 * @param {() => number} [options.now]
 */
export function createHandler({ store, token, models = [], allowOrigin = '', now = () => Date.now() }) {
  const tierFor = (modelId) => {
    const found = models.find((m) => m.id === modelId)
    return found?.byok === false ? 'hosted' : 'own'
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const send = (status, body) => json(res, status, body, { allowOrigin })

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
    // issue a token to an anonymous caller.
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      send(200, { ok: true, service: 'cryptoric-agent-server', models: models.length })
      return
    }

    if (req.method === 'GET' && path === '/v1/models') {
      if (!isAuthorized(req, token)) return send(401, { error: 'unauthorized' })
      send(200, { schemaVersion: 1, updatedAt: new Date(now()).toISOString(), models })
      return
    }

    if (!isAuthorized(req, token)) return send(401, { error: 'unauthorized' })

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