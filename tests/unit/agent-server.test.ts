/**
 * The agent server, driven over a real socket.
 *
 * Every test here starts the actual handler on a loopback port and fetches it.
 * A hand-written fake of this server would only prove the fake agrees with
 * itself; the rules that matter — an unauthenticated caller gets nothing, a
 * client cannot state its own price, a retry cannot charge twice, a ban holds on
 * every endpoint — are properties of the real request path.
 */

import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { createHandler, tokenMatches, looksLikeAccountId } from '../../agentserver/src/handlers.mjs'
import { MemoryStore, availableBalance, DAILY_COINS, SIGNUP_COINS } from '../../agentserver/src/store.mjs'
import { readCatalogueFile } from '../../agentserver/src/catalogue.mjs'

const TOKEN = 'test-token-abcdef123456'
const ACCOUNT = 'acct_00000001'

const MODELS = [
  { id: 'own-model', label: 'Own', description: '', contextWindow: 0, byok: true },
  { id: 'paid-model', label: 'Paid', description: '', contextWindow: 0, byok: false }
]

const servers: { close(): void }[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

async function start(overrides: Record<string, unknown> = {}): Promise<{ url: string; store: MemoryStore }> {
  const store = new MemoryStore()
  const handler = createHandler({ store, token: TOKEN, models: MODELS, ...overrides })
  const server = createServer((req, res) => void handler(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, store }
}

async function call(
  url: string,
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }),
      'content-type': 'application/json'
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

describe('the balance is derived, never stored', () => {
  const today = '2026-10-05'

  it('gives the signup grant on the first day only', () => {
    expect(availableBalance({ signupDay: today, today, charges: [] })).toBe(SIGNUP_COINS)
    expect(availableBalance({ signupDay: '2026-10-04', today, charges: [] })).toBe(DAILY_COINS)
  })

  it('subtracts what was charged today', () => {
    const balance = availableBalance({
      signupDay: '2026-10-04',
      today,
      charges: [
        { day: today, coins: 5 },
        { day: '2026-10-04', coins: 10 }
      ]
    })
    // Yesterday's charge is yesterday's problem.
    expect(balance).toBe(DAILY_COINS - 5)
  })

  it('never goes negative', () => {
    expect(availableBalance({ signupDay: '2026-10-04', today, charges: [{ day: today, coins: 999 }] })).toBe(0)
  })
})

describe('authentication', () => {
  it('compares in constant time and rejects a near miss', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false)
    expect(tokenMatches('', TOKEN)).toBe(false)
    expect(tokenMatches(undefined, TOKEN)).toBe(false)
  })

  it('answers health without a token, and nothing else', async () => {
    const { url } = await start()
    expect((await call(url, '/health', { token: null })).status).toBe(200)
    // A host that cannot answer is no reason to issue a token to a stranger.
    expect((await call(url, '/v1/models', { token: null })).status).toBe(401)
    expect((await call(url, '/v1/balance?accountId=' + ACCOUNT, { token: null })).status).toBe(401)
  })

  it('refuses every endpoint to a wrong token', async () => {
    const { url } = await start()
    expect((await call(url, '/v1/models', { token: 'nope' })).status).toBe(401)
    expect((await call(url, '/v1/balance?accountId=' + ACCOUNT, { token: 'nope' })).status).toBe(401)
    expect(
      (await call(url, '/v1/charge', { method: 'POST', token: 'nope', body: { accountId: ACCOUNT, grantId: 'g-123456', modelId: 'own-model' } })).status
    ).toBe(401)
  })

  it('rejects an account id that is not shaped like one we issued', () => {
    expect(looksLikeAccountId('acct_00000001')).toBe(true)
    expect(looksLikeAccountId('../../etc/passwd')).toBe(false)
    expect(looksLikeAccountId('short')).toBe(false)
    expect(looksLikeAccountId('')).toBe(false)
  })
})

