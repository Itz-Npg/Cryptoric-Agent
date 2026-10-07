/**
 * `web_fetch`, against a real HTTP server on loopback.
 *
 * A mocked `fetch` would prove that this module calls its own stub. The
 * behaviours worth checking — a redirect chain, a body cut off mid-stream, a
 * declared charset, a 404 — are all HTTP, so the test serves HTTP. Nothing here
 * leaves the machine: the server binds 127.0.0.1 on an ephemeral port.
 *
 * Three refusals are asserted without any server at all, because the point is
 * that they never become a request: the cloud metadata address, a `file:` URL,
 * and a URL carrying credentials in its userinfo.
 */

import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildResearchTools, htmlToText, MAX_REDIRECTS } from '../../src/main/services/tools/builtin/research'
import { ToolRegistry } from '../../src/main/services/tools/registry'
import { ToolRuntime } from '../../src/main/services/tools/runtime'
import { ApprovalQueue, PermissionPolicy, DEFAULT_PERMISSION_RULES } from '../../src/main/services/permissions/policy'

let server: Server
let base = ''
let approvals: ApprovalQueue
let runtime: ToolRuntime

const HTML = `<!doctype html>
<html><head><title>Widget API &mdash; docs</title>
<style>body{color:red}</style></head>
<body>
<h1>Widget API</h1>
<p>Call <code>createWidget()</code> with a name.</p>
<ul><li>alpha</li><li>beta</li></ul>
<script>stealEverything()</script>
<a href="/next">next</a>
</body></html>`

function startServer(): Promise<string> {
  return new Promise((resolvePromise) => {
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(HTML)
        return
      }
      if (url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ name: 'widget', version: 3 }))
        return
      }
      if (url === '/redirect') {
        res.writeHead(302, { location: '/html' })
        res.end()
        return
      }
      if (url === '/loop') {
        res.writeHead(302, { location: '/loop' })
        res.end()
        return
      }
      if (url === '/to-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
        res.end()
        return
      }
      if (url === '/binary') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        return
      }
      if (url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('x'.repeat(5000))
        return
      }
      if (url === '/latin1') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' })
        res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]))
        return
      }
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<html><body><h1>Not found</h1></body></html>')
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolvePromise(`http://127.0.0.1:${port}`)
    })
  })
}

function runtimeWith(maxBodyBytes?: number): ToolRuntime {
  const registry = new ToolRegistry()
  registry.registerAll(buildResearchTools(maxBodyBytes === undefined ? {} : { maxBodyBytes }))
  return new ToolRuntime({
    registry,
    policy: new PermissionPolicy(DEFAULT_PERMISSION_RULES),
    approvals
  })
}

async function invokeWith(
  target: ToolRuntime,
  url: string,
  args: Record<string, unknown> = {}
) {
  const pending = target.invoke('web_fetch', { url, ...args }, { grantedTier: 'safe' })
  const watch = setInterval(() => {
    for (const request of approvals.list()) approvals.resolve(request.id, true)
  }, 2)
  try {
    return await pending
  } finally {
    clearInterval(watch)
  }
}

async function call(url: string, args: Record<string, unknown> = {}) {
  return invokeWith(runtime, url, args)
}

beforeAll(async () => {
  base = await startServer()

  approvals = new ApprovalQueue()
  runtime = runtimeWith()
})

afterAll(() => {
  server?.close()
})

describe('htmlToText', () => {
  it('keeps structure and drops scripts and styles', () => {
    const { title, text } = htmlToText(HTML)
    expect(title).toBe('Widget API — docs')
    expect(text).toContain('Widget API')
    expect(text).toContain('- alpha')
    expect(text).toContain('- beta')
    expect(text).not.toContain('stealEverything')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('<h1>')
  })
})

describe('web_fetch', () => {
  it('fetches a page and returns its title and text', async () => {
    const result = await call(`${base}/html`)
    expect(result.ok).toBe(true)
    const data = result.data as { title: string | null; text: string; status: number; finalUrl: string }
    expect(data.status).toBe(200)
    expect(data.title).toBe('Widget API — docs')
    expect(data.text).toContain('Call createWidget() with a name.')
    expect(data.finalUrl).toBe(`${base}/html`)
  })

  it('returns JSON as text rather than guessing at a schema', async () => {
    const result = await call(`${base}/json`)
    expect(result.ok).toBe(true)
    expect((result.data as { text: string }).text).toContain('"version":3')
  })

  it('follows a redirect and reports the hops it took', async () => {
    const result = await call(`${base}/redirect`)
    expect(result.ok).toBe(true)
    const data = result.data as { redirects: string[]; finalUrl: string; text: string }
    expect(data.redirects).toEqual([`${base}/redirect`])
    expect(data.finalUrl).toBe(`${base}/html`)
    expect(data.text).toContain('Widget API')
  })

  it('stops after a bounded number of redirects instead of following forever', async () => {
    const result = await call(`${base}/loop`)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(new RegExp(`Followed ${MAX_REDIRECTS} redirects`))
  })

  it('truncates text to maxChars and says so', async () => {
    const result = await call(`${base}/big`, { maxChars: 200 })
    expect(result.ok).toBe(true)
    const data = result.data as { text: string; truncated: boolean; chars: number }
    expect(data.truncated).toBe(true)
    expect(data.chars).toBe(5000)
    expect(data.text.length).toBeLessThan(300)
    expect(data.text).toContain('chars total')
  })

  it('stops reading the body at the byte cap', async () => {
    // A 64-byte cap rather than four megabytes: the cap is what is under test,
    // not the constant. The response is 5000 bytes, so the reader has to stop
    // and cancel early for this to pass at all.
    const tiny = runtimeWith(64)
    const result = await invokeWith(tiny, `${base}/big`, { maxChars: 5000 })
    const data = result.data as { bytes: number; truncated: boolean; text: string }
    expect(data.bytes).toBe(64)
    expect(data.truncated).toBe(true)
    expect(data.text.length).toBeLessThanOrEqual(64)
  })

  it('decodes the charset the response declares', async () => {
    const result = await call(`${base}/latin1`)
    expect((result.data as { text: string }).text.trim()).toBe('café')
  })

  it('refuses a binary content type rather than returning mojibake', async () => {
    const result = await call(`${base}/binary`)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/image\/png/)
  })

  it('reports a 404 as a failure that still carries what the server said', async () => {
    const result = await call(`${base}/nope`)
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/404/)
    expect((result.data as { text: string }).text).toContain('Not found')
  })

  it('refuses the cloud metadata address, before making a request', async () => {
    const result = await call('http://169.254.169.254/latest/meta-data/')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/metadata/i)
    expect(result.failureKind).toBe('permission-denied')
  })

  it('refuses a redirect into the metadata address', async () => {
    // The rule has to hold at every hop: a permitted host is not a licence for
    // wherever it points next.
    const result = await call(`${base}/to-metadata`)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/metadata/i)
  })

  it('refuses a file: URL and a URL carrying credentials', async () => {
    const file = await call('file:///etc/passwd')
    expect(file.ok).toBe(false)
    expect(file.error).toMatch(/http and https/i)

    const withCredentials = await call(`${base.replace('http://', 'http://user:secret@')}/html`)
    expect(withCredentials.ok).toBe(false)
    expect(withCredentials.error).toMatch(/credentials/i)
  })

  it('refuses something that is not a URL at all', async () => {
    const result = await call('not a url')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not an absolute URL/i)
  })
})
