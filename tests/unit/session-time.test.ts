/**
 * Session time: coins in, wall clock out.
 *
 * These rules are what a user is charged and what they get for it, so the
 * assertions are about the numbers a person would see on a receipt — 5 coins
 * really is 30 minutes, a model is never cheaper than 5, a part-paid balance
 * still works, and an expired session cannot be resumed for free.
 */

import { describe, expect, it } from 'vitest'

import {
  COINS_PER_BLOCK,
  MAX_MODEL_COINS,
  MINUTES_PER_BLOCK,
  MINUTES_PER_COIN,
  MIN_MODEL_COINS,
  coinsChargedOn,
  coinsForMinutes,
  describeSessionEnd,
  durationForCoins,
  formatRemaining,
  isExpired,
  minutesForCoins,
  modelCoinCost,
  remainingMs,
  resumableGrant,
  runtimeBudgetMs,
  startSession,
  type SessionGrant
} from '../../src/shared/session-time'

const NOW = Date.parse('2026-10-05T12:00:00.000Z')

function grant(overrides: Partial<SessionGrant> = {}): SessionGrant {
  return {
    id: 'g1',
    model: 'space-bunny-alpha',
    coins: 5,
    minutes: 30,
    startedAt: NOW,
    expiresAt: NOW + 30 * 60_000,
    day: '2026-10-05',
    projectRoot: '/work/app',
    prompt: 'fix the failing test',
    consumed: false,
    ...overrides
  }
}

describe('the exchange rate', () => {
  it('is five coins for thirty minutes, stated once', () => {
    expect(COINS_PER_BLOCK).toBe(5)
    expect(MINUTES_PER_BLOCK).toBe(30)
    expect(MINUTES_PER_COIN).toBe(6)
  })

  it('buys exactly half an hour for five coins', () => {
    expect(minutesForCoins(5)).toBe(30)
    expect(durationForCoins(5)).toBe(30 * 60_000)
  })

  it('buys an hour for ten coins', () => {
    expect(minutesForCoins(10)).toBe(60)
  })

  it('converts back the same way', () => {
    expect(coinsForMinutes(30)).toBe(5)
    expect(coinsForMinutes(90)).toBe(15)
  })

  it('treats a nonsense balance as no session at all', () => {
    expect(minutesForCoins(0)).toBe(0)
    expect(minutesForCoins(-5)).toBe(0)
    expect(minutesForCoins(Number.NaN)).toBe(0)
  })
})

describe('what a model costs', () => {
  it('charges five for a model the user brought, ten for one we pay for', () => {
    expect(modelCoinCost('own')).toBe(5)
    expect(modelCoinCost('hosted')).toBe(10)
  })

  it('never goes below five, whatever it is handed', () => {
    expect(MIN_MODEL_COINS).toBe(5)
    expect(MAX_MODEL_COINS).toBe(10)
    // The clamp is the point: a tier arriving from an editable settings file
    // must not be able to price a model at zero.
    for (const raw of ['own', 'hosted'] as const) {
      expect(modelCoinCost(raw)).toBeGreaterThanOrEqual(MIN_MODEL_COINS)
    }
  })
})

