/**
 * Tool router.
 *
 * The agent has a large capability surface and a short context window, so
 * "run every tool" is both wasteful and wrong — it burns time on Docker for a
 * CSS fix, and it floods the transcript with results the agent did not need.
 *
 * The router answers one question: for *this* task, which capabilities are
 * actually required, and which tool in each capability is the best entry point?
 * It is a pure function of the request and the registry, so a plan can be
 * inspected, tested and replayed before anything executes.
 *
 * Deliberately mirrors the skill router (`skills/registry.ts`): the same
 * "select a little, report what was skipped" shape, so the two subsystems read
 * as one idea rather than two.
 */

import type { ToolCategory, ToolDescriptor, ToolRiskLevel } from '@shared/types'
import type { ToolRegistry } from './registry'

/**
 * Intent signals.
 *
 * `chain` is the canonical order for that kind of work. The router uses it to
 * rank related tools against each other — the analyzer before the search before
 * the edit — so a plan reads as a workflow rather than a bag of tools.
 *
 * **Every id in a chain must be a tool that is actually registered.** This list
 * used to name `git_status`, `generate_diff`, `run_tests`, `web_research`,
 * `scan_secrets`, `find_references`, `detect_dev_port` and `database_inspect`,
 * none of which existed — so the "canonical workflow" it ranked against was a
 * description of a different product. `tests/unit/tool-catalogue.test.ts` now
 * builds the real registries and fails if a chain names anything else, which is
 * the only thing that keeps this list from drifting back into fiction.
 */
export interface IntentSignal {
  intent: string
  categories: ToolCategory[]
  keywords: string[]
  chain: string[]
}

export const INTENT_SIGNALS: IntentSignal[] = [
  {
    intent: 'fix-bug',
    categories: ['files', 'code', 'terminal', 'test'],
    keywords: ['fix', 'bug', 'broken', 'failing', 'error', 'crash', 'regression', 'not working', 'fails'],
    chain: ['analyze_project', 'search_content', 'read_file', 'edit_file', 'run_tests', 'git_diff']
  },
  {
    intent: 'build-feature',
    categories: ['code', 'files', 'test'],
    keywords: ['add', 'implement', 'build', 'create', 'feature', 'support', 'write', 'new'],
    chain: ['analyze_project', 'search_content', 'read_file', 'write_file', 'run_tests']
  },
  {
    intent: 'refactor',
    categories: ['code', 'files', 'test'],
    keywords: ['refactor', 'rename', 'extract', 'cleanup', 'restructure', 'simplify', 'organize'],
    chain: ['analyze_project', 'search_content', 'edit_file', 'run_tests', 'git_diff']
  },
  {
    intent: 'setup-environment',
    categories: ['runtime', 'process', 'terminal'],
    keywords: ['install', 'runtime', 'toolchain', 'setup', 'set up', 'missing', 'version', 'node', 'python', 'rust', 'java', 'go', 'dotnet'],
    chain: ['detect_runtime', 'detect_package_manager', 'install_runtime', 'refresh_environment', 'verify_runtime', 'create_terminal_session']
  },
  {
    intent: 'run-project',
    categories: ['process', 'terminal', 'runtime', 'browser'],
    keywords: ['run', 'start', 'serve', 'dev server', 'launch', 'preview', 'localhost', 'port'],
    chain: ['analyze_project', 'detect_package_manager', 'run_command', 'list_running_processes', 'browser_navigate']
  },
  {
    intent: 'test',
    categories: ['test', 'terminal', 'files'],
    keywords: ['test', 'tests', 'coverage', 'spec', 'unit', 'integration', 'e2e', 'vitest', 'jest', 'pytest'],
    chain: ['analyze_project', 'run_tests', 'git_diff']
  },
  {
    intent: 'review',
    categories: ['git', 'files', 'code'],
    keywords: ['review', 'check', 'inspect', 'audit', 'diff', 'changes', 'pr', 'pull request'],
    chain: ['git_status', 'git_diff', 'git_log', 'read_file']
  },
  {
    intent: 'commit',
    categories: ['git', 'security'],
    keywords: ['commit', 'push', 'checkpoint', 'version control', 'stage', 'branch'],
    chain: ['git_status', 'git_diff', 'git_commit', 'git_log']
  },
  {
    intent: 'security',
    categories: ['security', 'files', 'git'],
    keywords: ['security', 'vulnerability', 'secret', 'exposed', 'xss', 'injection', 'traversal', 'audit', 'cve', 'dependency risk'],
    chain: ['analyze_project', 'search_content', 'git_diff']
  },
  {
    intent: 'debug',
    categories: ['terminal', 'process', 'code', 'files'],
    keywords: ['debug', 'stack trace', 'stacktrace', 'exception', 'segfault', 'hang', 'hangs', 'hangs', 'deadlock', 'port conflict'],
    chain: ['analyze_project', 'run_command', 'list_running_processes', 'read_file', 'edit_file']
  },
  {
    intent: 'documentation',
    categories: ['files', 'code', 'git'],
    keywords: ['document', 'documentation', 'readme', 'docstring', 'explain', 'changelog', 'architecture doc'],
    chain: ['analyze_project', 'search_content', 'read_file', 'write_file']
  },
  {
    intent: 'research',
    categories: ['research', 'network'],
    keywords: ['research', 'docs', 'documentation for', 'latest', 'version of', 'how does', 'official', 'changelog', 'api reference'],
    chain: ['web_fetch', 'read_file']
  },
  {
    intent: 'ui-work',
    categories: ['browser', 'files', 'code', 'test'],
    keywords: ['ui', 'design', 'layout', 'style', 'css', 'responsive', 'screenshot', 'visual', 'component', 'frontend', 'page'],
    chain: ['analyze_project', 'search_content', 'read_file', 'edit_file', 'run_command', 'browser_navigate', 'browser_screenshot']
  },
  {
    intent: 'container',
    categories: ['containers', 'terminal', 'process'],
    keywords: ['docker', 'compose', 'container', 'podman', 'image', 'volume'],
    chain: ['detect_runtime', 'list_running_processes', 'read_file']
  },
  {
    intent: 'database',
    categories: ['database', 'terminal'],
    keywords: ['database', 'sql', 'postgres', 'mysql', 'mongo', 'redis', 'sqlite', 'schema', 'migration', 'query'],
    chain: ['analyze_project', 'read_file']
  },
  {
    intent: 'understand',
    categories: ['files', 'code', 'git'],
    keywords: ['explain', 'how does', 'what does', 'understand', 'analyse', 'analyze', 'architecture', 'structure', 'walk me through'],
    chain: ['analyze_project', 'search_content', 'git_log', 'read_file']
  }
]

