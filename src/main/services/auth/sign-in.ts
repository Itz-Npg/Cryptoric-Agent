/**
 * The browser half of sign-in, in the order it has to happen.
 *
 * This exists as its own module because the order is the whole correctness story
 * and order is exactly the thing that is invisible to review. Three steps must
 * run in sequence: bind the loopback port, *then* hand the URL to the system
 * browser, *then* wait for the redirect. Swap the first two and the redirect
 * lands on a closed port — the person sees a connection error, the code is
 * gone, and the app reports "sign-in failed" for a bug nobody can find.
 *
 * Both the listener and the browser are injected. That is not architecture for
 * its own sake: with a real socket and a fake browser, a test can assert the
 * port is already accepting connections at the instant the browser is handed
 * the URL — the one assertion that would have caught the bug this file was
 * extracted to prevent.
 */

import type { CallbackListener, CallbackOutcome } from './loopback'

export interface SignInDeps {
  /** Build the URL the browser will be sent to. */
  buildUrl(): string
  /** Start listening for the redirect. Must not block on binding. */
  listen(): CallbackListener
  /** Hand the URL to the system browser. */
  openBrowser(url: string): Promise<void>
  /** Redeem a code against the state we issued, and store the session. */
  complete(code: string, state: string): Promise<{ ok: boolean; error?: string }>
  /** Forget the in-flight attempt. Called on every path that ends it. */
  clearAttempt(): void
}

export interface SignInOutcome {
  ok: boolean
  /** The URL we opened, so a UI whose browser did not open can show it. */
  url: string
  redirectUri: string
  error?: string
}

export interface SignInOptions extends SignInDeps {
  redirectUri: string
}

/**
 * Run one attempt end to end.
 *
 * Never throws: every failure is a message a person can read. An exception
 * escaping into the IPC layer would reach the renderer as a rejected invoke
 * with none of this context, and "Sign-in timed out. Try again." is worth more
 * than a stack trace.
 */
export async function startSignIn(options: SignInOptions): Promise<SignInOutcome> {
  const url = options.buildUrl()
  const redirectUri = options.redirectUri

  const listener = options.listen()

  // The port must be *bound*, not merely requested: `listen()` is asynchronous
  // inside, so awaiting `listening` is the only thing that makes the next line
  // safe. `outcome` carries the identical error for anyone who never awaits
  // this promise.
  try {
    await listener.listening
  } catch (err) {
    options.clearAttempt()
    return {
      ok: false,
      url,
      redirectUri,
      error: err instanceof Error ? err.message : 'Could not listen for the sign-in redirect.'
    }
  }

  // Only now does control leave the app.
  try {
    await options.openBrowser(url)
  } catch (err) {
    // A browser that will not open leaves a bound port and an attempt nobody
    // can complete, so both are released here rather than on the timeout.
    listener.cancel()
    options.clearAttempt()
    return {
      ok: false,
      url,
      redirectUri,
      error: `Could not open your browser: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const arrived: CallbackOutcome = await listener.outcome
  if (!arrived.ok) {
    // Cancelled, timed out, or a refusal from Google: none of these leave a
    // usable attempt behind, and a stale one would let a late callback
    // redeem a code nobody is waiting for.
    options.clearAttempt()
    return { ok: false, url, redirectUri, error: arrived.error }
  }

  const completed = await options.complete(arrived.result.code, arrived.result.state)
  return {
    ok: completed.ok,
    url,
    redirectUri,
    ...(completed.error ? { error: completed.error } : {})
  }
}
