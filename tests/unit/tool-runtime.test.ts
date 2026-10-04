import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry, type ToolContext, type ToolDefinition } from '../../src/main/services/tools/registry'
import { ToolRuntime, platformSupported, riskForTier } from '../../src/main/services/tools/runtime'
import { ApprovalQueue, PermissionPolicy } from '../../src/main/services/permissions/policy'
import type {
  PermissionDomain,
  PermissionRule,
  PermissionTier,
  ToolCategory,
  ToolRiskLevel
} from '@shared/types'

/** Minimal tool builder so each test declares only what it is asserting. */
function makeTool(
  id: string,
  overrides: {
    tier?: PermissionTier
    category?: ToolCategory
    risk?: ToolRiskLevel
    domain?: PermissionDomain
    dependsOn?: string[]
    timeoutMs?: number
    platforms?: NodeJS.Platform[] | ['*']
    mutates?: boolean
    sensitiveArgs?: string[]
    schema?: z.ZodTypeAny
    run?: (args: any, ctx: ToolContext) => Promise<any>
  } = {}
): ToolDefinition {
  const schema = overrides.schema ?? z.object({})
  return {
    descriptor: {
      id,
      label: id,
      description: `test tool ${id}`,
      dependsOn: overrides.dependsOn ?? [],
      tier: overrides.tier ?? 'safe',
      inputSchema: {},
      category: overrides.category,
      risk: overrides.risk,
      timeoutMs: overrides.timeoutMs,
      platforms: overrides.platforms,
      mutates: overrides.mutates,
      sensitiveArgs: overrides.sensitiveArgs
    },
    domain: overrides.domain ?? 'fs.read',
    schema,
    dependsOn: overrides.dependsOn,
    execute: overrides.run ?? (async () => ({ ok: true, summary: 'done', data: { id } }))
  } as ToolDefinition
}

function setup(
  tools: ToolDefinition[],
  options: { rules?: PermissionRule[]; onRecord?: (r: any) => void } = {}
) {
  const registry = new ToolRegistry()
  registry.registerAll(tools)
  const approvals = new ApprovalQueue()
  const policy = new PermissionPolicy(
    options.rules ?? [{ domain: 'fs.read', default: 'allow' }]
  )
  const runtime = new ToolRuntime({
    registry,
    policy,
    approvals,
    ...(options.onRecord ? { onRecord: options.onRecord } : {})
  })
  return { registry, approvals, policy, runtime }
}

