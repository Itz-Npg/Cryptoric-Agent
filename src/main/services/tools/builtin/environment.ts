/**
 * Environment and process tools — the first-class capability surface the agent
 * uses to keep a machine buildable without bouncing the developer out of the app.
 *
 * Every tool here is thin: it delegates to a service that already owns the
 * behaviour and the safety checks. Tools never re-implement policy.
 */

import { z } from 'zod'
import type { PermissionDomain, PermissionTier, ToolDescriptor } from '@shared/types'
import type { EnvironmentManager } from '../../env/manager'
import type { ProcessSupervisor } from '../../proc/supervisor'
import type { TerminalSessionManager } from '../../terminal/sessions'
import { describeSchema, type ToolContext, type ToolDefinition, type ToolResult } from '../registry'
import { runCaptured } from '../exec'

/**
 * Execution metadata for every tool in this module.
 *
 * Kept as one auditable table rather than inline in each descriptor: risk,
 * timeout and capability family are the properties a reviewer wants to see side
 * by side, and having them in a single block makes an unsafe tool obvious.
 *
 * `risk` is the effect's blast radius, independent of who may call it — an
 * install that changes the machine is `medium` even when the user asked for it.
 */
const TOOL_META: Record<string, Pick<ToolDescriptor, 'category' | 'risk'> & { timeoutMs: number; mutates: boolean }> = {
  detect_runtime: { category: 'runtime', risk: 'safe', timeoutMs: 60_000, mutates: false },
  detect_package_manager: { category: 'runtime', risk: 'safe', timeoutMs: 60_000, mutates: false },
  install_runtime: { category: 'runtime', risk: 'medium', timeoutMs: 900_000, mutates: true },
  install_package_manager: { category: 'runtime', risk: 'medium', timeoutMs: 900_000, mutates: true },
  verify_runtime: { category: 'runtime', risk: 'safe', timeoutMs: 60_000, mutates: false },
  refresh_environment: { category: 'runtime', risk: 'low', timeoutMs: 120_000, mutates: false },
  inspect_environment: { category: 'runtime', risk: 'safe', timeoutMs: 180_000, mutates: false },
  create_terminal_session: { category: 'terminal', risk: 'low', timeoutMs: 30_000, mutates: true },
  list_running_processes: { category: 'process', risk: 'safe', timeoutMs: 30_000, mutates: false },
  stop_process: { category: 'process', risk: 'medium', timeoutMs: 30_000, mutates: true },
  restart_process: { category: 'process', risk: 'medium', timeoutMs: 120_000, mutates: true }
}

export interface EnvironmentToolDeps {
  env: EnvironmentManager
  terminals: TerminalSessionManager
  processes: ProcessSupervisor
  /** Request a user decision for a tier-gated action. */
  authorize: (tier: PermissionTier, title: string, detail: string) => Promise<boolean>
}

const ok = (summary: string, data?: unknown): ToolResult => ({ ok: true, summary, ...(data !== undefined ? { data } : {}) })
const fail = (summary: string, error: string): ToolResult => ({ ok: false, summary, error })

