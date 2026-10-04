import { describe, expect, it } from 'vitest'
import { ToolRegistry, type ToolDefinition } from '../../src/main/services/tools/registry'
import { classifyIntent, describePlan, planByCategory, planOrder, routeTools } from '../../src/main/services/tools/router'
import type { ToolCategory, ToolRiskLevel } from '@shared/types'

function tool(
  id: string,
  category: ToolCategory,
  opts: { risk?: ToolRiskLevel; mutates?: boolean; description?: string; dependsOn?: string[] } = {}
): ToolDefinition {
  return {
    descriptor: {
      id,
      label: id,
      description: opts.description ?? `${id} tool`,
      dependsOn: opts.dependsOn ?? [],
      tier: 'safe',
      inputSchema: {},
      category,
      risk: opts.risk ?? 'safe',
      mutates: opts.mutates
    },
    domain: 'fs.read',
    schema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
    execute: async () => ({ ok: true, summary: 'ok' })
  } as unknown as ToolDefinition
}

function registry(tools: ToolDefinition[]): ToolRegistry {
  const r = new ToolRegistry()
  r.registerAll(tools)
  return r
}

const SAMPLE = [
  tool('analyze_project', 'files'),
  tool('search_code', 'code', { description: 'search the code base for content and symbols' }),
  tool('read_file', 'files'),
  tool('edit_file', 'files', { mutates: true, risk: 'medium' }),
  tool('generate_diff', 'git'),
  tool('run_tests', 'test'),
  tool('run_command', 'terminal', { risk: 'medium' }),
  tool('detect_runtime', 'runtime'),
  tool('install_runtime', 'runtime', { risk: 'medium', mutates: true }),
  tool('refresh_environment', 'runtime'),
  tool('verify_runtime', 'runtime'),
  tool('create_terminal_session', 'terminal', { mutates: true, risk: 'low' }),
  tool('git_status', 'git'),
  tool('git_commit', 'git', { risk: 'medium', mutates: true }),
  tool('scan_secrets', 'security'),
  tool('browser_navigate', 'browser', { risk: 'low' }),
  tool('list_containers', 'containers'),
  tool('database_inspect', 'database', { risk: 'medium' }),
  tool('web_research', 'research')
]

describe('classifyIntent', () => {
  it('recognises a bug fix', () => {
    expect(classifyIntent({ prompt: 'Fix the failing login test' })).toContain('fix-bug')
  })

  it('recognises an environment request', () => {
    const intents = classifyIntent({ prompt: 'Install Rust so this project can build' })
    expect(intents).toContain('setup-environment')
  })

  it('recognises a commit request', () => {
    expect(classifyIntent({ prompt: 'Commit the changes and push' })).toContain('commit')
  })

  it('returns nothing for a request with no capability signal', () => {
    expect(classifyIntent({ prompt: 'hello' })).toEqual([])
  })

  it('keeps at most the three strongest intents', () => {
    const intents = classifyIntent({ prompt: 'fix a bug, run tests, commit, document, refactor, setup runtime' })
    expect(intents.length).toBeLessThanOrEqual(3)
  })
})

