/**
 * Session time bought with coins.
 *
 * The rule the product asked for, stated once here so nothing else can restate
 * it:
 *
 *  - **5 coins buys 30 minutes.** One coin is 6 minutes. The block is charged
 *    when a task starts, not per model call, so a session is predictable: the
 *    user knows what they are getting and the agent is not metered per request.
 *  - **A model costs between 5 and 10 coins, never fewer.** 5 for a model the
 *    user brought themselves or runs locally, which costs the project nothing;
 *    10 for one Cryptoric pays for. The floor is enforced here rather than left
 *    to each call site, because a model priced at 1 coin is exactly the sort of
 *    value that arrives later as a pricing decision nobody reviewed.
 *
 * Pure and import-free, like `coins.ts`. The line deciding how long a user may
 * work belongs somewhere a test can load it without a provider, a key or an
 * account service — and this file is that line.
 */

/** Coins that buy one block of session time. */
export const COINS_PER_BLOCK = 5

/** Wall-clock minutes one block buys. */
export const MINUTES_PER_BLOCK = 30

/** Minutes per coin. The whole economy is this number and nothing else. */
export const MINUTES_PER_COIN = MINUTES_PER_BLOCK / COINS_PER_BLOCK

/** No model may ever cost less than this. */
export const MIN_MODEL_COINS = 5

/** No model may ever cost more than this. */
export const MAX_MODEL_COINS = 10

/** What the user is paying for when they pick a model. */
/** `own`: the user's own key or a model on their machine, free to serve. `hosted`: Cryptoric pays the provider. */
export type ModelTier = 'own' | 'hosted'

/**
 * What one task of this model costs, in coins.
 *
 * Clamped rather than trusted: a tier passed in from a settings file is user-
 * editable, and a stored cost of 0 would hand out an unlimited agent.
 */
export function modelCoinCost(tier: ModelTier): number {
  const raw = tier === 'own' ? MIN_MODEL_COINS : MAX_MODEL_COINS
  return Math.min(MAX_MODEL_COINS, Math.max(MIN_MODEL_COINS, raw))
}

/** Minutes a coin balance buys. Fractional minutes are kept, not rounded away. */
export function minutesForCoins(coins: number): number {
  if (!Number.isFinite(coins) || coins <= 0) return 0
  return coins * MINUTES_PER_COIN
}

/** The inverse, for showing what a balance is worth. */
export function coinsForMinutes(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0
  return minutes / MINUTES_PER_COIN
}

/** Milliseconds of session time a coin balance buys. */
export function durationForCoins(coins: number): number {
  return minutesForCoins(coins) * 60_000
}

/**
 * One bought session.
 *
 * `expiresAt` is stored rather than recomputed from a start time on every read:
 * a timer that recomputes from "now" each time it is asked silently extends
 * itself every time the app is restarted.
 */
export interface SessionGrant {
  id: string
  /** Model this time was bought for. */
  model: string
  /** Coins actually charged, after the balance was clamped to what was left. */
  coins: number
  minutes: number
  /** Epoch ms the charge was made. */
  startedAt: number
  /** Epoch ms the time runs out. */
  expiresAt: number
  /** UTC day the charge belongs to, so the daily allowance can be reconciled. */
  day: string
  /** Project the task was running in, so a resume knows where to go back. */
  projectRoot: string
  /** The prompt, so an interrupted task can be continued rather than restarted. */
  prompt: string
  /** True once the task ran to completion; an abandoned grant still costs. */
  consumed: boolean
}

export type GrantResult =
  | { ok: true; grant: SessionGrant; remainingCoins: number }
  | { ok: false; error: string }

/**
 * Charge a balance and start a session.
 *
 * Charges the model price, not the whole balance: a user with 17 coins running
 * a 5-coin model keeps 12. `available` is passed in rather than read from
 * anywhere, so the arithmetic is testable and the caller stays the only thing
 * that knows where the balance lives.
 */