/** Answer the next approval request; used to drive the approval branch. */
async function decide(approvals: ApprovalQueue, approved: boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const [request] = approvals.list()
    if (request) {
      approvals.resolve(request.id, approved)
      return
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('ToolRuntime.invoke', () => {
  it('runs a safe tool and returns the normalised result shape', async () => {
    const { runtime } = setup([makeTool('read_thing')])
    const result = await runtime.invoke('read_thing', {})

    expect(result.ok).toBe(true)
    expect(typeof result.durationMs).toBe('number')
    expect(result.artifacts).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.metadata['category']).toBeDefined()
    expect(result.metadata['risk']).toBe('safe')
  })

  it('rejects an unknown tool before anything executes', async () => {
    let ran = false
    const { runtime } = setup([
      makeTool('known', { run: async () => { ran = true; return { ok: true, summary: 'x' } } })
    ])
    const result = await runtime.invoke('nope', {})
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('unavailable')
    expect(ran).toBe(false)
  })

  it('refuses a tool that does not support this platform', async () => {
    const { runtime } = setup([
      makeTool('posix_only', { platforms: ['darwin', 'linux'], run: async () => ({ ok: true, summary: 'x' }) })
    ])
    const result = await runtime.invoke('posix_only', {})
    if (process.platform === 'win32') {
      expect(result.ok).toBe(false)
      expect(result.failureKind).toBe('platform-unsupported')
    } else {
      expect(result.ok).toBe(true)
    }
    expect(platformSupported(['*'])).toBe(true)
    expect(platformSupported(undefined)).toBe(true)
  })

  it('reports a missing dependency instead of failing later', async () => {
    const { runtime } = setup([makeTool('needs_a', { dependsOn: ['absent_tool'] })])
    const result = await runtime.invoke('needs_a', {})
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('dependency-missing')
    expect(result.error).toMatch(/absent_tool/)
  })

  it('validates arguments rather than coercing them', async () => {
    const { runtime } = setup([
      makeTool('needs_path', { schema: z.object({ path: z.string().min(1) }) })
    ])
    const result = await runtime.invoke('needs_path', { path: '' })
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('invalid-args')
  })

  it('never lets a tool exceed the ceiling its caller granted', async () => {
    const { runtime } = setup([
      makeTool('dangerous', {
        tier: 'destructive',
        domain: 'fs.delete',
        run: async () => ({ ok: true, summary: 'should not run' })
      })
    ])
    const result = await runtime.invoke('dangerous', {}, { grantedTier: 'safe' })
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('permission-denied')
    expect(result.error).toMatch(/only granted safe/)
  })

  it('honours a policy deny regardless of the caller grant', async () => {
    const { runtime } = setup([makeTool('blocked', { domain: 'fs.delete' })], {
      rules: [{ domain: 'fs.delete', default: 'deny' }]
    })
    const result = await runtime.invoke('blocked', {}, { grantedTier: 'destructive' })
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('permission-denied')
  })

  it('asks for approval above the safe tier and runs once approved', async () => {
    const { runtime, approvals } = setup(
      [makeTool('install_it', { tier: 'elevated', domain: 'env.install' })],
      { rules: [{ domain: 'env.install', default: 'ask' }] }
    )
    const pending = runtime.invoke('install_it', {}, { grantedTier: 'elevated' })
    await decide(approvals, true)
    const result = await pending
    expect(result.ok).toBe(true)
  })

  it('records a denial when the user says no', async () => {
    const { runtime, approvals } = setup(
      [makeTool('install_it', { tier: 'elevated', domain: 'env.install' })],
      { rules: [{ domain: 'env.install', default: 'ask' }] }
    )
    const pending = runtime.invoke('install_it', {}, { grantedTier: 'elevated' })
    await decide(approvals, false)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('not-approved')
    expect(runtime.audit().at(-1)?.approved).toBe(false)
  })

  it('does not prompt for a safe tool when policy allows it', async () => {
    const { runtime, approvals } = setup([makeTool('read_thing')])
    await runtime.invoke('read_thing', {})
    expect(approvals.list()).toHaveLength(0)
  })

  it('aborts a tool that outlives its timeout instead of hanging the agent', async () => {
    const { runtime } = setup([
      makeTool('hangs', {
        timeoutMs: 40,
        // Deliberately ignores its signal, which is the case the race protects.
        run: () => new Promise(() => undefined)
      })
    ])
    const result = await runtime.invoke('hangs', {})
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('timeout')
  })

  it('reports cancellation when the caller aborts mid-flight', async () => {
    const controller = new AbortController()
    const { runtime } = setup([
      makeTool('slow', { run: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, summary: 'late' }), 500)) })
    ])
    const pending = runtime.invoke('slow', {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('cancelled')
  })

  it('classifies a thrown error instead of crashing the agent', async () => {
    const { runtime } = setup([
      makeTool('explodes', { run: async () => { throw new Error('kaboom') } })
    ])
    const result = await runtime.invoke('explodes', {})
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('threw')
    expect(result.error).toBe('kaboom')
  })

  it('writes an audit record for every invocation', async () => {
    const { runtime } = setup([makeTool('read_thing')])
    await runtime.invoke('read_thing', {}, { taskId: 'task-1' })
    const record = runtime.audit().at(-1)
    expect(record).toBeDefined()
    expect(record?.toolId).toBe('read_thing')
    expect(record?.taskId).toBe('task-1')
    expect(record?.ok).toBe(true)
    expect(record?.id).toBeTruthy()
  })

  it('redacts sensitive arguments before they reach the audit trail', async () => {
    const { runtime } = setup([
      makeTool('login', {
        sensitiveArgs: ['apiKey'],
        schema: z.object({ apiKey: z.string(), user: z.string() }),
        run: async () => ({ ok: true, summary: 'logged in' })
      })
    ])
    await runtime.invoke('login', { apiKey: 'sk-abcdefghijklmnopqrstuvwx', user: 'ada' })
    const record = runtime.audit().at(-1)
    expect(record?.args).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(record?.args).toContain('ada')
  })

  it('bounds the audit trail', async () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('read_thing'))
    const runtime = new ToolRuntime({
      registry,
      policy: new PermissionPolicy([{ domain: 'fs.read', default: 'allow' }]),
      approvals: new ApprovalQueue(),
      maxAuditRecords: 3
    })
    for (let i = 0; i < 6; i += 1) await runtime.invoke('read_thing', {})
    expect(runtime.audit()).toHaveLength(3)
  })

  it('keeps artifacts attributable to the task that produced them', async () => {
    const { runtime } = setup([makeTool('shoot')])
    const artifact = runtime.recordArtifact('shoot', {
      taskId: 'task-9',
      kind: 'screenshot',
      path: '/tmp/shot.png',
      bytes: 12,
      summary: 'home page'
    })
    expect(artifact.id).toBeTruthy()
    expect(artifact.toolId).toBe('shoot')
    expect(runtime.artifactsFor('task-9')).toHaveLength(1)
    expect(runtime.artifactsFor('other')).toHaveLength(0)
  })
})