describe('routeTools', () => {
  it('proposes only tools from required capability families', () => {
    const plan = routeTools(registry(SAMPLE), { prompt: 'Fix the failing login test' }, { maxTools: 8 })
    const categories = new Set(plan.tools.map((t) => t.category))
    expect(categories.has('containers')).toBe(false)
    expect(categories.has('database')).toBe(false)
    expect(categories.has('research')).toBe(false)
  })

  it('never proposes a browser tool for a pure backend fix', () => {
    const plan = routeTools(registry(SAMPLE), { prompt: 'Fix the failing login test' }, { maxTools: 10 })
    expect(plan.tools.map((t) => t.toolId)).not.toContain('browser_navigate')
    expect(plan.tools.map((t) => t.toolId)).not.toContain('list_containers')
    expect(plan.tools.map((t) => t.toolId)).not.toContain('database_inspect')
  })

  it('brings in the runtime chain when a runtime is missing', () => {
    const plan = routeTools(registry(SAMPLE), { prompt: 'Install Rust and run the project' }, { maxTools: 8 })
    const ids = plan.tools.map((t) => t.toolId)
    expect(ids).toContain('detect_runtime')
    expect(ids).toContain('install_runtime')
    expect(ids).toContain('verify_runtime')
  })

  it('orders a plan along the intent chain rather than by raw score', () => {
    const runtimeOnly = [
      tool('detect_runtime', 'runtime'),
      tool('install_runtime', 'runtime', { risk: 'medium', mutates: true }),
      tool('refresh_environment', 'runtime'),
      tool('verify_runtime', 'runtime'),
      tool('create_terminal_session', 'terminal', { mutates: true, risk: 'low' })
    ]
    const plan = routeTools(registry(runtimeOnly), { prompt: 'Rust is missing, install it' }, { maxTools: 5 })
    const order = planOrder(plan)
    expect(order).toEqual([
      'detect_runtime',
      'install_runtime',
      'refresh_environment',
      'verify_runtime',
      'create_terminal_session'
    ])
  })

  it('keeps the whole runtime chain when the budget allows it', () => {
    const plan = routeTools(registry(SAMPLE), { prompt: 'Install Rust' }, { maxTools: 12 })
    const ids = plan.tools.map((t) => t.toolId)
    expect(ids).toContain('verify_runtime')
    expect(ids).toContain('refresh_environment')
  })

  it('respects the selection limit and explains every rejection', () => {
    const plan = routeTools(registry(SAMPLE), { prompt: 'Fix a bug and run the tests' }, { maxTools: 3 })
    expect(plan.tools).toHaveLength(3)
    expect(plan.skipped.length).toBeGreaterThan(0)
    for (const skip of plan.skipped) expect(skip.reason).toBeTruthy()
  })

  it('refuses tools above the task risk ceiling', () => {
    const risky = [...SAMPLE, tool('drop_everything', 'files', { risk: 'critical', mutates: true })]
    const plan = routeTools(registry(risky), { prompt: 'Fix a bug and edit the file' }, { maxTools: 10, maxRisk: 'medium' })
    expect(plan.tools.map((t) => t.toolId)).not.toContain('drop_everything')
    expect(plan.skipped.find((s) => s.id === 'drop_everything')?.reason).toMatch(/risk/)
  })

  it('skips a tool whose dependency is not registered', () => {
    const broken = [...SAMPLE, tool('orphan', 'files', { dependsOn: ['never_registered'] })]
    const plan = routeTools(registry(broken), { prompt: 'Fix a bug' }, { maxTools: 20 })
    expect(plan.tools.map((t) => t.toolId)).not.toContain('orphan')
    expect(plan.skipped.find((s) => s.id === 'orphan')?.reason).toMatch(/depends on/)
  })

  it('returns an empty plan rather than guessing when no intent is detected', () => {
    const plan = routeTools(registry(SAMPLE), { prompt: 'hello' }, { maxTools: 8 })
    expect(plan.tools).toHaveLength(0)
    expect(describePlan(plan)).toMatch(/No tools required/)
  })

  it('gives every selected tool a reason a human can read', () => {
    const plan = routeTools(registry(SAMPLE), { prompt: 'Commit the changes' }, { maxTools: 5 })
    expect(plan.tools.length).toBeGreaterThan(0)
    for (const t of plan.tools) expect(t.reasons.length).toBeGreaterThan(0)
  })

  it('groups a plan by capability family for display', () => {
    const plan = routeTools(registry(SAMPLE), { prompt: 'Fix the failing test' }, { maxTools: 6 })
    const grouped = planByCategory(plan)
    expect(grouped.length).toBeGreaterThan(0)
    expect(grouped.every((g) => g.toolIds.length > 0)).toBe(true)
  })

  it('describes a plan as a readable workflow', () => {
    const plan = routeTools(registry(SAMPLE), { prompt: 'Install Rust' }, { maxTools: 4 })
    expect(describePlan(plan)).toMatch(/→/)
  })
})