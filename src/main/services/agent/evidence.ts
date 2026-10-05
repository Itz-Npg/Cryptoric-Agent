/**
 * Execution evidence.
 *
 * The defect this module exists to prevent: an agent that changes nothing
 * reports **"Task complete — no files were changed."** and the pipeline marks
 * every stage green.
 *
 * That was not a display bug. `implementStage` returned `continue: true` when the
 * model answered in prose instead of calling a tool, and again when no provider
 * was configured at all. The pipeline then walked through verification and review
 * — stages that have nothing to verify and nothing to review — and finished
 * `COMPLETED`. Every tick was earned by a stage that ran, and not one of them
 * checked whether the *task* had been done.
 *
 * So the rule here is narrow and blunt: **a phase completing proves the phase
 * ran, never that the work happened.** Only observed change proves work happened.
 *
 * Everything in this file is pure. That is not tidiness — the line deciding
 * whether a task succeeded is the line that was wrong, and it has to be
 * reachable by a test.
 */

/** What the user is asking for, which decides whether change is required. */
export type TaskIntent =
  | 'READ_ONLY'
  | 'ANALYSIS_ONLY'
  | 'IMPLEMENTATION'
  | 'DEBUGGING'
  | 'REFACTOR'
  | 'TESTING'
  | 'RESEARCH'
  | 'CONFIGURATION'
  | 'MIXED'

/** Intents where doing nothing can be a perfectly correct answer. */
const NON_MUTATING: readonly TaskIntent[] = ['READ_ONLY', 'ANALYSIS_ONLY', 'RESEARCH']

/**
 * Whether an intent obliges the agent to change the project.
 *
 * This is the gate the pipeline was missing. A question can be answered without
 * touching a file; "add a hero section" cannot.
 */
export function requiresMutation(intent: TaskIntent): boolean {
  return !NON_MUTATING.includes(intent)
}

/** Words that mean "look, don't touch". */
const READ_VERBS =
  /\b(what|why|how does|how do|explain|describe|summar(?:ise|ize)|review|analyz|analys|inspect|audit|find|where is|list|show|report|compare|diagnos\w*|investigate)\b/

/** Words that mean "change the project". */
const MUTATION_VERBS =
  /\b(build|create|make|add|implement|write|scaffold|generate|set up|setup|bootstrap|remove|delete|rename|move|update|upgrade|install|configure|fix|debug|repair|refactor|restructure|clean up|extract|port|migrate|bump|patch|edit|initiali[sz]e)\b/

/** Words that mean "change the tests". */
const TEST_VERBS = /\b(test|tests|testing|spec|specs|coverage|assertions?)\b/

/**
 * Classify a request.
 *
 * Deliberately conservative and keyword-based. A wrong guess here has a real
 * cost in both directions — calling a read-only question an implementation task
 * would demand edits the user never wanted — so the ordering matters: an
 * explicit mutation verb wins over a generic reading verb, and a request with
 * both is MIXED rather than silently collapsed.
 */
