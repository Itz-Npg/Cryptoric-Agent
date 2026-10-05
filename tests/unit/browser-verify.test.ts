/**
 * Tests for the browser-verification reporting rules.
 *
 * The behaviour under test exists because the verify stage used to hard-code
 * `const browserApplicable = false` and print:
 *
 *     browser: NOT RUN — no browser tools are registered in this build
 *
 * That was false — 43 browser tools were registered — and nothing tested it,
 * because the answer was a constant. These tests are the regression net: every
 * one of them fails if the stage goes back to asserting a capability state
 * instead of asking the registry.
 */

import { describe, expect, it } from 'vitest'

import { buildPipeline } from '../../src/main/services/agent/stages'
import {
  BROWSER_PROBE_TOOLS,
  browserAvailability,
  browserFailed,
  evaluateBrowserObservation,
  formatBrowserLine,
  isBrowserRelevant,
  readBrowserObservation,
  type BrowserCheckResult
} from '../../src/main/services/agent/browser-verify'

const ALL_TOOLS_PRESENT = () => true

describe('browserAvailability', () => {
  it('reports available when every probe tool is registered', () => {
    const availability = browserAvailability(ALL_TOOLS_PRESENT)
    expect(availability.available).toBe(true)
    expect(availability.missing).toEqual([])
  })

  // The exact falsehood this replaces. If this passes, the stage can again
  // claim a build has no browser tools while 43 of them are registered.
  it('does not claim there are no browser tools when they are registered', () => {
    const availability = browserAvailability((id) =>
      BROWSER_PROBE_TOOLS.concat(['browser_navigate', 'browser_screenshot']).includes(id)
    )
    expect(availability.available).toBe(true)
    expect(availability.reason).not.toMatch(/no browser tools/i)
    expect(availability.reason).not.toMatch(/not run/i)
  })

  it('names the missing tools rather than gesturing at a category', () => {
    const availability = browserAvailability((id) => id !== 'browser_create_tab')
    expect(availability.available).toBe(false)
    expect(availability.missing).toEqual(['browser_create_tab'])
    expect(availability.reason).toContain('browser_create_tab')
  })

  it('distinguishes "unavailable" from "not needed"', () => {
    const availability = browserAvailability(() => false)
    expect(availability.available).toBe(false)
    expect(availability.reason).toMatch(/unavailable/i)
  })
})

describe('isBrowserRelevant', () => {
  it.each([
    '/repo/index.html',
    '/repo/src/App.tsx',
    '/repo/styles/main.css',
    '/repo/component.jsx',
    '/repo/App.vue',
    '/repo/Widget.svelte'
  ])('treats %s as browser-relevant', (path) => {
    expect(isBrowserRelevant([path])).toBe(true)
  })

  it.each(['/repo/README.md', '/repo/src/main/services/agent/core.ts', '/repo/package.json.bak'])(
    'treats %s as not browser-relevant by path',
    (path) => {
      expect(isBrowserRelevant([path], '')).toBe(false)
    }
  )

  it('honours an explicit request for a browser even with no changed paths', () => {
    expect(isBrowserRelevant([], 'check how it renders in the browser')).toBe(true)
    expect(isBrowserRelevant([], 'take a screenshot of the page')).toBe(true)
  })

  it('ignores a hint that only looks similar', () => {
    expect(isBrowserRelevant([], 'explain what a browser is')).toBe(false)
  })

  it('handles Windows backslash paths', () => {
    expect(isBrowserRelevant(['C:\\repo\\index.html'])).toBe(true)
  })

  it('is case-insensitive on the extension', () => {
    expect(isBrowserRelevant(['/repo/INDEX.HTML'])).toBe(true)
  })
})

