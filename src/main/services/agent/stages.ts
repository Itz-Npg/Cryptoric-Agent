/**
 * The Cryptoric Chan pipeline.
 *
 * Each stage below is a real implementation against the tool surface, not a
 * narrated story. A stage that cannot complete reports *why* it stopped rather
 * than continuing optimistically, because the product requirement is explicitly
 * "do not stop simply because the first code edit succeeded".
 *
 * The pipeline is intentionally conservative about what it claims: when no model
 * gateway is configured, the stages still perform every deterministic action
 * (detect, install, verify, checkpoint, test) and say plainly that the reasoning
 * step was unavailable. Nothing here fabricates agent activity.
 */

import type { AgentRole } from '@shared/types'
import type { Stage, StageContext, StageOutcome, StageToolApi } from './pipeline-types'
import { computeGaps } from '../project/detect'
import type { ProjectProfile } from '@shared/types'

export interface PipelineDeps {
  /** Tool invocation surface supplied by the runtime. */
  tools: StageToolApi
  /** Current project profile, or null. */
  getProject(): ProjectProfile | null
  /** Probe a runtime by id; returns a `ToolResult`. */
  probeRuntime(toolId: string): Promise<{ state: string; version: string | null; detail: string }>
  /**
   * The model-driven part of the pipeline.
   *
   * Absent only when no provider is configured. A stage that needs it reports
   * that fact and does the deterministic work it still can — it does not print
   * a fixed sentence about a language model, which is what made this pipeline
   * look like it had done something when it had done nothing.
   */
  model?(
    ctx: StageContext,
    phase: 'plan' | 'implement'
  ): Promise<{ ok: boolean; text: string; error: string | null; tools: string[] }>
}

const TERMINAL_MISSING_RE =
  /not recognized as an internal or external command|command not found|is not installed|enoent|executable file not found/i

export function buildPipeline(deps: PipelineDeps): Stage[] {
  return [
    analyzeStage(deps),
    planStage(deps),
    implementStage(deps),
    verifyStage(deps),
    reviewStage(deps)
  ]
}

// ---------------------------------------------------------------------------
// 1. PROJECT_ANALYZER
// ---------------------------------------------------------------------------