export function buildEnvironmentTools(deps: EnvironmentToolDeps): ToolDefinition[] {
  const { env, terminals, processes } = deps

  const tool = (
    descriptor: ToolDescriptor,
    domain: PermissionDomain,
    schema: z.ZodTypeAny,
    execute: (input: never, ctx: ToolContext) => Promise<ToolResult>,
    dependsOn?: string[]
  ): ToolDefinition => ({
    descriptor: {
      // Execution metadata is declared once per tool id; an explicit value in
      // the descriptor always wins, so the table cannot override a tool.
      ...TOOL_META[descriptor.id],
      ...descriptor,
      platforms: descriptor.platforms ?? ['*'],
      inputSchema: describeSchema(schema)
    },
    domain,
    schema,
    dependsOn,
    execute: execute as ToolDefinition['execute']
  })

  return [
    // ----------------------------------------------------------------- detect
    tool(
      {
        id: 'detect_runtime',
        label: 'Detect runtime',
        description:
          'Report whether a development runtime is resolvable in the current environment, including version and executable path.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'env.detect',
      z.object({ toolId: z.string().min(1).describe('Runtime id, e.g. node, python, rust, java, go') }),
      async (input: { toolId: string }) => {
        const status = await env.probeTool(input.toolId)
        return ok(status.detail, {
          toolId: status.spec.id,
          label: status.spec.label,
          state: status.state,
          version: status.version,
          path: status.path,
          constraint: status.constraint
        })
      }
    ),

    tool(
      {
        id: 'detect_package_manager',
        label: 'Detect package manager',
        description:
          'Report which package manager the open project actually uses, inferred from its lockfile, and whether that manager is available.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'env.detect',
      z.object({}),
      async () => {
        const snapshot = env.getSnapshot()
        const candidates = ['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'cargo', 'maven', 'gradle']
        const statuses = await env.probeTools(candidates)
        const available = statuses
          .filter((s) => s.state === 'present')
          .map((s) => ({ id: s.spec.id, version: s.version, path: s.path }))
        return ok(
          `Package managers available: ${available.length > 0 ? available.map((a) => a.id).join(', ') : 'none'}`,
          { snapshotId: snapshot.id, available }
        )
      }
    ),

    // ---------------------------------------------------------------- install
    tool(
      {
        id: 'install_runtime',
        label: 'Install runtime',
        description:
          'Install a missing runtime from an official or package-manager-verified source, refresh the environment, and verify the result. The application is never restarted.',
        dependsOn: ['detect_runtime'],
        tier: 'elevated',
        inputSchema: {}
      },
      'env.install',
      z.object({
        toolId: z.string().min(1),
        version: z.string().optional().describe('Version to install when the route supports pinning'),
        installerId: z.string().optional().describe('Preferred installer id from the tool registry')
      }),
      async (input: { toolId: string; version?: string; installerId?: string }, ctx) => {
        ctx.note(`Installing ${input.toolId}…`, 'info')

        const outcome = await env.install(input.toolId, {
          version: input.version,
          installerId: input.installerId,
          authorize: deps.authorize,
          onProgress: (p) => {
            if (p.phase === 'download' || p.phase === 'install') {
              ctx.note(`${p.message}${p.ratio !== null ? ` ${Math.round(p.ratio * 100)}%` : ''}`, 'info')
            }
          }
        })

        if (!outcome.ok) {
          return fail(`Failed to install ${input.toolId}`, outcome.error ?? 'unknown error')
        }

        // Refresh is what makes this restartless; surface it explicitly.
        terminals.markStale(env.getSnapshot().id)
        processes.markStale(env.getSnapshot().id)

        return ok(
          `${outcome.status?.spec.label ?? input.toolId} ${outcome.status?.version ?? ''} installed and verified on a refreshed environment (snapshot ${outcome.snapshotBefore} → ${outcome.snapshotAfter}); no restart required.`,
          {
            toolId: input.toolId,
            version: outcome.status?.version ?? null,
            path: outcome.status?.path ?? null,
            snapshotBefore: outcome.snapshotBefore,
            snapshotAfter: outcome.snapshotAfter,
            refreshedWithoutRestart: outcome.refreshedWithoutRestart
          }
        )
      }
    ),

    tool(
      {
        id: 'install_package_manager',
        label: 'Install package manager',
        description: 'Install a package manager (npm, pnpm, yarn, bun, uv, poetry) using a trusted route.',
        dependsOn: ['detect_package_manager'],
        tier: 'elevated',
        inputSchema: {}
      },
      'env.install',
      z.object({ toolId: z.enum(['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry']) }),
      async (input: { toolId: string }, ctx: ToolContext) => {
        const outcome = await env.install(input.toolId, {
          authorize: deps.authorize,
          onProgress: (p) => ctx.note(p.message, 'info')
        })
        if (!outcome.ok) return fail(`Failed to install ${input.toolId}`, outcome.error ?? 'unknown error')
        return ok(`${input.toolId} ${outcome.status?.version ?? ''} installed`, {
          version: outcome.status?.version ?? null,
          snapshotAfter: outcome.snapshotAfter
        })
      }
    ),

    // ----------------------------------------------------------------- verify
    tool(
      {
        id: 'verify_runtime',
        label: 'Verify runtime',
        description:
          'Run a runtime\'s version command against the current environment snapshot and report whether it works.',
        dependsOn: ['detect_runtime'],
        tier: 'safe',
        inputSchema: {}
      },
      'env.detect',
      z.object({ toolId: z.string().min(1) }),
      async (input: { toolId: string }) => {
        const status = await env.probeTool(input.toolId)
        if (status.state === 'missing' || status.state === 'unverified') {
          return fail(`Verification failed for ${status.spec.label}`, status.detail)
        }
        return ok(`${status.spec.label} ${status.version} verified`, {
          version: status.version,
          path: status.path,
          state: status.state
        })
      }
    ),

    tool(
      {
        id: 'refresh_environment',
        label: 'Refresh environment',
        description:
          'Re-read the operating system environment, rebuild the managed tool layer, and publish a new snapshot. Existing processes are preserved; new ones receive the refreshed environment.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'env.detect',
      z.object({}),
      async () => {
        const before = env.getSnapshot().id
        const snapshot = await env.refresh('manual-refresh')
        terminals.markStale(snapshot.id)
        processes.markStale(snapshot.id)
        const staleTerminals = terminals.list().filter((t) => t.envStale).length
        const staleProcesses = processes.list().filter((p) => p.envStale).length
        return ok(
          `Environment refreshed (snapshot ${before} → ${snapshot.id}). ${staleTerminals} terminal(s) and ${staleProcesses} process(es) keep their original environment and can be restarted on request.`,
          {
            snapshotId: snapshot.id,
            staleTerminals,
            staleProcesses
          }
        )
      }
    ),

    tool(
      {
        id: 'inspect_environment',
        label: 'Inspect environment',
        description:
          'Return the full runtime inventory with versions, executable paths, and which projects required each tool.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'env.detect',
      z.object({ includeAll: z.boolean().optional() }),
      async (input: { includeAll?: boolean }) => {
        const statuses = input.includeAll ? await env.probeAllTools() : await env.probeCoreTools()
        const snapshot = env.getSnapshot()
        return ok(`${statuses.length} runtime(s) inspected on snapshot ${snapshot.id}`, {
          snapshotId: snapshot.id,
          tools: statuses.map((s) => ({
            id: s.spec.id,
            label: s.spec.label,
            state: s.state,
            version: s.version,
            path: s.path,
            constraint: s.constraint
          }))
        })
      }
    ),

    // -------------------------------------------------------------- terminals
    tool(
      {
        id: 'create_terminal_session',
        label: 'Create terminal session',
        description:
          'Open a new shell session in a directory using the current environment snapshot. Use this after an install so the new shell has the refreshed PATH.',
        dependsOn: ['inspect_environment'],
        tier: 'safe',
        inputSchema: {}
      },
      'terminal.safe',
      z.object({
        cwd: z.string().optional(),
        label: z.string().optional()
      }),
      async (input: { cwd?: string; label?: string }, ctx: ToolContext) => {
        const cwd = input.cwd ?? ctx.projectRoot ?? process.cwd()
        const session = terminals.create({ cwd, label: input.label ?? 'agent shell' })
        return ok(`Terminal session ${session.id} ready (${session.shell}, snapshot ${session.envSnapshotId})`, session)
      }
    ),

    // -------------------------------------------------------------- processes
    tool(
      {
        id: 'list_running_processes',
        label: 'List running processes',
        description: 'List every process Cryptoric supervises, with pid, port and environment staleness.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'terminal.safe',
      z.object({}),
      async () => {
        const list = processes.list()
        return ok(`${list.length} supervised process(es)`, list)
      }
    ),

    tool(
      {
        id: 'stop_process',
        label: 'Stop process',
        description: 'Stop a supervised process. Does not remove it from the list, so its logs remain inspectable.',
        dependsOn: ['list_running_processes'],
        tier: 'ask',
        inputSchema: {}
      },
      'terminal.elevated',
      z.object({ processId: z.string().min(1) }),
      async (input: { processId: string }) => {
        const found = processes.stop(input.processId)
        if (!found) return fail('Stop failed', `No process with id ${input.processId}`)
        const info = processes.get(input.processId)
        return ok(`Stopped ${info?.label ?? input.processId}`, info)
      }
    ),

    tool(
      {
        id: 'restart_process',
        label: 'Restart process',
        description:
          'Restart a supervised process so it receives the current environment snapshot. This is the supported way to hand a long-running child a refreshed toolchain.',
        dependsOn: ['list_running_processes', 'refresh_environment'],
        tier: 'ask',
        inputSchema: {}
      },
      'terminal.elevated',
      z.object({ processId: z.string().min(1) }),
      async (input: { processId: string }) => {
        const info = processes.restart(input.processId)
        if (!info) return fail('Restart failed', `No process with id ${input.processId}`)
        return ok(`Restarted ${info.label} on snapshot ${info.envSnapshotId}`, info)
      }
    )
  ]
}

// Small helpers kept local so the tool bodies read declaratively.

export { runCaptured }