export function classifyIntent(prompt: string): TaskIntent {
  const p = prompt.toLowerCase()

  const mutating = MUTATION_VERBS.test(p)
  const reading = READ_VERBS.test(p)
  const testing = TEST_VERBS.test(p)

  if (mutating && reading) return 'MIXED'
  if (mutating) {
    if (/\b(fix|debug|repair|broken|error|crash|failing|regression)\b/.test(p)) return 'DEBUGGING'
    if (/\brefactor|restructure|clean up|extract|simplif\w+|reorganis|reorganiz/.test(p)) return 'REFACTOR'
    if (/\b(configure|configuration|settings|env|environment variable|dependency|dependencies|package)\b/.test(p)) {
      return 'CONFIGURATION'
    }
    if (testing) return 'TESTING'
    return 'IMPLEMENTATION'
  }

  if (testing && /\badd|write|create|cover\b/.test(p)) return 'TESTING'
  if (/\b(research|investigate|explore|evaluate|survey|compare options|alternatives)\b/.test(p)) return 'RESEARCH'
  if (reading) return /\b(explain|why|summar\w+|describe|compare)\b/.test(p) ? 'ANALYSIS_ONLY' : 'READ_ONLY'

  // No verb at all. Treating silence as read-only is the safe direction: it
  // means the agent asks rather than editing a project nobody asked it to edit.
  return 'READ_ONLY'
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** Path (relative, POSIX-ish) to content hash. */
export type FileSnapshot = Readonly<Record<string, string>>

export interface SnapshotDiff {
  created: string[]
  modified: string[]
  deleted: string[]
}

export interface SnapshotComparison extends SnapshotDiff {
  /** Everything that differs, in one list. */
  changed: string[]
  /** True when nothing at all differs. */
  isEmpty: boolean
}

/**
 * Compare two snapshots.
 *
 * Content hashes rather than timestamps: an agent that rewrites a file with
 * identical bytes has changed nothing, and reporting it as a modification would
 * let the agent manufacture evidence for itself by touching a file.
 */
export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): SnapshotComparison {
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const [path, hash] of Object.entries(after)) {
    if (!(path in before)) created.push(path)
    else if (before[path] !== hash) modified.push(path)
  }
  for (const path of Object.keys(before)) {
    if (!(path in after)) deleted.push(path)
  }

  created.sort()
  modified.sort()
  deleted.sort()

  return {
    created,
    modified,
    deleted,
    changed: [...created, ...modified, ...deleted].sort(),
    isEmpty: created.length === 0 && modified.length === 0 && deleted.length === 0
  }
}

// ---------------------------------------------------------------------------
// Why nothing changed
// ---------------------------------------------------------------------------

/**
 * Why an implementation task produced no change.
 *
 * Reported instead of the truth being papered over. "Task complete" when
 * nothing happened is the single worst answer this agent can give, because the
 * user has no way to tell it apart from success.
 */
export type NoChangeReason =
  | 'TASK_MISUNDERSTOOD'
  | 'REQUIRES_CLARIFICATION'
  | 'IMPLEMENTATION_TOOLS_FAILED'
  | 'PROJECT_READ_ONLY'
  | 'CHANGES_ALREADY_PRESENT'
  | 'NO_CHANGES_REQUIRED'

export interface NoChangeVerdict {
  reason: NoChangeReason
  /** The sentence shown to the user. Names the reason; never claims success. */
  message: string
}

/**
 * Phrases that assert work without evidence.
 *
 * "I've implemented the feature" in prose is a claim, not a result. Detecting it
 * lets the engine keep going instead of accepting narration as completion.
 */
