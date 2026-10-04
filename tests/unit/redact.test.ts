import { describe, expect, it } from 'vitest'
import { isSensitiveKey, redactArgs, redactText, summarizeArgs } from '../../src/main/services/tools/redact'

describe('redactText', () => {
  it('scrubs provider key formats', () => {
    expect(redactText('key is sk-abcdefghijklmnopqrstuvwxyz012345')).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(redactText('ghp_abcdefghijklmnopqrstuvwxyz012345')).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(redactText('AKIAIOSFODNN7EXAMPLE')).not.toContain('IOSFODNN7EXAMPLE')
  })

  it('scrubs a PEM private key block including its body', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nsecretbodyline\n-----END RSA PRIVATE KEY-----'
    const out = redactText(pem)
    expect(out).not.toContain('MIIEowIBAAKCAQEA')
    expect(out).not.toContain('secretbodyline')
  })

  it('scrubs bearer tokens and authorization headers', () => {
    expect(redactText('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop')
  })

  it('scrubs key=value credentials while keeping the key', () => {
    const out = redactText('api_key=supersecretvalue123')
    expect(out).toContain('api_key')
    expect(out).not.toContain('supersecretvalue123')
  })

  it('scrubs credentials embedded in a URL', () => {
    expect(redactText('https://user:hunter2@example.com/path')).not.toContain('hunter2')
  })

  it('leaves ordinary text alone', () => {
    const text = 'Installed Node 22.20.2 in C:\\tools\\node and refreshed snapshot 4.'
    expect(redactText(text)).toBe(text)
  })
})

describe('redactArgs', () => {
  it('replaces declared sensitive arguments wholesale', () => {
    const out = redactArgs({ apiKey: 'anything at all', user: 'ada' }, ['apiKey']) as Record<string, unknown>
    expect(out['apiKey']).not.toBe('anything at all')
    expect(out['user']).toBe('ada')
  })

  it('replaces obviously sensitive keys even when not declared', () => {
    const out = redactArgs({ password: 'hunter2', token: 'xyz', port: 3000 }) as Record<string, unknown>
    expect(out['password']).toBe('[redacted]')
    expect(out['token']).toBe('[redacted]')
    expect(out['port']).toBe(3000)
  })

  it('walks nested structures', () => {
    const out = redactArgs({ outer: { inner: { secret: 'leak-me', keep: 'fine' } } }) as any
    expect(out.outer.inner.secret).toBe('[redacted]')
    expect(out.outer.inner.keep).toBe('fine')
  })

  it('handles arrays', () => {
    const out = redactArgs({ values: ['plain', 'sk-abcdefghijklmnopqrstuvwx'] }) as any
    expect(out.values[0]).toBe('plain')
    expect(out.values[1]).not.toContain('abcdefghijklmnopqrstuvwx')
  })

  it('redacts secrets found inside otherwise ordinary strings', () => {
    const out = redactArgs({ command: 'export TOKEN=abcdef123456789' }) as any
    expect(out.command).not.toContain('abcdef123456789')
  })

  it('leaves primitives alone', () => {
    expect(redactArgs(42)).toBe(42)
    expect(redactArgs(null)).toBe(null)
    expect(redactArgs(true)).toBe(true)
  })
})

describe('isSensitiveKey', () => {
  it('recognises credential-shaped key names', () => {
    expect(isSensitiveKey('apiKey')).toBe(true)
    expect(isSensitiveKey('client_secret')).toBe(true)
    expect(isSensitiveKey('PATH')).toBe(false)
    expect(isSensitiveKey('branch')).toBe(false)
  })
})

describe('summarizeArgs', () => {
  it('never includes a secret in an approval summary', () => {
    const summary = summarizeArgs({ apiKey: 'sk-abcdefghijklmnopqrstuvwx', host: 'api.example.com' }, ['apiKey'])
    expect(summary).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(summary).toContain('api.example.com')
  })

  it('truncates very large arguments', () => {
    const summary = summarizeArgs({ blob: 'x'.repeat(2000) })
    expect(summary.length).toBeLessThan(700)
  })
})