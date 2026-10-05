/**
 * Coin allowances.
 *
 * Two separate things, deliberately not conflated:
 *
 *  - **20 coins every day** — the ongoing daily allowance.
 *  - **25 coins on the signup day**, granted once, replacing that day's 20.
 *
 * Pure and import-free so the arithmetic is testable without a provider, a key
 * or an account service. That is the same rule the rest of this repository
 * learned the hard way: the line deciding what a user is allowed to do belongs
 * somewhere a test can load it.
 */

/** Ongoing daily allowance, in coins. One coin is one cent of modelled cost. */
export const FREE_DAILY_COINS = 20

/** Available on the first day only, to a profile that has never had it. */
export const SIGNUP_BONUS_COINS = 25

export interface AllowanceInput {
  /** The configured daily ceiling, which Settings can change. */
  dailyAllowanceCoins: number
  /**
   * UTC day the signup bonus was granted, or null if never.
   *
   * Stored as a day rather than an instant so the comparison is a string match
   * and cannot drift by a timezone.
   */
  bonusGrantedOn: string | null
  /** Today, as a UTC day string. Injected so the rule is testable. */
  today: string
}

/**
 * How many coins are available right now.
 *
 * The signup amount **replaces** the daily allowance for that one day rather
 * than adding to it, so a new user sees 25 on day one and 20 on day two. Adding
 * instead would hand them 45, which is not what "25 at first, then 20 a day"
 * says.
 *
 * A user who has *raised* their allowance above the signup amount keeps the
 * higher number on the grant day rather than having it lowered to 25.
 */
export function availableCoins(input: AllowanceInput): number {
  const daily = Math.max(0, input.dailyAllowanceCoins)
  const isSignupDay = input.bonusGrantedOn !== null && input.bonusGrantedOn === input.today
  return isSignupDay ? Math.max(daily, SIGNUP_BONUS_COINS) : daily
}

/** True when this user has never received the signup bonus. */
export function shouldGrantSignupBonus(bonusGrantedOn: string | null): boolean {
  return bonusGrantedOn === null
}

/**
 * The message shown when there are no coins left.
 *
 * States the position plainly and names both ways out. "Request failed" would be
 * untrue and useless; so would a bare `0`.
 */
export function describeExhaustion(input: {
  usedCoins: number
  budgetCoins: number
  /** False for a user's own key, which is never charged. */
  metered: boolean
}): string | null {
  if (!input.metered) return null
  if (input.usedCoins < input.budgetCoins) return null
  return (
    `You have no coins left today — ${input.usedCoins} of ${input.budgetCoins} used. ` +
    `Your allowance refreshes tomorrow, or you can raise it in Settings. ` +
    `If you have your own provider key, add it in Settings and this limit does not apply to you.`
  )
}