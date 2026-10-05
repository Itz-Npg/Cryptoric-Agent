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
import {
  classifyIntent,
  diffSnapshots,
  explainNoChange,
  looksLikeUnbackedClaim,
  requiresMutation,
  type TaskIntent
} from './evidence'
import { isProjectWritable, takeSnapshot } from './snapshot'

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
  ): Promise<{
    ok: boolean
    text: string
    error: string | null
    tools: string[]
    /** Tools actually executed, as opposed to tools merely mentioned. */
    toolCalls: number
    failedToolCalls: number
    modelCalls: number
  }>
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

      const intent = classifyIntent(ctx.task.prompt)
      const needsChange = requiresMutation(intent)
      const root = ctx.task.projectRoot ?? deps.getProject()?.root ?? null

      ctx.note(`request classified as ${intent}`, 'info')

      if (!deps.model) {
        // Said because it is true, and only when it is true. The previous
        // version of this branch printed the same sentence unconditionally,
        // which is how a configured model ended up reported as absent.
        ctx.note('No model provider is configured, so no file changes were attempted.', 'error')
        // BLOCKED, not `continue: true`. Returning true here let the pipeline
        // walk on through verification and review and finish with a green tick
        // and "Task complete" for a run that never had a model at all.
        return {
          continue: false,
          status: 'BLOCKED',
          summary:
            'Blocked: no model provider is configured, so nothing was implemented. ' +
            'Set one in Settings and add your API key, then ask again. ' +
            'Nothing in this project was changed.'
        }
      }

      const before = root ? takeSnapshot(root) : { files: {}, truncated: 0, unreadable: true }

      const outcome = await deps.model(ctx, 'implement')

      const after = root ? takeSnapshot(root) : { files: {}, truncated: 0, unreadable: true }
      const diff = diffSnapshots(before.files, after.files)

      recordEvidence(ctx, intent, before.files, after.files, diff, {
        toolCalls: outcome.toolCalls,
        failedToolCalls: outcome.failedToolCalls,
        modelCalls: outcome.modelCalls
      })

      const observed = !diff.isEmpty
      if (observed) {
        ctx.note(
          `${diff.changed.length} file(s) changed on disk: ${diff.changed.slice(0, 5).join(', ')}` +
            (diff.changed.length > 5 ? ` … +${diff.changed.length - 5} more` : ''),
          'ok'
        )
      } else {
        ctx.note('No file on disk changed during this stage.', 'error')
      }

      if (!outcome.ok) {
        return {
          continue: false,
          status: 'FAILED',
          summary: outcome.text || outcome.error || 'The run did not complete.'
        }
      }

      // An unbacked claim is a signal to keep going, not a result.
      if (observed && looksLikeUnbackedClaim(outcome.text) && outcome.toolCalls === 0) {
        ctx.note('The answer described work without a tool call behind it; treating it as unproven.', 'error')
      }

      if (needsChange && !observed) {
        const verdict = explainNoChange({
          modelText: outcome.text,
          toolCalls: outcome.toolCalls,
          failedToolCalls: outcome.failedToolCalls,
          filesAlreadyPresent: [],
          projectWritable: root ? isProjectWritable(root) : false
        })
        return {
          continue: false,
          status: 'BLOCKED',
          summary: `Blocked — nothing was implemented. ${verdict.message}`
        }
      }

      if (outcome.toolCalls > 0) {
        ctx.note(`${outcome.toolCalls} tool call(s) executed`, 'ok')
      }

      return {
        continue: true,
        summary: observed
          ? `Implemented: ${diff.changed.length} file(s) changed.${outcome.text ? `\n\n${outcome.text}` : ''}`
          : outcome.text || 'No change was required.'
      }
    }
  }
}

/** Fold what was observed into the task's evidence record. */
function recordEvidence(
  ctx: StageContext,
  classification: string,
  before: Record<string, string>,
  after: Record<string, string>,
  diff: { created: string[]; modified: string[]; deleted: string[]; changed: string[] },
  counts: { toolCalls: number; failedToolCalls: number; modelCalls: number }
): void {
  const previous = ctx.task.evidence
  const testsExecuted = previous?.testsExecuted ?? []
  const created = diff.created
  const modified = diff.modified
  const deleted = diff.deleted

  // Union with anything a prior stage recorded, so `testsExecuted` survives.
  const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])].sort()

  ctx.task.evidence = {
    classification,
    filesBefore: Object.keys(before).length,
    filesAfter: Object.keys(after).length,
    createdFiles: union(previous?.createdFiles ?? [], created),
    modifiedFiles: union(previous?.modifiedFiles ?? [], modified),
    deletedFiles: union(previous?.deletedFiles ?? [], deleted),
    changedFiles: union(previous?.changedFiles ?? [], diff.changed),
    toolCalls: (previous?.toolCalls ?? 0) + counts.toolCalls,
    failedToolCalls: (previous?.failedToolCalls ?? 0) + counts.failedToolCalls,
    modelCalls: (previous?.modelCalls ?? 0) + counts.modelCalls,
    testsExecuted,
    finalStatus: previous?.finalStatus ?? 'IN_PROGRESS',
    reason: previous?.reason ?? ''
  }

  // The review stage reads `changedPaths`; keep it aligned with what was actually
  // observed rather than with what a tool claimed.
  for (const path of diff.changed) {
    if (!ctx.task.changedPaths.includes(path)) ctx.task.changedPaths.push(path)
  }
}

