/**
 * Coin allowance rules.
 *
 * "25 coins at signup, then 20 a day" is three separate claims — a bonus worth
 * 25, granted to a first-time user, and gone the next day — and each has been
 * wrong in isolation before, so each is pinned here.
 */

import { describe, expect, it } from 'vitest'
import {
  FREE_DAILY_COINS,
  SIGNUP_BONUS_COINS,
  availableCoins,
  describeExhaustion,
  shouldGrantSignupBonus
} from '../../src/shared/coins'

describe('allowance constants', () => {
  it('is 20 a day and 25 at signup', () => {
    expect(FREE_DAILY_COINS).toBe(20)
    expect(SIGNUP_BONUS_COINS).toBe(25)
  })
})

describe('signup bonus', () => {
  it('is granted to a profile that has never had one', () => {
    expect(shouldGrantSignupBonus(null)).toBe(true)
  })

  it('is never granted twice', () => {
    expect(shouldGrantSignupBonus('2026-10-05')).toBe(false)
    expect(shouldGrantSignupBonus('2020-01-01')).toBe(false)
  })
})

describe('available coins', () => {
  it('is 25 on the day a first-time user signs up, replacing the daily 20', () => {
    expect(
      availableCoins({ dailyAllowanceCoins: 20, bonusGrantedOn: '2026-10-05', today: '2026-10-05' })
    ).toBe(25)
  })

  it('is 20 the next day, because the signup amount was one day only', () => {
    expect(
      availableCoins({ dailyAllowanceCoins: 20, bonusGrantedOn: '2026-10-05', today: '2026-10-06' })
    ).toBe(20)
  })

  it('is 20 for a user who signed up days ago', () => {
    expect(
      availableCoins({ dailyAllowanceCoins: 20, bonusGrantedOn: '2026-01-01', today: '2026-10-05' })
    ).toBe(20)
  })

  it('is never more than the daily allowance when no bonus was granted', () => {
    expect(
      availableCoins({ dailyAllowanceCoins: 20, bonusGrantedOn: null, today: '2026-10-05' })
    ).toBe(20)
  })

  it('respects a Settings change to the daily allowance', () => {
    expect(
      availableCoins({ dailyAllowanceCoins: 100, bonusGrantedOn: null, today: '2026-10-05' })
    ).toBe(100)
  })

  it('does not lower a raised allowance back to 25 on the signup day', () => {
    expect(
      availableCoins({ dailyAllowanceCoins: 100, bonusGrantedOn: '2026-10-05', today: '2026-10-05' })
    ).toBe(100)
  })

  it('never returns a negative allowance', () => {
    expect(
      availableCoins({ dailyAllowanceCoins: -5, bonusGrantedOn: null, today: '2026-10-05' })
    ).toBe(0)
  })
})

describe('running out of coins', () => {
  it('says so plainly, and names both ways out', () => {
    const message = describeExhaustion({ usedCoins: 20, budgetCoins: 20, metered: true })
    expect(message).toContain('no coins left')
    expect(message).toMatch(/20 of 20/)
    expect(message).toMatch(/tomorrow/i)
    expect(message).toMatch(/own provider key/i)
  })

  it('names the signup day allowance when that is what ran out', () => {
    const message = describeExhaustion({ usedCoins: 25, budgetCoins: 25, metered: true })
    expect(message).toMatch(/25 of 25/)
  })

  it('says nothing while coins remain', () => {
    expect(describeExhaustion({ usedCoins: 19, budgetCoins: 20, metered: true })).toBeNull()
  })

  it('says nothing at all for a user paying with their own key', () => {
    expect(describeExhaustion({ usedCoins: 9999, budgetCoins: 20, metered: false })).toBeNull()
  })

  it('treats exactly zero as exhausted, not as "still has some"', () => {
    expect(describeExhaustion({ usedCoins: 0, budgetCoins: 0, metered: true })).toMatch(
      /no coins left/
    )
  })
})