/**
 * Talking to the agent server.
 *
 * The client exists for one reason: in `hosted` mode the server, not this
 * machine, decides what a session costs and whether any coins are left. The app
 * asks; it never asserts. That is the whole difference between a balance and a
 * number in a file, so every method here is a request and a typed failure —
 * there is no path that invents a balance.
 *
 * Two rules worth stating because they are easy to get wrong:
 *
 *  - **No silent fallback.** If this build is `hosted` and the server cannot be
 *    reached, the answer is "the server could not be reached", not "you have
 *    plenty of coins". Degrading quietly would let someone run an agent for
 *    free by unplugging the network.
 *  - **The token never appears in an error or a log.** It is sent in a header
 *    and forgotten; every message here is built without it.
 */

import type { RunMode } from '@shared/mode'

export interface AgentServerConfig {
  /** Normalised, no trailing slash. */
  url: string
  token: string
}

export interface ServerBalance {
  accountId: string
  /** Coins available right now, after today's charges. */
  balance: number
  dailyCoins: number
}

export interface ServerCharge {
  coins: number
  minutes: number
  balance: number
  /** True when the server recognised this grant id and charged nothing again. */
  duplicate: boolean
}

export type ServerResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

/**
 * Read the server settings out of the environment.
 *
 * `local` yields `config: null` — not an error, just no server. `hosted`
 * without a usable URL or token is an error, because a hosted build that
 * cannot reach its server cannot do the thing it was built to do.
 */
export function serverConfigFrom(
  env: Record<string, string | undefined>,
  mode: RunMode
): { ok: true; config: AgentServerConfig | null } | { ok: false; error: string } {
  if (mode === 'local') return { ok: true, config: null }

  const url = (env.AGENT_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  if (url.length === 0) {
    return { ok: false, error: 'CRYPTORIC_MODE=hosted but AGENT_SERVER_URL is not set.' }
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: `AGENT_SERVER_URL="${url}" is not an http(s) URL.` }
  }
  const token = (env.AGENT_SERVER_TOKEN ?? '').trim()
  if (token.length === 0) {
    return {
      ok: false,
      error: 'CRYPTORIC_MODE=hosted but AGENT_SERVER_TOKEN is not set. It belongs to the maintainer; ask for it.'
    }
  }
  return { ok: true, config: { url, token } }
}

export interface AgentServerOptions {
  config: AgentServerConfig
  fetchImpl?: typeof fetch
  /** Every call is bounded. A server that never answers must not hang the gate. */
  timeoutMs?: number
}

export class AgentServerClient {
  private readonly config: AgentServerConfig
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: AgentServerOptions) {
    this.config = options.config
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ServerResult<T>> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.config.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (err) {
      // Deliberately terse: the URL is not a secret and the reason is, and a
      // stack trace here would be noise in a message a person has to read.
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'could not be reached'
      return { ok: false, status: 0, error: `The Cryptoric account server ${reason}.` }
    }

    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    const message =
      parsed !== null && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string'
        ? parsed.error
        : `The server answered ${res.status}.`

    if (!res.ok) return { ok: false, status: res.status, error: message }
    return { ok: true, value: parsed as T }
  }

  /** Is the server there at all? Open on purpose: it carries no token. */
  async health(): Promise<{ ok: boolean; error: string }> {
    try {
      const res = await this.fetchImpl(`${this.config.url}/health`, {
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      if (!res.ok) return { ok: false, error: `The account server answered ${res.status}.` }
      return { ok: true, error: '' }
    } catch {
      return { ok: false, error: 'The Cryptoric account server could not be reached.' }
    }
  }

  /** Create the account if it does not exist yet, and report the balance. */
  async ensureAccount(accountId: string, displayName?: string): Promise<ServerResult<ServerBalance>> {
    const result = await this.call<ServerBalance>('POST', '/v1/accounts', {
      accountId,
      ...(displayName ? { displayName } : {})
    })
    return result.ok ? { ok: true, value: readBalance(result.value, accountId) } : result
  }

  async balance(accountId: string): Promise<ServerResult<ServerBalance>> {
    const result = await this.call<ServerBalance>(
      'GET',
      `/v1/balance?accountId=${encodeURIComponent(accountId)}`
    )
    return result.ok ? { ok: true, value: readBalance(result.value, accountId) } : result
  }

  /**
   * Buy time.
   *
   * `grantId` is the client's task id, so a retry after a timeout — which is
   * ordinary, not an attack — is recognised by the server and charged once.
   */
  async charge(input: { accountId: string; grantId: string; modelId: string }): Promise<ServerResult<ServerCharge>> {
    const result = await this.call<ServerCharge>('POST', '/v1/charge', input)
    if (!result.ok) return result
    const value = result.value
    if (typeof value?.coins !== 'number' || typeof value?.minutes !== 'number') {
      // A server that answers with the wrong shape is worse than one that
      // answers with an error: the numbers below would be invented.
      return { ok: false, status: 502, error: 'The account server sent a charge this build cannot read.' }
    }
    return {
      ok: true,
      value: {
        coins: value.coins,
        minutes: value.minutes,
        balance: typeof value.balance === 'number' ? value.balance : 0,
        duplicate: value.duplicate === true
      }
    }
  }
}

/**
 * Read a balance response, refusing to guess at a missing number.
 *
 * A `balance` of `undefined` would render as `NaN` coins and, worse, compare as
 * `NaN <= 0` → false, which would let a task start on a server that answered
 * nonsense.
 */
function readBalance(value: unknown, accountId: string): ServerBalance {
  const record = (value ?? {}) as Record<string, unknown>
  const balance = typeof record.balance === 'number' && Number.isFinite(record.balance) ? record.balance : 0
  return {
    accountId: typeof record.accountId === 'string' && record.accountId ? record.accountId : accountId,
    balance: Math.max(0, Math.floor(balance)),
    dailyCoins: typeof record.dailyCoins === 'number' ? record.dailyCoins : 0
  }
}