// ---------------------------------------------------------------------------
// 4. VERIFIER
// ---------------------------------------------------------------------------

/**
 * Checks that are worth running for a JavaScript project, in the order that
 * fails fastest and cheapest.
 *
 * Each entry names the manifest script it wants. A script the project does not
 * declare is skipped and reported as skipped — not silently treated as a pass.
 * That distinction is the whole reason this stage exists.
 */
const JS_CHECKS: { script: string; label: string; argv: (pm: string) => { command: string; args: string[] } }[] = [
  {
    script: 'typecheck',
    label: 'typecheck',
    argv: (pm) => ({ command: pm, args: ['run', 'typecheck'] })
  },
  { script: 'lint', label: 'lint', argv: (pm) => ({ command: pm, args: ['run', 'lint'] }) },
  { script: 'test', label: 'test', argv: (pm) => ({ command: pm, args: ['test'] }) },
  { script: 'build', label: 'build', argv: (pm) => ({ command: pm, args: ['run', 'build'] }) }
]

interface CheckResult {
  label: string
  /** `pass` | `fail` | `skip` | `error`. Never anything else. */
  outcome: 'pass' | 'fail' | 'skip' | 'error'
  detail: string
}

/**
 * Run the project's own checks and report what actually happened.
 *
 * The previous version of this stage called `list_running_processes` and
 * returned "N supervised process(es)", which the UI rendered as **"Ran tests and
 * verified"**. Nothing was run and nothing was verified. That is the specific
 * failure the product requirement forbids: a stage that marks itself complete
 * without performing the work it names.
 *
 * Every result here is derived from a real `run_command` exit code. A check the
 * project does not define reports `skip` and says so; a check that errors
 * reports the error. Neither is reported as a pass.
 */
function verifyStage(deps: PipelineDeps): Stage {
  return {
    role: 'TESTER',
    name: 'verify',
    maxTier: 'ask',
    async run(ctx: StageContext): Promise<StageOutcome> {
      const project = deps.getProject()
      if (!project) {
        return { continue: false, status: 'FAILED', summary: 'No project is open, so there is nothing to verify.' }
      }

      const pm = project.packageManager ?? 'npm'
      const declared = project.scripts ?? {}
      const results: CheckResult[] = []
      const executed: string[] = []

      // A check that actually ran is evidence. A check that was skipped is not,
      // and must not be able to become one by accident.
      const markExecuted = (label: string): void => {
        executed.push(label)
        if (!ctx.task.evidence) {
          ctx.task.evidence = {
            classification: classifyIntent(ctx.task.prompt),
            filesBefore: 0,
            filesAfter: 0,
            createdFiles: [],
            modifiedFiles: [],
            deletedFiles: [],
            changedFiles: [...ctx.task.changedPaths],
            toolCalls: 0,
            failedToolCalls: 0,
            modelCalls: 0,
            testsExecuted: [],
            finalStatus: 'IN_PROGRESS',
            reason: ''
          }
        }
        ctx.task.evidence.testsExecuted = [...new Set(executed)].sort()
      }

      for (const check of JS_CHECKS) {
        if (ctx.signal.aborted) {
          return { continue: false, status: 'CANCELLED', summary: 'Stopped during verification.' }
        }

        if (!declared[check.script]) {
          results.push({
            label: check.label,
            outcome: 'skip',
            detail: `the project declares no "${check.script}" script`
          })
          ctx.note(`skipped ${check.label} — the project declares no "${check.script}" script`, 'info')
          continue
        }

        const { command, args } = check.argv(pm)
        ctx.note(`running ${pm} ${args.join(' ')}`, 'info')
        markExecuted(check.label)

        const run = await ctx.call('run_command', { command, args, cwd: project.root })
        const code = exitCodeOf(run)
        const tail = tailOf(run, 400)

        if (!run.ok) {
          results.push({ label: check.label, outcome: 'error', detail: run.error ?? run.summary })
          ctx.note(`${check.label} could not run: ${run.error ?? run.summary}`, 'error')
          continue
        }
        if (code === 0) {
          results.push({ label: check.label, outcome: 'pass', detail: 'exit 0' })
          ctx.note(`${check.label} passed`, 'ok')
          continue
        }

        results.push({ label: check.label, outcome: 'fail', detail: `exit ${code}${tail ? ` — ${tail}` : ''}` })
        ctx.note(`${check.label} FAILED (exit ${code})`, 'error')
      }

      const passed = results.filter((r) => r.outcome === 'pass')
      const failed = results.filter((r) => r.outcome === 'fail' || r.outcome === 'error')
      const skipped = results.filter((r) => r.outcome === 'skip')

      // Browser verification is reported as not applicable unless browser tools
      // exist. There are none in this build, so claiming a visual pass would be
      // the exact fabrication this stage is meant to stop.
      const browserApplicable = false
      const browserNote = browserApplicable
        ? 'Browser checks ran.'
        : 'Browser verification not run — no browser tools are registered in this build.'
      ctx.note(browserNote, 'info')

      const lines = [
        ...results.map(
          (r) =>
            `- ${r.label}: ${r.outcome === 'pass' ? 'passed' : r.outcome === 'skip' ? 'SKIPPED' : 'FAILED'} (${r.detail})`
        ),
        `- browser: NOT RUN — ${browserNote.replace('Browser verification ', '')}`
      ]

      // "No checks applied" is its own outcome and is reported as such. It is
      // NOT_APPLICABLE, which is not a pass and must not read like one.
      if (results.length === 0 || results.every((r) => r.outcome === 'skip')) {
        ctx.note('NO_TEST_SUITE_FOUND — this project declares none of the known checks.', 'info')
        return {
          continue: true,
          summary:
            `Verification: NO_TEST_SUITE_FOUND — ${results.map((r) => r.label).join(', ') || 'no known checks'} ` +
            'are not defined by this project, so nothing was executed. This is not a pass.'
        }
      }

      if (ctx.task.evidence) {
        ctx.task.evidence.finalStatus = failed.length > 0 ? 'FAILED' : 'COMPLETED'
      }

      if (failed.length > 0) {
        // A failing check is a real outcome. The task ends here rather than
        // continuing to a review that would report success.
        return {
          continue: false,
          status: 'FAILED',
          summary:
            `Verification failed — ${failed.length} of ${results.length} checks did not pass ` +
            `(${passed.length} passed, ${skipped.length} skipped):\n${lines.join('\n')}`
        }
      }

      return {
        continue: true,
        summary:
          `Verification: ${passed.length} passed, ${skipped.length} skipped, 0 failed.\n${lines.join('\n')}`
      }
    }
  }
}

