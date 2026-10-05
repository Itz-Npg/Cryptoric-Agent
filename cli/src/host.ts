/**
 * The CLI composition root.
 *
 * This is the second place the agent is assembled. The desktop app builds it in
 * `main/index.ts` around a window, an OS keychain and a browser; the CLI builds
 * it here around argv, environment variables and a pipe.
 *
 * What is shared is everything that decides behaviour: `AgentRuntime`,
 * `buildPipeline`, `ToolRuntime`, `PermissionPolicy`, the tool definitions, the
 * skills registry, the model gateway and the prompts. What differs is only the
 * edges — where state lives, where the API key comes from, and who answers an
 * approval prompt. Two composition roots with one implementation is the design;
 * two implementations of the pipeline would be a fork.
 *
 * The browser tools are deliberately absent rather than stubbed. They are backed
 * by `WebContentsView`, which needs a window, so registering them here would mean
 * shipping a tool that exists and always fails.
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { AgentTask } from '../../src/shared/types'
import { AgentRuntime } from '../../src/main/services/agent/core'
import { buildPipeline } from '../../src/main/services/agent/stages'
import type { StageContext } from '../../src/main/services/agent/pipeline-types'
import { chanSystemPrompt, planSystemPrompt } from '../../src/main/services/agent/prompts'
import { formatExecutionLog, heartbeatLine } from '../../src/main/services/agent/execution'
import type { FinalVerdict } from '../../src/main/services/agent/evidence'
import { describeExecution, runAgentLoop } from '../../src/main/services/agent/loop'

import { ToolRegistry } from '../../src/main/services/tools/registry'
import { ToolRuntime } from '../../src/main/services/tools/runtime'
import { buildCommandTools } from '../../src/main/services/tools/builtin/command'
import { buildEnvironmentTools } from '../../src/main/services/tools/builtin/environment'
import { buildFilesystemTools } from '../../src/main/services/tools/builtin/filesystem'

import {
  ApprovalQueue,
  PermissionPolicy,
  DEFAULT_PERMISSION_RULES
} from '../../src/main/services/permissions/policy'
import { EnvironmentManager } from '../../src/main/services/env/manager'
import { TerminalSessionManager } from '../../src/main/services/terminal/sessions'
import { ProcessSupervisor } from '../../src/main/services/proc/supervisor'
import { FileService } from '../../src/main/services/fs/files'
import { SkillRegistry, DEFAULT_SKILL_ROOTS } from '../../src/main/services/skills/registry'
import { ModelGateway, PROVIDER_CREDENTIAL_SLOTS } from '../../src/main/services/models/gateway'
import type { ModelConfig } from '../../src/main/services/models/gateway'
import { detectProject } from '../../src/main/services/project/detect'
import {
  ensureProjectWorkspace,
  resolveHistoryPaths,
  type HistoryLocation
} from '../../src/main/services/project/workspace'
import { MirroredConversation } from '../../src/main/services/agent/mirrored-conversation'
import type { ProjectProfile } from '../../src/shared/types'

import type { ApprovalMode } from './args'

export interface HostEvents {
  /** A pipeline timeline entry, already rendered to text by the caller. */
  note(message: string, status: 'ok' | 'error' | 'pending' | 'info', stage: string): void
  /** A stage began. Printed so a long silence is never ambiguous. */
  stageStart(stage: string): void
  /** The agent spoke. */
  say(text: string): void
}

export interface HostOptions {
  cwd: string
  approval: ApprovalMode
  events: HostEvents
  /** Called when a gated operation needs a decision. */
  authorize: (title: string, detail: string) => Promise<boolean>
  env: NodeJS.ProcessEnv
}

export interface RunResult {
  verdict: FinalVerdict
  reason: string | null
  answer: string | null
  task: AgentTask
  durationMs: number
  /** Turns now on disk for this project. */
  history: number
}

