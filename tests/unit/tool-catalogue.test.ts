/**
 * The tool catalogue guard.
 *
 * Two failures this test exists to catch, both of which are invisible in a
 * passing build:
 *
 *  1. **An intent chain that names a tool nobody registers.** `router.ts`
 *     described canonical workflows built from `search_code`, `generate_diff`,
 *     `run_tests`, `web_research` and four more ids that no tool builder ever
 *     produced. Nothing failed, because the router is a pure function over
 *     whatever registry it is handed — including a fictional one. The chains are
 *     only useful if the tools in them exist.
 *  2. **Two builders registering the same id, or a tool with no declared
 *     category, risk or timeout.** `ToolRegistry.register` throws on a duplicate,
 *     so building the real registry is itself the assertion; the descriptor
 *     checks are the rest.
 *
 * The registries here are built the way each composition root builds them, out
 * of the same builder functions, with stub services. Stubs are enough because
 * these builders choose *what tools exist*, not what they do — and if one ever
 * starts doing real work at construction time, this test fails loudly instead of
 * the app failing at boot.
 */

import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../src/main/services/tools/registry'
import type { ToolDefinition } from '../../src/main/services/tools/registry'
import { INTENT_SIGNALS } from '../../src/main/services/tools/router'
import { buildBrowserTools } from '../../src/main/services/browser/tools'
import { buildCommandTools } from '../../src/main/services/tools/builtin/command'
import { buildEnvironmentTools } from '../../src/main/services/tools/builtin/environment'
import { buildFilesystemTools } from '../../src/main/services/tools/builtin/filesystem'
import { buildGitTools } from '../../src/main/services/tools/builtin/git'
import { buildProjectTools } from '../../src/main/services/tools/builtin/project'
import { buildResearchTools } from '../../src/main/services/tools/builtin/research'
import { PermissionPolicy } from '../../src/main/services/permissions/policy'

/** Enough of a service for a builder to construct its descriptors. */
const stub = {} as never
const getRoots = (): string[] => []

/**
 * Everything the CLI registers.
 *
 * The browser tools are deliberately absent rather than stubbed — they are
 * backed by `WebContentsView`, so a CLI cannot have them — which is why the
 * desktop set is this plus `buildBrowserTools`.
 */
function sharedTools(): ToolDefinition[] {
  return [
    ...buildEnvironmentTools({ env: stub, terminals: stub, processes: stub, authorize: async () => true }),
    ...buildFilesystemTools({ files: stub, policy: new PermissionPolicy(), getRoots }),
    ...buildCommandTools({ env: stub, getRoots }),
    ...buildGitTools({ git: stub, getRoots }),
    ...buildResearchTools(),
    ...buildProjectTools({ env: stub, getRoots })
  ]
}

function desktopTools(): ToolDefinition[] {
  return [...sharedTools(), ...buildBrowserTools({ tabs: stub })]
}

function idsOf(tools: ToolDefinition[]): string[] {
  return tools.map((t) => t.descriptor.id)
}

describe('the tool catalogue', () => {
  it('registers without a duplicate id, in both hosts', () => {
    // `register` throws on a duplicate, so simply building the real registry is
    // the assertion. A duplicate is how one builder silently replaces another's
    // tool and the agent loses a capability nobody notices is gone.
    expect(() => new ToolRegistry().registerAll(desktopTools())).not.toThrow()
    expect(() => new ToolRegistry().registerAll(sharedTools())).not.toThrow()
  })

  it('gives every tool a category, a risk, a timeout and platforms', () => {
    for (const tool of desktopTools()) {
      const d = tool.descriptor
      expect(d.category, `${d.id} has no category`).toBeTruthy()
      expect(d.risk, `${d.id} has no risk`).toBeTruthy()
      expect(d.timeoutMs ?? 0, `${d.id} has no timeout`).toBeGreaterThan(0)
      expect(d.platforms, `${d.id} has no platforms`).toEqual(['*'])
      expect(d.description.length, `${d.id} has no description`).toBeGreaterThan(20)
    }
  })

  it('names only registered tools in every intent chain', () => {
    const registered = new Set(idsOf(desktopTools()))
    const offenders: string[] = []
    for (const signal of INTENT_SIGNALS) {
      for (const id of signal.chain) {
        if (!registered.has(id)) offenders.push(`${signal.intent} → ${id}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('gives every intent chain at least one tool the CLI also has', () => {
    // An intent whose entire chain is desktop-only would be a workflow the CLI
    // can classify but cannot act on.
    const cliIds = new Set(idsOf(sharedTools()))
    const stranded = INTENT_SIGNALS.filter((s) => !s.chain.some((id) => cliIds.has(id))).map((s) => s.intent)
    expect(stranded).toEqual([])
  })

  it('offers the capability families the chains promise', () => {
    const byCategory = new Map<string, number>()
    for (const tool of desktopTools()) {
      const category = tool.descriptor.category ?? 'files'
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1)
    }
    for (const category of ['files', 'code', 'terminal', 'runtime', 'process', 'git', 'test', 'browser', 'research']) {
      expect(byCategory.get(category) ?? 0, `no tool in category ${category}`).toBeGreaterThan(0)
    }
  })

  it('keeps git read-only tools off the approval path and the commit tool on it', () => {
    const tools = new Map(desktopTools().map((t) => [t.descriptor.id, t]))
    for (const id of ['git_status', 'git_diff', 'git_log']) {
      const tool = tools.get(id)
      expect(tool, `${id} is missing`).toBeTruthy()
      expect(tool?.descriptor.tier).toBe('safe')
      expect(tool?.descriptor.mutates).toBe(false)
      expect(tool?.domain).toBe('git.read')
    }
    const commit = tools.get('git_commit')
    expect(commit?.descriptor.tier).toBe('ask')
    expect(commit?.descriptor.mutates).toBe(true)
    expect(commit?.domain).toBe('git.modify')
  })

  it('never exposes a git capability that rewrites history or publishes', () => {
    // Destructive git is not a tool at any tier. Asserting the absence is the
    // point: it is the difference between "no tool uses `push`" and "no tool
    // *can*", and only this makes the second claim checkable.
    const ids = idsOf(desktopTools())
    const forbidden = ['git_push', 'git_reset', 'git_clean', 'git_rebase', 'git_force_push']
    expect(ids.filter((id) => forbidden.includes(id))).toEqual([])
  })
})
