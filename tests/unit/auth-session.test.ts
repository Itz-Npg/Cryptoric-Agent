/**
 * The signed-in session, and what happens when it is broken.
 *
 * A half-read session is the failure worth guarding: the UI would show a
 * signed-in account whose tokens are unusable, and every agent task would then
 * fail for a reason the user cannot see. Corrupt data has to read as *signed
 * out, with a reason*.
 */

import { describe, expect, it } from 'vitest'

import {
  accessTokenIsFresh,
  describeSignedOut,
  parseSession,
  sessionMatches,
  summarise,
  type SessionSecrets,
  type SessionSummary
} from '../../src/main/services/auth/session-store'

const IDENTITY = { sub: '1234567890', email: 'a@b.test', name: 'A', picture: null }

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    accountId: 'acct_abcdef0123456789',
    email: 'a@b.test',
    name: 'A',
    picture: null,
    signedInAt: '2026-10-05T12:00:00.000Z',
    ...overrides
  }
}

describe('signing in', () => {
  it('derives an account the server will accept', () => {
    const result = summarise(IDENTITY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary.accountId).toMatch(/^acct_[A-Za-z0-9_-]{8,128}$/)
  })

  it('keeps no secret in the summary', () => {
    const result = summarise(IDENTITY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The summary is the half that is safe to show, sync and log.
    expect(JSON.stringify(result.summary)).not.toContain('token')
  })

  it('refuses an identity with an unusable sub rather than storing it', () => {
    const result = summarise({ sub: '../../etc/passwd', email: null, name: null, picture: null })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/cannot use/i)
  })
})

describe('reading a stored session', () => {
  it('accepts a complete one', () => {
    const result = parseSession({ refreshToken: 'r', accessToken: 'a', expiresAt: 1 })
    expect(result.ok).toBe(true)
  })

  it('reads a session with no access token as signed out, not broken', () => {
    // The normal case on a cold start: a refresh token is enough to get one.
    const result = parseSession({ refreshToken: 'r', accessToken: null, expiresAt: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ok).toBe(true)
  })

  it('refuses a session with no refresh token', () => {
    const result = parseSession({ refreshToken: null, accessToken: 'a', expiresAt: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/sign in again/i)
  })

  it('refuses corrupt data rather than throwing', () => {
    for (const bad of [null, undefined, 'a string', 42, { refreshToken: 7 }]) {
      const result = parseSession(bad)
      expect(result.ok).toBe(false)
    }
  })
})

describe('token freshness', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z')

  it('treats a token with a minute left as stale', () => {
    // Using it would expire mid-request, which surfaces as an error the user
    // cannot act on. Refreshing a few seconds early costs one call.
    expect(accessTokenIsFresh({ accessToken: 'a', refreshToken: 'r', expiresAt: now + 30_000 }, now)).toBe(false)
  })

  it('keeps one with room to spare', () => {
    expect(accessTokenIsFresh({ accessToken: 'a', refreshToken: 'r', expiresAt: now + 600_000 }, now)).toBe(true)
  })

  it('is never fresh without a token', () => {
    const secrets: SessionSecrets = { accessToken: null, refreshToken: 'r', expiresAt: now + 600_000 }
    expect(accessTokenIsFresh(secrets, now)).toBe(false)
  })

  it('assumes a token with no stated expiry is usable', () => {
    expect(accessTokenIsFresh({ accessToken: 'a', refreshToken: 'r', expiresAt: null }, now)).toBe(true)
  })
})

describe('guarding against the wrong account', () => {
  it('accepts the same account', () => {
    expect(sessionMatches(summary(), 'acct_abcdef0123456789')).toBe(true)
  })

  it('refuses a different one', () => {
    // A refresh that quietly names another account would move someone's
    // balance to somebody else's.
    expect(sessionMatches(summary(), 'acct_zzzzzzzzzzzzzzzz')).toBe(false)
  })

  it('refuses when the stored id is empty', () => {
    expect(sessionMatches(summary({ accountId: '' }), 'acct_abcdef0123456789')).toBe(false)
  })
})

describe('what the user is told', () => {
  it('says what to do when nobody is signed in', () => {
    expect(describeSignedOut(null)).toMatch(/sign in/i)
  })

  it('passes a real reason through instead of hiding it', () => {
    expect(describeSignedOut('The saved sign-in could not be read. Sign in again.')).toMatch(/could not be read/)
  })
})