/**
 * Where the CLI keeps its state.
 *
 * Separate from the desktop app's userDataDir on purpose: a CLI run and a GUI
 * session writing the same conversation file would interleave read-modify-write
 * on `JsonStore`, and the loser's turn would vanish.
 */
export function resolveStateDir(env: NodeJS.ProcessEnv): string {
  const configured = env.CRYPTORIC_HOME
  if (configured && configured.trim().length > 0) return resolve(configured.trim())
  return join(homedir(), '.cryptoric')
}

/** Model configuration from the environment, or null when nothing is configured. */
export function resolveModelConfig(
  env: NodeJS.ProcessEnv,
  overrides: { provider: string | null; endpoint: string | null; model: string | null }
): ModelConfig | null {
  const provider = (overrides.provider ?? env.CRYPTORIC_PROVIDER ?? 'openrouter') as ModelConfig['provider']
  const key = env.CRYPTORIC_API_KEY ?? null
  const endpoint = overrides.endpoint ?? env.CRYPTORIC_ENDPOINT ?? null
  const model = overrides.model ?? env.CRYPTORIC_MODEL ?? null

  // No key means no provider. Saying "configured" here would let a stage
  // believe it can call the model, and every call would fail at the far end
  // with an opaque 401 instead of the true reason.
  if (!key) return null
  if (!endpoint || !model) return null

  return {
    provider,
    endpoint,
    model,
    credentialKey: PROVIDER_CREDENTIAL_SLOTS[provider] ?? 'model-api-key',
    dailyBudgetCoins: Number(env.CRYPTORIC_DAILY_BUDGET_COINS ?? '25')
  }
}

/**
 * Where history is written, from the environment.
 *
 * An unrecognised value falls back to `both` rather than throwing: a typo in a
 * variable should not stop the CLI from starting, and `both` is the setting
 * that loses the least.
 */
export function readHistoryLocation(env: NodeJS.ProcessEnv): HistoryLocation {
  const raw = env.CRYPTORIC_HISTORY_LOCATION
  if (raw === 'app' || raw === 'project' || raw === 'both') return raw
  return 'both'
}

/** First string that is not empty after trimming. */
function firstNonEmpty(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  return null
}

/**
 * The authoritative verdict for a finished task.
 *
 * `evidence.finalStatus` is what the verify and review stages wrote, so it is
 * preferred. It starts life as `IN_PROGRESS`, which is not a verdict, and a
 * task that ends without one must not read as COMPLETED — the fallback for a
 * non-terminal status is BLOCKED, because "it stopped without saying why" is a
 * blocked run, not a successful one.
 */
export function verdictFor(task: AgentTask): FinalVerdict {
  const recorded = task.evidence?.finalStatus
  if (
    recorded === 'COMPLETED' ||
    recorded === 'FAILED' ||
    recorded === 'BLOCKED' ||
    recorded === 'PARTIAL' ||
    recorded === 'CANCELLED'
  ) {
    return recorded
  }

  switch (task.status) {
    case 'COMPLETED':
      return 'COMPLETED'
    case 'FAILED':
      return 'FAILED'
    case 'CANCELLED':
    case 'CANCELLING':
    case 'PAUSED':
      return 'CANCELLED'
    case 'BLOCKED':
      return 'BLOCKED'
    default:
      return 'BLOCKED'
  }
}

export class CliHost {
  private readonly tools: ToolRegistry
  private readonly gateway: ModelGateway | null
  private readonly conversation: MirroredConversation
  private project: ProjectProfile | null
  private lastAnswer: string | null = null
  /** Attached after construction: the runtime's deps close over this host. */
  private agent: AgentRuntime | null = null

  private constructor(init: {
    tools: ToolRegistry
    gateway: ModelGateway | null
    conversation: MirroredConversation
    project: ProjectProfile | null
  }) {
    this.tools = init.tools
    this.gateway = init.gateway
    this.conversation = init.conversation
    this.project = init.project
  }

  attachRuntime(agent: AgentRuntime): void {
    this.agent = agent
  }

