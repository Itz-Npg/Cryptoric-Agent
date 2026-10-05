/**
 * The MongoDB store's adapter, against a stubbed Data API.
 *
 * This does **not** test MongoDB. It tests the part that is ours and the part
 * that breaks silently: which URL we build, what we send, and what we do when
 * the database is unreachable or says no. A real Atlas connection is not
 * something CI can hold, so pretending otherwise would be the worse choice.
 *
 * The default store is the in-memory one, and every behaviour test elsewhere
 * runs against that. These exist so the Mongo path is not merely plausible.
 */

import { describe, expect, it, vi } from 'vitest'

import { createMongoStore, DEFAULT_API_BASE } from '../../agentserver/src/mongo.mjs'

interface Call {
  url: string
  body: any
}

/**
 * A Data API that answers whatever the test tells it to.
 *
 * Replies are keyed by the *action* in the URL — `findOne`, `insertOne` — not by
 * call number. Keying by index made a test assert on the read that happens
 * *before* a write, which passes or fails for reasons unrelated to what it
 * claims to check.
 */
function stubDataApi(replies: Record<string, unknown> = {}, failWith?: { status: number; body: string }) {
  const calls: (Call & { action: string })[] = []
  // The same signature as real `fetch`, because that is what it stands in for;
  // a narrower one would let the stub pass a type the server could never call.
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const action = url.split('/').pop() ?? ''
    calls.push({ url, action, body: JSON.parse(String(init?.body)) })
    if (failWith) {
      return new Response(failWith.body, { status: failWith.status })
    }
    const reply = replies[action] ?? { document: null, documents: [] }
    return new Response(JSON.stringify(reply), { status: 200 })
  })
  return { fetchImpl, calls, callFor: (action: string) => calls.find((c) => c.action === action) }
}

describe('choosing an endpoint', () => {
  it('builds the region-scoped Data API URL', async () => {
    const { fetchImpl, calls } = stubDataApi({ findOne: { document: null } })
    const previous = process.env.MONGODB_REGION
    process.env.MONGODB_REGION = 'eu-west-1'
    try {
      const store = createMongoStore('mongodb+srv://cluster.mongodb.net', { fetchImpl })
      await store.getAccount('acct_00000001')
      expect(calls[0]?.url).toContain('eu-west-1.data.mongodb.net')
      expect(DEFAULT_API_BASE).toContain('${region}')
    } finally {
      if (previous === undefined) delete process.env.MONGODB_REGION
      else process.env.MONGODB_REGION = previous
    }
  })

  it('uses an https Data API URL as given', async () => {
    const { fetchImpl, calls } = stubDataApi({ findOne: { document: null } })
    const store = createMongoStore('https://gateway.internal/data', { fetchImpl })
    await store.getAccount('acct_00000001')
    expect(calls[0]?.url).toContain('https://gateway.internal/data')
  })

  it('refuses a mongodb URI with no region, and says why', () => {
    const previous = process.env.MONGODB_REGION
    delete process.env.MONGODB_REGION
    try {
      const { fetchImpl } = stubDataApi()
      // Silently guessing a region would send every balance to the wrong
      // cluster, which is worse than refusing to start.
      expect(() => createMongoStore('mongodb+srv://cluster.mongodb.net', { fetchImpl })).toThrow(/MONGODB_REGION/)
    } finally {
      if (previous !== undefined) process.env.MONGODB_REGION = previous
    }
  })
})

describe('talking to it', () => {
  it('sends the key as api-key and the document in the body', async () => {
    const { fetchImpl, calls } = stubDataApi({ findOne: { document: { _id: 'acct_00000001', signupDay: 'x', dailyCoins: 20 } } })
    const store = createMongoStore('https://gateway.internal/data', { fetchImpl })
    const account = await store.getAccount('acct_00000001')
    expect(account?.id).toBe('acct_00000001')
    expect(calls[0]?.body).toEqual({ filter: { _id: 'acct_00000001' } })
    expect(calls[0]?.action).toBe('findOne')
  })

  it('names the account `id`, which is what every consumer reads', async () => {
    const { fetchImpl } = stubDataApi({
      findOne: { document: { _id: 'acct_00000001', signupDay: '2026-10-05', dailyCoins: 20 } }
    })
    const store = createMongoStore('https://gateway.internal/data', { fetchImpl })
    const account = await store.getAccount('acct_00000001')
    // Mongo says `_id`; the balance code and /v1/accounts say `id`. Getting this
    // wrong makes the server create accounts it cannot name.
    expect(account?.id).toBe('acct_00000001')
    expect(account?.signupDay).toBe('2026-10-05')
  })

  it('stores a charge under its own id so a repeat is visible', async () => {
    const { fetchImpl, calls } = stubDataApi({ findOne: { document: null }, insertOne: { insertedId: 'grant-0001' } })
    const store = createMongoStore('https://gateway.internal/data', { fetchImpl })
    const charge = {
      id: 'grant-0001',
      accountId: 'acct_00000001',
      coins: 5,
      minutes: 30,
      model: 'm',
      day: '2026-10-05',
      at: ''
    }
    await store.recordCharge(charge)
    // The write, not the existence check that runs before it.
    expect(calls.find((c) => c.action === 'insertOne')?.body.document._id).toBe('grant-0001')
  })

  it('reports a repeat rather than charging twice', async () => {
    const { fetchImpl } = stubDataApi({ findOne: { document: { _id: 'grant-0001' } } })
    const store = createMongoStore('https://gateway.internal/data', { fetchImpl })
    const result = await store.recordCharge({
      id: 'grant-0001',
      accountId: 'acct_00000001',
      coins: 5,
      minutes: 30,
      model: 'm',
      day: '2026-10-05',
      at: ''
    })
    expect(result).toEqual({ charged: false, duplicate: true })
  })

  it('reads charges back under the field names the balance expects', async () => {
    const { fetchImpl } = stubDataApi({
      find: { documents: [{ _id: 'grant-0001', accountId: 'acct_00000001', coins: 5, day: '2026-10-05' }] }
    })
    const store = createMongoStore('https://gateway.internal/data', { fetchImpl })
    const charges = await store.chargesFor('acct_00000001')
    // `_id` is Mongo's field; `id` is what the balance code reads. Mapping it is
    // the adapter's whole job on the way out.
    expect(charges[0]?.id).toBe('grant-0001')
  })

  it('sees a ban', async () => {
    const { fetchImpl } = stubDataApi({ findOne: { document: { _id: 'acct_00000001', reason: 'tampered' } } })
    const store = createMongoStore('https://gateway.internal/data', { fetchImpl })
    expect(await store.isBanned('acct_00000001')).toBe(true)
  })

  it('reports a database failure instead of returning an empty balance', async () => {
    const { fetchImpl } = stubDataApi({}, { status: 401, body: 'invalid api key' })
    const store = createMongoStore('https://gateway.internal/data', { fetchImpl })
    // An empty charges list here would look like "you have all your coins",
    // which is the most expensive possible way to be wrong about a database.
    await expect(store.chargesFor('acct_00000001')).rejects.toThrow(/401/)
  })

  it('upserts a ban rather than failing on the second report', async () => {
    const { fetchImpl, calls } = stubDataApi()
    const store = createMongoStore('https://gateway.internal/data', { fetchImpl })
    await store.ban('acct_00000001', 'debugger attached')
    expect(calls.find((c) => c.action === 'replaceOne')?.body.upsert).toBe(true)
  })
})