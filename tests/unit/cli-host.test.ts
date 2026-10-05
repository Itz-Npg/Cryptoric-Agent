/**
 * CLI host: verdict mapping, exit codes, rendering.
 *
 * The rule these tests exist to enforce: **a CLI run can never report success
 * it did not observe.** `cryptoric run` is the part of this agent most likely to
 * be wired into a script or a CI step, so a wrong exit code here is a wrong
 * answer delivered with total confidence. Every branch below is a way a run can
 * end without evidence, and each one has to resolve to something other than
 * COMPLETED.
 */

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentTask } from '../../src/shared/types'
import { resolveModelConfig, resolveStateDir, verdictFor } from '../../cli/src/host'
import { EXIT_BLOCKED, EXIT_CANCELLED, EXIT_FAILED, EXIT_OK, EXIT_PARTIAL, exitCodeFor } from '../../cli/src/exit-code'
import { clockOf, renderSummary, renderTimelineEntry } from '../../cli/src/render'

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 't1',
    title: 'a task',
    prompt: 'a task',
    status: 'COMPLETED',
    role: 'IMPLEMENTER',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    projectRoot: '/tmp/project',
    ownedPaths: [],
    changedPaths: [],
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 },
    ...overrides
  }
}

function evidence(finalStatus: string): NonNullable<AgentTask['evidence']> {
  return {
    classification: 'IMPLEMENTATION',
    filesBefore: 1,
    filesAfter: 1,
    createdFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    changedFiles: [],
    toolCalls: 0,
    failedToolCalls: 0,
    modelCalls: 0,
    testsExecuted: [],
    finalStatus,
    reason: 'recorded by the pipeline'
  }
}

describe('verdictFor', () => {
  it('prefers the verdict the pipeline recorded', () => {
    // A stage recorded FAILED even though the task status says COMPLETED. The
    // recorded verdict is the one that saw the evidence.
    const t = task({ status: 'COMPLETED', evidence: evidence('FAILED') })
    expect(verdictFor(t)).toBe('FAILED')
  })

  it('honours COMPLETED, BLOCKED, PARTIAL and CANCELLED from the pipeline', () => {
    for (const v of ['COMPLETED', 'BLOCKED', 'PARTIAL', 'CANCELLED'] as const) {
      expect(verdictFor(task({ evidence: evidence(v) }))).toBe(v)
    }
  })

  it('falls back to task status when no verdict was recorded', () => {
    expect(verdictFor(task({ status: 'FAILED' }))).toBe('FAILED')
    expect(verdictFor(task({ status: 'BLOCKED' }))).toBe('BLOCKED')
    expect(verdictFor(task({ status: 'CANCELLED' }))).toBe('CANCELLED')
  })

  it('treats PAUSED and CANCELLING as cancelled, not complete', () => {
    expect(verdictFor(task({ status: 'PAUSED' }))).toBe('CANCELLED')
    expect(verdictFor(task({ status: 'CANCELLING' }))).toBe('CANCELLED')
  })

  it('ignores the IN_PROGRESS placeholder evidence carries', () => {
    // `finalStatus` starts life as IN_PROGRESS. Reading it as a verdict is how
    // a run that stopped early would read as finished.
    const t = task({ status: 'COMPLETED', evidence: evidence('IN_PROGRESS') })
    expect(verdictFor(t)).toBe('COMPLETED')
  })

  it.each([
    'QUEUED',
    'ANALYZING',
    'PLANNING',
    'IMPLEMENTING',
    'VERIFYING',
    'TESTING',
    'REVIEWING',
    'FIXING',
    'WAITING_FOR_USER',
    'WAITING_FOR_TOOL',
    'RUNNING'
  ])('never reports COMPLETED for a run left in %s', (status) => {
    const t = task({ status: status as AgentTask['status'] })
    expect(verdictFor(t)).not.toBe('COMPLETED')
    expect(verdictFor(t)).toBe('BLOCKED')
  })
})

describe('exitCodeFor', () => {
  it('maps each verdict to its own code', () => {
    expect(exitCodeFor('COMPLETED')).toBe(EXIT_OK)
    expect(exitCodeFor('FAILED')).toBe(EXIT_FAILED)
    expect(exitCodeFor('BLOCKED')).toBe(EXIT_BLOCKED)
    expect(exitCodeFor('CANCELLED')).toBe(EXIT_CANCELLED)
    expect(exitCodeFor('PARTIAL')).toBe(EXIT_PARTIAL)
  })

  it('does not collapse BLOCKED into failure', () => {
    // "The agent correctly refused to guess" and "the agent broke" are
    // different outcomes and a caller can act on each differently.
    expect(exitCodeFor('BLOCKED')).not.toBe(exitCodeFor('FAILED'))
  })

  it('throws on a verdict it has never heard of', () => {
    expect(() => exitCodeFor('NONSENSE' as never)).toThrow()
  })
})

