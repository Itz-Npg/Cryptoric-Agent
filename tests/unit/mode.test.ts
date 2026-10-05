/**
 * Which mode this install runs in.
 *
 * The rule under test is not "does hosted work" — it is that a build can never
 * *half* be hosted. A silent fallback to local is the failure that matters: the
 * user believes their balance follows them to a new device when it does not, and
 * it looks exactly like a successful install.
 */

import { describe, expect, it } from 'vitest'

import {
  describeMode,
  modeRequiresAccount,
  normaliseServerUrl,
  resolveMode,
  RUN_MODES
} from '../../src/shared/mode'

const HOSTED = { CRYPTORIC_MODE: 'hosted', AGENT_SERVER_URL: 'https://api.cryptoric.dev' }

describe('the default', () => {
  it('is local with no environment at all', () => {
    const result = resolveMode({})
    expect(result).toEqual({ ok: true, mode: 'local', serverUrl: '', note: '' })
  })

  it('needs no account', () => {
    expect(modeRequiresAccount('local')).toBe(false)
    expect(modeRequiresAccount('hosted')).toBe(true)
  })
})

describe('hosted', () => {
  it('accepts a well-formed configuration', () => {
    const result = resolveMode(HOSTED)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mode).toBe('hosted')
    expect(result.serverUrl).toBe('https://api.cryptoric.dev')
  })

  it('strips a trailing slash so paths cannot double up', () => {
    const result = resolveMode({ ...HOSTED, AGENT_SERVER_URL: 'https://api.cryptoric.dev//' })
    expect(result.ok && result.serverUrl).toBe('https://api.cryptoric.dev')
  })

  it('refuses rather than falling back when the URL is missing', () => {
    const result = resolveMode({ CRYPTORIC_MODE: 'hosted' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // Falling back to local here would leave someone thinking their balance is
    // synced when it is sitting in a file on this machine.
    expect(result.error).toMatch(/needs a server/)
  })

  it('allows plain http only on loopback', () => {
    expect(resolveMode({ ...HOSTED, AGENT_SERVER_URL: 'http://127.0.0.1:8789' }).ok).toBe(true)
    expect(resolveMode({ ...HOSTED, AGENT_SERVER_URL: 'http://localhost:8789' }).ok).toBe(true)
    const remote = resolveMode({ ...HOSTED, AGENT_SERVER_URL: 'http://api.cryptoric.dev' })
    expect(remote.ok).toBe(false)
    if (remote.ok) return
    // The account token would cross the network in the clear.
    expect(remote.error).toMatch(/clear/)
  })

  it('rejects a mode it does not recognise instead of guessing', () => {
    const result = resolveMode({ CRYPTORIC_MODE: 'hosted-ish' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('local or hosted')
  })
})

describe('half-configured is an error, not a default', () => {
  it('rejects a URL with no mode', () => {
    const result = resolveMode({ AGENT_SERVER_URL: 'https://api.cryptoric.dev' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/CRYPTORIC_MODE/)
  })

  it('rejects local mode with a URL set', () => {
    const result = resolveMode({ CRYPTORIC_MODE: 'local', AGENT_SERVER_URL: 'https://api.cryptoric.dev' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/nothing is sent to a server/)
  })
})

describe('server URLs', () => {
  it('rejects what is not a URL', () => {
    expect(normaliseServerUrl('api.cryptoric.dev').ok).toBe(false)
    expect(normaliseServerUrl('').ok).toBe(false)
  })

  it('rejects a protocol that is not http', () => {
    const result = normaliseServerUrl('ftp://api.cryptoric.dev')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/unsupported protocol/)
  })

  it('accepts the two it supports', () => {
    expect(normaliseServerUrl('https://a.dev').ok).toBe(true)
    expect(normaliseServerUrl('http://127.0.0.1:1/').ok).toBe(true)
  })
})

describe('what it says', () => {
  it('describes each mode in one line', () => {
    expect(describeMode('local')).toMatch(/stay on this computer/i)
    expect(describeMode('hosted')).toMatch(/server/i)
  })

  it('offers exactly two modes', () => {
    expect(RUN_MODES).toEqual(['local', 'hosted'])
  })
})