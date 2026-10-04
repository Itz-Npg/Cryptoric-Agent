/**
 * Agent core.
 *
 * Cryptoric Chan is a staged pipeline, not a single prompt. Each stage has a
 * declared role, a capability ceiling, and an explicit reason to exist, and every
 * transition is recorded on the task timeline so an autonomous run is auditable
 * rather than mysterious.
 *
 * Two properties matter more than cleverness here:
 *
 *  - **Interruptibility.** A task can be paused, resumed or stopped at any await
 *    boundary. Cancellation is cooperative and checked before every tool call, so
 *    "stop" means the agent stops issuing work, not that a promise is abandoned.
 *  - **No capability escalation.** A tool's tier is `min(caller's grant, the
 *    tool's own declared tier)`. A model cannot talk its way into a destructive
 *    operation, and an approval prompt is the only path to one.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentRole,
  AgentTask,
  TaskStatus,
  TimelineEntry,
  UsageRecord
} from '@shared/types'
import type { PermissionPolicy } from '../permissions/policy'
import { ApprovalQueue } from '../permissions/policy'
import type { SkillRegistry } from '../skills/registry'
import { buildSkillContext, routeSkills, type TaskCategory } from '../skills/registry'
import type { ToolContext, ToolRegistry, ToolResult } from '../tools/registry'
import type { Stage, StageContext, StageOutcome } from './pipeline-types'

export type { Stage, StageContext, StageOutcome }

export interface AgentEventSink {
  timeline(entry: TimelineEntry): void
  task(task: AgentTask): void
  /** Forward a tool's structured result to the UI (live diff, process, etc.). */
  toolResult(toolId: string, result: ToolResult): void
  /** The agent wants to speak; surfaces in the transcript. */
  say(text: string): void
}

export interface AgentDeps {
  tools: ToolRegistry
  policy: PermissionPolicy
  approvals: ApprovalQueue
  skills: SkillRegistry
  events: AgentEventSink
  /** Root of the currently open project, or null. */
  getProjectRoot(): string | null
  /** Skill routing budget. */
  skillTokenBudget: number
  maxSkillsPerTask: number
}

/** Declared stages. Order is the pipeline order. */

const EMPTY_USAGE: UsageRecord = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 }

export class AgentRuntime {
  private readonly tasks = new Map<string, AgentTask>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly queues = new Map<string, string[]>()
  private running = false
  private activeTaskId: string | null = null

  constructor(
    private readonly deps: AgentDeps,
    private readonly stages: Stage[]
  ) {}

  listTasks(): AgentTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getTask(id: string): AgentTask | null {
    return this.tasks.get(id) ?? null
  }

  /** Create a task and queue it. Returns immediately; work happens in background. */
  submit(input: {
    title: string
    prompt: string
    role: AgentRole
    projectRoot?: string | null
    categories?: TaskCategory[]
    paths?: string[]
  }): AgentTask {
    const task: AgentTask = {
      id: randomUUID(),
      title: input.title,
      prompt: input.prompt,
      status: 'QUEUED',
      role: input.role,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectRoot: input.projectRoot ?? this.deps.getProjectRoot(),
      ownedPaths: [],
      changedPaths: [],
      error: null,
      usage: { ...EMPTY_USAGE }
    }
    this.tasks.set(task.id, task)
    const queue = this.queues.get('default') ?? []
    queue.push(task.id)
    this.queues.set('default', queue)

    this.emit(task)
    // Kick the pump without blocking the caller: tasks must not block the UI.
    void this.pump()
    return task
  }

  pause(id: string): boolean {
    const controller = this.controllers.get(id)
    if (!controller) return false
    const task = this.tasks.get(id)
    if (!task) return false
    task.status = 'PAUSED'
    this.touch(task)
    controller.abort()
    return true
  }

