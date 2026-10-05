/**
 * The account surface's decisions.
 *
 * These are the rules a person reads when they cannot sign in: is there a
 * button, does it say what to do, is the failure visible. They live in a pure
 * module precisely so they can be asserted here without a DOM, and so the
 * component stays a drawing of the answer.
 */

import { describe, expect, it } from 'vitest'

import { accountView, describeBalance, parsePastedRedirect } from '../../src/shared/account-view'
import type { AuthStatus } from '../../src/preload'

function status(over: Partial<AuthStatus> = {}): AuthStatus {
  return {
    signedIn: false,
    configured: true,
    account: null,
    message: null,
    ...over
  }
}

const ACCOUNT = {
  accountId: 'acct_0123456789abcdef0123456789abcdef',
  email: 'chan@example.com',
  name: 'Cryptoric Chan',
  picture: null,
  signedInAt: '2026-10-05T10:00:00.000Z'
}

describe('what the account surface shows', () => {
  it('says nothing about signing in until the status has been read', () => {
    const view = accountView(null, 'idle', null)
    expect(view.chip).toBe('Account')
    expect(view.action).toBeNull()
    expect(view.busy).toBe(false)
  })

  it('offers sign-in when nobody is signed in', () => {
    const view = accountView(status(), 'idle', null)
    expect(view.action).toEqual({ label: 'Sign in with Google', kind: 'sign-in' })
    expect(view.tone).toBe('idle')
  })

  it('offers no button at all when no client id is configured', () => {
    // Pressing a button here could only ever produce the message underneath
    // it, which is a worse experience than saying what to set instead.
    const view = accountView(
      status({ configured: false, message: 'Set GOOGLE_CLIENT_ID in .env to a Desktop app client id.' }),
      'idle',
      null
    )
    expect(view.action).toBeNull()
    expect(view.tone).toBe('warn')
    expect(view.notice).toMatch(/GOOGLE_CLIENT_ID/)
  })

  it('shows who is signed in, and a way out', () => {
    const view = accountView(status({ signedIn: true, account: ACCOUNT }), 'idle', null)
    expect(view.chip).toBe('Cryptoric Chan')
    expect(view.detail).toBe('chan@example.com')
    expect(view.action).toEqual({ label: 'Sign out', kind: 'sign-out' })
    expect(view.tone).toBe('ok')
  })

  it('falls back to the email, then the account id, when there is no name', () => {
    const noName = accountView(status({ signedIn: true, account: { ...ACCOUNT, name: null } }), 'idle', null)
    expect(noName.chip).toBe('chan@example.com')

    const noNameNoEmail = accountView(
      status({ signedIn: true, account: { ...ACCOUNT, name: null, email: null } }),
      'idle',
      null
    )
    expect(noNameNoEmail.chip).toBe('Signed in')
    // The id is what the server knows them by, so it is shown rather than hidden.
    expect(noNameNoEmail.detail).toBe(ACCOUNT.accountId)
  })

  it('describes the browser round-trip while it is in flight, and disables the action', () => {
    const starting = accountView(status(), 'starting', null)
    expect(starting.busy).toBe(true)
    expect(starting.action).toBeNull()
    expect(starting.chip).toMatch(/browser/i)

    const waiting = accountView(status(), 'waiting', null)
    expect(waiting.busy).toBe(true)
    expect(waiting.chip).toMatch(/google/i)
  })

  it('never claims to be waiting while already signed in', () => {
    // The sign-in button is reachable while signed in; a stale phase must not
    // replace a working session with "waiting for Google".
    const view = accountView(status({ signedIn: true, account: ACCOUNT }), 'waiting', null)
    expect(view.chip).toBe('Cryptoric Chan')
    expect(view.busy).toBe(true)
  })

  it('offers a retry after a failure, because most failures are worth one more press', () => {
    const view = accountView(status(), 'idle', 'Sign-in timed out. Try again.')
    expect(view.tone).toBe('error')
    expect(view.action).toEqual({ label: 'Try again', kind: 'retry' })
    expect(view.detail).toBe('Sign-in timed out. Try again.')
  })

  it('does not offer a retry when retrying could not possibly work', () => {
    const view = accountView(status({ configured: false }), 'idle', 'No client id.')
    expect(view.action).toBeNull()
    expect(view.tone).toBe('error')
  })
})

describe('reading a redirect pasted by hand', () => {
  it('takes the code and state out of a full redirect URL', () => {
    const parsed = parsePastedRedirect(
      'http://127.0.0.1:53123/callback?code=4/0AbCd&state=xyz&scope=openid'
    )
    expect(parsed).toEqual({ ok: true, code: '4/0AbCd', state: 'xyz' })
  })

  it('tolerates the whitespace a copy-paste leaves behind', () => {
    const parsed = parsePastedRedirect('  http://127.0.0.1:53123/callback?code=a&state=b \n')
    expect(parsed).toEqual({ ok: true, code: 'a', state: 'b' })
  })

  it('refuses text that is not a link', () => {
    const parsed = parsePastedRedirect('4/0AbCd xyz')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/not a link/i)
  })

  it('refuses an empty box without pretending it was a failed sign-in', () => {
    const parsed = parsePastedRedirect('   ')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/paste the address/i)
  })

  it('reports a refusal as the person\'s choice', () => {
    const parsed = parsePastedRedirect('http://127.0.0.1:53123/callback?error=access_denied')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/cancelled/i)
  })

  it('passes any other error from Google through', () => {
    const parsed = parsePastedRedirect('http://127.0.0.1:53123/callback?error=access_denied&error_description=x')
    expect(parsed.ok).toBe(false)
  })

  it('refuses a link with no code, rather than sending an empty one to the exchange', () => {
    const parsed = parsePastedRedirect('http://127.0.0.1:53123/callback?state=only-state')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/no sign-in response/i)
  })
})

describe('the coins line', () => {
  it('says it is still reading, rather than claiming the user is broke', () => {
    expect(describeBalance(null)).toMatch(/reading/i)
  })

  it('shows a failure as a failure, so no stale number is left standing', () => {
    expect(describeBalance({ source: 'server', ok: false, error: 'The Cryptoric account server could not be reached.' }))
      .toMatch(/could not be reached/)
  })

  it('says where the coins are counted, which differs by mode', () => {
    expect(describeBalance({ source: 'server', ok: true, balance: 25, dailyCoins: 25 })).toMatch(
      /on the Cryptoric server/
    )
    expect(describeBalance({ source: 'local', ok: true, balance: 25, dailyCoins: 25 })).toMatch(/on this computer/)
  })

  it('converts coins into the minutes they actually buy', () => {
    // 6 minutes a coin: 20 coins is two hours. An approximate figure here would
    // be the same lie the pricing rule exists to prevent.
    expect(describeBalance({ source: 'server', ok: true, balance: 20 })).toMatch(/about 120 minutes/)
  })

  it('does not call one coin "1 coins"', () => {
    expect(describeBalance({ source: 'local', ok: true, balance: 1 })).toMatch(/1 coin —/)
  })

  it('says plainly that zero coins stops the agent', () => {
    expect(describeBalance({ source: 'server', ok: true, balance: 0 })).toMatch(/cannot run/i)
  })
})
