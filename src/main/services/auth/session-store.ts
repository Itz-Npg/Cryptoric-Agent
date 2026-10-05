/**
 * Who is signed in, and the tokens that prove it.
 *
 * The **refresh token goes in the OS credential store**, not in a settings file.
 * A refresh token is a standing credential: anyone holding it can mint access
 * for the account without the browser and without the password. Writing it
 * beside the settings would put a durable credential in a file the user syncs,
 * backs up, and pastes into bug reports.
 *
 * What *is* kept in plain settings is the non-secret half — the account id and a
 * display name — so the UI can say who is signed in without asking the keychain
 * to wake, and so a machine whose keychain is unavailable can still explain
 * itself rather than pretending nobody is signed in.
 */

import { accountIdFor, sameAccount, type Identity } from './google'

/** Credential-store slot. One account at a time, by design. */
export const AUTH_CREDENTIAL = 'cryptoric-google-session'

/** The half of the session that is not a secret. */
export interface SessionSummary {
  accountId: string
  email: string | null
  name: string | null
  picture: string | null
  signedInAt: string
}

/** The tokens. Only ever in the credential store. */
export interface SessionSecrets {
  refreshToken: string | null
  accessToken: string | null
  expiresAt: number | null
}

export type SessionResult =
  | { ok: true; summary: SessionSummary; secrets: SessionSecrets }
  | { ok: false; error: string }

function isSecrets(value: unknown): value is SessionSecrets {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  const strings = [s.refreshToken, s.accessToken]
  return strings.every((v) => v === null || typeof v === 'string')
}

/**
 * Parse what came out of the credential store.
 *
 * Corrupt or partially-written data is a signed-*out* state with a reason, not
 * an exception and not a session the app pretends is fine. A half-read session
 * would show a signed-in account whose tokens are unusable.
 */
export function parseSession(raw: unknown): SessionResult {
  if (!isSecrets(raw)) {
    return { ok: false, error: 'The saved sign-in could not be read. Sign in again.' }
  }
  if (!raw.refreshToken) {
    return { ok: false, error: 'There is no refresh token saved. Sign in again.' }
  }
  return {
    ok: true,
    summary: { accountId: '', email: null, name: null, picture: null, signedInAt: '' },
    secrets: { refreshToken: raw.refreshToken, accessToken: raw.accessToken, expiresAt: raw.expiresAt }
  }
}

/** Build the summary for an identity that has just signed in. */
export function summarise(identity: Identity, now: number = Date.now()): SessionResult {
  const accountId = accountIdFor(identity.sub)
  if (accountId === null) {
    // Refusing here rather than storing an unusable id: a session whose account
    // the server cannot find is a signed-in app that cannot do anything.
    return { ok: false, error: 'The sign-in service returned an account id this build cannot use.' }
  }
  return {
    ok: true,
    summary: {
      accountId,
      email: identity.email,
      name: identity.name,
      picture: identity.picture,
      signedInAt: new Date(now).toISOString()
    },
    secrets: { refreshToken: null, accessToken: null, expiresAt: null }
  }
}

/**
 * Is the stored access token still usable?
 *
 * A minute of slack, because a token that expires mid-request produces an error
 * the user cannot act on, while refreshing a few seconds early costs one call.
 */
export function accessTokenIsFresh(secrets: SessionSecrets, now: number): boolean {
  if (typeof secrets.accessToken !== 'string' || secrets.accessToken.length === 0) return false
  if (typeof secrets.expiresAt !== 'number') return true
  return secrets.expiresAt - now > 60_000
}

/**
 * Is this session still the one we expect?
 *
 * Used after a refresh, so a response that quietly names a different account —
 * which would move someone's balance to somebody else's — is caught here.
 */
export function sessionMatches(summary: SessionSummary, accountId: string): boolean {
  return summary.accountId.length > 0 && sameAccount(summary.accountId, accountId)
}

/** What the UI shows when nobody is signed in, with what to do about it. */
export function describeSignedOut(reason: string | null): string {
  return reason ?? 'Sign in with Google to use the agent. Your keys and your code never leave this machine.'
}