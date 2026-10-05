/**
 * False-completion / no-op regression suite.
 *
 * The reported defect: Cryptoric Chan received an implementation request,
 * produced **"Task complete — no files were changed."**, and every stage
 * displayed as finished with `0 ms`.
 *
 * The engine defect behind it was not a display problem. `implementStage`
 * returned `continue: true` when the model answered in prose instead of calling
 * a tool, and again when no provider was configured at all. The pipeline then
 * walked through verification and review — stages with nothing to verify and
 * nothing to review — and finished `COMPLETED`. Each stage had run. None of them
 * had checked whether the *task* had been done.
 *
 * The tests below are ordered to match the 18 required scenarios.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTask } from '../../src/shared/types'
import {
  classifyIntent,
  diffSnapshots,
  explainNoChange,
  judgeFinalStatus,
  looksLikeUnbackedClaim,
  requiresMutation,
  type FinalStatusInput
} from '../../src/main/services/agent/evidence'
import { isProjectWritable, takeSnapshot } from '../../src/main/services/agent/snapshot'
import { buildPipeline } from '../../src/main/services/agent/stages'
import { formatDuration, phaseDuration } from '../../src/shared/execution-display'
import { buildFilesystemTools } from '../../src/main/services/tools/builtin/filesystem'
import { PermissionPolicy } from '../../src/main/services/permissions/policy'
import { FileService } from '../../src/main/services/fs/files'
import { ToolRuntime } from '../../src/main/services/tools/runtime'
import { ToolRegistry } from '../../src/main/services/tools/registry'
import { ApprovalQueue } from '../../src/main/services/permissions/policy'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cryptoric-evidence-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: {} }), 'utf8')
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const prompt = (text: string, projectRoot: string | null = root): AgentTask => ({
  id: 'task-1',
  title: text.slice(0, 40),
  prompt: text,
  status: 'QUEUED' as const,
  role: 'IMPLEMENTER' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  projectRoot,
  ownedPaths: [],
  changedPaths: [],
  error: null,
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 }
})

type ModelPhase = 'plan' | 'implement'

function pipeline(options: {
  prompt: string
  model?: (ctx: never, phase: ModelPhase) => Promise<{
    ok: boolean
    text: string
    error: string | null
    tools: string[]
    toolCalls: number
    failedToolCalls: number
    modelCalls: number
  }>
  call?: (toolId: string, args: Record<string, unknown>) => Promise<unknown>
  scripts?: Record<string, string>
}) {
  const project = {
    root,
    name: 'demo',
    kind: 'node',
    manifests: [],
    requiredTools: [],
    packageManager: 'npm',
    scripts: options.scripts ?? {},
    devServerPort: null,
    isGitRepo: false,
    detectedAt: '2026-01-01T00:00:00.000Z'
  }
  const notes: string[] = []
  const stages = buildPipeline({
    tools: { call: async () => ({ ok: true, summary: 'unused' }) },
    getProject: () => project as never,
    probeRuntime: async () => ({ state: 'present', version: '1', detail: '' }),
    model: options.model as never
  })
  const stage = (name: string) => stages.find((s) => s.name === name)!
  const ctx = (task: ReturnType<typeof prompt>) => ({
    task: task as never,
    signal: new AbortController().signal,
    maxTier: 'elevated' as const,
    note: (m: string) => notes.push(m),
    call: (async (id: string, args: Record<string, unknown>) =>
      options.call ? options.call(id, args) : { ok: true, summary: '', data: {} }) as never,
    workspaceRoots: [root],
    skillContext: '',
    selectedSkills: []
  })
  return { stage, ctx, notes, task: prompt(options.prompt) }
}

const proseOnly = async () => ({
  ok: true,
  text: 'I have implemented the landing page.',
  error: null,
  tools: [] as string[],
  toolCalls: 0,
  failedToolCalls: 0,
  modelCalls: 1
})

// ---------------------------------------------------------------------------
// 1. An implementation request must modify files
// ---------------------------------------------------------------------------

describe('1. an implementation request modifies files', () => {
  it('reports the file it actually wrote', async () => {
    const { stage, ctx, task } = pipeline({
      prompt: 'Create a file named NOTES.md containing hello',
      model: async () => {
        writeFileSync(join(root, 'NOTES.md'), 'hello', 'utf8')
        return { ok: true, text: 'Created NOTES.md', error: null, tools: ['write_file'], toolCalls: 1, failedToolCalls: 0, modelCalls: 1 }
      }
    })

    const outcome = await stage('implement').run(ctx(task) as never)

    expect(outcome.continue).toBe(true)
    expect(task.evidence?.changedFiles).toContain('NOTES.md')
    expect(existsSync(join(root, 'NOTES.md'))).toBe(true)
  })

  it('detects the change by content, not by what a tool claimed', async () => {
    const before = takeSnapshot(root)
    writeFileSync(join(root, 'x.txt'), 'one', 'utf8')
    const mid = takeSnapshot(root)
    writeFileSync(join(root, 'x.txt'), 'two', 'utf8')
    const after = takeSnapshot(root)

    expect(diffSnapshots(before.files, mid.files).changed).toEqual(['x.txt'])
    expect(diffSnapshots(mid.files, after.files).modified).toEqual(['x.txt'])
  })

  it('ignores a rewrite that leaves the content identical', () => {
    writeFileSync(join(root, 'same.txt'), 'unchanged', 'utf8')
    const before = takeSnapshot(root)
    writeFileSync(join(root, 'same.txt'), 'unchanged', 'utf8')
    const after = takeSnapshot(root)

    expect(diffSnapshots(before.files, after.files).isEmpty).toBe(true)
  })

  it('notices a deletion', () => {
    writeFileSync(join(root, 'gone.txt'), 'x', 'utf8')
    const before = takeSnapshot(root)
    rmSync(join(root, 'gone.txt'))
    const after = takeSnapshot(root)

    expect(diffSnapshots(before.files, after.files).deleted).toEqual(['gone.txt'])
  })
})

// ---------------------------------------------------------------------------
// 2. An implementation request where no change is necessary
// ---------------------------------------------------------------------------

describe('2. no change was necessary', () => {
  it('completes a read-only request without demanding edits', async () => {
    const { stage, ctx, task } = pipeline({
      prompt: 'Explain what this project does',
      model: proseOnly
    })

    const outcome = await stage('implement').run(ctx(task) as never)
    expect(outcome.continue).toBe(true)
  })

  it('still records why nothing changed', async () => {
    const { stage, ctx, task } = pipeline({
      prompt: 'Explain what this project does',
      model: proseOnly
    })
    await stage('implement').run(ctx(task) as never)
    expect(task.evidence?.changedFiles).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3–8. The model/tool loop
// ---------------------------------------------------------------------------

describe('3-8. model and tool loop', () => {
  it('accepts a real write_file as implementation', async () => {
    const { stage, ctx, task } = pipeline({
      prompt: 'Add a readme file',
      model: async () => {
        writeFileSync(join(root, 'README.md'), '# demo', 'utf8')
        return { ok: true, text: 'added', error: null, tools: ['write_file'], toolCalls: 1, failedToolCalls: 0, modelCalls: 1 }
      }
    })

    expect((await stage('implement').run(ctx(task) as never)).continue).toBe(true)
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# demo')
  })

  it('rejects a claim of success from write_file when nothing landed', async () => {
    const { stage, ctx, task } = pipeline({
      prompt: 'Create a file named MISSING.md',
      model: async () => ({ ok: true, text: 'Created MISSING.md', error: null, tools: ['write_file'], toolCalls: 1, failedToolCalls: 0, modelCalls: 1 })
    })

    const outcome = await stage('implement').run(ctx(task) as never)
    expect(outcome.continue).toBe(false)
    expect(outcome.status).toBe('BLOCKED')
    expect(outcome.summary).not.toMatch(/task complete/i)
  })

  it('rejects a failed write outright', async () => {
    const { stage, ctx, task } = pipeline({
      prompt: 'Create a file named BAD.md',
      model: async () => ({ ok: true, text: '', error: null, tools: ['write_file'], toolCalls: 1, failedToolCalls: 1, modelCalls: 1 })
    })

    const outcome = await stage('implement').run(ctx(task) as never)
    expect(outcome.status).toBe('BLOCKED')
    expect(outcome.summary).toMatch(/failed|error/i)
  })

  it('blocks when the model only writes prose', async () => {
    const { stage, ctx, task } = pipeline({ prompt: 'Build a landing page', model: proseOnly })

    const outcome = await stage('implement').run(ctx(task) as never)
    expect(outcome.continue).toBe(false)
    expect(outcome.status).toBe('BLOCKED')
  })

  it('blocks when no provider is configured at all', async () => {
    const { stage, ctx, task } = pipeline({ prompt: 'Build a landing page' })

    const outcome = await stage('implement').run(ctx(task) as never)
    expect(outcome.status).toBe('BLOCKED')
    expect(outcome.summary).toMatch(/no model provider/i)
    expect(outcome.summary).not.toMatch(/task complete/i)
  })

  it('recognises an unbacked implementation claim', () => {
    expect(looksLikeUnbackedClaim("I've implemented the feature")).toBe(true)
    expect(looksLikeUnbackedClaim("Here's what I would implement next")).toBe(true)
    expect(looksLikeUnbackedClaim('The file defines a helper function.')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 9–13. Tests and build actually run
// ---------------------------------------------------------------------------

describe('9-13. testing actually executes', () => {
  it('runs the declared test script', async () => {
    const ran: string[] = []
    const { stage, ctx, task } = pipeline({
      prompt: 'Add a test',
      scripts: { test: 'vitest run' },
      call: async (id, args) => {
        ran.push(`${id}:${JSON.stringify((args as { args?: string[] }).args)}`)
        return { ok: true, summary: 'exit 0', data: { exitCode: 0, stdout: '3 passed' } }
      }
    })

    const outcome = await stage('verify').run(ctx(task) as never)
    expect(ran.some((r) => r.includes('test'))).toBe(true)
    expect(outcome.summary).toContain('test: passed')
    expect(task.evidence?.testsExecuted).toContain('test')
  })

  it('runs the declared build script', async () => {
    const ran: string[] = []
    const { stage, ctx, task } = pipeline({
      prompt: 'Build the project',
      scripts: { build: 'tsc' },
      call: async (id, args) => {
        ran.push(`${id}:${JSON.stringify((args as { args?: string[] }).args)}`)
        return { ok: true, summary: 'exit 0', data: { exitCode: 0 } }
      }
    })

    await stage('verify').run(ctx(task) as never)
    expect(ran.some((r) => r.includes('build'))).toBe(true)
    expect(task.evidence?.testsExecuted).toContain('build')
  })

  it('reports NO_TEST_SUITE_FOUND when nothing is declared', async () => {
    const { stage, ctx, task } = pipeline({ prompt: 'Tidy up', scripts: {} })

    const outcome = await stage('verify').run(ctx(task) as never)
    expect(outcome.summary).toMatch(/NO_TEST_SUITE_FOUND/)
    expect(outcome.summary).not.toMatch(/passed/i)
  })

  it('rejects a false tests-passed when a check actually fails', async () => {
    const { stage, ctx, task } = pipeline({
      prompt: 'Run the tests',
      scripts: { test: 'vitest run' },
      call: async () => ({ ok: true, summary: 'exit 1', data: { exitCode: 1, stdout: '1 failed' } })
    })

    const outcome = await stage('verify').run(ctx(task) as never)
    expect(outcome.status).toBe('FAILED')
    expect(outcome.summary).toContain('test: FAILED')
  })

  it('never claims browser verification', async () => {
    const { stage, ctx, task } = pipeline({
      prompt: 'Check the site',
      scripts: { test: 'x' },
      call: async () => ({ ok: true, summary: 'exit 0', data: { exitCode: 0 } })
    })

    const outcome = await stage('verify').run(ctx(task) as never)
    expect(outcome.summary).toMatch(/browser: NOT RUN/)
  })
})

// ---------------------------------------------------------------------------
// 14. Review cannot report success without evidence
// ---------------------------------------------------------------------------

describe('14. review requires evidence', () => {
  it('refuses to say "Task complete" when an implementation changed nothing', async () => {
    const { stage, ctx, task } = pipeline({ prompt: 'Build a landing page', model: proseOnly })

    task.evidence = {
      classification: 'IMPLEMENTATION',
      filesBefore: 1,
      filesAfter: 1,
      createdFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      changedFiles: [],
      toolCalls: 0,
      failedToolCalls: 0,
      modelCalls: 1,
      testsExecuted: [],
      finalStatus: 'IN_PROGRESS',
      reason: ''
    }

    const outcome = await stage('review').run(ctx(task) as never)
    expect(outcome.status).toBe('BLOCKED')
    expect(outcome.summary).not.toMatch(/task complete/i)
  })

  it('completes a review that has real changed files behind it', async () => {
    const { stage, ctx, task } = pipeline({ prompt: 'Add a readme' })

    task.evidence = {
      classification: 'IMPLEMENTATION',
      filesBefore: 1,
      filesAfter: 2,
      createdFiles: ['README.md'],
      modifiedFiles: [],
      deletedFiles: [],
      changedFiles: ['README.md'],
      toolCalls: 1,
      failedToolCalls: 0,
      modelCalls: 1,
      testsExecuted: [],
      finalStatus: 'IN_PROGRESS',
      reason: ''
    }

    const outcome = await stage('review').run(ctx(task) as never)
    expect(outcome.status).toBe('COMPLETED')
    expect(outcome.summary).toContain('README.md')
  })
})

// ---------------------------------------------------------------------------
// 15. No fake 0 ms phases
// ---------------------------------------------------------------------------

describe('15. a phase that never ran is NOT_RUN', () => {
  it('returns null rather than 0 for a phase with no timestamps', () => {
    expect(phaseDuration(null, null)).toBeNull()
    expect(formatDuration(null, null)).toBe('NOT_RUN')
  })

  it('returns null when only one end of the phase exists', () => {
    expect(phaseDuration('2026-01-01T00:00:00.000Z', null)).toBeNull()
    expect(phaseDuration(null, '2026-01-01T00:00:00.000Z')).toBeNull()
  })

  it('measures a phase that genuinely ran', () => {
    expect(phaseDuration('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.250Z')).toBe(1250)
  })
})

// ---------------------------------------------------------------------------
// 18. The final status is always truthful
// ---------------------------------------------------------------------------

describe('18. final status rule', () => {
  const base: FinalStatusInput = {
    intent: 'IMPLEMENTATION',
    cancelled: false,
    modelSucceeded: true,
    mutationObserved: true,
    toolCalls: 2,
    failedToolCalls: 0,
    verificationRan: true,
    verificationPassed: true,
    modelText: 'done',
    filesAlreadyPresent: [],
    projectWritable: true
  }

  it('COMPLETED when the change happened', () => {
    expect(judgeFinalStatus(base).status).toBe('COMPLETED')
  })

  it('BLOCKED when an implementation changed nothing, whatever the model said', () => {
    const verdict = judgeFinalStatus({
      ...base,
      mutationObserved: false,
      toolCalls: 0,
      modelText: 'I have implemented the landing page.'
    })
    expect(verdict.status).toBe('BLOCKED')
    expect(verdict.evidence).toBe(false)
    expect(verdict.reason).toMatch(/did not change anything/i)
  })

  it('FAILED when verification ran and failed', () => {
    expect(judgeFinalStatus({ ...base, verificationPassed: false }).status).toBe('FAILED')
  })

  it('PARTIAL when a testing task ran no check', () => {
    expect(judgeFinalStatus({ ...base, intent: 'TESTING', verificationRan: false }).status).toBe('PARTIAL')
  })

  it('CANCELLED when the user stopped it', () => {
    expect(judgeFinalStatus({ ...base, cancelled: true }).status).toBe('CANCELLED')
  })

  it('COMPLETED for a read-only question with no change', () => {
    expect(judgeFinalStatus({ ...base, intent: 'READ_ONLY', mutationObserved: false }).status).toBe(
      'COMPLETED'
    )
  })

  it('FAILED when the model run itself failed', () => {
    expect(judgeFinalStatus({ ...base, modelSucceeded: false }).status).toBe('FAILED')
  })
})

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

describe('intent classification', () => {
  it.each([
    ['Build a Nepal travel landing page with React', 'IMPLEMENTATION', true],
    ['Create a file named NOTES.md', 'IMPLEMENTATION', true],
    ['Fix the bug in the login form', 'DEBUGGING', true],
    ['Refactor the parser module', 'REFACTOR', true],
    ['Add tests for the gateway', 'TESTING', true],
    ['Configure the npm registry', 'CONFIGURATION', true],
    ['Explain what this project does', 'ANALYSIS_ONLY', false],
    ['What does the retry ladder do?', 'READ_ONLY', false],
    ['Research alternatives for the queue', 'RESEARCH', false]
  ])('classifies %s as %s', (text, expected, mutating) => {
    const intent = classifyIntent(text)
    expect(intent).toBe(expected)
    expect(requiresMutation(intent)).toBe(mutating)
  })

  it('classifies a request with both reading and changing verbs as MIXED', () => {
    expect(requiresMutation(classifyIntent('Check the config and update it'))).toBe(true)
  })

  it('explains each no-change reason distinctly', () => {
    expect(
      explainNoChange({ modelText: '', toolCalls: 0, failedToolCalls: 0, filesAlreadyPresent: [], projectWritable: true })
        .reason
    ).toBe('TASK_MISUNDERSTOOD')

    expect(
      explainNoChange({ modelText: '', toolCalls: 3, failedToolCalls: 3, filesAlreadyPresent: [], projectWritable: true })
        .reason
    ).toBe('IMPLEMENTATION_TOOLS_FAILED')

    expect(
      explainNoChange({ modelText: '', toolCalls: 1, failedToolCalls: 0, filesAlreadyPresent: [], projectWritable: false })
        .reason
    ).toBe('PROJECT_READ_ONLY')
  })
})

// ---------------------------------------------------------------------------
// End to end: the real filesystem tool, the real stage, a real disk
// ---------------------------------------------------------------------------

describe('end to end through the real write_file tool', () => {
  it('creates CRYPTORIC_AGENT_TEST.md and reports it as changed', async () => {
    const policy = new PermissionPolicy()
    const approvals = new ApprovalQueue()
    const registry = new ToolRegistry()
    for (const tool of buildFilesystemTools({
      files: new FileService(() => [root]),
      policy,
      getRoots: () => [root]
    })) {
      registry.register(tool)
    }

    const runtime = new ToolRuntime({ registry, policy, approvals })

    // `write_file` is `ask` tier, so the runtime legitimately pauses for a human.
    // This test stands in for that human by answering the prompt, which is the
    // same thing the existing filesystem suite does — the gate is not bypassed,
    // it is satisfied.
    const answer = setInterval(() => {
      for (const request of approvals.list()) approvals.resolve(request.id, true)
    }, 2)

    const target = join(root, 'CRYPTORIC_AGENT_TEST.md')

    const { stage, ctx, task } = pipeline({
      prompt: 'Create a file named CRYPTORIC_AGENT_TEST.md containing execution test',
      model: async () => {
        const result = await runtime.invoke(
          'write_file',
          { path: 'CRYPTORIC_AGENT_TEST.md', content: 'execution test' },
          { projectRoot: root, grantedTier: 'destructive' }
        )

        // §5: the tool result is structured, so the model and the engine reason
        // over the same facts rather than over a prose summary.
        expect(result.operation).toBe('write')
        expect(result.filesCreated).toHaveLength(1)
        expect(result.filesChanged).toHaveLength(1)
        expect(result.filesDeleted).toEqual([])
        expect(result.filesRenamed).toEqual([])
        expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
        expect(typeof result.durationMs).toBe('number')

        return {
          ok: result.ok,
          text: `Wrote CRYPTORIC_AGENT_TEST.md`,
          error: null,
          tools: ['write_file'],
          toolCalls: 1,
          failedToolCalls: result.ok ? 0 : 1,
          modelCalls: 1
        }
      }
    })

    const outcome = await stage('implement').run(ctx(task) as never)

    expect(outcome.continue).toBe(true)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('execution test')
    expect(task.evidence?.changedFiles).toContain('CRYPTORIC_AGENT_TEST.md')
    expect(task.evidence?.createdFiles).toContain('CRYPTORIC_AGENT_TEST.md')

    const review = await stage('review').run(ctx(task) as never)
    clearInterval(answer)
    expect(review.status).toBe('COMPLETED')
    expect(review.summary).toContain('CRYPTORIC_AGENT_TEST.md')
    expect(review.summary).toMatch(/1 created/)
  })

  it('reports a writable project as writable', () => {
    expect(isProjectWritable(root)).toBe(true)
    expect(isProjectWritable(join(root, 'does-not-exist'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §5 — tool results are structured and authoritative
// ---------------------------------------------------------------------------

describe('tool results are structured', () => {
  const build = () => {
    const policy = new PermissionPolicy()
    const approvals = new ApprovalQueue()
    const registry = new ToolRegistry()
    for (const tool of buildFilesystemTools({
      files: new FileService(() => [root]),
      policy,
      getRoots: () => [root]
    })) {
      registry.register(tool)
    }
    const runtime = new ToolRuntime({ registry, policy, approvals })
    const answer = setInterval(() => {
      for (const request of approvals.list()) approvals.resolve(request.id, true)
    }, 2)
    return { runtime, stop: () => clearInterval(answer) }
  }

  it('reports a created file as created, not merely changed', async () => {
    const { runtime, stop } = build()
    try {
      const result = await runtime.invoke(
        'write_file',
        { path: 'made.txt', content: 'x' },
        { projectRoot: root, grantedTier: 'destructive' }
      )
      expect(result.filesCreated).toHaveLength(1)
      expect(result.filesChanged).toEqual(result.filesCreated)
    } finally {
      stop()
    }
  })

  it('reports an overwrite as changed but not created', async () => {
    const { runtime, stop } = build()
    try {
      await runtime.invoke('write_file', { path: 'twice.txt', content: 'a' }, { projectRoot: root, grantedTier: 'destructive' })
      const second = await runtime.invoke(
        'write_file',
        { path: 'twice.txt', content: 'b' },
        { projectRoot: root, grantedTier: 'destructive' }
      )
      expect(second.filesCreated).toEqual([])
      expect(second.filesChanged).toHaveLength(1)
    } finally {
      stop()
    }
  })

  it('reports a deleted file as deleted', async () => {
    const { runtime, stop } = build()
    try {
      await runtime.invoke('write_file', { path: 'temp.txt', content: 'x' }, { projectRoot: root, grantedTier: 'destructive' })
      const removed = await runtime.invoke(
        'delete_file',
        { path: 'temp.txt' },
        { projectRoot: root, grantedTier: 'destructive' }
      )
      expect(removed.filesDeleted).toHaveLength(1)
      expect(removed.filesCreated).toEqual([])
    } finally {
      stop()
    }
  })

  it('classifies a read as an operation that changes nothing', async () => {
    const { runtime, stop } = build()
    try {
      await runtime.invoke('write_file', { path: 'r.txt', content: 'hello' }, { projectRoot: root, grantedTier: 'destructive' })
      const read = await runtime.invoke('read_file', { path: 'r.txt' }, { projectRoot: root, grantedTier: 'safe' })
      expect(read.operation).toBe('read')
      expect(read.filesChanged).toEqual([])
    } finally {
      stop()
    }
  })

  it('never claims a change from a tool that reported no effect', async () => {
    const { runtime, stop } = build()
    try {
      const missing = await runtime.invoke(
        'read_file',
        { path: 'absent.txt' },
        { projectRoot: root, grantedTier: 'safe' }
      )
      expect(missing.ok).toBe(false)
      expect(missing.filesChanged).toEqual([])
    } finally {
      stop()
    }
  })
})