describe('renderSummary', () => {
  const noColour = { color: false }

  it('calls out a COMPLETED run that wrote nothing', () => {
    const out = renderSummary(
      {
        task: task(),
        verdict: 'COMPLETED',
        answer: 'done',
        reason: null,
        changedPaths: [],
        usage: task().usage,
        durationMs: 1500
      },
      noColour
    )
    expect(out).toContain('none — no files were written')
  })

  it('lists changed files and a count', () => {
    const out = renderSummary(
      {
        task: task(),
        verdict: 'COMPLETED',
        answer: null,
        reason: null,
        changedPaths: ['src/a.ts', 'src/b.ts'],
        usage: task().usage,
        durationMs: 500
      },
      noColour
    )
    expect(out).toContain('2 file(s)')
    expect(out).toContain('src/a.ts')
    expect(out).not.toContain('none — no files were written')
  })

  it('carries the verdict in a word, not only in colour', () => {
    const out = renderSummary(
      {
        task: task(),
        verdict: 'BLOCKED',
        answer: null,
        reason: 'nothing was written',
        changedPaths: [],
        usage: task().usage,
        durationMs: 1
      },
      noColour
    )
    expect(out).toContain('BLOCKED')
    expect(out).toContain('nothing was written')
    // No ANSI when colour is off, so piped output stays clean.
    expect(out).not.toContain('[')
  })

  it('reports token usage including cached tokens', () => {
    const out = renderSummary(
      {
        task: task(),
        verdict: 'COMPLETED',
        answer: null,
        reason: null,
        changedPaths: ['a'],
        usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 5, estimatedCostUsd: 0.002 },
        durationMs: 2000
      },
      noColour
    )
    expect(out).toContain('in 10 / out 20 tokens')
    expect(out).toContain('5 cached')
    expect(out).toContain('$0.0020')
  })
})

describe('renderTimelineEntry', () => {
  it('renders stage, status word and message', () => {
    const line = renderTimelineEntry(
      {
        id: 'e1',
        taskId: 't1',
        at: '2026-01-01T12:00:00.000Z',
        role: 'SYSTEM',
        stage: 'verify',
        message: 'typecheck passed',
        status: 'ok'
      },
      { color: false }
    )
    expect(line).toContain('verify')
    expect(line).toContain('ok')
    expect(line).toContain('typecheck passed')
  })

  it('spells out an error rather than relying on red', () => {
    const line = renderTimelineEntry(
      {
        id: 'e1',
        taskId: 't1',
        at: '2026-01-01T12:00:00.000Z',
        role: 'SYSTEM',
        stage: 'verify',
        message: 'tests failed',
        status: 'error'
      },
      { color: false }
    )
    expect(line).toContain('ERROR')
  })
})

describe('clockOf', () => {
  it('returns a placeholder for an unparseable timestamp', () => {
    expect(clockOf('not a date')).toBe('--:--:--')
  })

  it('renders a real timestamp as HH:MM:SS', () => {
    expect(clockOf('2026-01-01T12:34:56.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})

describe('resolveModelConfig', () => {
  const overrides = { provider: null, endpoint: null, model: null }

  it('is null when no API key is present', () => {
    // Reporting a provider as configured without a key would let a stage try
    // to call the model and fail at the far end with an opaque 401.
    const config = resolveModelConfig(
      { CRYPTORIC_ENDPOINT: 'https://example.test', CRYPTORIC_MODEL: 'm' },
      overrides
    )
    expect(config).toBeNull()
  })

  it('is null when the endpoint or model is missing', () => {
    expect(resolveModelConfig({ CRYPTORIC_API_KEY: 'k' }, overrides)).toBeNull()
    expect(resolveModelConfig({ CRYPTORIC_API_KEY: 'k', CRYPTORIC_MODEL: 'm' }, overrides)).toBeNull()
  })

  it('builds a config when key, endpoint and model are all present', () => {
    const config = resolveModelConfig(
      { CRYPTORIC_API_KEY: 'k', CRYPTORIC_ENDPOINT: 'https://example.test', CRYPTORIC_MODEL: 'm' },
      overrides
    )
    expect(config).not.toBeNull()
    expect(config?.model).toBe('m')
    expect(config?.endpoint).toBe('https://example.test')
  })

  it('honours explicit overrides over the environment', () => {
    const config = resolveModelConfig(
      { CRYPTORIC_API_KEY: 'k', CRYPTORIC_ENDPOINT: 'https://env.test', CRYPTORIC_MODEL: 'env-model' },
      { provider: null, endpoint: 'https://flag.test', model: 'flag-model' }
    )
    expect(config?.endpoint).toBe('https://flag.test')
    expect(config?.model).toBe('flag-model')
  })
})

describe('resolveStateDir', () => {
  it('uses CRYPTORIC_HOME when set, resolved to an absolute path', () => {
    // Compared against `resolve` rather than a literal: this is a Windows-first
    // project, and '/tmp/state' resolves to 'C:\tmp\state' here. Asserting the
    // literal would make the suite pass on Linux and fail on the maintainer's
    // own machine, which is worse than not asserting it.
    expect(resolveStateDir({ CRYPTORIC_HOME: '/tmp/state' })).toBe(resolve('/tmp/state'))
  })

  it('ignores a blank CRYPTORIC_HOME rather than resolving to the cwd', () => {
    // `resolve('')` is the current directory, which would scatter state files
    // through whatever directory the user happened to run from.
    expect(resolveStateDir({ CRYPTORIC_HOME: '   ' })).not.toBe('')
    expect(resolveStateDir({ CRYPTORIC_HOME: '   ' })).toContain('.cryptoric')
  })
})