const UNBACKED_CLAIM =
  /\b(here('s| is) what i('d| would) implement|i've implemented|i have implemented|now implemented|changes (are )?(made|applied)|i (have )?(finished|completed) (the )?(implementation|work))\b/i

export function looksLikeUnbackedClaim(text: string): boolean {
  return UNBACKED_CLAIM.test(text)
}

/** A question the agent cannot answer without the user. */
const NEEDS_CLARIFICATION =
  /\b(which|what|how|where|should i|do you want|which one|clarify|ambiguous)\b.*\?|\?\s*$/i

/**
 * Decide why an implementation task changed nothing.
 *
 * The order is the diagnosis, cheapest and most likely first.
 */
export function explainNoChange(input: {
  modelText: string
  toolCalls: number
  failedToolCalls: number
  filesAlreadyPresent: string[]
  projectWritable: boolean
}): NoChangeVerdict {
  const { modelText, toolCalls, failedToolCalls, filesAlreadyPresent, projectWritable } = input

  if (!projectWritable) {
    return {
      reason: 'PROJECT_READ_ONLY',
      message:
        'The project could not be written to. Nothing was changed and the task is not complete — ' +
        'check the folder permissions or whether it is read-only.'
    }
  }

  if (failedToolCalls > 0 && toolCalls > 0) {
    return {
      reason: 'IMPLEMENTATION_TOOLS_FAILED',
      message:
        `Every attempt to change the project failed (${failedToolCalls} of ${toolCalls} tool call(s) errored). ` +
        'The errors are on the execution timeline; nothing was written.'
    }
  }

  if (toolCalls === 0) {
    const asked = NEEDS_CLARIFICATION.test(modelText)
    return {
      reason: asked ? 'REQUIRES_CLARIFICATION' : 'TASK_MISUNDERSTOOD',
      message: asked
        ? `I did not change anything because the request is ambiguous: "${firstLine(modelText)}". ` +
          'Tell me which file or behaviour you want changed and I will do it.'
        : `I did not change anything. I answered in prose without using a file or command tool, ` +
          `which does not implement the request. The request was: "${firstLine(modelText)}".`
    }
  }

  if (filesAlreadyPresent.length > 0) {
    return {
      reason: 'CHANGES_ALREADY_PRESENT',
      message:
        `Nothing changed because the work is already present: ${filesAlreadyPresent.slice(0, 5).join(', ')} ` +
        'already matches what was asked for. I did not rewrite them.'
    }
  }

  return {
    reason: 'NO_CHANGES_REQUIRED',
    message:
      'No files changed. I ran the tools but they made no net modification, so I am not reporting this as done.'
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

// ---------------------------------------------------------------------------
// Final status
// ---------------------------------------------------------------------------

export type FinalVerdict = 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'PARTIAL' | 'CANCELLED'

export interface FinalStatusInput {
  intent: TaskIntent
  cancelled: boolean
  /** The model run itself failed (timeout, provider error, loop limit). */
  modelSucceeded: boolean
  /** Real observed change: snapshot diff, or a tool the runtime vouches for. */
  mutationObserved: boolean
  toolCalls: number
  failedToolCalls: number
  /** A check that applies to this project was actually executed. */
  verificationRan: boolean
  /** Null when nothing applied — NOT_APPLICABLE, which is not a pass. */
  verificationPassed: boolean | null
  modelText: string
  filesAlreadyPresent: string[]
  projectWritable: boolean
}

export interface FinalStatus {
  status: FinalVerdict
  reason: string
  /** True only when change was demanded and actually observed. */
  evidence: boolean
}

/**
 * The rule that COMPLETED now means what it says.
 *
 * `COMPLETED` is allowed when the requested work actually happened, or when the
 * task was correctly determined to need no changes — and in no other case. A
 * model producing a confident final answer is not one of those reasons; that was
 * the original defect.
 */
export function judgeFinalStatus(input: FinalStatusInput): FinalStatus {
  const {
    intent,
    cancelled,
    modelSucceeded,
    mutationObserved,
    toolCalls,
    failedToolCalls,
    verificationRan,
    verificationPassed,
    modelText,
    filesAlreadyPresent,
    projectWritable
  } = input

  if (cancelled) {
    return { status: 'CANCELLED', reason: 'The task was stopped before it finished.', evidence: false }
  }

  if (!modelSucceeded) {
    return { status: 'FAILED', reason: 'The model run did not complete.', evidence: false }
  }

  const needsMutation = requiresMutation(intent)

  if (needsMutation && !mutationObserved) {
    const verdict = explainNoChange({
      modelText,
      toolCalls,
      failedToolCalls,
      filesAlreadyPresent,
      projectWritable
    })
    // BLOCKED, never COMPLETED. The work is unfinished and the user has to act.
    return { status: 'BLOCKED', reason: verdict.message, evidence: false }
  }

  if (verificationPassed === false) {
    return { status: 'FAILED', reason: 'Verification ran and did not pass.', evidence: mutationObserved }
  }

  if (intent === 'TESTING' && !verificationRan) {
    return {
      status: 'PARTIAL',
      reason: 'A testing task finished without any check being executed, so nothing is verified.',
      evidence: mutationObserved
    }
  }

  if (!needsMutation) {
    return {
      status: 'COMPLETED',
      reason: 'Answered from inspection; this request did not ask for a change.',
      evidence: true
    }
  }

  return {
    status: 'COMPLETED',
    reason: mutationObserved
      ? 'The requested change was made and verified against the project.'
      : 'Completed.',
    evidence: true
  }
}

// ---------------------------------------------------------------------------
// Phase timing
// ---------------------------------------------------------------------------

/**
 * Re-exported from `shared/` so the rule lives in one place while both the
 * engine and the renderer can reach it — `tsconfig.web.json` does not include
 * `src/main/**`.
 */
export { NOT_RUN, formatDuration, phaseDuration } from '@shared/execution-display'