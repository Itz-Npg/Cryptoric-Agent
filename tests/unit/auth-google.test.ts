/**
 * Signing in.
 *
 * The assertions are about what a sign-in must *refuse* and what it must never
 * send, because those are the failures that are invisible in a demo: a hijacked
 * callback, a code redeemed with the wrong verifier, a client secret in the
 * request, or an account keyed on something a person can type.
 *
 * The exchange and profile calls take an injected `fetch`, so every branch here
 * runs without a network, a browser, or an OAuth client. What cannot be tested
 * in this repository is the handshake with Google itself, and nothing below
 * pretends otherwise.
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'

import {
  accountIdFor,
  ATTEMPT_TTL_MS,
  authorizeUrl,
  codeChallenge,
  createAttempt,
  describeMissingClientId,
  exchangeCode,
  fetchIdentity,
  GOOGLE_SCOPES,
  sameAccount,
  stateMatches,
  attemptIsFresh
} from '../../src/main/services/auth/google'

const CLIENT_ID = '123456.apps.googleusercontent.com'
const REDIRECT = 'http://127.0.0.1:53123/callback'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('PKCE', () => {
  it('derives the challenge as SHA-256, never the verifier itself', () => {
    const attempt = createAttempt()
    const expected = createHash('sha256').update(attempt.verifier).digest('base64url')
    expect(codeChallenge(attempt.verifier)).toBe(expected)
    expect(codeChallenge(attempt.verifier)).not.toBe(attempt.verifier)
  })

  it('makes a different verifier and state every time', () => {
    const a = createAttempt()
    const b = createAttempt()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.state).not.toBe(b.state)
  })

  it('produces url-safe base64 with no padding', () => {
    const attempt = createAttempt()
    expect(attempt.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(attempt.state).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('the callback', () => {
  const attempt = createAttempt(Date.parse('2026-10-05T12:00:00.000Z'))

  it('accepts the state it issued', () => {
    expect(stateMatches(attempt, attempt.state)).toBe(true)
  })

  it('refuses a state from another application', () => {
    // Without this, another app on this machine could hand us a code it
    // obtained and have it redeemed as if the user had signed in.
    expect(stateMatches(attempt, createAttempt().state)).toBe(false)
    expect(stateMatches(attempt, '')).toBe(false)
    expect(stateMatches(attempt, `${attempt.state}x`)).toBe(false)
  })

  it('refuses a state of the same length but different bytes', () => {
    // A length-only check would pass this one.
    const swapped = attempt.state.slice(0, -1) + (attempt.state.endsWith('A') ? 'B' : 'A')
    expect(stateMatches(attempt, swapped)).toBe(false)
  })

  it('expires an attempt so a stale callback is not redeemed', () => {
    expect(attemptIsFresh(attempt, attempt.createdAt + 1000)).toBe(true)
    expect(attemptIsFresh(attempt, attempt.createdAt + ATTEMPT_TTL_MS)).toBe(true)
    expect(attemptIsFresh(attempt, attempt.createdAt + ATTEMPT_TTL_MS + 1)).toBe(false)
  })
})

describe('the URL it opens', () => {
  it('asks for PKCE and carries the challenge, not the verifier', () => {
    const attempt = createAttempt()
    const url = new URL(authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, attempt }))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(codeChallenge(attempt.verifier))
    expect(url.toString()).not.toContain(attempt.verifier)
  })

  it('requests only the scopes the product needs', () => {
    const url = new URL(authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, attempt: createAttempt() }))
    expect(url.searchParams.get('scope')).toBe(GOOGLE_SCOPES.join(' '))
    expect(GOOGLE_SCOPES).toEqual(['openid', 'email', 'profile'])
  })

  it('asks for a refresh token so the user is not asked again at every launch', () => {
    const url = new URL(authorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, attempt: createAttempt() }))
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('response_type')).toBe('code')
  })
})

describe('redeeming the code', () => {
  it('sends the verifier, and no client secret of any kind', async () => {
    let sent = ''
    const result = await exchangeCode({
      code: 'auth-code',
      verifier: 'the-verifier',
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      tokenUrl: 'https://example.test/token',
      fetchImpl: async (_url, init) => {
        sent = String((init as RequestInit).body)
        return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      }
    })
    expect(result.ok).toBe(true)
    expect(sent).toContain('code_verifier=the-verifier')
    expect(sent).toContain(`client_id=${encodeURIComponent(CLIENT_ID)}`)
    // An Electron binary is not a secret store. Anything embedded here can be
    // extracted, so nothing may be embedded here.
    expect(sent).not.toContain('client_secret')
  })

  it('returns the refresh token when Google issues one', async () => {
    const result = await exchangeCode({
      code: 'c',
      verifier: 'v',
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      fetchImpl: async () => jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
    })
    expect(result.ok && result.refreshToken).toBe('rt')
  })

  it('copes with no refresh token, which is normal on a second consent', async () => {
    const result = await exchangeCode({
      code: 'c',
      verifier: 'v',
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      fetchImpl: async () => jsonResponse({ access_token: 'at', expires_in: 3600 })
    })
    expect(result.ok && result.refreshToken).toBeNull()
  })

  it("surfaces Google's own refusal rather than a bare failure", async () => {
    const result = await exchangeCode({
      code: 'c',
      verifier: 'v',
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      fetchImpl: async () => jsonResponse({ error_description: 'Bad Request' }, 400)
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('Bad Request')
  })

  it('reports an unreachable service instead of hanging', async () => {
    const result = await exchangeCode({
      code: 'c',
      verifier: 'v',
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/Could not reach/)
  })
})

describe('who signed in', () => {
  it('keeps the stable id and reads the rest as optional', async () => {
    const result = await fetchIdentity(
      'at',
      async () => jsonResponse({ sub: '1234567890', email: 'a@b.test', name: 'A', picture: 'https://x/y' })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity.sub).toBe('1234567890')
    expect(result.identity.email).toBe('a@b.test')
  })

  it('refuses a response with no account id', async () => {
    const result = await fetchIdentity('at', async () => jsonResponse({ email: 'a@b.test' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    // Without `sub` there is nothing to key an account on, and inventing one
    // from an email would let anyone claim an account by typing an address.
    expect(result.error).toMatch(/account id/)
  })

  it('tolerates a profile with no email or picture', async () => {
    const result = await fetchIdentity('at', async () => jsonResponse({ sub: '1234567890' }))
    expect(result.ok && result.identity.email).toBeNull()
  })
})

describe('the account id', () => {
  it('is stable for one Google account, so a reinstall keeps the balance', () => {
    expect(accountIdFor('1234567890')).toBe(accountIdFor('1234567890'))
  })

  it('differs between two Google accounts', () => {
    expect(accountIdFor('1234567890')).not.toBe(accountIdFor('9876543210'))
  })

  it('is shaped the way the agent server requires', () => {
    // `looksLikeAccountId` there demands 8-128 of A-Z a-z 0-9 _ -
    expect(accountIdFor('1234567890')).toMatch(/^acct_[A-Za-z0-9_-]{8,128}$/)
  })

  it('does not leak the Google id into the account id', async () => {
    expect(accountIdFor('1234567890')).not.toContain('1234567890')
  })

  it('refuses a sub that is not a plausible id', () => {
    expect(accountIdFor('')).toBeNull()
    expect(accountIdFor('   ')).toBeNull()
    expect(accountIdFor('../../etc/passwd')).toBeNull()
    expect(accountIdFor('short')).toBeNull()
  })

  it('compares ids without a timing leak', () => {
    expect(sameAccount('acct_abc', 'acct_abc')).toBe(true)
    expect(sameAccount('acct_abc', 'acct_abd')).toBe(false)
  })
})

describe('when it is not configured', () => {
  it('says what to set, and that nothing is sent until then', () => {
    const message = describeMissingClientId()
    expect(message).toContain('GOOGLE_CLIENT_ID')
    expect(message).toMatch(/not a secret/i)
    expect(message).toMatch(/nothing is sent/i)
  })
})