/** Exit code out of a tool result, or null when the tool did not report one. */
function exitCodeOf(result: { data?: unknown; summary?: string; ok: boolean }): number | null {
  const data = result.data as { exitCode?: unknown; code?: unknown } | undefined
  const raw = data?.exitCode ?? data?.code
  if (typeof raw === 'number') return raw
  const m = /exit(?: code)?\s+(\d+)/i.exec(result.summary ?? '')
  return m ? Number(m[1]) : null
}

/** Last few lines of command output, for a failure report. */
function tailOf(result: { data?: unknown; summary?: string }, max: number): string {
  const data = result.data as { stdout?: unknown; stderr?: unknown } | undefined
  const text = `${data?.stdout ?? ''}\n${data?.stderr ?? ''}`.trim()
  if (!text) return result.summary ?? ''
  return text.length > max ? `…${text.slice(-max)}` : text
}

// ---------------------------------------------------------------------------
// 5. REVIEWER
// ---------------------------------------------------------------------------
// 5. REVIEWER
// ---------------------------------------------------------------------------

function reviewStage(_deps: PipelineDeps): Stage {
  return {
    role: 'REVIEWER',
    name: 'review',
    maxTier: 'safe',
    async run(ctx: StageContext): Promise<StageOutcome> {
      const evidence = ctx.task.evidence
      const changed = evidence?.changedFiles ?? ctx.task.changedPaths
      const intent = (evidence?.classification as TaskIntent | undefined) ?? classifyIntent(ctx.task.prompt)
      const needsChange = requiresMutation(intent)

      if (changed.length === 0) {
        // The old line here was `status: 'COMPLETED', summary: 'Task complete —
        // no files were changed.'` A stage that reviews nothing completing
        // successfully is how a no-op run reported as a finished task.
        if (!needsChange) {
          ctx.note('Nothing changed, and this request did not ask for a change.', 'info')
          return {
            continue: false,
            status: 'COMPLETED',
            summary:
              'Answered from inspection of the project. This request did not ask for a change, ' +
              'so nothing was modified.'
          }
        }
        ctx.note('Nothing was changed, so there is nothing to review.', 'error')
        return {
          continue: false,
          status: 'BLOCKED',
          summary:
            'Blocked — this was an implementation request and no file changed. ' +
            'The task is not complete.'
        }
      }

      const shown = changed.slice(0, 20)
      ctx.note(`${changed.length} file(s) changed`, 'ok')
      for (const path of shown) ctx.note(`  ${path}`, 'info')
      if (changed.length > shown.length) {
        ctx.note(`  … and ${changed.length - shown.length} more`, 'info')
      }

      if (evidence) {
        evidence.finalStatus = 'COMPLETED'
        evidence.reason = `${changed.length} file(s) changed and reviewed.`
      }

      const created = evidence?.createdFiles ?? []
      const deleted = evidence?.deletedFiles ?? []

      return {
        continue: false,
        status: 'COMPLETED',
        summary:
          `Task complete. ${changed.length} file(s) changed` +
          `${created.length ? ` (${created.length} created)` : ''}` +
          `${deleted.length ? `, ${deleted.length} deleted` : ''}:\n` +
          `${shown.map((p) => `- ${p}`).join('\n')}` +
          `${changed.length > shown.length ? `\n… and ${changed.length - shown.length} more` : ''}`
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