/**
 * Types for the account store.
 *
 * Hand-written rather than inferred. Turning on `allowJs` to let TypeScript read
 * the server's own source changed inference for the whole repository — it
 * surfaced two unrelated errors in `signing.test.ts` — which is a bad trade for
 * one plain-JS package. These declarations type the server for its consumers
 * without touching anything else.
 */

export declare const DAILY_COINS: 20
export declare const SIGNUP_COINS: 25

export interface Charge {
  /** Idempotency key. A repeat of this id is never charged again. */
  id: string
  accountId: string
  coins: number
  minutes: number
  model: string
  /** UTC day the charge belongs to. */
  day: string
  at: string
}

export interface Account {
  id: string
  /** UTC day the account was created; grants the bonus that day only. */
  signupDay: string
  displayName: string
  dailyCoins: number
}

export declare function emptyCharge(overrides?: Partial<Charge>): Charge

export declare class AccountStore {
  ensureAccount(account: { id: string; displayName?: string }): Promise<Account>
  getAccount(accountId: string): Promise<Account | null>
  recordCharge(charge: Charge): Promise<{ charged: boolean; duplicate: boolean }>
  chargesFor(accountId: string): Promise<Charge[]>
  ban(accountId: string, reason: string): Promise<void>
  isBanned(accountId: string): Promise<boolean>
}

export declare function availableBalance(input: {
  dailyCoins?: number
  signupDay?: string | null
  today: string
  /** Only `day` and `coins` are read, so only those are required. */
  charges?: Pick<Charge, 'day' | 'coins'>[]
}): number

export declare class MemoryStore extends AccountStore {
  accounts: Map<string, Account>
  charges: Map<string, Charge[]>
  bans: Map<string, { accountId: string; reason: string; at: string }>
}
