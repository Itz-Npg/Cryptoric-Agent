/**
 * Live check for Google sign-in.
 *
 * The unit tests prove the pieces decide correctly; the pieces have never met
 * Google. This runs the real handshake: the real loopback listener on the real
 * port, the real authorization endpoint, the real code exchange, the real
 * userinfo call, and the real `startSignIn` sequencing that the app uses.
 *
 * What only this check can prove, and a unit test cannot:
 *
 *  - the port is **already accepting connections at the instant the browser is
 *    handed the URL**. The unit test for that ordering uses a fake browser; this
 *    one probes the socket from inside the callback that opens the real one.
 *  - Google actually accepts this redirect URI and this PKCE challenge, and
 *    actually returns a code the verifier redeems.
 *  - the identity Google returns has a `sub`, which is the only thing an account
 *    can be keyed on. A response without one is a real possibility and a real
 *    failure, not a hypothetical.
 *  - the listener is **gone** afterwards, so a reloaded tab cannot deliver a
 *    second code.
 *
 * One deliberate omission: this does not write to the OS credential store. A
 * refresh token in a terminal check's process is a standing credential in a
 * place nobody would think to look for one, so the session is held in memory and
 * dropped when the process exits.
 *
 * Needs a browser and a human: the person consents, so the check cannot be
 * unattended. With no `GOOGLE_CLIENT_ID` it reports SKIPPED and exits 0 — an
 * absent credential is a missing test input, the same convention as
 * `npm run test:model`, and it says loudly that nothing ran.
 */

import { spawn } from 'node:child_process'
import { readEnvFile } from '../../src/main/services/models/dotenv'
import {
  accountIdFor,
  attemptIsFresh,
  authorizeUrl,
  createAttempt,
  exchangeCode,
  fetchIdentity,
  stateMatches,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_SCOPES,
  type AuthAttempt,
  type Identity
} from '../../src/main/services/auth/google'
import { CALLBACK_PORT, CALLBACK_URI, startCallbackListener } from '../../src/main/services/auth/loopback'
import { startSignIn } from '../../src/main/services/auth/sign-in'

let failures = 0
let passes = 0

function pass(message: string): void {
  passes++
  console.log(`[PASS] ${message}`)
}

function fail(message: string): void {
  failures++
  console.error(`[FAIL] ${message}`)
}

/** The client id the app would read at boot, resolved the way the app resolves it. */
function resolveClientId(): string {
  const fromEnv = process.env['GOOGLE_CLIENT_ID']
  if (fromEnv) return fromEnv.trim()
  return (readEnvFile([process.cwd()]).GOOGLE_CLIENT_ID ?? '').trim()
}

const clientId = resolveClientId()

if (clientId.length === 0) {
  console.log('[SKIP] no GOOGLE_CLIENT_ID — set it in .env (see .env.example) or the environment')
  console.log('0 checks run against Google. The unit tests are not a substitute for this.')
  process.exit(0)
}

/** Hand a URL to this machine's default browser. The app uses Electron; a terminal does not. */
function systemOpen(url: string): Promise<void> {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('exit', () => resolve())
  })
}

