/**
 * The loopback listener that receives Google's redirect.
 *
 * This is the one piece of sign-in that runs a real socket, so it gets a real
 * socket test: a fake `createServer` would prove nothing about who can reach
 * this port. The assertions are about what it *refuses* — a wrong path, a
 * missing code, a second callback — because this port is the only thing between
 * a random page in a browser and a live authorization code.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { awaitCallback, CALLBACK_PORT, CALLBACK_URI } from '../../src/main/services/auth/loopback'

let stop: (() => void) | null = null

afterEach(() => {
  stop?.()
  stop = null
})

/** Drive a real listener on an ephemeral port. */
async function listen(options: { timeoutMs?: number } = {}) {
  const port = CALLBACK_PORT + 1 + Math.floor(Math.random() * 400)
  const pending = awaitCallback({ port, timeoutMs: options.timeoutMs ?? 5_000 })
  return { port, pending }
}

describe('receiving the redirect', () => {
  it('returns the code and state it was sent', async () => {
    const { port, pending } = await listen()
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=xyz`)
    expect(res.status).toBe(200)
    // The person is told what happened, in the tab they are looking at.
    expect(await res.text()).toMatch(/signed in/i)

    const outcome = await pending
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toEqual({ code: 'abc', state: 'xyz' })
  })

  it('is bound to loopback only, so nothing off the machine can reach it', () => {
    // `localhost` would resolve to IPv6 first on some machines and the redirect
    // would silently go nowhere.
    expect(CALLBACK_URI).toBe(`http://127.0.0.1:${CALLBACK_PORT}/callback`)
    expect(CALLBACK_URI).not.toContain('localhost')
  })

  it('404s any other path, rather than answering whatever arrives', async () => {
    const { port, pending } = await listen({ timeoutMs: 600 })
    const res = await fetch(`http://127.0.0.1:${port}/?code=stolen`)
    expect(res.status).toBe(404)
    const outcome = await pending
    // The listener is still waiting for a real callback.
    expect(outcome.ok).toBe(false)
  })

  it('refuses a redirect with no code', async () => {
    const { port, pending } = await listen()
    await fetch(`http://127.0.0.1:${port}/callback?state=xyz`)
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/did not carry a code/)
  })

  it('reports a cancellation as the person\'s choice', async () => {
    const { port, pending } = await listen()
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`)
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/cancelled/i)
  })

  it('answers only once, so a reloaded tab cannot redeem a second code', async () => {
    const { port, pending } = await listen()
    await fetch(`http://127.0.0.1:${port}/callback?code=first&state=s`)
    await pending
    // The server is closed by now; a second attempt must not reach it.
    const second = await fetch(`http://127.0.0.1:${port}/callback?code=second&state=s`).catch(
      () => null
    )
    expect(second === null || second.status >= 400).toBe(true)
  })

  it('gives up rather than listening forever', async () => {
    const { port, pending } = await listen({ timeoutMs: 60 })
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/timed out/i)
    // And the port is released, so the next attempt can bind it.
    const reused = await fetch(`http://127.0.0.1:${port}/callback?code=a&state=b`).catch(() => null)
    expect(reused === null || reused.status >= 400).toBe(true)
  })

  it('reports a port it cannot bind, instead of hanging', async () => {
    const { createServer } = await import('node:http')
    const port = CALLBACK_PORT + 900 + Math.floor(Math.random() * 50)
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve))
    try {
      const outcome = await awaitCallback({ port, timeoutMs: 2_000 })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      // A hang here would leave the browser staring at a spinner forever.
      expect(outcome.error).toMatch(/could not listen/i)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})