  private requireAgent(): AgentRuntime {
    if (!this.agent) throw new Error('CLI host has no agent runtime attached.')
    return this.agent
  }

  static async create(options: HostOptions): Promise<CliHost> {
    const env = options.env
    const stateDir = resolveStateDir(env)
    mkdirSync(join(stateDir, 'tmp'), { recursive: true })

    const cwd = resolve(options.cwd)
    const project = await detectProject(cwd)

    const policy = new PermissionPolicy(DEFAULT_PERMISSION_RULES)
    const approvals = new ApprovalQueue()

    const authorize = async (title: string, detail: string): Promise<boolean> => {
      const request = approvals.request({
        toolId: 'cli.authorize',
        tier: 'ask',
        title,
        detail,
        risk: 'Requires explicit approval.'
      })
      const granted = await options.authorize(title, detail)
      approvals.resolve(request.id, granted)
      return granted
    }

    const environment = new EnvironmentManager({
      userDataDir: stateDir,
      managedRoot: join(stateDir, 'tools'),
      scratchDir: join(stateDir, 'tmp'),
      platform: process.platform
    })
    await environment.init()

    // Terminal output goes to stderr so a `--json` run can keep stdout clean.
    // Writing terminal bytes to stdout would corrupt piped machine output.
    const terminals = new TerminalSessionManager(environment, {
      onOutput: (_sessionId, chunk) => options.events.note(chunk.replace(/\s+$/, ''), 'info', 'terminal'),
      onExit: (sessionId, exitCode) => options.events.note(`terminal ${sessionId} exited ${exitCode}`, 'info', 'terminal'),
      onChange: () => undefined
    })

    const processes = new ProcessSupervisor(environment, {
      onChange: () => undefined,
      onOutput: (_processId, chunk) => options.events.note(chunk.replace(/\s+$/, ''), 'info', 'process')
    })

    const tools = new ToolRegistry()
    tools.registerAll(buildEnvironmentTools({ env: environment, terminals, processes, authorize }))
    // No `buildBrowserTools` call. See the note at the top of this file.

    const skills = new SkillRegistry()
    await skills.discover(DEFAULT_SKILL_ROOTS, cwd)

    const getRoots = (): string[] => [cwd]
    const files = new FileService(getRoots)
    // No `GitService` here: no tool builder takes one. Git in the desktop app is
    // reached through IPC for the status panel, and a CLI has no status panel.
    // Constructing it would be an unused object, not a capability.

    tools.registerAll(buildFilesystemTools({ files, policy, getRoots }))
    tools.registerAll(buildCommandTools({ env: environment, getRoots }))

    const runtime = new ToolRuntime({
      registry: tools,
      policy,
      approvals,
      onRecord: (record) =>
        options.events.note(
          formatExecutionLog(record.ok ? 'TOOL_OK' : 'TOOL_FAILED', `${record.toolId} (${record.durationMs}ms)`),
          record.ok ? 'info' : 'error',
          'tool'
        )
    })

    // Opening a folder creates `.cryptoricagent/` in it, exactly as the desktop
    // app does, so the two surfaces cannot disagree about where a project's
    // state lives or what its id is.
    const workspace = ensureProjectWorkspace(cwd, project?.name)
    const conversation = new MirroredConversation(
      resolveHistoryPaths(
        {
          appDir: stateDir,
          projectDir: workspace.dir,
          location: readHistoryLocation(env)
        },
        workspace.manifest.id
      ).writes
    )
    conversation.setProject(cwd)

    const config = resolveModelConfig(env, {
      provider: null,
      endpoint: null,
      model: null
    })
    const gateway = config
      ? new ModelGateway({
          config,
          // The desktop app reads an OS-encrypted keychain. A CLI has no
          // keychain and no business writing one, so the key comes from the
          // environment and is never persisted to disk by this process.
          getApiKey: () => env.CRYPTORIC_API_KEY ?? null,
          onUsage: () => undefined
        })
      : null

    const host = new CliHost({ tools, gateway, conversation, project })
    // The runtime needs a reference back to the host for `runModelPhase`, so it
    // is constructed after the host and handed in.
    const agent = new AgentRuntime(
      {
        tools,
        runtime,
        skills,
        skillTokenBudget: 6000,
        maxSkillsPerTask: 4,
        getProjectRoot: () => host.projectRoot,
        events: {
          timeline: (entry) => options.events.note(entry.message, entry.status, entry.stage),
          task: () => undefined,
          toolResult: () => undefined,
          say: (text) => {
            host.lastAnswer = text
            options.events.say(text)
          }
        }
      },
      buildPipeline({
        tools: {
          call: (toolId, args) =>
            tools.get(toolId)?.execute(args as never, {
              projectRoot: cwd,
              taskEnv: null,
              signal: new AbortController().signal,
              note: () => undefined,
              taskId: null,
              grantedTier: 'safe',
              recordArtifact: () => ({}) as never
            }) ?? Promise.resolve({ ok: false, summary: 'Unknown tool', error: `No tool registered with id "${toolId}".` }),
          hasTool: (toolId) => tools.has(toolId)
        },
        getProject: () => host.project,
        probeRuntime: async (toolId) => {
          const state = await environment.probeTool(toolId)
          return { state: state.state, version: state.version, detail: state.detail }
        },
        model: gateway?.isEnabled() ? async (ctx, phase) => host.runModelPhase(ctx, phase) : undefined
      })
    )

    ;(host as unknown as { attachRuntime(a: AgentRuntime): void }).attachRuntime(agent)
    return host
  }

