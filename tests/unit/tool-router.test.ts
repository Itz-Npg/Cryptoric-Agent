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

/**
 * A registry of tool ids that actually exist in the product.
 *
 * This fixture used to carry `search_code`, `generate_diff`, `scan_secrets`,
 * `list_containers`, `database_inspect` and `web_research` — none of which any
 * tool builder registers. A router unit test proving that a fictional workflow
 * ranks correctly is not a test of this router. The ids below are the real ones;
 * `tests/unit/tool-catalogue.test.ts` is what keeps them real, by building the
 * registries the composition roots build and refusing to let an intent chain
 * name anything else.
 */
const SAMPLE = [
  tool('analyze_project', 'files'),
  tool('search_content', 'code', { description: 'search the code base for content and symbols' }),
  tool('read_file', 'files'),
  tool('write_file', 'files', { mutates: true, risk: 'medium' }),
  tool('edit_file', 'files', { mutates: true, risk: 'medium' }),
  tool('git_status', 'git'),
  tool('git_diff', 'git'),
  tool('git_log', 'git'),
  tool('git_commit', 'git', { risk: 'medium', mutates: true }),
  tool('run_tests', 'test'),
  tool('run_command', 'terminal', { risk: 'medium' }),
  tool('web_fetch', 'research'),
  tool('detect_runtime', 'runtime'),
  tool('install_runtime', 'runtime', { risk: 'medium', mutates: true }),
  tool('refresh_environment', 'runtime'),
  tool('verify_runtime', 'runtime'),
  tool('create_terminal_session', 'terminal', { mutates: true, risk: 'low' }),
  tool('list_running_processes', 'process'),
  tool('browser_navigate', 'browser', { risk: 'low' }),
  tool('browser_screenshot', 'browser', { risk: 'low' })
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
    const wanted = new Set(plan.categories)
    expect(plan.tools.length).toBeGreaterThan(0)
    // Not "these ids are absent" but "every selected id belongs to a family the
    // router actually decided this task needs" — which is the guarantee, and it
    // holds whatever the registry contains.
    for (const selected of plan.tools) expect(wanted.has(selected.category)).toBe(true)
    expect(plan.tools.map((t) => t.toolId)).not.toContain('web_fetch')
  })

  it('never proposes a browser tool for a pure backend fix', () => {
    const plan = routeTools(registry(SAMPLE), { prompt: 'Fix the failing login test' }, { maxTools: 10 })
    const ids = plan.tools.map((t) => t.toolId)
    expect(ids).not.toContain('browser_navigate')
    expect(ids).not.toContain('browser_screenshot')
    expect(plan.tools.some((t) => t.category === 'browser')).toBe(false)
  })

  it('brings in the runtime chain when a runtime is missing', () => {
    // The budget is deliberately generous: the real registry is larger than the
    // chain, and what is asserted is that the chain is *proposed*, not that it
    // wins a popularity contest against tools the same prompt also plausibly
    // needs. See `keeps the whole runtime chain` below for the ordering claim.
    const plan = routeTools(registry(SAMPLE), { prompt: 'Install Rust on this machine' }, { maxTools: 12 })
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