/**
 * Receiving the redirect.
 *
 * Google sends the browser to `http://127.0.0.1:<port>/callback` after the user
 * consents, and something has to be listening or the tab shows a connection
 * error and the code is lost. That "something" is a loopback HTTP server bound
 * to one port, for one attempt, and torn down the moment it has what it came
 * for.
 *
 * Why loopback rather than a custom protocol or a deep link: `127.0.0.1` is
 * bound by the machine itself, so nothing outside it can deliver a callback, and
 * Google's installed-app flow expects it. `localhost` is not used because it
 * resolves to IPv6 first on some machines and the listener may be on IPv4 only —
 * a redirect that silently goes nowhere is worse than a visible failure.
 */

import { createServer, type Server } from 'node:http'

/** What a successful redirect carries. */
export interface CallbackResult {
  code: string
  state: string
}

/** What a caller gets instead, when the browser arrived and we did not want it. */
export type CallbackOutcome =
  | { ok: true; result: CallbackResult }
  | { ok: false; error: string }

export interface LoopbackOptions {
  port: number
  /** How long to wait before giving up. A person takes time to consent. */
  timeoutMs?: number
  /** Injected so a test can drive time and the browser. */
  createServerImpl?: typeof createServer
}

/**
 * A started listener, and — the part that matters — proof it is *bound*.
 *
 * `server.listen` is asynchronous, so "I called the function that listens" is
 * not "the port is open". Anyone who opens a browser before `listening`
 * resolves has reproduced the bug this file exists to prevent: the redirect
 * lands on a closed port and the authorization code is lost. Awaiting
 * `listening` is what makes the ordering in the caller meaningful instead of
 * merely plausible.
 */
export interface CallbackListener {
  /** Resolves once the port accepts connections. Rejects if it never can. */
  listening: Promise<void>
  /** Resolves exactly once, with the callback or the reason there was none. */
  outcome: Promise<CallbackOutcome>
  /** Stop listening early — the person gave up, or the app is shutting down. */
  cancel(): void
}

const PAGE_OK = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font-family:system-ui;margin:4rem auto;max-width:32rem;text-align:center">
<h1>You're signed in</h1><p>You can close this tab and go back to Cryptoric Agent.</p>`

const PAGE_BAD = `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<body style="font-family:system-ui;margin:4rem auto;max-width:32rem;text-align:center">
<h1>Sign-in failed</h1><p>Go back to Cryptoric Agent and try again.</p>`

/**
 * Listen for exactly one callback, then close.
 *
 * Kept as the one-call form for callers with nothing to sequence. Anything that
 * opens a browser afterwards must use `startCallbackListener` and await
 * `listening` first.
 */
export function awaitCallback(options: LoopbackOptions): Promise<CallbackOutcome> {
  return startCallbackListener(options).outcome
}

/**
 * Start listening, reporting back when the port is actually open.
 *
 * Only the first callback is answered, then the server closes. That is not a
 * nicety: a browser that retries, or a user who reloads the tab, would
 * otherwise keep the server alive and able to answer a second code.
 */
export function startCallbackListener(options: LoopbackOptions): CallbackListener {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const make = options.createServerImpl ?? createServer

  let markListening!: () => void
  let markUnlistenable!: (err: Error) => void
  const listening = new Promise<void>((res, rej) => {
    markListening = res
    markUnlistenable = rej
  })
  // A caller that only wants `outcome` must not be killed by a rejection nobody
  // asked for. `outcome` carries the very same error, so nothing is lost.
  void listening.catch(() => {})

  let cancel = (): void => {}

  const outcome = new Promise<CallbackOutcome>((resolve) => {
    let settled = false

    const finish = (value: CallbackOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      resolve(value)
    }
    cancel = () => finish({ ok: false, error: 'Sign-in was cancelled.' })

    const server: Server = make((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      // Anything that is not our callback gets nothing. This port is the only
      // thing standing between a random page and the authorization code.
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><meta charset="utf-8"><p>Not found.</p>')
        return
      }

      const code = url.searchParams.get('code') ?? ''
      const state = url.searchParams.get('state') ?? ''
      const error = url.searchParams.get('error') ?? ''

      const fail = (message: string): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE_BAD)
        finish({ ok: false, error: message })
      }

      if (error.length > 0) {
        // A refusal the person chose (`access_denied`) is reported as their
        // choice, not as a broken app.
        fail(error === 'access_denied' ? 'Sign-in was cancelled.' : `Google returned "${error}".`)
        return
      }
      if (code.length === 0 || state.length === 0) {
        fail('The redirect did not carry a code.')
        return
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE_OK)
      finish({ ok: true, result: { code, state } })
    })

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'Sign-in timed out. Try again.' })
    }, timeoutMs)
    // A pending timer must not be the reason the process stays alive.
    timer.unref?.()

    server.on('error', (err) => {
      const failure = new Error(`Could not listen for the sign-in redirect: ${err.message}`)
      // Both audiences get it: whoever is waiting to open a browser needs to
      // know now, and whoever only wants the outcome needs the reason.
      markUnlistenable(failure)
      finish({ ok: false, error: failure.message })
    })

    // The one signal this design exists for. Nothing downstream should hand
    // control to a browser until this fires.
    server.on('listening', () => {
      markListening()
    })

    server.listen(options.port, '127.0.0.1')
  })

  return { listening, outcome, cancel: () => cancel() }
}

/** The port the callback listener uses. Fixed so the redirect URI can be registered. */
export const CALLBACK_PORT = 53123

/** The redirect URI to register with Google. */
export const CALLBACK_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`