export function startSession(input: {
  id: string
  model: string
  tier: ModelTier
  available: number
  now: number
  projectRoot: string
  prompt: string
}): GrantResult {
  const price = modelCoinCost(input.tier)
  const available = Number.isFinite(input.available) ? Math.max(0, Math.floor(input.available)) : 0

  if (available <= 0) {
    return {
      ok: false,
      error:
        'You have no coins left, so the agent cannot run. Your allowance refreshes tomorrow, ' +
        'or raise it in Settings.'
    }
  }

  // A balance smaller than the price buys the time the balance can pay for,
  // rather than refusing outright. Stopping at 12 coins because a task costs 13
  // would leave the user unable to do anything at all.
  const charged = Math.min(price, available)
  const minutes = minutesForCoins(charged)

  return {
    ok: true,
    grant: {
      id: input.id,
      model: input.model,
      coins: charged,
      minutes,
      startedAt: input.now,
      expiresAt: input.now + minutes * 60_000,
      day: new Date(input.now).toISOString().slice(0, 10),
      projectRoot: input.projectRoot,
      prompt: input.prompt,
      consumed: false
    },
    remainingCoins: available - charged
  }
}

/** Milliseconds left on a grant. Never negative: an expired grant is zero. */
export function remainingMs(grant: SessionGrant, now: number): number {
  return Math.max(0, grant.expiresAt - now)
}

/** Has this session's time run out? */
export function isExpired(grant: SessionGrant, now: number): boolean {
  return remainingMs(grant, now) <= 0
}

/**
 * Wall-clock ceiling for one task, in milliseconds.
 *
 * The agent loop already stops a run at `maxRuntimeMs`, so a session's time is
 * expressed as that ceiling rather than as a second, parallel timer. One
 * mechanism stops runaway tasks; a second one would only be a second way for
 * the two to disagree.
 *
 * Capped at `ceilingMs` so a 10-coin session cannot quietly raise the runtime
 * limit above what Settings allows.
 */
export function runtimeBudgetMs(grant: SessionGrant, ceilingMs: number): number {
  return Math.min(remainingMs(grant, grant.startedAt), ceilingMs)
}

/** `28 minutes left`, `under a minute left`, or `no time left`. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'no time left'
  const minutes = ms / 60_000
  if (minutes < 1) return 'under a minute left'
  const whole = Math.floor(minutes)
  const seconds = Math.round((minutes - whole) * 60)
  if (seconds === 0) return `${whole} minute${whole === 1 ? '' : 's'} left`
  return `${whole}:${String(seconds).padStart(2, '0')} left`
}

/**
 * The message shown when a session runs out mid-task.
 *
 * Names what was bought and what happens next, because "request failed" tells a
 * user nothing about whether the work was saved or whether to buy more time.
 */
export function describeSessionEnd(grant: SessionGrant): string {
  return (
    `This session's ${Math.round(grant.minutes)} minutes are used up — ${grant.coins} ` +
    `coin${grant.coins === 1 ? '' : 's'} bought ${Math.round(grant.minutes)} minutes on ${grant.model}. ` +
    'The work so far is saved. Start another session to keep going.'
  )
}

/** Total coins charged on one UTC day. The ledger's own reconciliation. */
export function coinsChargedOn(grants: readonly SessionGrant[], day: string): number {
  return grants.filter((g) => g.day === day).reduce((sum, g) => sum + g.coins, 0)
}

/**
 * The most recent grant for a project that was interrupted.
 *
 * Interrupted means: never consumed, and either still running or was running
 * when the app last closed. A grant whose time has fully expired is not
 * resumable — restarting it would give away time that was already paid for and
 * has run out, so the honest action is to start a new session.
 */
export function resumableGrant(
  grants: readonly SessionGrant[],
  projectRoot: string,
  now: number
): SessionGrant | null {
  const candidates = grants
    .filter((g) => !g.consumed && g.projectRoot === projectRoot && remainingMs(g, now) > 0)
    .sort((a, b) => b.startedAt - a.startedAt)
  return candidates[0] ?? null
}