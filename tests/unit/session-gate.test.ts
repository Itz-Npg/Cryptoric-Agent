/**
 * The coin gate, end to end through the runtime.
 *
 * The claim under test is the one a user would state: **with no coins the agent
 * does nothing at all, and a task interrupted by a restart continues on the
 * time already paid for rather than being charged again.**
 *
 * Both are asserted against a real `AgentRuntime` with a stage that records
 * whether it ran. An assertion about a returned error would pass even if the
 * pipeline went on to edit files anyway, which is the failure that matters.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentRuntime } from '../../src/main/services/agent/core'
import type { Stage, StageContext } from '../../src/main/services/agent/pipeline-types'
import type { AgentRole, AgentTask } from '../../src/shared/types'
import type { GrantResult, SessionGrant } from '../../src/shared/session-time'
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
  root = mkdtempSync(join(tmpdir(), 'cryptoric-coins-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A stage that remembers whether it ran, and what session it was given. */
function recordingStage(state: { ran: number; session: SessionGrant | null }): Stage {
  return {
    role: 'IMPLEMENTER' as AgentRole,
    name: 'work',
    maxTier: 'safe',
    run: async (ctx: StageContext) => {
      state.ran += 1
      state.session = ctx.session
      return { continue: false, status: 'COMPLETED' as const }
    }
  }
}

function makeRuntime(
  stage: Stage,
  sessions: {
    begin?: (task: AgentTask, resume: SessionGrant | null) => Promise<GrantResult>
    ended: string[]
  }
): AgentRuntime {
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
      getProjectRoot: () => root,
      events: { timeline: () => undefined, task: () => undefined, toolResult: () => undefined, say: () => undefined },
      ...(sessions.begin ? { beginSession: sessions.begin } : {}),
      endSession: async (id: string) => {
        sessions.ended.push(id)
      }
    },
    [stage]
  )
}

/** A grant with time left, as an interrupted session would be. */
function liveGrant(overrides: Partial<SessionGrant> = {}): SessionGrant {
  const now = Date.now()
  return {
    id: 'g-resumed',
    model: 'm',
    coins: 5,
    minutes: 30,
    startedAt: now - 10 * 60_000,
    expiresAt: now + 20 * 60_000,
    day: new Date(now).toISOString().slice(0, 10),
    projectRoot: root,
    prompt: 'carry on',
    consumed: false,
    ...overrides
  }
}

/** Wait until the runtime has drained, so assertions are not racing the pump. */
async function settled(agent: AgentRuntime): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const busy = agent.listTasks().some((t) => !['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(t.status))
    if (!busy) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('no coins, no work', () => {
  it('never runs a stage and says why', async () => {
    const state = { ran: 0, session: null as SessionGrant | null }
    const agent = makeRuntime(recordingStage(state), {
      begin: async () => ({ ok: false, error: 'You have no coins left, so the agent cannot run.' }),
      ended: []
    })

    const task = agent.submit({ title: 't', prompt: 'do work', role: 'IMPLEMENTER', projectRoot: root })
    await settled(agent)

    expect(state.ran).toBe(0)
    const finished = agent.getTask(task.id)
    // BLOCKED, not FAILED: the agent stopped, which is not the same as the
    // work having gone wrong.
    expect(finished?.status).toBe('BLOCKED')
    expect(finished?.error).toMatch(/no coins left/i)
  })

  it('runs normally when a session was bought', async () => {
    const state = { ran: 0, session: null as SessionGrant | null }
    const grant = liveGrant({ id: 'g-fresh' })
    const agent = makeRuntime(recordingStage(state), {
      begin: async () => ({ ok: true, grant, remainingCoins: 15 }),
      ended: []
    })

    agent.submit({ title: 't', prompt: 'do work', role: 'IMPLEMENTER', projectRoot: root })
    await settled(agent)

    expect(state.ran).toBe(1)
    expect(state.session?.id).toBe('g-fresh')
  })

  it('marks the session consumed once the task is over', async () => {
    const ended: string[] = []
    const grant = liveGrant({ id: 'g-done' })
    const agent = makeRuntime(recordingStage({ ran: 0, session: null }), {
      begin: async () => ({ ok: true, grant, remainingCoins: 0 }),
      ended
    })

    agent.submit({ title: 't', prompt: 'do work', role: 'IMPLEMENTER', projectRoot: root })
    await settled(agent)
    // An abandoned session left resumable is how one crash-looping task turns
    // into unlimited free time.
    expect(ended).toEqual(['g-done'])
  })
})

describe('resuming', () => {
  it('continues the interrupted session instead of charging again', async () => {
    const state = { ran: 0, session: null as SessionGrant | null }
    const charged: SessionGrant[] = []
    const grant = liveGrant()
    const agent = makeRuntime(recordingStage(state), {
      begin: async (_task, resume) => {
        // Mirrors the real wiring: a session that still has time is reused.
        if (resume && resume.expiresAt > Date.now()) {
          return { ok: true, grant: resume, remainingCoins: 0 }
        }
        charged.push(resume as SessionGrant)
        return { ok: true, grant: liveGrant({ id: 'g-new' }), remainingCoins: 0 }
      },
      ended: []
    })

    agent.submit({
      title: 'resumed',
      prompt: 'carry on',
      role: 'IMPLEMENTER',
      projectRoot: root,
      resume: grant
    })
    await settled(agent)

    expect(state.ran).toBe(1)
    expect(state.session?.id).toBe(grant.id)
    // The whole point: no second charge for time already bought.
    expect(charged).toHaveLength(0)
  })

  it('charges again when the resumed session had already run out', async () => {
    const state = { ran: 0, session: null as SessionGrant | null }
    const spent = liveGrant({ id: 'g-old', expiresAt: Date.now() - 1 })
    const agent = makeRuntime(recordingStage(state), {
      begin: async (_task, resume) => {
        if (resume && resume.expiresAt > Date.now()) {
          return { ok: true, grant: resume, remainingCoins: 0 }
        }
        return { ok: true, grant: liveGrant({ id: 'g-new' }), remainingCoins: 0 }
      },
      ended: []
    })

    agent.submit({ title: 'resumed', prompt: 'carry on', role: 'IMPLEMENTER', projectRoot: root, resume: spent })
    await settled(agent)

    expect(state.session?.id).toBe('g-new')
  })
})