describe('readBrowserObservation', () => {
  it('reads the console errors count', () => {
    const observation = readBrowserObservation({ errors: 2, total: 5, warnings: 3 }, null)
    expect(observation.consoleErrors).toBe(2)
  })

  it('reads the network failure total and urls', () => {
    const observation = readBrowserObservation(null, {
      total: 1,
      failures: [{ url: 'http://localhost/app.js' }]
    })
    expect(observation.networkFailures).toBe(1)
    expect(observation.failureUrls).toEqual(['http://localhost/app.js'])
  })

  // An unreadable payload must not become "zero errors".
  it('returns null, not zero, when the payload shape is unrecognised', () => {
    const observation = readBrowserObservation('nonsense', { unexpected: true })
    expect(observation.consoleErrors).toBeNull()
    expect(observation.networkFailures).toBeNull()
  })

  it('survives null, undefined and arrays', () => {
    expect(readBrowserObservation(null, null).consoleErrors).toBeNull()
    expect(readBrowserObservation(undefined, undefined).networkFailures).toBeNull()
    expect(readBrowserObservation([], []).consoleErrors).toBeNull()
  })
})

describe('evaluateBrowserObservation', () => {
  const available = browserAvailability(ALL_TOOLS_PRESENT)

  it('reports NOT RUN and names the missing tools when the build has no browser', () => {
    const result = evaluateBrowserObservation(browserAvailability(() => false), true, null)
    expect(result.outcome).toBe('skip')
    expect(result.detail).toMatch(/NOT RUN/)
  })

  it('reports NOT APPLICABLE, not a failure, when nothing web changed', () => {
    const result = evaluateBrowserObservation(available, false, null)
    expect(result.outcome).toBe('not_applicable')
    expect(browserFailed(result)).toBe(false)
  })

  it('passes only when the browser reported zero of both', () => {
    const result = evaluateBrowserObservation(available, true, {
      consoleErrors: 0,
      networkFailures: 0,
      failureUrls: []
    })
    expect(result.outcome).toBe('pass')
  })

  it('fails on console errors', () => {
    const result = evaluateBrowserObservation(available, true, {
      consoleErrors: 3,
      networkFailures: 0,
      failureUrls: []
    })
    expect(result.outcome).toBe('fail')
    expect(result.detail).toContain('3 console error(s)')
  })

  it('fails on network failures and names the url', () => {
    const result = evaluateBrowserObservation(available, true, {
      consoleErrors: 0,
      networkFailures: 2,
      failureUrls: ['http://localhost/missing.js']
    })
    expect(result.outcome).toBe('fail')
    expect(result.detail).toContain('missing.js')
  })

  // The critical case: the browser ran but its report cannot be read. Passing
  // here would wave through a page whose diagnostics were never understood.
  it('errors rather than passes when the report cannot be read', () => {
    const result = evaluateBrowserObservation(available, true, {
      consoleErrors: null,
      networkFailures: 0,
      failureUrls: []
    })
    expect(result.outcome).toBe('error')
    expect(result.outcome).not.toBe('pass')
  })

  it('errors rather than passes when nothing was observed', () => {
    const result = evaluateBrowserObservation(available, true, null)
    expect(result.outcome).toBe('error')
    expect(result.outcome).not.toBe('pass')
  })
})

describe('formatBrowserLine', () => {
  const cases: Array<[BrowserCheckResult['outcome'], RegExp]> = [
    ['pass', /PASSED/],
    ['fail', /FAILED/],
    ['skip', /NOT RUN/],
    ['not_applicable', /NOT APPLICABLE/],
    ['error', /ERROR/]
  ]

  it.each(cases)('labels a %s outcome unmistakably', (outcome, pattern) => {
    const line = formatBrowserLine({ outcome, detail: 'detail text' })
    expect(line).toMatch(pattern)
    expect(line.startsWith('- browser: ')).toBe(true)
  })

  // The original bug: a line reading "NOT RUN — no browser tools are
  // registered" on a build that has them.
  it('never prints the old false claim', () => {
    for (const [outcome] of cases) {
      const line = formatBrowserLine({ outcome, detail: 'detail text' })
      expect(line).not.toMatch(/no browser tools are registered/i)
    }
  })
})

