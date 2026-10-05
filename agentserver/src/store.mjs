/**
 * Where an account's coins actually live.
 *
 * The balance is **derived**, never stored as a running number: it is the daily
 * allowance plus granted coins, minus every charge in the ledger. This is the
 * same rule the local ledger uses, and for the same reason — a number in a file
 * or a document is a number someone can edit, whereas a ledger of charges can be
 * audited, and editing one row shows up in the sum.
 *
 * An interface rather than a Mongo client, so the rules above are testable
 * without a database and so this server has no runtime dependency at all.
 */

/** Coins granted per UTC day. Mirrors the local daily allowance. */
export const DAILY_COINS = 20

/**
 * @typedef {object} Charge
 * @property {string} id       Idempotency key. A repeat of this id is not charged again.
 * @property {string} accountId
 * @property {number} coins
 * @property {number} minutes
 * @property {string} model
 * @property {string} day      UTC day the charge belongs to.
 * @property {string} at       ISO instant.
 */

/**
 * @typedef {object} Account
 * @property {string} id
 * @property {string} signupDay   UTC day the account was created; grants the bonus that day only.
 * @property {string} displayName
 * @property {number} dailyCoins
 */

/** Coins granted once, on the day the account was created. */
export const SIGNUP_COINS = 25

/** One bought session, as charged. */
/**
 * @param {Partial<Charge>} [overrides]
 * @returns {Charge}
 */
export function emptyCharge(overrides) {
  return {
    id: '',
    accountId: '',
    coins: 0,
    minutes: 0,
    model: '',
    day: '',
    at: '',
    ...overrides
  }
}

export class AccountStore {
  /**
   * @param {{id: string, displayName?: string}} account
   * @returns {Promise<Account>} the stored account
   */
  async ensureAccount(account) {
    throw new Error('not implemented')
  }

  /** @returns {Promise<Account|null>} */
  async getAccount(accountId) {
    throw new Error('not implemented')
  }

  /**
   * Record a charge. Idempotent on `id`: a retried request must never cost the
   * user twice, and a client that times out and retries is the normal case, not
   * an attack.
   */
  /** @param {Charge} charge @returns {Promise<{charged: boolean, duplicate: boolean}>} */
  async recordCharge(charge) {
    throw new Error('not implemented')
  }

  /** @returns {Promise<Charge[]>} */
  async chargesFor(accountId) {
    throw new Error('not implemented')
  }

  /** Called by the watcher. A banned account stays banned. */
  async ban(accountId, reason) {
    throw new Error('not implemented')
  }

  async isBanned(accountId) {
    throw new Error('not implemented')
  }
}

/**
 * Coins an account may spend today.
 *
 * @param {object} input
 * @param {number} [input.dailyCoins]
 * @param {string|null} [input.signupDay]
 * @param {string} input.today
 * @param {Charge[]} [input.charges]
 * @returns {number}
 *
 * The signup grant counts on its day and never again, so "25 at signup, then 20
 * a day" is actually true rather than 45 on day one.
 */
export function availableBalance({ dailyCoins = DAILY_COINS, signupDay = null, today, charges = [] }) {
  const dayCoins = Math.max(0, dailyCoins)
  const base = signupDay !== null && signupDay === today ? Math.max(dayCoins, SIGNUP_COINS) : dayCoins
  const spent = charges.filter((c) => c.day === today).reduce((sum, c) => sum + c.coins, 0)
  return Math.max(0, base - spent)
}

/**
 * In-memory store.
 *
 * The default for `npm start` and the substrate every test runs against: real
 * enforcement logic, zero infrastructure, nothing to install. `MongoStore` has
 * the same shape, so swapping one for the other cannot change behaviour.
 */
/**
 * @extends {AccountStore}
 */
export class MemoryStore extends AccountStore {
  constructor() {
    super()
    /** @type {Map<string, object>} */
    this.accounts = new Map()
    /** @type {Map<string, object[]>} */
    this.charges = new Map()
    /** @type {Map<string, object>} */
    this.bans = new Map()
  }

  async ensureAccount(account) {
    const existing = this.accounts.get(account.id)
    if (existing) return existing
    const today = new Date().toISOString().slice(0, 10)
    const created = { id: account.id, signupDay: today, displayName: account.displayName ?? '', dailyCoins: DAILY_COINS }
    this.accounts.set(created.id, created)
    return created
  }

  async getAccount(accountId) {
    return this.accounts.get(accountId) ?? null
  }

  async recordCharge(charge) {
    const rows = this.charges.get(charge.accountId) ?? []
    if (rows.some((row) => row.id === charge.id)) return { charged: false, duplicate: true }
    rows.push(charge)
    this.charges.set(charge.accountId, rows)
    return { charged: true, duplicate: false }
  }

  async chargesFor(accountId) {
    return [...(this.charges.get(accountId) ?? [])]
  }

  async ban(accountId, reason) {
    this.bans.set(accountId, { accountId, reason, at: new Date().toISOString() })
  }

  async isBanned(accountId) {
    return this.bans.has(accountId)
  }
}