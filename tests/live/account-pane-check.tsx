/**
 * The account pane, rendered for real.
 *
 * There is no DOM test environment in this project and no browser automation
 * for a `WebContentsView`, so a React component could otherwise only ever be
 * checked by typechecking it. `react-dom/server` renders the real component
 * tree to real markup in plain Node, which is enough to prove that each state
 * draws the right control — a sign-in button that is never drawn is exactly the
 * bug this check exists for.
 *
 * It renders; it does not click. The click path is the bridge, which is covered
 * by the main-process tests and by `typecheck:web` failing if a component calls
 * a method the bridge does not have.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountPane, AccountChip } from '../../src/renderer/src/panes/Account'
import { accountView } from '../../src/shared/account-view'
import type { AuthStatus } from '../../src/preload'

const account = {
  accountId: 'acct_0123456789abcdef0123456789abcdef',
  email: 'chan@example.com',
  name: 'Cryptoric Chan',
  picture: null,
  signedInAt: '2026-10-05T10:00:00.000Z'
}

const cases: { name: string; status: AuthStatus | null; phase: 'idle' | 'starting' | 'waiting'; error: string | null; hosted: boolean }[] = [
  { name: 'signed out, configured', status: { signedIn: false, configured: true, account: null, message: null }, phase: 'idle', error: null, hosted: false },
  { name: 'not configured', status: { signedIn: false, configured: false, account: null, message: 'Set GOOGLE_CLIENT_ID in .env to a Desktop app client id.' }, phase: 'idle', error: null, hosted: true },
  { name: 'waiting', status: { signedIn: false, configured: true, account: null, message: null }, phase: 'waiting', error: null, hosted: false },
  { name: 'failed', status: { signedIn: false, configured: true, account: null, message: null }, phase: 'idle', error: 'Sign-in timed out. Try again.', hosted: false },
  { name: 'signed in', status: { signedIn: true, configured: true, account, message: null }, phase: 'idle', error: null, hosted: true }
]

let bad = 0
for (const c of cases) {
  const html = renderToStaticMarkup(
    createElement(AccountPane, {
      status: c.status,
      phase: c.phase,
      error: c.error,
      hosted: c.hosted,
      onSignIn: () => {},
      onSignOut: () => {},
      onComplete: () => {}
    })
  )
  const view = accountView(c.status, c.phase, c.error)
  const has = (s: string): boolean => html.includes(s)
  // "The label is absent" is trivially true when the whole pane is broken, so
  // the button itself is counted: one primary action exactly when the view
  // model says there is one to press.
  const primaryButtons = (html.match(/data-variant="primary"/g) ?? []).length
  const wantsPrimary = view.action !== null && view.action.kind !== 'sign-out'
  const checks: [string, boolean][] = [
    ['chip text rendered', has(view.chip)],
    ['action label rendered', view.action ? has(view.action.label) : true],
    ['primary button count matches the view model', primaryButtons === (wantsPrimary ? 1 : 0)],
    ['paste box present', has('127.0.0.1:53123/callback?code=')],
    ['no token in markup', !/ya29\.|refresh_token|accessToken/.test(html)]
  ]
  if (c.hosted) checks.push(['hosted chip rendered', has('Hosted')])
  if (c.name === 'signed in') checks.push(['account rows rendered', has('acct_0123456789abcdef0123456789abcdef')])
  const failed = checks.filter(([, ok]) => !ok)
  bad += failed.length
  console.log(`${failed.length === 0 ? 'PASS' : 'FAIL'} ${c.name} — ${failed.map(([n]) => n).join(', ') || 'all checks'}`)
}

const chip = renderToStaticMarkup(
  createElement(AccountChip, { status: cases[4]!.status, phase: 'idle', error: null, onOpen: () => {} })
)
console.log(`${chip.includes('Cryptoric Chan') ? 'PASS' : 'FAIL'} topbar chip shows the signed-in name`)
if (!chip.includes('Cryptoric Chan')) bad++

console.log(bad === 0 ? 'ALL RENDER CHECKS PASSED' : `${bad} RENDER CHECK(S) FAILED`)
process.exitCode = bad === 0 ? 0 : 1