  private get projectRoot(): string {
    return this.project?.root ?? process.cwd()
  }

  /** Ids of every tool this CLI can actually call. */
  toolIds(): string[] {
    return this.tools
      .list()
      .map((t) => t.id)
      .sort()
  }

  /** Is a model provider reachable from this environment? */
  get modelName(): string | null {
    const config = this.gateway?.getConfig()
    return config ? `${config.provider}/${config.model}` : null
  }

  get hasModel(): boolean {
    return this.gateway?.isEnabled() ?? false
  }

  async run(task: string, signal: AbortSignal): Promise<RunResult> {
    const started = Date.now()

    // Scoped to the project and recorded before anything runs. Without this a
    // CLI session with no model provider wrote an empty conversation file, so
    // "the history is still there after a restart" was true only for runs that
    // reached the model. The task text belongs in the history regardless of
    // which stages it managed to reach.
    this.conversation.setProject(this.projectRoot)
    this.conversation.appendUser(task)

    const created = this.requireAgent().submit({
      title: task.length > 72 ? `${task.slice(0, 69)}…` : task,
      prompt: task,
      role: 'IMPLEMENTER',
      projectRoot: this.projectRoot
    })

    // `submit` returns immediately and pumps in the background, which is right
    // for a UI and wrong for a CLI: the process would exit before the work ran.
    // So the CLI waits on the task rather than assuming completion.
    const finished = await this.waitFor(created.id, signal)

    // A verdict with no reason is half an answer. The pipeline does report one —
    // it goes out as a stage note and as the agent's closing line — but neither
    // path always reaches `evidence.reason`, so `--json` was handing scripts a
    // BLOCKED with `reason: null`. Every source is consulted before giving up.
    const reason =
      firstNonEmpty(finished.evidence?.reason, finished.error, this.lastAnswer)

    // The outcome is recorded too, so the history reads as a conversation
    // rather than a list of unanswered questions.
    const verdict = verdictFor(finished)
    this.conversation.appendAssistant(
      firstNonEmpty(this.lastAnswer, reason) ?? `${verdict}: no response was produced.`
    )
    // Durable before the process can exit. `cryptoric run` returns straight
    // after this, and the store writes on a queued promise, so skipping the
    // flush would race the exit and occasionally lose the last turn.
    await this.conversation.flush()

    return {
      verdict,
      reason,
      answer: this.lastAnswer,
      history: this.conversation.all().length,
      task: finished,
      durationMs: Date.now() - started
    }
  }