describe('riskForTier', () => {
  it('derives a default risk from the permission tier', () => {
    expect(riskForTier('safe')).toBe('safe')
    expect(riskForTier('ask')).toBe('low')
    expect(riskForTier('elevated')).toBe('medium')
    expect(riskForTier('destructive')).toBe('high')
  })
})

describe('session grants', () => {
  // Found while wiring the agent loop: "Allow for this session" called
  // `policy.grantSession`, but the runtime only skipped the prompt for a tool
  // declared at the `safe` tier. So the button granted nothing and an agent
  // writing eight files prompted eight times, which is the behaviour the button
  // was added to remove.
  const writer = (): ToolDefinition =>
    makeTool('write_file', { tier: 'ask', domain: 'fs.write', run: async () => ({ ok: true, summary: 'wrote' }) })

  it('still prompts when the domain merely defaults to allow', async () => {
    const { runtime, approvals } = setup([writer()], { rules: [{ domain: 'fs.write', default: 'allow' }] })
    const pending = runtime.invoke('write_file', {})
    await new Promise((r) => setTimeout(r, 10))
    expect(approvals.list()).toHaveLength(1)
    approvals.resolve(approvals.list()[0]!.id, false)
    await pending
  })

  it('stops prompting once the user grants the domain for the session', async () => {
    const { runtime, policy, approvals } = setup([writer()], { rules: [{ domain: 'fs.write', default: 'allow' }] })
    policy.grantSession('fs.write', 'allow')

    const result = await runtime.invoke('write_file', {})
    expect(result.ok).toBe(true)
    expect(approvals.list()).toHaveLength(0)
  })

  it('does not let a session grant override a denial', async () => {
    const { runtime, policy, approvals } = setup([writer()], { rules: [{ domain: 'fs.write', default: 'deny' }] })
    policy.grantSession('fs.write', 'allow')

    const result = await runtime.invoke('write_file', {})
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('permission-denied')
    expect(approvals.list()).toHaveLength(0)
  })

  it('does not let one domain\u2019s grant authorise another', async () => {
    const { runtime, policy, approvals } = setup([writer()], { rules: [{ domain: 'fs.write', default: 'allow' }] })
    policy.grantSession('fs.delete', 'allow')

    const pending = runtime.invoke('write_file', {})
    await new Promise((r) => setTimeout(r, 10))
    expect(approvals.list()).toHaveLength(1)
    approvals.resolve(approvals.list()[0]!.id, false)
    await pending
  })

  it('reports hasSessionGrant separately from a default allow', () => {
    const policy = new PermissionPolicy([{ domain: 'fs.write', default: 'allow' }])
    expect(policy.hasSessionGrant('fs.write')).toBe(false)
    policy.grantSession('fs.write', 'allow')
    expect(policy.hasSessionGrant('fs.write')).toBe(true)
    expect(policy.hasSessionGrant('fs.delete')).toBe(false)
  })
})