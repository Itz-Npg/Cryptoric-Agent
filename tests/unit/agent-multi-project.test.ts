/**
 * Multi-project execution.
 *
 * The claim under test is narrow and falsifiable: **two tasks in two different
 * folders run at the same time, and two tasks in one folder never do.** Both
 * halves matter. Dropping the first makes multi-project a tab bar; dropping the
 * second lets two agents overwrite each other's files.
 *
 * The stage in `blockingStage` parks on a shared latch so overlap is something
 * the test observes rather than something it infers from timing. A test that
 * measured "it finished faster" would pass on a slow machine and fail on a
 * fast one; a test that counts tasks inside the critical section does not.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentRuntime } from '../../src/main/services/agent/core'
import type { Stage } from '../../src/main/services/agent/pipeline-types'
import type { AgentRole } from '../../src/shared/types'
import { ToolRegistry } from '../../src/main/services/tools/registry'
import { ToolRuntime } from '../../src/main/services/tools/runtime'
import { SkillRegistry } from '../../src/main/services/skills/registry'
import {
  ApprovalQueue,
  PermissionPolicy,
  DEFAULT_PERMISSION_RULES
} from '../../src/main/services/permissions/policy'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cryptoric-parallel-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * A stage that records how many of its runs are inside the critical section at
 * once, and only returns when `release` is called.
 */
function blockingStage(state: { inside: number; peak: number }, release: Promise<void>): Stage {
  return {
    role: 'IMPLEMENTER' as AgentRole,
    name: 'blocking',
    maxTier: 'safe',
    run: async () => {
      state.inside += 1
      state.peak = Math.max(state.peak, state.inside)
      await release
      state.inside -= 1
      return { continue: false, status: 'COMPLETED' as const }
    }
  }
}

function makeRuntime(stage: Stage): AgentRuntime {
  const tools = new ToolRegistry()
  const skills = new SkillRegistry()
  return new AgentRuntime(
    {
      tools,
      runtime: new ToolRuntime({
        registry: tools,
        policy: new PermissionPolicy(DEFAULT_PERMISSION_RULES),
        approvals: new ApprovalQueue()
      }),
      skills,
      skillTokenBudget: 6000,
      maxSkillsPerTask: 4,
      getProjectRoot: () => null,
      events: { timeline: () => undefined, task: () => undefined, toolResult: () => undefined, say: () => undefined }
    },
    [stage]
  )
}

/** Wait until `predicate` holds, or fail. Polling rather than a fixed sleep. */
async function until(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

describe('multi-project execution', () => {
  it('runs tasks from two different projects at the same time', async () => {
    const state = { inside: 0, peak: 0 }
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const runtime = makeRuntime(blockingStage(state, gate))
    const projectA = join(root, 'alpha')
    const projectB = join(root, 'beta')

    runtime.submit({ title: 'a1', prompt: 'task in alpha', role: 'IMPLEMENTER', projectRoot: projectA })
    runtime.submit({ title: 'a2', prompt: 'task in beta', role: 'IMPLEMENTER', projectRoot: projectB })

    // Both parked inside the stage at once — only possible if the two projects
    // drain independently.
    await until(() => state.inside === 2, 'both projects to be running')
    expect(state.peak).toBe(2)
    expect(runtime.activeTasks()).toHaveLength(2)
    expect(runtime.isRunning()).toBe(true)

    release()
    await until(() => !runtime.isRunning(), 'both tasks to finish')
    expect(state.peak).toBe(2)
  })

  it('never overlaps two tasks inside one project', async () => {
    const state = { inside: 0, peak: 0 }
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const runtime = makeRuntime(blockingStage(state, gate))
    const project = join(root, 'solo')

    const first = runtime.submit({ title: 'one', prompt: 'first', role: 'IMPLEMENTER', projectRoot: project })
    runtime.submit({ title: 'two', prompt: 'second', role: 'IMPLEMENTER', projectRoot: project })

    await until(() => state.inside === 1, 'the first task to start')
    // Give the queue a chance to (incorrectly) start the second as well.
    await new Promise((r) => setTimeout(r, 60))
    expect(state.inside).toBe(1)

    release()
    await until(() => !runtime.isRunning(), 'both tasks to finish')
    // Serialised within a project: peak concurrency never exceeded one.
    expect(state.peak).toBe(1)
    expect(runtime.getTask(first.id)?.status).toBe('COMPLETED')
  })

  it('keeps three projects running independently', async () => {
    const state = { inside: 0, peak: 0 }
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const runtime = makeRuntime(blockingStage(state, gate))
    for (const name of ['one', 'two', 'three']) {
      runtime.submit({
        title: name,
        prompt: `task ${name}`,
        role: 'IMPLEMENTER',
        projectRoot: join(root, name)
      })
    }

    await until(() => state.inside === 3, 'all three projects to be running')
    expect(runtime.activeTasks()).toHaveLength(3)

    release()
    await until(() => !runtime.isRunning(), 'all three tasks to finish')
    expect(state.peak).toBe(3)
  })

  it('reports no activity once everything has drained', async () => {
    const state = { inside: 0, peak: 0 }
    const runtime = makeRuntime(
      blockingStage(state, Promise.resolve())
    )
    const task = runtime.submit({ title: 'x', prompt: 'x', role: 'IMPLEMENTER', projectRoot: join(root, 'solo') })
    await until(() => !runtime.isRunning(), 'the task to finish')

    expect(runtime.isRunning()).toBe(false)
    expect(runtime.activeTasks()).toEqual([])
    expect(runtime.getTask(task.id)?.status).toBe('COMPLETED')
  })

  it('stopAll clears every project queue, not just one', async () => {
    const state = { inside: 0, peak: 0 }
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const runtime = makeRuntime(blockingStage(state, gate))
    runtime.submit({ title: 'a', prompt: 'a', role: 'IMPLEMENTER', projectRoot: join(root, 'a') })
    runtime.submit({ title: 'b', prompt: 'b', role: 'IMPLEMENTER', projectRoot: join(root, 'b') })
    await until(() => state.inside === 2, 'both to start')

    runtime.stopAll()
    release()
    await until(() => !runtime.isRunning(), 'everything to stop')
    expect(runtime.activeTasks()).toEqual([])
  })
})