export interface RouterInput {
  prompt: string
  /** Files the agent believes it will touch; a secondary signal. */
  paths?: string[]
}

export interface RouterOptions {
  /** Hard ceiling on how many tools a plan may propose. */
  maxTools: number
  /** Ceiling on tool risk; a plan may not propose anything above it. */
  maxRisk?: 'safe' | 'low' | 'medium' | 'high' | 'critical'
}

export interface ToolRoute {
  toolId: string
  category: ToolCategory
  score: number
  /** Why this tool was selected, so a plan is inspectable. */
  reasons: string[]
  /** Position in the matching intent chain, when there is one. */
  chainIndex: number
}

export interface ToolPlan {
  intents: string[]
  categories: ToolCategory[]
  tools: ToolRoute[]
  skipped: { id: string; reason: string }[]
}

const RISK_RANK: Record<ToolRiskLevel, number> = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
}

/**
 * Classify a request into the intents it plausibly contains.
 *
 * Signals are additive: "fix the failing test in the api client" scores both
 * `fix-bug` and `test`, and the router keeps both, because the work genuinely
 * needs both capability families.
 */
export function classifyIntent(input: RouterInput): string[] {
  const haystack = `${input.prompt} ${(input.paths ?? []).join(' ')}`.toLowerCase()
  const scored: { intent: string; score: number }[] = []

  for (const signal of INTENT_SIGNALS) {
    let score = 0
    for (const keyword of signal.keywords) {
      if (haystack.includes(keyword)) score += 2
    }
    if (score > 0) scored.push({ intent: signal.intent, score })
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .map((s) => s.intent)
    .slice(0, 3)
}

/**
 * Build an execution plan for a task.
 *
 * The plan proposes; it never executes. Selection is capped and every
 * rejection is reported, so "the agent chose three tools out of forty" is a
 * fact a user can check rather than an assumption.
 */
export function routeTools(
  registry: ToolRegistry,
  input: RouterInput,
  options: RouterOptions
): ToolPlan {
  const intents = classifyIntent(input)
  const wanted = new Set<ToolCategory>()
  const chainIndexByTool = new Map<string, number>()
  const reasonByTool = new Map<string, string[]>()

  for (const intent of intents) {
    const signal = INTENT_SIGNALS.find((s) => s.intent === intent)
    if (!signal) continue
    for (const category of signal.categories) wanted.add(category)
    signal.chain.forEach((toolId, index) => {
      const existing = chainIndexByTool.get(toolId)
      if (existing === undefined || index < existing) chainIndexByTool.set(toolId, index)
      const reasons = reasonByTool.get(toolId) ?? []
      if (!reasons.includes(`matches intent "${intent}"`)) reasons.push(`matches intent "${intent}"`)
      reasonByTool.set(toolId, reasons)
    })
  }

  const maxRisk = options.maxRisk ?? 'critical'
  const candidates: ToolRoute[] = []
  const skipped: { id: string; reason: string }[] = []

  for (const descriptor of registry.list()) {
    const category = descriptor.category ?? 'files'

    // Outside every required capability family: not even considered.
    if (!wanted.has(category)) {
      skipped.push({ id: descriptor.id, reason: `not required for ${intents.join(', ') || 'this task'}` })
      continue
    }

    const risk = descriptor.risk ?? 'medium'
    if (RISK_RANK[risk] > RISK_RANK[maxRisk]) {
      skipped.push({ id: descriptor.id, reason: `risk ${risk} exceeds this task's ceiling` })
      continue
    }

    const reasons = [...(reasonByTool.get(descriptor.id) ?? [])]
    let score = 5 // the category itself matched

    const haystack = `${descriptor.label} ${descriptor.description}`.toLowerCase()
    const prompt = `${input.prompt} ${(input.paths ?? []).join(' ')}`.toLowerCase()
    const overlap = haystack.split(/[^a-z0-9]+/).filter((w) => w.length > 3 && prompt.includes(w))
    if (overlap.length > 0) {
      score += Math.min(4, overlap.length)
      reasons.push(`description matches ${overlap.slice(0, 3).join(', ')}`)
    }

    // Prefer reading over writing when both fit: inspect before mutating.
    if (descriptor.mutates) score -= 1

    const chainIndex = chainIndexByTool.get(descriptor.id)
    if (chainIndex !== undefined) score += Math.max(0, 6 - chainIndex)

    // A tool whose dependencies are not in the plan is not a useful entry point.
    const unmet = (descriptor.dependsOn ?? []).filter((id) => !registry.has(id))
    if (unmet.length > 0) {
      skipped.push({ id: descriptor.id, reason: `depends on unregistered ${unmet.join(', ')}` })
      continue
    }

    if (reasons.length === 0) reasons.push(`category ${category} is required for this task`)
    candidates.push({ toolId: descriptor.id, category, score, reasons, chainIndex: chainIndex ?? -1 })
  }

  candidates.sort((a, b) => b.score - a.score || a.toolId.localeCompare(b.toolId))

  const selected = candidates.slice(0, options.maxTools)
  for (const rejected of candidates.slice(options.maxTools)) {
    skipped.push({ id: rejected.toolId, reason: 'below the selection limit for this task' })
  }

  return {
    intents,
    categories: [...wanted],
    tools: selected,
    skipped
  }
}

/** Every tool id a plan would run, in chain order where one exists. */
export function planOrder(plan: ToolPlan): string[] {
  return [...plan.tools]
    .sort((a, b) => {
      if (a.chainIndex !== b.chainIndex) {
        if (a.chainIndex === -1) return 1
        if (b.chainIndex === -1) return -1
        return a.chainIndex - b.chainIndex
      }
      return b.score - a.score
    })
    .map((t) => t.toolId)
}

/** Tools grouped by capability family, for a readable plan summary. */
export function planByCategory(plan: ToolPlan): { category: ToolCategory; toolIds: string[] }[] {
  const grouped = new Map<ToolCategory, string[]>()
  for (const tool of plan.tools) {
    const list = grouped.get(tool.category) ?? []
    list.push(tool.toolId)
    grouped.set(tool.category, list)
  }
  return [...grouped.entries()].map(([category, toolIds]) => ({ category, toolIds }))
}

/** One-line human summary of a plan, used on the task timeline. */
export function describePlan(plan: ToolPlan): string {
  if (plan.tools.length === 0) return `No tools required (${plan.intents.join(', ') || 'no intent detected'})`
  return `${plan.intents.join(', ') || 'general'} → ${planOrder(plan).join(' → ')}`
}

/** Ids of every tool a registry exposes, for diagnostics. */
export function toolIds(descriptors: ToolDescriptor[]): string[] {
  return descriptors.map((d) => d.id)
}