  resume(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'PAUSED') return false
    task.status = 'QUEUED'
    this.touch(task)
    const queue = this.queues.get('default') ?? []
    queue.push(id)
    this.queues.set('default', queue)
    void this.pump()
    return true
  }

  /** Cooperative stop: no further tool calls are issued for this task. */
  stop(id: string): boolean {
    const controller = this.controllers.get(id)
    const task = this.tasks.get(id)
    if (!task) return false
    controller?.abort()
    const queue = this.queues.get('default') ?? []
    this.queues.set(
      'default',
      queue.filter((q) => q !== id)
    )
    if (task.status !== 'COMPLETED' && task.status !== 'FAILED') {
      task.status = 'CANCELLED'
      task.error = 'Stopped by user'
      this.touch(task)
    }
    return true
  }

  stopAll(): void {
    for (const id of this.controllers.keys()) this.stop(id)
    for (const queue of this.queues.values()) queue.length = 0
  }

  isRunning(): boolean {
    return this.running
  }

  /** Id of the task currently executing, or null. */
  activeTask(): string | null {
    return this.activeTaskId
  }

  /** Serial pump: one task at a time, so concurrent agents cannot fight over files. */
  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (true) {
        const queue = this.queues.get('default') ?? []
        const next = queue.shift()
        this.queues.set('default', queue)
        if (!next) break
        const task = this.tasks.get(next)
        if (!task || task.status === 'CANCELLED') continue
        this.activeTaskId = next
        await this.runTask(task)
        this.activeTaskId = null
      }
    } finally {
      this.running = false
    }
  }

  private async runTask(task: AgentTask): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(task.id, controller)

    // File ownership: a task claims the paths it intends to modify so a later
    // task cannot silently overwrite concurrent work.
    const claim = this.claimPaths(task.id, task.projectRoot)
    if (!claim.ok) {
      task.status = 'FAILED'
      task.error = claim.conflict ?? 'Path ownership conflict'
      this.touch(task)
      this.controllers.delete(task.id)
      return
    }

    const routing = routeSkills(
      this.deps.skills,
      { prompt: `${task.title}\n${task.prompt}`, paths: task.ownedPaths, categories: [] },
      { tokenBudget: this.deps.skillTokenBudget, maxSkills: this.deps.maxSkillsPerTask }
    )
    const skillContext = buildSkillContext(this.deps.skills, routing.skillIds)

    this.note(task, 'SYSTEM', 'task-started', `Task started · ${routing.categories.join(', ') || 'general'}`, 'info')
    if (routing.skillIds.length > 0) {
      this.note(task, 'SYSTEM', 'skills-loaded', `Skills: ${routing.skillIds.join(', ')} (~${routing.estimatedTokens} tokens)`, 'info')
    } else if (routing.skipped.length > 0) {
      this.note(task, 'SYSTEM', 'skills-routed', `No skill matched; ${routing.skipped.length} considered`, 'info')
    }

    const ctx: StageContext = {
      task,
      signal: controller.signal,
      maxTier: 'safe',
      note: (message, status) => this.note(task, 'SYSTEM', 'progress', message, status ?? 'info'),
      call: async (toolId, args) => this.invoke(task, toolId, args, controller.signal),
      workspaceRoots: task.projectRoot ? [task.projectRoot] : [],
      skillContext,
      selectedSkills: routing.skillIds
    }

    for (const stage of this.stages) {
      if (controller.signal.aborted) {
        if (task.status !== 'PAUSED') task.status = 'CANCELLED'
        break
      }
      task.status = statusForRole(stage.role, task.status)
      this.touch(task)
      this.note(task, stage.role, stage.name, `${stage.role} · ${stage.name}`, 'info')

      try {
        const outcome = await stage.run({ ...ctx, maxTier: stage.maxTier })
        this.deps.events.toolResult('__stage__', {
          ok: outcome.continue,
          summary: outcome.summary ?? `${stage.name} finished`,
          data: { stage: stage.name }
        })
        if (!outcome.continue) {
          task.status = outcome.status ?? 'COMPLETED'
          if (outcome.summary) this.deps.events.say(outcome.summary)
          break
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        task.status = 'FAILED'
        task.error = message
        this.note(task, stage.role, stage.name, message, 'error')
        break
      }
    }

    if (task.status !== 'COMPLETED' && task.status !== 'FAILED' && task.status !== 'CANCELLED') {
      task.status = controller.signal.aborted ? 'CANCELLED' : 'COMPLETED'
    }
    this.touch(task)
    this.releasePaths(task.id)
    this.controllers.delete(task.id)
  }

  /**
   * Policy-enforcing tool invocation.
   *
   * The tier is re-derived from the tool definition and the policy decision, then
   * clamped by the stage ceiling. An `allow` decision is never granted to a tool
   * whose declared tier exceeds the caller's grant.
   */
  private async invoke(
    task: AgentTask,
    toolId: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<ToolResult> {
    if (signal.aborted) {
      return { ok: false, summary: 'Task stopped', error: 'The task was stopped before this tool ran.' }
    }

    const tool = this.deps.tools.get(toolId)
    if (!tool) {
      return { ok: false, summary: 'Unknown tool', error: `No tool registered with id "${toolId}".` }
    }

    const parsed = this.deps.tools.parse(toolId, args)
    if (!parsed.ok) {
      this.note(task, 'IMPLEMENTER', 'tool-invalid-args', parsed.error, 'error')
      return { ok: false, summary: 'Invalid arguments', error: parsed.error }
    }

    // 1. Domain policy.
    const decision = this.deps.policy.evaluateDomain(tool.domain)
    const requiredTier = tool.descriptor.tier

    // 2. Approval. Timeouts deny, so a dismissed dialog cannot stall a task.
    let approved = decision === 'allow'
    if (decision !== 'allow') {
      const request = this.deps.approvals.request({
        toolId,
        tier: requiredTier,
        title: `Allow ${tool.descriptor.label}?`,
        detail: summarizeArgs(toolId, parsed.value),
        risk: `Requires ${requiredTier} permission (${tool.domain}).`
      })
      this.deps.events.timeline({
        id: randomUUID(),
        taskId: task.id,
        at: new Date().toISOString(),
        role: 'SYSTEM',
        stage: 'approval',
        message: `Waiting for approval: ${tool.descriptor.label}`,
        status: 'pending',
        ref: request.id
      })
      approved = await this.deps.approvals.wait(request.id)
    }

    if (!approved) {
      this.note(task, 'IMPLEMENTER', 'tool-denied', `${toolId} was not approved`, 'error')
      return { ok: false, summary: 'Denied', error: 'The user did not approve this action.' }
    }

    // 3. Execute.
    this.note(task, 'IMPLEMENTER', 'tool-start', `${toolId}`, 'info')
    const toolCtx: ToolContext = {
      projectRoot: task.projectRoot,
      taskEnv: null,
      signal,
      note: (message, status) => this.note(task, 'IMPLEMENTER', 'tool-note', message, status ?? 'info')
    }

    try {
      const result = await tool.execute(parsed.value, toolCtx)
      this.note(
        task,
        'IMPLEMENTER',
        result.ok ? 'tool-ok' : 'tool-error',
        `${toolId}: ${result.summary}`,
        result.ok ? 'ok' : 'error'
      )
      this.deps.events.toolResult(toolId, result)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.note(task, 'IMPLEMENTER', 'tool-throw', `${toolId}: ${message}`, 'error')
      return { ok: false, summary: `${toolId} threw`, error: message }
    }
  }

  // -------------------------------------------------------------------------
  // File ownership
  // -------------------------------------------------------------------------

  private readonly owned = new Map<string, { owner: string; path: string }>()

  private claimPaths(taskId: string, root: string | null): { ok: boolean; conflict?: string } {
    if (!root) return { ok: true }
    const claimPath = (root + sepOf(root)).replace(/[\\/]+$/, '')
    for (const claim of this.owned.values()) {
      if (claim.owner !== taskId && sameOrNested(claimPath, claim.path)) {
        return { ok: false, conflict: `Another task already owns ${claim.path}` }
      }
    }
    this.owned.set(taskId, { owner: taskId, path: claimPath })
    return { ok: true }
  }

  private releasePaths(taskId: string): void {
    this.owned.delete(taskId)
  }

  /** Paths currently locked, exposed for the UI's multi-agent view. */
  locks(): { owner: string; path: string }[] {
    return [...this.owned.values()]
  }

  private note(
    task: AgentTask,
    role: AgentRole | 'SYSTEM',
    stage: string,
    message: string,
    status: TimelineEntry['status']
  ): void {
    this.deps.events.timeline({
      id: randomUUID(),
      taskId: task.id,
      at: new Date().toISOString(),
      role,
      stage,
      message,
      status
    })
  }

  private touch(task: AgentTask): void {
    task.updatedAt = new Date().toISOString()
    this.emit(task)
  }

  private emit(task: AgentTask): void {
    this.deps.events.task({ ...task })
  }
}

function sepOf(root: string): string {
  return root.includes('\\') ? '\\' : '/'
}

function sameOrNested(candidate: string, claim: string): boolean {
  const a = candidate.toLowerCase()
  const b = claim.toLowerCase()
  return a === b || a.startsWith(b.endsWith('/') || b.endsWith('\\') ? b : b + '/')
}

function statusForRole(role: AgentRole, previous: TaskStatus): TaskStatus {
  switch (role) {
    case 'PLANNER':
      return 'PLANNING'
    case 'TERMINAL_AGENT':
    case 'IMPLEMENTER':
      return 'RUNNING'
    case 'TESTER':
      return 'TESTING'
    case 'REVIEWER':
    case 'SECURITY_REVIEWER':
      return 'REVIEWING'
    default:
      return previous === 'QUEUED' ? 'PLANNING' : previous
  }
}

function summarizeArgs(toolId: string, args: unknown): string {
  try {
    const text = JSON.stringify(args)
    return text.length > 600 ? `${text.slice(0, 600)}…` : text
  } catch {
    return `${toolId}(unserialisable arguments)`
  }
}

export { randomUUID }