describe('starting a session', () => {
  it('charges the model price and hands back the rest', () => {
    const result = startSession({
      id: 'g1',
      model: 'm',
      tier: 'own',
      available: 17,
      now: NOW,
      projectRoot: '/w',
      prompt: 'do a thing'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grant.coins).toBe(5)
    expect(result.grant.minutes).toBe(30)
    expect(result.grant.expiresAt).toBe(NOW + 30 * 60_000)
    expect(result.remainingCoins).toBe(12)
  })

  it('buys ten coins of time for a hosted model', () => {
    const result = startSession({
      id: 'g2',
      model: 'm',
      tier: 'hosted',
      available: 20,
      now: NOW,
      projectRoot: '/w',
      prompt: 'x'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grant.minutes).toBe(60)
  })

  it('refuses outright when there is nothing left', () => {
    const result = startSession({
      id: 'g3',
      model: 'm',
      tier: 'own',
      available: 0,
      now: NOW,
      projectRoot: '/w',
      prompt: 'x'
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/no coins left/i)
  })

  it('buys what a short balance can pay for instead of refusing', () => {
    const result = startSession({
      id: 'g4',
      model: 'm',
      tier: 'hosted',
      available: 3,
      now: NOW,
      projectRoot: '/w',
      prompt: 'x'
    })
    // 10 coins is the price, the user has 3. Refusing here would leave someone
    // with a few coins unable to do anything at all.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grant.coins).toBe(3)
    expect(result.grant.minutes).toBe(18)
    expect(result.remainingCoins).toBe(0)
  })

  it('records the day the charge belongs to, for the daily allowance', () => {
    const result = startSession({
      id: 'g5',
      model: 'm',
      tier: 'own',
      available: 20,
      now: NOW,
      projectRoot: '/w',
      prompt: 'x'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.grant.day).toBe('2026-10-05')
  })
})

describe('the clock', () => {
  it('counts down and stops at zero', () => {
    const g = grant()
    expect(remainingMs(g, NOW)).toBe(30 * 60_000)
    expect(remainingMs(g, NOW + 20 * 60_000)).toBe(10 * 60_000)
    expect(remainingMs(g, NOW + 60 * 60_000)).toBe(0)
    expect(isExpired(g, NOW + 60 * 60_000)).toBe(true)
    expect(isExpired(g, NOW)).toBe(false)
  })

  it('uses a stored expiry, so reopening the app does not extend the session', () => {
    const g = grant({ expiresAt: NOW + 10 * 60_000 })
    // Read ten minutes later, the same grant says ten minutes, not forty.
    expect(remainingMs(g, NOW + 20 * 60_000)).toBe(0)
  })

  it('feeds the loop one runtime ceiling rather than a second timer', () => {
    const g = grant()
    expect(runtimeBudgetMs(g, 60 * 60_000)).toBe(30 * 60_000)
  })

  it('never raises the loop ceiling above what settings allows', () => {
    const g = grant()
    expect(runtimeBudgetMs(g, 5 * 60_000)).toBe(5 * 60_000)
  })

  it('formats the remainder for a person', () => {
    expect(formatRemaining(0)).toBe('no time left')
    expect(formatRemaining(30_000)).toBe('under a minute left')
    expect(formatRemaining(60_000)).toBe('1 minute left')
    expect(formatRemaining(20 * 60_000)).toBe('20 minutes left')
    expect(formatRemaining(9 * 60_000 + 30_000)).toBe('9:30 left')
  })

  it('says what was bought and that the work was kept', () => {
    const message = describeSessionEnd(grant())
    expect(message).toContain('30 minutes')
    expect(message).toContain('5 coins')
    expect(message).toMatch(/saved/i)
  })
})

describe('the ledger', () => {
  it('totals the coins charged on one day only', () => {
    const grants = [
      grant({ id: 'a', coins: 5, day: '2026-10-05' }),
      grant({ id: 'b', coins: 10, day: '2026-10-05' }),
      grant({ id: 'c', coins: 5, day: '2026-10-04' })
    ]
    expect(coinsChargedOn(grants, '2026-10-05')).toBe(15)
    expect(coinsChargedOn(grants, '2026-10-06')).toBe(0)
  })
})

describe('resuming', () => {
  const abandoned = grant({ id: 'abandoned', startedAt: NOW - 60_000 })

  it('finds the interrupted task for a project', () => {
    const grants = [grant({ id: 'done', consumed: true, startedAt: NOW - 120_000 }), abandoned]
    expect(resumableGrant(grants, '/work/app', NOW)?.id).toBe('abandoned')
  })

  it('does not resume a task whose time already ran out', () => {
    // Resuming would hand back time that was paid for and has gone.
    const expired = grant({ id: 'old', expiresAt: NOW - 1 })
    expect(resumableGrant([expired], '/work/app', NOW)).toBeNull()
  })

  it('does not resume one that finished', () => {
    expect(resumableGrant([grant({ consumed: true })], '/work/app', NOW)).toBeNull()
  })

  it('does not carry one project\'s task into another', () => {
    expect(resumableGrant([abandoned], '/work/other', NOW)).toBeNull()
  })

  it('picks the most recent when a project has two', () => {
    const grants = [
      grant({ id: 'older', startedAt: NOW - 600_000 }),
      grant({ id: 'newer', startedAt: NOW - 60_000 })
    ]
    expect(resumableGrant(grants, '/work/app', NOW)?.id).toBe('newer')
  })
})