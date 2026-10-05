/**
 * Types for the MongoDB adapter.
 *
 * Hand-written for the same reason as the other server declarations: enabling
 * `allowJs` to infer these changed inference across the whole repository.
 */

import type { Account, AccountStore, Charge } from './store.mjs'

export declare const DEFAULT_API_BASE: string

export declare class MongoRestError extends Error {}

/**
 * Build a store backed by the MongoDB REST Data API.
 *
 * @param uri a `mongodb+srv://` connection string (needs `MONGODB_REGION`) or an
 *   https Data API URL, used as given.
 */
export declare function createMongoStore(
  uri: string,
  options?: { apiBase?: string; fetchImpl?: typeof fetch }
): AccountStore & {
  ensureAccount(account: { id: string; displayName?: string }): Promise<Account>
  getAccount(accountId: string): Promise<Account | null>
  recordCharge(charge: Charge): Promise<{ charged: boolean; duplicate: boolean }>
  chargesFor(accountId: string): Promise<Charge[]>
}