  private async waitFor(id: string, signal: AbortSignal): Promise<AgentTask> {
    return new Promise<AgentTask>((resolvePromise, rejectPromise) => {
      const poll = (): void => {
        const task = this.requireAgent().getTask(id)
        if (!task) {
          rejectPromise(new Error(`Task ${id} disappeared from the runtime.`))
          return
        }
        if (signal.aborted) {
          this.requireAgent().stop(id)
          resolvePromise(task)
          return
        }
        if (
          task.status === 'COMPLETED' ||
          task.status === 'FAILED' ||
          task.status === 'CANCELLED' ||
          task.status === 'BLOCKED'
        ) {
          resolvePromise(task)
          return
        }
        setTimeout(poll, 40)
      }
      poll()
    })
  }

  /** Cooperative stop. The runtime checks its signal before every tool call. */
  stop(id: string): void {
    this.requireAgent().stop(id)
  }

  /**
   * The model-driven half of the pipeline.
   *
   * Structurally the same two-phase split the desktop app uses: plan writes,
   * implement acts. Sharing it here is the point — a CLI whose agent behaved
   * differently from the GUI agent would be a second product, not a second
   * surface.
   */
  private async runModelPhase(
    ctx: StageContext,
    phase: 'plan' | 'implement'
  ): Promise<{
    ok: boolean
    text: string
    error: string | null
    tools: string[]
    toolCalls: number
    failedToolCalls: number
    modelCalls: number
  }> {
    if (!this.gateway) {
      return { ok: false, text: '', error: 'No model provider configured.', tools: [], toolCalls: 0, failedToolCalls: 0, modelCalls: 0 }
    }

    const history = this.conversation.contextMessages()

    if (phase === 'plan') {
      const result = await this.gateway.complete({
        messages: [
          { role: 'system', content: planSystemPrompt() },
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: ctx.task.prompt }
        ],
        maxTokens: 700,
        signal: ctx.signal
      })
      if (!result.ok) {
        ctx.note(formatExecutionLog('PLAN_FAILED', result.error ?? 'unknown error'), 'error')
        return { ok: false, text: '', error: result.error, tools: [], toolCalls: 0, failedToolCalls: 0, modelCalls: 1 }
      }
      const text = result.text.trim()
      return {
        ok: true,
        text: text || 'No plan produced.',
        error: null,
        tools: [],
        toolCalls: 0,
        failedToolCalls: 0,
        modelCalls: 1
      }
    }

    const outcome = await runAgentLoop(
      {
        complete: (request) => this.gateway!.complete(request),
        listTools: () => this.tools.list(),
        invoke: (toolId, args) => this.requireAgent().invoke(ctx.task, toolId, args, ctx.signal, 'elevated'),
        note: (message, status) => ctx.note(message, status ?? 'info'),
        record: (role, text, tool, ok) => this.conversation.append({ role, text, tool, ok }),
        heartbeat: (beat) => ctx.note(formatExecutionLog('HEARTBEAT', heartbeatLine(beat)), 'info')
      },
      {
        systemPrompt: chanSystemPrompt(ctx.task.projectRoot),
        history,
        prompt: ctx.task.prompt,
        signal: ctx.signal
      }
    )

    for (const line of describeExecution(outcome)) {
      ctx.note(line, line.includes('FAILED') || line.includes('TIMEOUT') ? 'error' : 'info')
    }

    const failedToolCalls = outcome.toolRecords.filter((r) => r.status !== 'COMPLETED').length
    return {
      ok: outcome.ok,
      text: outcome.text,
      error: outcome.error,
      tools: outcome.called,
      toolCalls: outcome.toolRecords.length,
      failedToolCalls,
      modelCalls: outcome.calls.length
    }
  }
}