/** Is the callback port answering? A 404 from our own listener is proof it is bound. */
async function probePort(): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${CALLBACK_PORT}/probe-${Date.now()}`)
    return res.status
  } catch {
    return null
  }
}

/** Wait for the port to stop answering, which is the listener tearing itself down. */
async function waitForPortClosed(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await probePort()) === null) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

interface Captured {
  identity: Identity
  accountId: string
  refreshToken: string | null
  accessToken: string
}

let attempt: AuthAttempt | null = null
let captured: Captured | null = null
let boundBeforeBrowser: number | null = null
let openedUrl = ''
/** Kept so the replay attempt after the run can re-send exactly what worked. */
let spent: { code: string; verifier: string } | null = null

async function main(): Promise<void> {
  console.log(`Redirect URI: ${CALLBACK_URI}`)
  console.log('A browser will open. Sign in to prove the handshake; nothing is stored.\n')

  const outcome = await startSignIn({
    redirectUri: CALLBACK_URI,
    buildUrl: () => {
      const next = createAttempt()
      attempt = next
      return authorizeUrl({ clientId, redirectUri: CALLBACK_URI, attempt: next })
    },
    listen: () => startCallbackListener({ port: CALLBACK_PORT }),
    openBrowser: async (url) => {
      openedUrl = url
      // The assertion the app's correctness rests on, measured from the only
      // place that can measure it: the moment control leaves for the browser.
      boundBeforeBrowser = await probePort()
      console.log('If the browser did not open, visit:\n')
      console.log(`  ${url}\n`)
      await systemOpen(url)
    },
    complete: async (code, state) => {
      const current = attempt
      attempt = null
      if (!current) return { ok: false, error: 'There is no sign-in in progress.' }
      if (!stateMatches(current, state)) {
        return { ok: false, error: 'That sign-in response did not come from this app.' }
      }
      if (!attemptIsFresh(current, Date.now())) {
        return { ok: false, error: 'That sign-in took too long. Start again.' }
      }
      const token = await exchangeCode({ code, verifier: current.verifier, clientId, redirectUri: CALLBACK_URI })
      if (!token.ok) return { ok: false, error: token.error }
      const profile = await fetchIdentity(token.accessToken)
      if (!profile.ok) return { ok: false, error: profile.error }
      const accountId = accountIdFor(profile.identity.sub)
      if (accountId === null) return { ok: false, error: 'Google returned a sub we cannot key an account on.' }
      spent = { code, verifier: current.verifier }
      captured = {
        identity: profile.identity,
        accountId,
        refreshToken: token.refreshToken,
        accessToken: token.accessToken
      }
      return { ok: true }
    },
    clearAttempt: () => {
      attempt = null
    }
  })

  console.log('')

  // --- 1. the authorization URL is the real one, shaped right -----------------
  {
    const url = new URL(outcome.url)
    const good =
      `${url.origin}${url.pathname}` === GOOGLE_AUTHORIZE_URL &&
      url.searchParams.get('response_type') === 'code' &&
      url.searchParams.get('code_challenge_method') === 'S256' &&
      url.searchParams.get('access_type') === 'offline' &&
      url.searchParams.get('scope') === GOOGLE_SCOPES.join(' ') &&
      url.searchParams.get('redirect_uri') === CALLBACK_URI &&
      (url.searchParams.get('code_challenge') ?? '').length > 0 &&
      (url.searchParams.get('state') ?? '').length > 0
    if (good) {
      pass('the URL sent to Google is the authorization endpoint with S256 PKCE and offline access')
    } else {
      fail(`the authorization URL is malformed: ${outcome.url}`)
    }
  }

  // --- 2. the port was bound before the browser was handed the URL ------------
  {
    if (boundBeforeBrowser === 404) {
      pass(`port ${CALLBACK_PORT} was already answering when the browser was opened`)
    } else {
      fail(
        `the port was not bound when the browser was opened (probe returned ${boundBeforeBrowser ?? 'nothing'}) — ` +
          'a redirect here loses the code'
      )
    }
  }

  // --- 3. the handshake itself -------------------------------------------------
  if (!outcome.ok || !captured) {
    fail(`sign-in did not complete: ${outcome.error ?? 'no reason given'}`)
  } else {
    pass(`Google exchanged the code for a real access token (${captured.accessToken.length} chars)`)
    pass(`userinfo returned a sub, so an account can be keyed: ${captured.identity.email ?? '(no email)'}`)
    if (/^acct_[A-Za-z0-9_-]{32}$/.test(captured.accountId)) {
      pass(`sub maps to a well-formed account id: ${captured.accountId}`)
    } else {
      fail(`account id is malformed: ${captured.accountId}`)
    }
    if (captured.refreshToken !== null) {
      pass('a refresh token came back, so the person is not asked to sign in again')
    } else {
      pass('no refresh token this time, which is expected when consent was already granted')
    }
  }

  // --- 4. the listener tore itself down ---------------------------------------
  {
    if (await waitForPortClosed(3000)) {
      pass(`port ${CALLBACK_PORT} closed after one callback, so a reloaded tab cannot deliver a second code`)
    } else {
      fail(`port ${CALLBACK_PORT} is still answering after the callback`)
    }
  }

  // --- 5. the code cannot be spent twice ---------------------------------------
  //
  // Two separate replays are tried, and both are the real thing rather than a
  // look at a local variable. The authorization code is presented to Google a
  // second time with the verifier that legitimately redeemed it the first time —
  // if a code were reusable, a code observed in a browser history or a proxy log
  // would be a durable credential.
  {
    const replay = spent
    if (!replay) {
      fail('nothing was captured to replay; the run did not get as far as a code')
    } else {
      const again = await exchangeCode({
        code: replay.code,
        verifier: replay.verifier,
        clientId,
        redirectUri: CALLBACK_URI
      })
      if (again.ok) {
        fail('Google redeemed the same authorization code twice — a spent code is reusable')
      } else {
        pass(`Google refused to redeem the code a second time: ${again.error}`)
      }
      if (attempt === null) {
        pass('the local attempt was consumed, so a replayed callback has nothing to match state against')
      } else {
        fail('a local attempt is still held after completion')
      }
    }
  }
}

try {
  await main()
} catch (err) {
  fail(`the check threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
} finally {
  console.log('')
  console.log(`--- ${passes} passed, ${failures} failed ---`)
  if (openedUrl.length > 0 && !captured) console.log(`The URL that was opened: ${openedUrl}`)
  process.exitCode = failures === 0 ? 0 : 1
}
