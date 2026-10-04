/**
 * Unit tests for the browser subsystem's pure logic.
 *
 * These functions decide what URL a tab loads, whether a console line counts as
 * a defect, and which protocol key code a keystroke carries. All three fail
 * silently when wrong — a tab opens the wrong origin, a real error is dismissed
 * as noise, a password gets typed as capitals — so they are tested directly
 * rather than only through Electron.
 */

import { describe, expect, it } from 'vitest'
import {
  classifyTarget,
  clip,
  clipText,
  consoleLevel,
  isLoopbackUrl,
  isProblemEntry,
  normalizeUrl,
  percentile,
  summarizeRequests
} from '../../src/main/services/browser/dom'
import { describeKey, modifierBit, modifiersMask } from '../../src/main/services/browser/keys'

describe('normalizeUrl', () => {
  it('prefixes a bare host:port, the most common thing an agent writes', () => {
    expect(normalizeUrl('localhost:5173')).toEqual({ ok: true, url: 'http://localhost:5173/' })
    expect(normalizeUrl('127.0.0.1:8080/app')).toEqual({ ok: true, url: 'http://127.0.0.1:8080/app' })
    expect(normalizeUrl('[::1]:3000')).toEqual({ ok: true, url: 'http://[::1]:3000/' })
  })

  it('prefixes a bare hostname but leaves a real scheme alone', () => {
    expect(normalizeUrl('example.com')).toEqual({ ok: true, url: 'http://example.com/' })
    expect(normalizeUrl('https://example.com/x')).toEqual({ ok: true, url: 'https://example.com/x' })
    expect(normalizeUrl('about:blank')).toEqual({ ok: true, url: 'about:blank' })
  })

  it('treats an empty input as a blank tab rather than an error', () => {
    expect(normalizeUrl('')).toEqual({ ok: true, url: 'about:blank' })
    expect(normalizeUrl('   ')).toEqual({ ok: true, url: 'about:blank' })
  })

  it('refuses schemes that would run code or smuggle a payload into the tab', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/abc'
    ]) {
      expect(normalizeUrl(url).ok, url).toBe(false)
    }
  })

  it('reports unusable input instead of throwing', () => {
    expect(normalizeUrl('http://').ok).toBe(false)
  })

  it('resolves a relative reference against a base when one is given', () => {
    expect(normalizeUrl('settings', 'http://localhost:5173/app/')).toEqual({
      ok: true,
      url: 'http://localhost:5173/app/settings'
    })
  })
})

describe('target classification', () => {
  it('recognises the developer machine', () => {
    expect(classifyTarget('http://localhost:5173/')).toBe('local')
    expect(classifyTarget('http://127.0.0.1:3000/x')).toBe('local')
    expect(isLoopbackUrl('http://[::1]:8080/')).toBe(true)
  })

  it('separates remote origins from browser-internal documents', () => {
    expect(classifyTarget('https://example.com/')).toBe('remote')
    expect(classifyTarget('about:blank')).toBe('internal')
    expect(classifyTarget('file:///tmp/index.html')).toBe('internal')
  })

  it('does not mistake a lookalike host for loopback', () => {
    expect(isLoopbackUrl('http://localhost.evil.test/')).toBe(false)
    expect(classifyTarget('http://localhost.evil.test/')).toBe('remote')
  })
})

describe('consoleLevel', () => {
  it('maps Chromium levels, degrading anything unknown to the loudest bucket', () => {
    expect(consoleLevel(0)).toBe('log')
    expect(consoleLevel(1)).toBe('info')
    expect(consoleLevel(2)).toBe('warning')
    expect(consoleLevel(3)).toBe('error')
    expect(consoleLevel(9)).toBe('error')
  })

  it('treats warnings as problems but not ordinary output', () => {
    expect(isProblemEntry({ level: 'error' })).toBe(true)
    expect(isProblemEntry({ level: 'warning' })).toBe(true)
    expect(isProblemEntry({ level: 'info' })).toBe(false)
  })
})

describe('clipping', () => {
  it('leaves short text untouched', () => {
    expect(clipText('short', 100)).toBe('short')
    expect(clip('short', 100)).toEqual({ value: 'short', truncated: false, originalLength: 5 })
  })

  it('cuts long text but reports how much was dropped', () => {
    const outcome = clip('x'.repeat(500), 100)
    expect(outcome.truncated).toBe(true)
    expect(outcome.originalLength).toBe(500)
    expect(outcome.value.length).toBeLessThan(200)
    expect(outcome.value).toContain('400 more characters')
  })
})

