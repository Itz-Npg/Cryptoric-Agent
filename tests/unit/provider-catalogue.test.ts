/**
 * The self-hosted model catalogue.
 *
 * The round-trip tests here start the **real** server (`server/index.mjs`) on an
 * ephemeral port and fetch it over loopback. A hand-written fake would prove
 * only that the client agrees with itself; the interesting failures are the ones
 * where the server and the client disagree about auth, status codes or payload
 * shape.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  fetchCatalogue,
  isTransportAllowed,
  parseCatalogue,
  toProviderConfigs
} from '../../src/main/services/models/catalogue'

const SERVER = resolve(__dirname, '..', '..', 'server', 'index.mjs')
const TOKEN = 'test-token-not-a-secret'

let child: ChildProcess
let baseUrl: string

/** Wait for the server to answer /healthz. */
async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('provider server never became healthy')
}

/** An ephemeral port the child process can bind to. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

beforeAll(async () => {
  const port = await freePort()
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), PROVIDER_TOKEN: TOKEN },
    stdio: 'ignore'
  })
  baseUrl = `http://127.0.0.1:${port}`
  await waitForHealth(baseUrl)
}, 40_000)

afterAll(() => {
  child?.kill()
})

describe('isTransportAllowed', () => {
  it('accepts https anywhere', () => {
    expect(isTransportAllowed('https://models.example.com').ok).toBe(true)
  })

  it('accepts http on loopback, for a server on this machine', () => {
    expect(isTransportAllowed('http://127.0.0.1:8788').ok).toBe(true)
    expect(isTransportAllowed('http://localhost:8788').ok).toBe(true)
  })

  it('refuses plain http to a remote host', () => {
    // The token is a bearer credential. Over http it is readable by anyone on
    // the path, so this must fail closed.
    const result = isTransportAllowed('http://models.example.com')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('plain http')
  })

  it('permits http only when the caller explicitly opted in', () => {
    expect(isTransportAllowed('http://models.example.com', true).ok).toBe(true)
  })

  it('rejects a non-URL and a non-http protocol', () => {
    expect(isTransportAllowed('not a url').ok).toBe(false)
    expect(isTransportAllowed('ftp://example.com').ok).toBe(false)
  })
})

describe('parseCatalogue', () => {
  it('accepts a well-formed catalogue', () => {
    const parsed = parseCatalogue({
      schemaVersion: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      models: [{ id: 'm1', label: 'M1', description: 'd', contextWindow: 128000 }]
    })
    expect(parsed?.models).toHaveLength(1)
    expect(parsed?.models[0]?.id).toBe('m1')
  })

  it('drops models with no id rather than adopting them', () => {
    const parsed = parseCatalogue({ models: [{ label: 'nameless' }, { id: 'good' }] })
    expect(parsed?.models.map((m) => m.id)).toEqual(['good'])
  })

  it('rejects a catalogue with no usable models', () => {
    // An empty picker with no error is worse than a visible failure.
    expect(parseCatalogue({ models: [] })).toBeNull()
    expect(parseCatalogue({ models: [{ label: 'x' }] })).toBeNull()
    expect(parseCatalogue({ nope: true })).toBeNull()
    expect(parseCatalogue(null)).toBeNull()
  })

  it('replaces a nonsense context window instead of passing NaN through', () => {
    const parsed = parseCatalogue({ models: [{ id: 'm', contextWindow: 'lots' }] })
    expect(parsed?.models[0]?.contextWindow).toBe(0)
  })

  it('defaults a missing label to the id', () => {
    const parsed = parseCatalogue({ models: [{ id: 'm' }] })
    expect(parsed?.models[0]?.label).toBe('m')
  })
})

describe('round trip against the real provider server', () => {
  it('fetches the catalogue with a valid token', async () => {
    const result = await fetchCatalogue(baseUrl, { token: TOKEN })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.catalogue.models.length).toBeGreaterThan(0)
      expect(result.catalogue.models.map((m) => m.id)).toContain('cryptoric-mini')
    }
  })

  it('refuses a wrong token', async () => {
    const result = await fetchCatalogue(baseUrl, { token: 'wrong' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('401')
  })

  it('refuses a missing token', async () => {
    const result = await fetchCatalogue(baseUrl, { token: null })
    expect(result.ok).toBe(false)
  })

  it('accepts the catalogue path as well as the server root', async () => {
    // A user pasting either should get the same catalogue.
    const root = await fetchCatalogue(baseUrl, { token: TOKEN })
    const path = await fetchCatalogue(`${baseUrl}/v1/models`, { token: TOKEN })
    expect(root.ok && path.ok).toBe(true)
    if (root.ok && path.ok) {
      expect(path.catalogue.models.map((m) => m.id)).toEqual(root.catalogue.models.map((m) => m.id))
    }
  })

  it('reports an unreachable server without throwing', async () => {
    const result = await fetchCatalogue('http://127.0.0.1:1', { token: TOKEN, timeoutMs: 2000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Could not reach|refused/i)
  })

  it('turns the catalogue into gateway configs pointing at the server', async () => {
    const result = await fetchCatalogue(baseUrl, { token: TOKEN })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const configs = toProviderConfigs(result.catalogue, baseUrl)
    expect(configs).toHaveLength(result.catalogue.models.length)
    for (const config of configs) {
      expect(config.endpoint).toBe(baseUrl)
      expect(config.provider).toBe('openai-compatible')
      expect(config.dailyBudgetCoins).toBeGreaterThan(0)
    }
  })
})

describe('toProviderConfigs', () => {
  it('strips a trailing slash so endpoints do not double up', () => {
    const configs = toProviderConfigs(
      { schemaVersion: 1, updatedAt: '', models: [{ id: 'm', label: 'm', description: '', contextWindow: 0, byok: false }] },
      'https://models.example.com/'
    )
    expect(configs[0]?.endpoint).toBe('https://models.example.com')
  })
})
