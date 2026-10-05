/**
 * MongoDB-backed store, over the REST Data API.
 *
 * Reached with `fetch` rather than the `mongodb` driver, for one reason: this
 * server then has **no runtime dependency**, which matters more here than it
 * would elsewhere — the account server is the thing that has to keep working,
 * and a dependency tree is a supply chain and a disk cost attached to the one
 * place balances live.
 *
 * MongoDB Atlas exposes this API directly. Self-hosted Mongo does not, and there
 * the driver is the only route; `MONGODB_API_BASE` is there for that.
 *
 * The balance is still derived from charges, never stored as a number. The
 * difference is only *where* the charges live.
 */

import { AccountStore } from './store.mjs'

/** Atlas Data API shape, overridable for a self-hosted gateway. */
export const DEFAULT_API_BASE = 'https://${region}.data.mongodb.net'

export class MongoRestError extends Error {}

/**
 * @param {string} uri mongodb+srv://... or https://... data API URL
 * @returns {AccountStore}
 */
export function createMongoStore(uri, { apiBase = DEFAULT_API_BASE, fetchImpl = fetch } = {}) {
  const database = process.env.MONGODB_DATABASE ?? 'cryptoric'
  const collections = {
    accounts: process.env.MONGODB_ACCOUNTS ?? 'accounts',
    charges: process.env.MONGODB_CHARGES ?? 'charges',
    bans: process.env.MONGODB_BANS ?? 'bans'
  }

  let endpoint = uri
  if (uri.startsWith('mongodb+srv://') || uri.startsWith('mongodb://')) {
    const region = process.env.MONGODB_REGION
    if (!region) {
      throw new MongoRestError(
        'MONGODB_REGION is required with a mongodb+srv:// URI, because the Data API is region-scoped. ' +
          'Set MONGODB_REGION (for example us-east-1), or pass an https Data API URL as MONGODB_URI.'
      )
    }
    endpoint = apiBase.replace('${region}', region)
  }

  async function call(collection, action, body) {
    const res = await fetchImpl(`${endpoint}/${database}/${collection}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': uri },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new MongoRestError(`mongo ${collection}.${action} failed with ${res.status}: ${detail}`)
    }
    return res.json()
  }

  return new (class extends AccountStore {
    async ensureAccount(account) {
      const existing = await this.getAccount(account.id)
      if (existing) return existing
      const today = new Date().toISOString().slice(0, 10)
      const created = { _id: account.id, id: account.id, signupDay: today, displayName: account.displayName ?? '', dailyCoins: 20 }
      await call(collections.accounts, 'insertOne', { document: created }).catch(async (err) => {
        // A duplicate here is two devices creating the account at once, which is
        // normal. Re-reading beats reporting a failure to a user signing in.
        if (!String(err?.message ?? '').includes('duplicate')) throw err
      })
      return (await this.getAccount(account.id)) ?? created
    }

    async getAccount(accountId) {
      const found = await call(collections.accounts, 'findOne', { filter: { _id: accountId } })
      const doc = found?.document
      if (!doc) return null
      // Mongo stores the id as `_id`; every consumer reads `id`. Returning the
      // raw document made `/v1/accounts` answer `accountId: undefined` on a
      // Mongo-backed server — a server that created accounts it could not name.
      return { ...doc, id: doc.id ?? doc._id }
    }

    async recordCharge(charge) {
      const existing = await call(collections.charges, 'findOne', { filter: { _id: charge.id } })
      if (existing?.document) return { charged: false, duplicate: true }
      await call(collections.charges, 'insertOne', { document: { ...charge, _id: charge.id } })
      return { charged: true, duplicate: false }
    }

    async chargesFor(accountId) {
      const found = await call(collections.charges, 'find', { filter: { accountId } })
      return Array.isArray(found?.documents) ? found.documents.map((d) => ({ ...d, id: d._id })) : []
    }

    async ban(accountId, reason) {
      await call(collections.bans, 'replaceOne', {
        filter: { _id: accountId },
        update: { $set: { _id: accountId, accountId, reason, at: new Date().toISOString() } },
        upsert: true
      })
    }

    async isBanned(accountId) {
      const found = await call(collections.bans, 'findOne', { filter: { _id: accountId } })
      return Boolean(found?.document)
    }
  })()
}