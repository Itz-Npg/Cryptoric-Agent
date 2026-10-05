/**
 * Terminal rendering.
 *
 * Pure functions from data to text, so the wording can be asserted in tests
 * without spawning a process. `index.ts` is the only place that writes.
 *
 * Two rules shape the output:
 *
 *  - Colour is decoration, never information. Every state that colour carries
 *    is also carried by a word (`ok`, `error`, `WARN`), because the output is
 *    read in pipes and CI logs where colour is stripped or meaningless.
 *  - Stage changes are visible without a TTY, because a CLI that goes quiet
 *    for two minutes is indistinguishable from one that has hung.
 */

import type { AgentTask, TimelineEntry } from '../../src/shared/types'
import type { FinalVerdict } from '../../src/main/services/agent/evidence'

export interface RenderOptions {
  /** Emit ANSI colour. Off by default so piped output stays clean. */
  color: boolean
}

const ANSI = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  green: '[32m',
  red: '[31m',
  yellow: '[33m',
  cyan: '[36m'
} as const

function paint(text: string, code: string, options: RenderOptions): string {
  return options.color ? `${code}${text}${ANSI.reset}` : text
}

const STATUS_WORD: Record<TimelineEntry['status'], string> = {
  ok: 'ok',
  error: 'ERROR',
  pending: '...',
  info: 'info'
}

const STATUS_COLOR: Record<TimelineEntry['status'], string> = {
  ok: ANSI.green,
  error: ANSI.red,
  pending: ANSI.yellow,
  info: ANSI.cyan
}

/** `HH:MM:SS` from an ISO timestamp. Local time, because that is what a person reads. */
export function clockOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** One timeline entry as a single line. */
export function renderTimelineEntry(entry: TimelineEntry, options: RenderOptions): string {
  const time = paint(clockOf(entry.at), ANSI.dim, options)
  const stage = entry.stage ? paint(entry.stage.padEnd(11).slice(0, 11), ANSI.bold, options) : ' '.repeat(11)
  const status = paint(STATUS_WORD[entry.status].padEnd(5), STATUS_COLOR[entry.status], options)
  return `${time} ${stage} ${status} ${entry.message}`
}

export interface SummaryInput {
  task: AgentTask
  verdict: FinalVerdict
  /** One line the agent produced, or null when it produced none. */
  answer: string | null
  /** Why the verdict, in the pipeline's own words. */
  reason: string | null
  changedPaths: string[]
  usage: AgentTask['usage']
  durationMs: number
}

const VERDICT_WORD: Record<FinalVerdict, string> = {
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  PARTIAL: 'PARTIAL',
  CANCELLED: 'CANCELLED'
}

function verdictColor(verdict: FinalVerdict): string {
  if (verdict === 'COMPLETED') return ANSI.green
  if (verdict === 'FAILED') return ANSI.red
  if (verdict === 'CANCELLED') return ANSI.yellow
  return ANSI.yellow
}

/** The end-of-run block. */
export function renderSummary(input: SummaryInput, options: RenderOptions): string {
  const lines: string[] = []
  const word = paint(VERDICT_WORD[input.verdict], verdictColor(input.verdict), options)

  lines.push('')
  lines.push(`${paint('verdict', ANSI.bold, options)}  ${word}`)

  if (input.reason) lines.push(`reason   ${input.reason}`)
  if (input.answer) lines.push(`answer   ${input.answer}`)

  // An empty change list under COMPLETED is the exact combination that let a
  // no-op report as done, so it is called out rather than left to be inferred.
  if (input.changedPaths.length === 0) {
    lines.push(paint('changes  none — no files were written', ANSI.yellow, options))
  } else {
    lines.push(`changes  ${input.changedPaths.length} file(s)`)
    for (const path of input.changedPaths.slice(0, 20)) lines.push(`         ${path}`)
    if (input.changedPaths.length > 20) {
      lines.push(paint(`         … and ${input.changedPaths.length - 20} more`, ANSI.dim, options))
    }
  }

  const u = input.usage
  lines.push(
    `usage    in ${u.inputTokens} / out ${u.outputTokens} tokens` +
      (u.cachedTokens > 0 ? ` (${u.cachedTokens} cached)` : '') +
      (u.estimatedCostUsd > 0 ? ` · $${u.estimatedCostUsd.toFixed(4)}` : '')
  )
  lines.push(`elapsed  ${(input.durationMs / 1000).toFixed(1)}s`)

  return lines.join('\n')
}

/** Progress line printed when a stage begins, so silence is never ambiguous. */
export function renderStageStart(stage: string, options: RenderOptions): string {
  return paint(`▸ ${stage}`, ANSI.dim, options)
}

/** Header printed before the pipeline starts. */
export function renderHeader(projectRoot: string, model: string | null, options: RenderOptions): string {
  const root = paint(projectRoot, ANSI.bold, options)
  const modelLine = model
    ? `\n${paint('model', ANSI.bold, options)}   ${model}`
    : `\n${paint('model', ANSI.bold, options)}   ${paint('none configured — deterministic stages only', ANSI.yellow, options)}`
  return `${root}${modelLine}`
}

/** The warning shown when gated work is auto-approved. Printed every time. */
export function renderApprovalWarning(options: RenderOptions): string {
  return paint('warning: --yes pre-approves gated operations, including destructive ones.', ANSI.yellow, options)
}