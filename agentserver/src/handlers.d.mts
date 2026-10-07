import type { AccountStore } from './store.mjs'

export interface ModelEntry {
  id: string
  label?: string
  description?: string
  contextWindow?: number
  /** false means this project pays for the model, so it costs more. */
  byok?: boolean
}

export declare const PRICES: { own: 5; hosted: 10 }
export declare const MINUTES_PER_COIN: 6

/** Default requests per window for any route, and for the writing ones. */
export declare const GENERAL_LIMIT: 240
export declare const MUTATING_LIMIT: 60
export declare const RATE_WINDOW_MS: 60000

export declare function json(
  res: { writeHead(status: number, headers: Record<string, unknown>): void; end(payload?: string): void },
  status: number,
  body: unknown,
  options?: { allowOrigin?: string; headers?: Record<string, string> }
): void

export declare function tokenMatches(provided: unknown, expected: unknown): boolean
export declare function bearerOf(req: { headers?: Record<string, unknown> }): string
export declare function isAuthorized(req: { headers?: Record<string, unknown> }, expectedToken: string): boolean
export declare function clientAddress(req: { socket?: { remoteAddress?: string } }): string
export declare function readBody(req: AsyncIterable<unknown>, limitBytes?: number): Promise<any>
export declare function looksLikeAccountId(value: unknown): boolean

export declare function chargeForSession(input: {
  store: AccountStore
  accountId: string
  grantId: string
  tier: 'own' | 'hosted'
  model: string
  now: number
}): Promise<
  | { ok: true; duplicate: boolean; charge: { coins: number; minutes: number }; balance: number }
  | { ok: false; status: number; error: string }
>

/** The same handler `node:http` and Vercel both mount. */
export declare function createHandler(options: {
  store: AccountStore
  /** Client credential, shipped inside the app. */
  token: string
  models?: ModelEntry[]
  allowOrigin?: string
  now?: () => number
  /**
   * Operator credential. Bans require it and it must differ from `token`:
   * an unconfigured server leaves `POST /v1/integrity` disabled.
   */
  adminToken?: string
  generalLimit?: number
  mutatingLimit?: number
}): (req: any, res: any) => Promise<void>