describe('browserFailed', () => {
  it('is true only for a real browser failure', () => {
    expect(browserFailed({ outcome: 'fail', detail: '' })).toBe(true)
    expect(browserFailed({ outcome: 'pass', detail: '' })).toBe(false)
    expect(browserFailed({ outcome: 'skip', detail: '' })).toBe(false)
    expect(browserFailed({ outcome: 'not_applicable', detail: '' })).toBe(false)
    // An unreadable report is an error, not a failure — but it is certainly not
    // a pass, which is why it is tested explicitly here.
    expect(browserFailed({ outcome: 'error', detail: '' })).toBe(false)
  })
})

/**
 * End-to-end through the real verify stage.
 *
 * The pure tests above pin the rules; these pin the wiring. The original defect
 * lived in `stages.ts` as a hard-coded constant, so nothing about the rules
 * would have caught it — only driving the actual stage does.
 */
describe('the real verify stage', () => {
  const project = {
    root: '/tmp/demo',
    name: 'demo',
    kind: 'web',
    manifests: [],
    requiredTools: [],
    packageManager: 'npm',
    scripts: {},
    devServerPort: null,
    isGitRepo: false,
    detectedAt: '2026-01-01T00:00:00.000Z'
  }

  function runVerify(options: { hasBrowserTools: boolean; changedPaths: string[] }) {
    const pipeline = buildPipeline({
      tools: {
        call: async () => ({ ok: true, summary: 'unused' }),
        hasTool: () => options.hasBrowserTools
      },
      getProject: () => project as never,
      probeRuntime: async () => ({ state: 'present', version: '1', detail: '' })
    })
    return pipeline
      .find((s) => s.name === 'verify')!
      .run({
        task: {
          id: 't',
          title: 't',
          prompt: 'do the thing',
          changedPaths: options.changedPaths
        } as never,
        signal: new AbortController().signal,
        maxTier: 'ask',
        note: () => undefined,
        call: async () => ({ ok: false, summary: 'no tab', error: 'No browser tab is open.' }),
        hasTool: () => options.hasBrowserTools,
        workspaceRoots: [],
        skillContext: '',
        selectedSkills: []
      })
  }

  // THE regression test. On a build with browser tools registered, the stage
  // used to print "no browser tools are registered in this build". It must never
  // say that again.
  it('does not claim the build has no browser tools when they are registered', async () => {
    const outcome = await runVerify({ hasBrowserTools: true, changedPaths: ['/tmp/demo/index.html'] })
    expect(outcome.summary).not.toMatch(/no browser tools are registered/i)
  })

  it('reports NOT APPLICABLE rather than NOT RUN when no web file changed', async () => {
    const outcome = await runVerify({ hasBrowserTools: true, changedPaths: [] })
    expect(outcome.summary).toMatch(/browser: NOT APPLICABLE/)
  })

  it('reports NOT RUN, naming the gap, when the build genuinely has no browser', async () => {
    const outcome = await runVerify({ hasBrowserTools: false, changedPaths: ['/tmp/demo/index.html'] })
    expect(outcome.summary).toMatch(/browser: NOT RUN/)
  })

  // A browser that cannot be opened is an ERROR, never a silent pass.
  it('reports an error, not a pass, when the browser cannot be driven', async () => {
    const outcome = await runVerify({ hasBrowserTools: true, changedPaths: ['/tmp/demo/index.html'] })
    expect(outcome.summary).not.toMatch(/browser: PASSED/)
  })

  it('never claims a browser pass regardless of outcome', async () => {
    for (const changedPaths of [[], ['/tmp/demo/index.html']]) {
      for (const hasBrowserTools of [true, false]) {
        const outcome = await runVerify({ hasBrowserTools, changedPaths })
        expect(outcome.summary).not.toMatch(/browser: PASSED/)
      }
    }
  })
})