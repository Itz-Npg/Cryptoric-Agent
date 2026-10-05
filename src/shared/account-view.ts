/**
 * What the account surface should show.
 *
 * Split out from the React component on purpose. The decisions here — is the
 * button live, what does the chip say, is an error worth showing — are the part
 * that can be wrong, and they are all testable without a DOM. The component is
 * then only responsible for drawing whatever this returns.
 *
 * No DOM, no `window`, no bridge: `AuthStatus` comes in as data. It lives in
 * `shared/` because a test has to be able to reach it, and the node project
 * cannot import out of `src/renderer/`.
 */

import type { AuthStatus } from '../preload'

/** Where the browser round-trip has got to. */
export type SignInPhase = 'idle' | 'starting' | 'waiting'

export interface AccountView {
  /** What the topbar chip says. Never empty. */
  chip: string
  tone: 'ok' | 'warn' | 'error' | 'idle'
  /** The one line under the chip. */
  detail: string
  /** The primary button, or `null` when there is nothing useful to press. */
  action: { label: string; kind: 'sign-in' | 'sign-out' | 'retry' } | null
  /** True while the browser round-trip is in flight; buttons must be inert. */
  busy: boolean
  /**
   * A configuration or failure message that needs reading rather than
   * skimming — the exact env var, or why the attempt stopped.
   */
  notice: string | null
}

const SIGN_IN_BLURB = 'Sign in with Google so your coin balance follows you to another install.'

/**
 * Reduce everything known about sign-in into one view model.
 *
 * `error` wins over everything except being signed in, because an error the
 * user cannot see is the difference between "this app is broken" and "this
 * attempt failed" — and the second one is worth retrying.
 */
export function accountView(status: AuthStatus | null, phase: SignInPhase, error: string | null): AccountView {
  const busy = phase !== 'idle'

  // While the browser is in flight the state on the other side of it is not
  // yet true, so the view describes the round-trip rather than the old answer.
  if (busy && !(status?.signedIn ?? false)) {
    return {
      chip: phase === 'starting' ? 'Opening browser…' : 'Waiting for Google…',
      tone: 'idle',
      detail:
        phase === 'starting'
          ? 'Starting the loopback listener before your browser opens.'
          : 'Finish in the browser tab. This tab can be closed once you are back.',
      action: null,
      busy: true,
      notice: error
    }
  }

  if (error !== null) {
    return {
      chip: 'Sign-in failed',
      tone: 'error',
      detail: error,
      // A retry is offered rather than a dead end: the commonest cause is a
      // cancelled or expired tab, and that is worth one more press.
      action: status?.configured === false ? null : { label: 'Try again', kind: 'retry' },
      busy: false,
      notice: error
    }
  }

  if (status === null) {
    return {
      chip: 'Account',
      tone: 'idle',
      detail: 'Checking whether you are signed in…',
      action: null,
      busy,
      notice: null
    }
  }

  if (!status.configured) {
    // No button, because pressing one could only produce the same message.
    // The message itself names the variable to set.
    return {
      chip: 'Sign-in unavailable',
      tone: 'warn',
      detail: status.message ?? 'No OAuth client id is configured.',
      action: null,
      busy,
      notice: status.message
    }
  }

  if (status.signedIn && status.account) {
    const who = status.account.name ?? status.account.email ?? 'Signed in'
    return {
      chip: who,
      tone: 'ok',
      detail: status.account.email ?? status.account.accountId,
      action: { label: 'Sign out', kind: 'sign-out' },
      busy,
      notice: null
    }
  }

  return {
    chip: 'Sign in',
    tone: 'idle',
    detail: status.message ?? SIGN_IN_BLURB,
    action: { label: 'Sign in with Google', kind: 'sign-in' },
    busy,
    notice: null
  }
}

/**
 * Read a redirect someone pasted back in by hand.
 *
 * Corporate browsers that refuse to open a loopback address still copy the
 * address bar contents, and asking for a bare authorization code instead would
 * mean asking for the one thing that person has no way to isolate.
 */
export function parsePastedRedirect(pasted: string): { ok: true; code: string; state: string } | { ok: false; error: string } {
  const text = pasted.trim()
  if (text.length === 0) return { ok: false, error: 'Paste the address your browser was sent to.' }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, error: 'That is not a link. Paste the whole address, starting with http://.' }
  }

  const error = url.searchParams.get('error')
  if (error !== null) {
    return {
      ok: false,
      error: error === 'access_denied' ? 'Sign-in was cancelled.' : `Google returned "${error}".`
    }
  }

  const code = url.searchParams.get('code') ?? ''
  const state = url.searchParams.get('state') ?? ''
  if (code.length === 0 || state.length === 0) {
    return { ok: false, error: 'That link carries no sign-in response. Start again and copy the full address.' }
  }
  return { ok: true, code, state }
}