describe('accounts and balances survive everything local', () => {
  it('creates an account and reports the signup grant', async () => {
    const { url } = await start()
    const created = await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    expect(created.status).toBe(200)
    expect(created.body.balance).toBe(SIGNUP_COINS)
  })

  it('returns the same balance on another device', async () => {
    const { url } = await start()
    await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    await call(url, '/v1/charge', { method: 'POST', body: { accountId: ACCOUNT, grantId: 'grant-0001', modelId: 'own-model' } })
    // Nothing local is involved: this is the second read, and it is the same
    // number, which is what "survives uninstall" has to mean.
    const balance = await call(url, `/v1/balance?accountId=${ACCOUNT}`)
    expect(balance.body.balance).toBe(SIGNUP_COINS - 5)
  })

  it('404s an account it has never seen', async () => {
    const { url } = await start()
    expect((await call(url, '/v1/balance?accountId=acct_99999999')).status).toBe(404)
  })
})

describe('charging', () => {
  it('prices a BYOK model at 5 coins for 30 minutes', async () => {
    const { url } = await start()
    await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    const res = await call(url, '/v1/charge', {
      method: 'POST',
      body: { accountId: ACCOUNT, grantId: 'grant-0001', modelId: 'own-model' }
    })
    expect(res.status).toBe(200)
    expect(res.body.coins).toBe(5)
    expect(res.body.minutes).toBe(30)
  })

  it('prices a model this project pays for at 10', async () => {
    const { url } = await start()
    await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    const res = await call(url, '/v1/charge', {
      method: 'POST',
      body: { accountId: ACCOUNT, grantId: 'grant-0002', modelId: 'paid-model' }
    })
    expect(res.body.coins).toBe(10)
    expect(res.body.minutes).toBe(60)
  })

  it('ignores a price the client tries to state', async () => {
    const { url } = await start()
    await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    const res = await call(url, '/v1/charge', {
      method: 'POST',
      body: { accountId: ACCOUNT, grantId: 'grant-0003', modelId: 'paid-model', coins: 1, minutes: 600 }
    })
    // The client's numbers are not read at all.
    expect(res.body.coins).toBe(10)
    expect(res.body.minutes).toBe(60)
  })

  it('never charges the same grant twice', async () => {
    const { url } = await start()
    await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    const body = { accountId: ACCOUNT, grantId: 'grant-0004', modelId: 'own-model' }
    const first = await call(url, '/v1/charge', { method: 'POST', body })
    const second = await call(url, '/v1/charge', { method: 'POST', body })
    // A client that times out and retries is ordinary, not an attack.
    expect(first.body.duplicate).toBe(false)
    expect(second.body.duplicate).toBe(true)
    expect(second.body.balance).toBe(SIGNUP_COINS - 5)
  })

  it('refuses when the balance is empty, with the reason', async () => {
    const { url, store } = await start()
    await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    await store.ban
    await store.recordCharge({ id: 'spent', accountId: ACCOUNT, coins: 999, minutes: 0, model: 'm', day: new Date().toISOString().slice(0, 10), at: '' })
    const res = await call(url, '/v1/charge', { method: 'POST', body: { accountId: ACCOUNT, grantId: 'grant-0005', modelId: 'own-model' } })
    expect(res.status).toBe(402)
    expect(res.body.error).toMatch(/no coins left/i)
  })

  it('buys what a short balance can pay for rather than refusing', async () => {
    const { url } = await start()
    await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    await call(url, '/v1/charge', { method: 'POST', body: { accountId: ACCOUNT, grantId: 'grant-a1', modelId: 'own-model' } })
    await call(url, '/v1/charge', { method: 'POST', body: { accountId: ACCOUNT, grantId: 'grant-b2', modelId: 'own-model' } })
    await call(url, '/v1/charge', { method: 'POST', body: { accountId: ACCOUNT, grantId: 'grant-c3', modelId: 'own-model' } })
    await call(url, '/v1/charge', { method: 'POST', body: { accountId: ACCOUNT, grantId: 'grant-d4', modelId: 'own-model' } })
    // 25 coins, four charges of 5.
    const last = await call(url, '/v1/charge', { method: 'POST', body: { accountId: ACCOUNT, grantId: 'grant-e5', modelId: 'paid-model' } })
    expect(last.status).toBe(200)
    expect(last.body.coins).toBe(5)
    expect(last.body.balance).toBe(0)
  })

  it('requires a grant id', async () => {
    const { url } = await start()
    await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    const res = await call(url, '/v1/charge', { method: 'POST', body: { accountId: ACCOUNT, modelId: 'own-model' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/grantId/)
  })

  it('prices an unknown model at the BYOK rate, never at zero', async () => {
    const { url } = await start()
    await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    const res = await call(url, '/v1/charge', { method: 'POST', body: { accountId: ACCOUNT, grantId: 'grant-0009', modelId: 'never-heard-of-it' } })
    expect(res.body.coins).toBeGreaterThanOrEqual(5)
  })
})

describe('the watcher', () => {
  it('records a report and bans the account', async () => {
    const { url, store } = await start()
    await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    const res = await call(url, '/v1/integrity', {
      method: 'POST',
      body: { accountId: ACCOUNT, reasons: ['debugger attached', 'asar integrity mismatch'] }
    })
    expect(res.status).toBe(200)
    expect(await store.isBanned(ACCOUNT)).toBe(true)
  })

  it('refuses a banned account everywhere, not just the agent', async () => {
    const { url } = await start()
    await call(url, '/v1/accounts', { method: 'POST', body: { accountId: ACCOUNT } })
    await call(url, '/v1/integrity', { method: 'POST', body: { accountId: ACCOUNT, reasons: ['tampered'] } })
    // A ban that only bites on one endpoint is side-stepped by asking another.
    expect((await call(url, '/v1/balance?accountId=' + ACCOUNT)).status).toBe(403)
    expect((await call(url, '/v1/charge', { method: 'POST', body: { accountId: ACCOUNT, grantId: 'grant-x9', modelId: 'own-model' } })).status).toBe(403)
  })

  it('demands a reason rather than banning on a shrug', async () => {
    const { url, store } = await start()
    const res = await call(url, '/v1/integrity', { method: 'POST', body: { accountId: ACCOUNT, reasons: [] } })
    expect(res.status).toBe(400)
    expect(await store.isBanned(ACCOUNT)).toBe(false)
  })
})

describe('robustness', () => {
  it('caps the body rather than buffering it', async () => {
    const { url } = await start()
    const res = await call(url, '/v1/integrity', {
      method: 'POST',
      body: { accountId: ACCOUNT, reasons: ['x'.repeat(200_000)] }
    })
    expect([413, 400]).toContain(res.status)
  })

  it('refuses a body that is not JSON', async () => {
    const { url } = await start()
    const res = await fetch(`${url}/v1/accounts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'not json'
    })
    expect(res.status).toBe(400)
  })

  it('404s a route it does not have', async () => {
    const { url } = await start()
    expect((await call(url, '/v1/nope')).status).toBe(404)
  })
})

describe('the catalogue', () => {
  it('returns an empty list for a file it cannot read', async () => {
    // Falling back to a default list would ship prices nobody chose.
    expect(readCatalogueFile('C:/definitely/not/here.json')).toEqual([])
  })

  it('normalises a model file', () => {
    const models = readCatalogueFile('agentserver/test/catalogue.fixture.json')
    expect(models).toEqual([
      { id: 'fixture-model', label: 'Fixture', description: 'for tests', contextWindow: 32000, byok: true }
    ])
  })

  it('publishes it to an authenticated caller', async () => {
    const { url } = await start()
    const res = await call(url, '/v1/models')
    expect(res.status).toBe(200)
    expect(res.body.models).toHaveLength(2)
  })
})