/**
 * Signing in, for a desktop app that must never hold a client secret.
 *
 * OAuth 2.0 Authorization Code flow **with PKCE**, opened in the system browser
 * and handed back over a loopback redirect. Three properties make this the
 * right shape here rather than the obvious alternative:
 *
 *  - **No client secret ships with the app.** An Electron binary is not a
 *    secret store; anything embedded in it can be extracted. PKCE replaces the
 *    secret with a per-attempt verifier that never leaves this process until the
 *    code is redeemed. Google's own "installed app" flow is built this way.
 *  - **The browser does the credential entry**, so a user's Google password is
 *    never typed into our window and cannot be captured by us.
 *  - **`state` is compared, not trusted.** Without that check a redirect from
 *    another app could feed us a code, and the authorization-code flow is
 *    otherwise happy to redeem it.
 *
 * Everything here is pure or takes an injected `fetch`, so the parts that decide
 * whether a sign-in is *safe* are testable without a browser, a network, or an
 * OAuth client. The one thing that cannot be tested here is the handshake with
 * Google itself, because that needs a client id only the maintainer can create.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Google's OAuth endpoints. Overridable so the flow can be pointed elsewhere. */
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

/**
 * What we ask for, and nothing more.
 *
 * `openid email profile` is enough to know who someone is. Asking for anything
 * wider would be a larger grant than the product needs, and a scope someone did
 * not expect is the kind of thing that gets an app removed from a store.
 */
export const GOOGLE_SCOPES = ['openid', 'email', 'profile'] as const

/** One sign-in attempt: the two secrets that must match, plus the anti-CSRF value. */
export interface AuthAttempt {
  state: string
  verifier: string
  createdAt: number
}

/** base64url without padding, which is what the spec asks for. */
export function base64Url(input: Buffer | Uint8Array): string {
  return Buffer.from(input).toString('base64url')
}

/** `S256`: SHA-256 of the verifier, base64url-encoded. Never the plain verifier. */
export function codeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

/**
 * Begin an attempt.
 *
 * The verifier is 32 random bytes: long enough that guessing it is not a
 * project, and short enough that no provider rejects it.
 */
export function createAttempt(now: number = Date.now()): AuthAttempt {
  return {
    state: base64Url(randomBytes(32)),
    verifier: base64Url(randomBytes(32)),
    createdAt: now
  }
}

/**
 * Does this callback belong to the attempt we started?
 *
 * Constant-time on `state`: a comparison that returns early leaks it a character
 * at a time to anything able to measure, and `state` is what stops another
 * application from injecting a code of its own.
 */
export function stateMatches(attempt: AuthAttempt, returnedState: string): boolean {
  const provided = Buffer.from(returnedState ?? '', 'utf8')
  const expected = Buffer.from(attempt.state, 'utf8')
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i += 1) {
    // Lengths are equal, so both indexes are in range; the locals keep the
    // compiler from having to prove that on every line.
    diff |= provided[i]! ^ expected[i]!
  }
  return diff === 0
}

/**
 * Is this attempt still worth finishing?
 *
 * A code is only good for minutes, so a window that keeps a stale attempt
 * around invites redeeming a callback that no longer belongs to it. The window
 * is generous enough for a slow password manager and no wider.
 */
export const ATTEMPT_TTL_MS = 10 * 60_000

export function attemptIsFresh(attempt: AuthAttempt, now: number): boolean {
  return now - attempt.createdAt <= ATTEMPT_TTL_MS
}

export interface AuthorizeUrlInput {
  clientId: string
  redirectUri: string
  attempt: AuthAttempt
  /** Overridable for tests; defaults to Google. */
  endpoint?: string
}

/**
 * The URL to open in the browser.
 *
 * `access_type=offline` plus `prompt=consent` is what gets a refresh token, so
 * the user is not asked to sign in again every time the app restarts.
 */
export function authorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.endpoint ?? GOOGLE_AUTHORIZE_URL)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '))
  url.searchParams.set('code_challenge', codeChallenge(input.attempt.verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', input.attempt.state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

export type TokenResult =
  | { ok: true; accessToken: string; refreshToken: string | null; expiresInSeconds: number | null }
  | { ok: false; error: string }

/**
 * Redeem the code.
 *
 * `client_secret` is deliberately absent. For an installed app that is the
 * point of PKCE; sending an empty one is worse than sending none, because some
 * providers treat an empty secret as a failed confidential-client attempt.
 */
export async function exchangeCode(input: {
  code: string
  verifier: string
  clientId: string
  redirectUri: string
  fetchImpl?: typeof fetch
  tokenUrl?: string
}): Promise<TokenResult> {
  const doFetch = input.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(input.tokenUrl ?? GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: input.clientId,
        code_verifier: input.verifier,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri
      }).toString()
    })
  } catch (err) {
    return { ok: false, error: `Could not reach the sign-in service: ${err instanceof Error ? err.message : String(err)}` }
  }

  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error_description?: string
  }

  if (!res.ok || typeof body.access_token !== 'string') {
    return { ok: false, error: body.error_description ?? `Sign-in was refused (${res.status}).` }
  }
  return {
    ok: true,
    accessToken: body.access_token,
    // Absent when the user has already consented; the old one is still valid.
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : null
  }
}

/** Who signed in. `sub` is Google's stable id and is what the account is keyed on. */
export interface Identity {
  /** Google's user id. Stable for this account, and the only id we key on. */
  sub: string
  email: string | null
  name: string | null
  picture: string | null
}

export type ProfileResult = { ok: true; identity: Identity } | { ok: false; error: string }

export async function fetchIdentity(accessToken: string, fetchImpl?: typeof fetch): Promise<ProfileResult> {
  const doFetch = fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` }
    })
  } catch (err) {
    return { ok: false, error: `Could not reach the sign-in service: ${err instanceof Error ? err.message : String(err)}` }
  }
  const body = (await res.json().catch(() => ({}))) as Partial<Identity>
  if (!res.ok || typeof body.sub !== 'string' || body.sub.length === 0) {
    // A response with no `sub` is unusable: without it there is nothing to key
    // an account on, and inventing a key from an email would let anyone claim
    // an account by typing an address that is not theirs.
    return { ok: false, error: 'The sign-in service did not return an account id.' }
  }
  return {
    ok: true,
    identity: {
      sub: body.sub,
      email: typeof body.email === 'string' ? body.email : null,
      name: typeof body.name === 'string' ? body.name : null,
      picture: typeof body.picture === 'string' ? body.picture : null
    }
  }
}

/**
 * The account id this identity maps to on the agent server.
 *
 * Derived from `sub`, which Google guarantees is stable and unique per account.
 * A random id stored locally would be lost on reinstall — which is the exact
 * thing the hosted mode exists to prevent — and an email-derived one would let
 * two people collide, or one person claim another's account, over an address
 * that can change and can be verified by typing it.
 */
export function accountIdFor(sub: string): string | null {
  const trimmed = typeof sub === 'string' ? sub.trim() : ''
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(trimmed)) return null
  return `acct_${base64Url(createHash('sha256').update(`cryptoric:${trimmed}`).digest()).slice(0, 32)}`
}

/** Compare two ids without leaking them by timing. */
export function sameAccount(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** What a person sees when sign-in is impossible, with the reason and a way out. */
export function describeMissingClientId(): string {
  return (
    'Google sign-in is not set up on this build. Set GOOGLE_CLIENT_ID (an OAuth client id, not a ' +
    'secret) and restart. Nothing is sent anywhere until it is configured.'
  )
}