describe('summarizeRequests', () => {
  const durations = new Map([
    ['https://a.test/slow.js', 2400],
    ['https://a.test/app.js', 120]
  ])

  it('counts status codes and names the slowest request', () => {
    const summary = summarizeRequests(
      [
        { url: 'https://a.test/slow.js', status: 200 },
        { url: 'https://a.test/app.js', status: 200 },
        { url: 'https://a.test/api', status: 500 },
        { url: 'https://a.test/api2', status: null }
      ],
      durations,
      1
    )
    expect(summary.total).toBe(4)
    expect(summary.byStatus).toEqual({ '200': 2, '500': 1, failed: 1 })
    expect(summary.failures).toBe(1)
    expect(summary.slowest).toEqual({ url: 'https://a.test/slow.js', ms: 2400 })
  })

  it('reports a null slowest when no request completed', () => {
    const summary = summarizeRequests([{ url: 'x', status: 204 }], new Map(), 0)
    expect(summary.slowest).toBeNull()
  })
})

describe('percentile', () => {
  it('returns the trailing edge the way a developer reads it', () => {
    expect(percentile([10, 20, 30, 40, 100], 95)).toBe(100)
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30)
    expect(percentile([], 95)).toBe(0)
  })
})

describe('describeKey', () => {
  it('resolves named keys with their physical codes', () => {
    const parsed = describeKey('Enter')
    expect(parsed.ok).toBe(true)
    expect(parsed.descriptor).toMatchObject({ key: 'Enter', code: 'Enter', keyCode: 13, modifier: false })
  })

  it('reports a letter as lower-case key with the shifted text', () => {
    expect(describeKey('a').descriptor).toMatchObject({ key: 'a', code: 'KeyA', text: 'a' })
    expect(describeKey('A').descriptor).toMatchObject({ key: 'a', code: 'KeyA', text: 'A' })
  })

  it('maps punctuation and shifted symbols to their US-layout codes', () => {
    expect(describeKey('@').descriptor).toMatchObject({ code: 'Digit2', text: '@', keyCode: 50 })
    expect(describeKey('.').descriptor).toMatchObject({ code: 'Period', text: '.' })
    expect(describeKey('[').descriptor).toMatchObject({ code: 'BracketLeft' })
    expect(describeKey('?').descriptor).toMatchObject({ code: 'Slash' })
  })

  it('accepts a multi-character name as a sequence of keystrokes', () => {
    const parsed = describeKey('abc')
    expect(parsed.ok).toBe(true)
    expect(parsed.sequence?.map((d) => d.text)).toEqual(['a', 'b', 'c'])
  })

  it('expands a chord into modifiers followed by the target key', () => {
    const parsed = describeKey('Ctrl+Shift+P')
    expect(parsed.ok).toBe(true)
    const sequence = parsed.sequence ?? []
    expect(sequence).toHaveLength(3)
    expect(sequence[0]?.key).toBe('Control')
    expect(sequence[1]?.key).toBe('Shift')
    // Shift really is held, so the page must receive the shifted character.
    expect(sequence[2]?.key).toBe('P')
    expect(sequence[2]?.code).toBe('KeyP')
  })

  it('resolves the aliases an agent actually reaches for', () => {
    expect(describeKey('enter').descriptor?.code).toBe('Enter')
    expect(describeKey('cmd').descriptor?.code).toBe('MetaLeft')
    expect(describeKey('down').descriptor?.code).toBe('ArrowDown')
  })

  it('marks modifiers so a chord never inserts its own character', () => {
    expect(describeKey('Shift').descriptor?.modifier).toBe(true)
    expect(describeKey('a').descriptor?.modifier).toBe(false)
  })

  it('rejects empty input rather than silently doing nothing', () => {
    expect(describeKey('').ok).toBe(false)
    expect(describeKey('   ').ok).toBe(false)
  })
})

describe('modifier masks', () => {
  it('combines held modifiers into the bitmask the protocol expects', () => {
    const control = describeKey('Control').descriptor!
    const shift = describeKey('Shift').descriptor!
    expect(modifiersMask([control, shift])).toBe(2 | 8)
    expect(modifierBit(describeKey('Alt').descriptor!)).toBe(1)
    expect(modifierBit(describeKey('Meta').descriptor!)).toBe(4)
    expect(modifierBit(describeKey('a').descriptor!)).toBe(0)
  })
})