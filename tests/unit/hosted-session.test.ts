/**
 * `hosted` mode, end to end, against the real server.
 *
 * The point of hosted mode is that the balance is somebody else's. That is easy
 * to claim and easy to fake, so these tests start the actual handler on a
 * loopback port and drive it through the app's own client and billing gate.
 *
 * What is asserted, and why each one matters:
 *   - a charge buys the time the *server* priced, not a locally computed one;
 *   - an unreachable server refuses the task instead of quietly running it free;
 *   - nobody signed in means no task, not a local fallback;
 *   - a resumed task costs nothing and sends no request at all;
 *   - a half-configured build is blocked rather than downgraded to local.
 */

import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { createHandler } from '../../agentserver/src/handlers.mjs'
import { MemoryStore } from '../../agentserver/src/store.mjs'
import { AgentServerClient, serverConfigFrom } from '../../src/main/services/server/client'
import { beginSession, SIGN_IN_REQUIRED } from '../../src/main/services/session/charge'
import { readStoredAccountId } from '../../src/main/services/auth/session-store'
import { grantFromCharge } from '../../src/shared/session-time'
import type { SessionGrant } from '../../src/shared/session-time'

const TOKEN = 'client-token-abcdef123456'
const WRONG_TOKEN = 'not-the-token-abcdef123456'
const ACCOUNT = 'acct_00000001'
const MODEL = 'own-model'

const MODELS = [
  { id: 'own-model', label: 'Own', description: '', contextWindow: 0, byok: true },
  { id: 'paid-model', label: 'Paid', description: '', contextWindow: 0, byok: false }
]

const servers: { close(): void }[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

async function startServer(overrides: Record<string, unknown> = {}): Promise<{ url: string; store: MemoryStore }> {
  const store = new MemoryStore()
  const handler = createHandler({ store, token: TOKEN, models: MODELS, ...overrides })
  const server = createServer((req, res) => void handler(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, store }
}

function client(url: string, token = TOKEN, timeoutMs = 5_000): AgentServerClient {
  return new AgentServerClient({ config: { url, token }, timeoutMs })
}

const TASK = { id: 'task_00000001', projectRoot: 'C:/work/project', prompt: 'Build a thing' }

describe('reading the server settings', () => {
  it('has no server at all in local mode', () => {
    const resolved = serverConfigFrom({ AGENT_SERVER_URL: 'https://x.example', AGENT_SERVER_TOKEN: 't' }, 'local')
    expect(resolved).toEqual({ ok: true, config: null })
  })

  it('refuses hosted without a URL, and hosted without a token', () => {
    expect(serverConfigFrom({}, 'hosted')).toMatchObject({ ok: false })
    expect(serverConfigFrom({ AGENT_SERVER_URL: 'https://x.example' }, 'hosted')).toMatchObject({ ok: false })
    const withBoth = serverConfigFrom({ AGENT_SERVER_URL: 'https://x.example/', AGENT_SERVER_TOKEN: ' abc ' }, 'hosted')
    expect(withBoth).toEqual({ ok: true, config: { url: 'https://x.example', token: 'abc' } })
  })

  it('rejects a URL that is not http(s)', () => {
    expect(serverConfigFrom({ AGENT_SERVER_URL: 'ftp://x.example', AGENT_SERVER_TOKEN: 't' }, 'hosted')).toMatchObject({
      ok: false
    })
  })
})

describe('the client against the real server', () => {
  it('creates the account and reports the signup coins', async () => {
    const { url } = await startServer()
    const result = await client(url).ensureAccount(ACCOUNT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.balance).toBeGreaterThan(0)
    expect(result.value.accountId).toBe(ACCOUNT)
  })

  it('buys 30 minutes for a 5-coin model and reports the new balance', async () => {
    const { url } = await startServer()
    const api = client(url)
    await api.ensureAccount(ACCOUNT)

    const charged = await api.charge({ accountId: ACCOUNT, grantId: 'grant_00000001', modelId: MODEL })
    expect(charged.ok).toBe(true)
    if (!charged.ok) return
    expect(charged.value.coins).toBe(5)
    expect(charged.value.minutes).toBe(30)
    expect(charged.value.duplicate).toBe(false)
    expect(charged.value.balance).toBeGreaterThanOrEqual(0)

    // And the charge is visible from a fresh read, which is what proves it was
    // recorded rather than merely returned.
    const balance = await api.balance(ACCOUNT)
    expect(balance.ok).toBe(true)
    if (!balance.ok) return
    expect(balance.value.balance).toBe(charged.value.balance)
  })

  it('charges a retry of the same grant only once', async () => {
    const { url } = await startServer()
    const api = client(url)
    await api.ensureAccount(ACCOUNT)
    const first = await api.charge({ accountId: ACCOUNT, grantId: 'grant_retry', modelId: MODEL })
    const second = await api.charge({ accountId: ACCOUNT, grantId: 'grant_retry', modelId: MODEL })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.duplicate).toBe(true)
    expect(second.value.balance).toBe(first.value.balance)
  })

  it('is refused with the wrong token, and says so without naming either', async () => {
    const { url } = await startServer()
    const result = await client(url, WRONG_TOKEN).balance(ACCOUNT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(401)
    expect(result.error).not.toContain(TOKEN)
    expect(result.error).not.toContain(WRONG_TOKEN)
  })

  it('reports an unreachable server instead of throwing', async () => {
    // Port 1 is privileged, so nothing is listening: a real failure, not a mock.
    const api = new AgentServerClient({ config: { url: 'http://127.0.0.1:1', token: TOKEN }, timeoutMs: 2_000 })
    const result = await api.balance(ACCOUNT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/could not be reached|timed out/i)
    expect(result.error).not.toContain(TOKEN)
  })

  it('refuses a charge answer it cannot read, rather than inventing coins', async () => {
    // A server that answers 200 with the wrong shape must not become a grant.
    const liar = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ coins: 'lots', minutes: null }))
    })
    servers.push(liar)
    await new Promise<void>((resolve) => liar.listen(0, '127.0.0.1', resolve))
    const address = liar.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const result = await client(`http://127.0.0.1:${address.port}`).charge({
      accountId: ACCOUNT,
      grantId: 'grant_liar',
      modelId: MODEL
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/cannot read/i)
  })
})

