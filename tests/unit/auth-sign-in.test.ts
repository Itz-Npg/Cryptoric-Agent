/**
 * The order of the browser half of sign-in.
 *
 * These tests use a *real* loopback listener and a fake browser. The browser
 * stand-in does the one thing that matters: it asks the callback port whether
 * it is open, at the exact instant it is handed the URL. If the implementation
 * ever opens the browser before the bind completes, that request fails and this
 * file goes red — which is precisely the bug this module was extracted to make
 * visible.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'

import { startCallbackListener, CALLBACK_PORT, type CallbackListener } from '../../src/main/services/auth/loopback'
import { startSignIn } from '../../src/main/services/auth/sign-in'

const blockers: { port: number; close(): Promise<void> }[] = []

afterEach(async () => {
  while (blockers.length > 0) await blockers.pop()!.close()
})

/** An ephemeral port that is free right now. */
function freePort(base: number): number {
  return base + Math.floor(Math.random() * 400)
}

/** Occupy a port so the next bind fails, and release it after the test. */
async function occupy(port: number): Promise<void> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  blockers.push({ port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
}

describe('opening the browser last', () => {
  it('has the port answering connections by the time the browser is opened', async () => {
    const port = freePort(CALLBACK_PORT + 2000)
    const order: string[] = []
    let statusSeenByBrowser = 0
    let redeemed: { code: string; state: string } | null = null

    const result = await startSignIn({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      buildUrl: () => {
        order.push('build-url')
        return 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test'
      },
      listen: () => {
        order.push('listen')
        return startCallbackListener({ port, timeoutMs: 5_000 })
      },
      openBrowser: async () => {
        order.push('open-browser')
        // This is the moment of truth: the person is about to be sent back to
        // this port, so the port has to be open right now.
        const res = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=the-state`)
        statusSeenByBrowser = res.status
      },
      complete: async (code, state) => {
        redeemed = { code, state }
        return { ok: true }
      },
      clearAttempt: () => order.push('clear')
    })

    expect(statusSeenByBrowser).toBe(200)
    expect(order.slice(0, 3)).toEqual(['build-url', 'listen', 'open-browser'])
    expect(redeemed).toEqual({ code: 'the-code', state: 'the-state' })
    expect(result.ok).toBe(true)
    // The URL is returned even on success: a UI may need to show it.
    expect(result.url).toContain('accounts.google.com')
    expect(result.redirectUri).toBe(`http://127.0.0.1:${port}/callback`)
  })

  it('waits for a slow bind, so a port that takes a moment still catches the redirect', async () => {
    // On a local machine `listen()` binds within the tick, which is exactly why
    // the wrong order can pass a casual test and still lose real sign-ins. This
    // server takes 60ms to bind, so the port is provably closed until the
    // implementation has waited for `listening`.
    const port = freePort(CALLBACK_PORT + 2500)
    const slowBind: typeof createServer = ((handler: unknown) => {
      const server = createServer(handler as never)
      const realListen = server.listen.bind(server)
      server.listen = ((...args: unknown[]) => {
        setTimeout(() => {
          ;(realListen as (...a: unknown[]) => unknown)(...args)
        }, 60)
        return server
      }) as typeof server.listen
      return server
    }) as unknown as typeof createServer

    let statusSeenByBrowser = 0
    const result = await startSignIn({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      buildUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
      listen: () => startCallbackListener({ port, timeoutMs: 5_000, createServerImpl: slowBind }),
      openBrowser: async () => {
        const res = await fetch(`http://127.0.0.1:${port}/callback?code=slow&state=bind`)
        statusSeenByBrowser = res.status
      },
      complete: async () => ({ ok: true }),
      clearAttempt: () => {}
    })

    expect(statusSeenByBrowser).toBe(200)
    expect(result.ok).toBe(true)
  })

  it('does not open a browser at all when the port cannot be bound', async () => {
    const port = freePort(CALLBACK_PORT + 3000)
    await occupy(port)
    let opened = false
    let cleared = 0

    const result = await startSignIn({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      buildUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
      listen: () => startCallbackListener({ port, timeoutMs: 2_000 }),
      openBrowser: async () => {
        opened = true
      },
      complete: async () => ({ ok: true }),
      clearAttempt: () => {
        cleared += 1
      }
    })

    // Sending someone to a page that cannot be answered helps nobody.
    expect(opened).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/could not listen/i)
    expect(cleared).toBe(1)
  })

  it('releases the port and the attempt when the browser will not open', async () => {
    const port = freePort(CALLBACK_PORT + 4000)
    let cleared = 0

    const result = await startSignIn({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      buildUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
      listen: () => startCallbackListener({ port, timeoutMs: 30_000 }),
      openBrowser: async () => {
        throw new Error('no default browser')
      },
      complete: async () => ({ ok: true }),
      clearAttempt: () => {
        cleared += 1
      }
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/could not open your browser/i)
    expect(cleared).toBe(1)
    // The listener was cancelled, so the next attempt can use the same port.
    const probe = await fetch(`http://127.0.0.1:${port}/callback?code=a&state=b`).catch(() => null)
    expect(probe === null || probe.status >= 400).toBe(true)
  })

  it('forgets the attempt when the person declines at Google', async () => {
    const port = freePort(CALLBACK_PORT + 5000)
    let cleared = 0

    const pending = startSignIn({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      buildUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
      listen: () => startCallbackListener({ port, timeoutMs: 5_000 }),
      openBrowser: async () => {
        await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`)
      },
      complete: async () => ({ ok: true }),
      clearAttempt: () => {
        cleared += 1
      }
    })

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cancelled/i)
    expect(cleared).toBe(1)
  })

  it('reports a failed redemption without claiming the sign-in worked', async () => {
    const port = freePort(CALLBACK_PORT + 6000)

    const result = await startSignIn({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      buildUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
      listen: () => startCallbackListener({ port, timeoutMs: 5_000 }),
      openBrowser: async () => {
        await fetch(`http://127.0.0.1:${port}/callback?code=stale&state=wrong`)
      },
      complete: async () => ({ ok: false, error: 'That sign-in response did not come from this app.' }),
      clearAttempt: () => {}
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/did not come from this app/i)
  })
})

describe('what the caller gets back', () => {
  it('keeps the URL and redirect on a failure, so a stuck UI can show them', async () => {
    const listener: CallbackListener = startCallbackListener({ port: freePort(CALLBACK_PORT + 7000), timeoutMs: 40 })
    const result = await startSignIn({
      redirectUri: 'http://127.0.0.1:53123/callback',
      buildUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
      listen: () => listener,
      openBrowser: async () => {},
      complete: async () => ({ ok: true }),
      clearAttempt: () => {}
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timed out/i)
    // Without these a person whose browser never opened has nothing to copy.
    expect(result.url).toContain('client_id=test')
    expect(result.redirectUri).toBe('http://127.0.0.1:53123/callback')
  })
})