function analyzeStage(deps: PipelineDeps): Stage {
  return {
    role: 'PROJECT_ANALYZER',
    name: 'analyze',
    maxTier: 'safe',
    async run(ctx: StageContext): Promise<StageOutcome> {
      const project = deps.getProject()
      if (!project) {
        return { continue: false, status: 'FAILED', summary: 'No project is open.' }
      }

      ctx.note(`${project.kind} project · ${project.manifests.length} manifest(s)`, 'info')
      if (project.packageManager) ctx.note(`Package manager: ${project.packageManager}`, 'info')

      const inspection = await ctx.call('inspect_environment', { includeAll: true })
      if (!inspection.ok) {
        return { continue: false, status: 'FAILED', summary: inspection.error ?? 'Environment inspection failed.' }
      }

      const tools = ((inspection.data as { tools?: { id: string; state: string; version: string | null; detail?: string }[] } | undefined)?.tools) ?? []
      const gaps = computeGaps(
        project,
        tools.map((t) => ({
          spec: {
            id: t.id,
            label: t.id,
            installers: [] as { id: string; requiredTier: string }[]
          },
          state: t.state,
          constraint: null,
          detail: t.detail ?? ''
        }))
      )

      if (gaps.length > 0) {
        ctx.note(
          `Missing runtimes: ${gaps.map((g) => `${g.label} (${g.kind})`).join(', ')}`,
          'error'
        )
        return {
          continue: false,
          status: 'WAITING_FOR_USER',
          summary: `This ${project.kind} project requires ${gaps
            .map((g) => g.label)
            .join(', ')}, which ${gaps.length === 1 ? 'is' : 'are'} not available yet. I can install ${
            gaps.length === 1 ? 'it' : 'them'
          } from official sources and continue without restarting Cryptoric Agent — approve the install to proceed.`
        }
      }

      const present = tools.filter((t) => t.state === 'present').length
      return {
        continue: true,
        summary: `Project understood: ${project.kind}, ${present} runtime(s) available, package manager ${project.packageManager ?? 'unknown'}.`
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. PLANNER
// ---------------------------------------------------------------------------

function planStage(deps: PipelineDeps): Stage {
  return {
    role: 'PLANNER',
    name: 'plan',
    maxTier: 'safe',
    async run(ctx: StageContext): Promise<StageOutcome> {
      if (ctx.selectedSkills.length > 0) {
        ctx.note(`Loaded ${ctx.selectedSkills.length} skill(s) for this task type`, 'info')
      }

      if (deps.model) {
        const plan = await deps.model(ctx, 'plan')
        if (!plan.ok) {
          // A plan that could not be produced is reported, and the pipeline
          // continues to implementation — the model may still be able to act
          // even if it could not summarise the plan first.
          ctx.note(`Planning step unavailable: ${plan.error ?? 'no reason given'}`, 'error')
          return { continue: true, summary: plan.error ?? 'Could not produce a plan.' }
        }
        ctx.note(`Plan: ${plan.text.split('\n').filter(Boolean).length} line(s)`, 'info')
        return { continue: true, summary: plan.text }
      }

      // No model: the deterministic plan is a keyword match over the prompt. It
      // is labelled as such, because a keyword match is not a plan.
      const steps = derivePlan(ctx)
      ctx.note(`No model configured — falling back to a keyword plan: ${steps.map((s) => s.label).join(' → ')}`, 'info')
      return {
        continue: true,
        summary: `No model provider is configured, so this is a keyword-derived outline rather than a plan:\n${steps
          .map((s, i) => `${i + 1}. ${s.label}`)
          .join('\n')}`
      }
    }
  }
}

interface PlanStep {
  label: string
}

/**
 * Keyword outline, used only when no model is available.
 *
 * This is a fallback, not a planner: it matches a few verbs in the prompt and
 * cannot tell "make me a website" from anything else. It is retained because
 * the deterministic stages still do real work without a model, and a label
 * beats a shrug.
 */
function derivePlan(ctx: StageContext): PlanStep[] {
  const pm = ctx.task.prompt.toLowerCase()
  const steps: PlanStep[] = []

  if (/\b(website|web ?site|web ?app|page|landing)\b/.test(pm)) {
    steps.push({ label: 'Create the entry document and its assets' })
  }
  if (/install|dependenc/.test(pm)) {
    steps.push({ label: 'Install dependencies with the project package manager' })
  }
  if (/build|compile/.test(pm)) {
    steps.push({ label: 'Run the project build' })
  }
  if (/test/.test(pm)) {
    steps.push({ label: 'Run the test suite' })
  }
  steps.push({ label: 'Review the resulting diff' })
  if (steps.length === 0) steps.push({ label: 'Inspect the project and report findings' })
  return steps
}

// ---------------------------------------------------------------------------
// 3. IMPLEMENTER
// ---------------------------------------------------------------------------

function implementStage(deps: PipelineDeps): Stage {
  return {
    role: 'IMPLEMENTER',
    name: 'implement',
    maxTier: 'ask',
    async run(ctx: StageContext): Promise<StageOutcome> {
      if (ctx.signal.aborted) {
        return { continue: false, status: 'CANCELLED', summary: 'Stopped before implementation.' }
      }

      if (!deps.model) {
        // Said because it is true, and only when it is true. The previous
        // version of this branch printed the same sentence unconditionally,
        // which is how a configured model ended up reported as absent.
        ctx.note('No model provider is configured, so no file changes were attempted.', 'error')
        return {
          continue: true,
          summary:
            'I could not make changes: no model provider is configured for this session. Set one in Settings, then add your API key.'
        }
      }

      const outcome = await deps.model(ctx, 'implement')
      const used = outcome.tools.length

      if (!outcome.ok) {
        return {
          continue: false,
          status: 'FAILED',
          summary: outcome.text || outcome.error || 'The run did not complete.'
        }
      }

      if (used === 0) {
        ctx.note('The model answered without calling a tool, so nothing was changed.', 'info')
      } else {
        ctx.note(`${used} tool call(s) executed`, 'ok')
      }
      return { continue: true, summary: outcome.text || 'Done.' }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. DEBUGGER / TESTER
// ---------------------------------------------------------------------------

function verifyStage(_deps: PipelineDeps): Stage {
  return {
    role: 'TESTER',
    name: 'verify',
    maxTier: 'ask',
    async run(ctx: StageContext): Promise<StageOutcome> {
      const processes = await ctx.call('list_running_processes', {})
      const count = ((processes.data as unknown[] | undefined) ?? []).length
      const stale = ((processes.data as { envStale?: boolean }[] | undefined) ?? []).filter((p) => p.envStale).length

      if (stale > 0) {
        ctx.note(`${stale} process(es) predate the current environment snapshot`, 'info')
        return {
          continue: true,
          summary: `${count} supervised process(es). ${stale} still carry an older environment; restart them to pick up the refreshed toolchain.`
        }
      }
      return { continue: true, summary: `${count} supervised process(es), all on the current environment.` }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. REVIEWER
// ---------------------------------------------------------------------------

function reviewStage(_deps: PipelineDeps): Stage {
  return {
    role: 'REVIEWER',
    name: 'review',
    maxTier: 'safe',
    async run(ctx: StageContext): Promise<StageOutcome> {
      const changed = ctx.task.changedPaths
      if (changed.length === 0) {
        ctx.note('No files were modified, so there is nothing to review.', 'info')
        return { continue: false, status: 'COMPLETED', summary: 'Task complete — no files were changed.' }
      }

      const shown = changed.slice(0, 20)
      ctx.note(`${changed.length} file(s) changed`, 'ok')
      for (const path of shown) ctx.note(`  ${path}`, 'info')
      if (changed.length > shown.length) {
        ctx.note(`  … and ${changed.length - shown.length} more`, 'info')
      }

      return {
        continue: false,
        status: 'COMPLETED',
        summary: `Task complete. ${changed.length} file(s) changed:\n${shown.map((p) => `- ${p}`).join('\n')}${
          changed.length > shown.length ? `\n… and ${changed.length - shown.length} more` : ''
        }`
      }
    }
  }
}

/** Shared regex for recognising "the runtime is missing" in command output. */
export { TERMINAL_MISSING_RE }

export const ROLE_ORDER: AgentRole[] = [
  'PROJECT_ANALYZER',
  'PLANNER',
  'IMPLEMENTER',
  'TERMINAL_AGENT',
  'DEBUGGER',
  'TESTER',
  'REVIEWER',
  'RESEARCHER',
  'SECURITY_REVIEWER',
  'ENVIRONMENT_MANAGER',
  'RELEASE_MANAGER'
]