describe('a grant built from a server price', () => {
  it('uses the numbers it was given', () => {
    const now = Date.UTC(2026, 9, 5, 12, 0, 0)
    const result = grantFromCharge({
      id: 'g1',
      model: MODEL,
      coins: 5,
      minutes: 30,
      now,
      projectRoot: 'C:/work',
      prompt: 'hello'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grant.coins).toBe(5)
    expect(result.grant.minutes).toBe(30)
    expect(result.grant.expiresAt).toBe(now + 30 * 60_000)
    expect(result.grant.consumed).toBe(false)
  })

  it('refuses a charge that bought nothing', () => {
    for (const coins of [0, -3, Number.NaN]) {
      const result = grantFromCharge({
        id: 'g2',
        model: MODEL,
        coins,
        minutes: 30,
        now: Date.now(),
        projectRoot: '',
        prompt: ''
      })
      expect(result.ok).toBe(false)
    }
  })
})

describe('the billing gate', () => {
  it('bills the server in hosted mode and uses its price', async () => {
    const { url } = await startServer()
    const server = client(url)
    await server.ensureAccount(ACCOUNT)
    const recorded: SessionGrant[] = []

    const result = await beginSession(
      {
        mode: 'hosted',
        server,
        blockedReason: null,
        accountId: async () => ACCOUNT,
        // Would allow six sessions. If the gate used this, the test would not
        // notice the server had been bypassed, so it is deliberately tiny.
        localBalance: () => 1,
        record: async (grant) => {
          recorded.push(grant)
        },
        model: () => MODEL,
        tier: () => 'own'
      },
      TASK,
      null
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grant.coins).toBe(5)
    expect(result.grant.minutes).toBe(30)
    // Recorded locally too: that record is what makes an interrupted session
    // resumable without asking the server to remember our prompts.
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.id).toBe(TASK.id)
  })

  it('will not run a hosted task without somebody signed in', async () => {
    const { url } = await startServer()
    const result = await beginSession(
      {
        mode: 'hosted',
        server: client(url),
        blockedReason: null,
        accountId: async () => null,
        localBalance: () => 100,
        record: async () => {
          throw new Error('must not record a grant nobody paid for')
        },
        model: () => MODEL,
        tier: () => 'own'
      },
      TASK,
      null
    )
    expect(result).toEqual({ ok: false, error: SIGN_IN_REQUIRED })
  })

  it('refuses when the server cannot be reached, rather than running for free', async () => {
    // The failure mode this guards against: unplug the network, get an agent.
    const unreachable = new AgentServerClient({
      config: { url: 'http://127.0.0.1:1', token: TOKEN },
      timeoutMs: 2_000
    })
    const result = await beginSession(
      {
        mode: 'hosted',
        server: unreachable,
        blockedReason: null,
        accountId: async () => ACCOUNT,
        localBalance: () => 100,
        record: async () => {
          throw new Error('must not record a grant nobody paid for')
        },
        model: () => MODEL,
        tier: () => 'own'
      },
      TASK,
      null
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/could not be reached|timed out/i)
  })

  it('blocks a half-configured build instead of downgrading it to local', async () => {
    let charged = false
    const result = await beginSession(
      {
        mode: 'local',
        server: null,
        blockedReason: 'AGENT_SERVER_URL is set but CRYPTORIC_MODE is not.',
        accountId: async () => ACCOUNT,
        localBalance: () => 100,
        record: async () => {
          charged = true
        },
        model: () => MODEL,
        tier: () => 'own'
      },
      TASK,
      null
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/CRYPTORIC_MODE/)
    expect(charged).toBe(false)
  })

  it('charges a resumed task nothing and asks the server nothing', async () => {
    const { url, store } = await startServer()
    await client(url).ensureAccount(ACCOUNT)
    const before = await client(url).balance(ACCOUNT)

    const now = Date.now()
    const live: SessionGrant = {
      id: 'grant_resumed',
      model: MODEL,
      coins: 5,
      minutes: 30,
      startedAt: now - 60_000,
      expiresAt: now + 29 * 60_000,
      day: new Date(now).toISOString().slice(0, 10),
      projectRoot: TASK.projectRoot,
      prompt: TASK.prompt,
      consumed: false
    }

    const result = await beginSession(
      {
        mode: 'hosted',
        server: client(url),
        blockedReason: null,
        accountId: async () => ACCOUNT,
        localBalance: () => 0,
        record: async () => {
          throw new Error('a resumed task must not be recorded again')
        },
        model: () => MODEL,
        tier: () => 'own'
      },
      TASK,
      live,
      now
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grant.id).toBe('grant_resumed')
    // Unchanged on the server, and no new charge was recorded there.
    const after = await client(url).balance(ACCOUNT)
    expect(after.ok && before.ok && after.value.balance).toBe(before.ok ? before.value.balance : -1)
    expect(await store.chargesFor(ACCOUNT)).toHaveLength(0)
  })

  it('prices a local task from the local balance and never calls a server', async () => {
    let serverTouched = false
    const result = await beginSession(
      {
        mode: 'local',
        server: {
          charge: async () => {
            serverTouched = true
            return { ok: false, status: 500, error: 'should not be called' }
          }
        } as never,
        blockedReason: null,
        accountId: async () => null,
        localBalance: () => 25,
        record: async () => {},
        model: () => MODEL,
        tier: () => 'hosted'
      },
      TASK,
      null
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 10 coins for a model Cryptoric pays for, 60 minutes, 15 left over.
    expect(result.grant.coins).toBe(10)
    expect(result.grant.minutes).toBe(60)
    expect(result.remainingCoins).toBe(15)
    expect(serverTouched).toBe(false)
  })
})

describe('reading the account id out of the credential store', () => {
  it('takes the id from a stored session', () => {
    const raw = JSON.stringify({ summary: { accountId: ACCOUNT }, secrets: { refreshToken: 'r' } })
    expect(readStoredAccountId(raw)).toBe(ACCOUNT)
  })

  it('treats anything unreadable as signed out', () => {
    // A wrong id would bill somebody else's balance, so every odd shape is
    // "no account" rather than a guess.
    expect(readStoredAccountId(null)).toBeNull()
    expect(readStoredAccountId('not json')).toBeNull()
    expect(readStoredAccountId('{}')).toBeNull()
    expect(readStoredAccountId(JSON.stringify({ summary: {} }))).toBeNull()
    expect(readStoredAccountId(JSON.stringify({ summary: { accountId: 'short' } }))).toBeNull()
    expect(readStoredAccountId(JSON.stringify({ summary: { accountId: 42 } }))).toBeNull()
  })
})
