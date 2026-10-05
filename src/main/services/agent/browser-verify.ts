/**
 * Deciding whether — and how — to verify a task in a real browser.
 *
 * This module exists because of a specific false statement. The verify stage
 * used to hard-code `const browserApplicable = false` and report:
 *
 *     browser: NOT RUN — no browser tools are registered in this build
 *
 * That was untrue. `buildBrowserTools` registers 43 browser tools and
 * `src/main/index.ts` wires them into the registry, so the build *had* browser
 * capability and the stage claimed it did not. A stage that lies about its own
 * capabilities is the same defect as a stage that lies about its own results,
 * and this project has already shipped both.
 *
 * Two rules govern everything here:
 *
 *   1. **Absence of evidence is never evidence of absence.** Every outcome below
 *      distinguishes "the browser was not needed" from "the browser was
 *      unavailable" from "the browser ran and found problems". Only the third is
 *      a failure, and only real output produces a pass.
 *   2. **No result may be inferred.** A missing field is `unknown`, which is not
 *      zero errors. Reading `undefined` as "no console errors" is precisely how
 *      a broken page gets reported as a clean one.
 *
 * Pure: no imports, no I/O. Everything here is a function of its arguments,
 * which is what makes it testable without Electron.
 */

/**
 * The smallest set of tools that proves a build can drive a browser.
 *
 * Deliberately minimal. Checking all 43 would mean the report says "not
 * available" whenever one unrelated tool is renamed, and the whole point is to
 * answer "can this build open a page and read what happened on it".
 */
export const BROWSER_PROBE_TOOLS: readonly string[] = Object.freeze([
  'browser_create_tab',
  'browser_console_logs',
  'browser_network_failures'
])

/** A single observation pulled out of a browser tool result. */
export interface BrowserObservation {
  /** Count of console errors. `null` when the field was not reported. */
  consoleErrors: number | null
  /** Count of failed network requests. `null` when the field was not reported. */
  networkFailures: number | null
  /** URLs that failed, for the failure message. */
  failureUrls: string[]
}

/**
 * Whether browser verification is possible at all.
 *
 * The `reason` is written to be pasted into a user-facing timeline, so it names
 * what is missing rather than gesturing at a category.
 */
export interface BrowserAvailability {
  available: boolean
  missing: string[]
  reason: string
}

/**
 * Work out whether the registered tools can drive a browser.
 *
 * Takes a predicate rather than the registry so this stays pure and so the same
 * question can be asked of any collection of tools.
 *
 * @param hasTool `(id) => boolean`
 * @returns availability with a reason that is always safe to show a user
 */
export function browserAvailability(hasTool: (id: string) => boolean): BrowserAvailability {
  const missing = BROWSER_PROBE_TOOLS.filter((id) => !hasTool(id))
  if (missing.length === 0) {
    return {
      available: true,
      missing: [],
      reason: `${BROWSER_PROBE_TOOLS.length} browser tools are registered in this build`
    }
  }
  return {
    available: false,
    missing,
    reason:
      `browser tools are unavailable in this build — missing ${missing.join(', ')}. ` +
      'This build cannot drive a browser; it is not a statement about the change.'
  }
}

/** Extensions a browser renders whatever directory they live in. */
const ALWAYS_WEB_EXTENSIONS: readonly string[] = Object.freeze([
  '.html',
  '.htm',
  '.css',
  '.jsx',
  '.tsx',
  '.vue',
  '.svelte'
])

/**
 * Extensions that are web code only sometimes.
 *
 * `.ts` and `.js` cut both ways: a React component is exactly what a browser
 * renders, and `src/main/index.ts` is the main process. Treating every `.ts`
 * as a web file sends the verify stage to open a browser for a Node change,
 * which costs seconds and produces a meaningless green line.
 */
const AMBIGUOUS_WEB_EXTENSIONS: readonly string[] = Object.freeze(['.ts', '.js', '.mjs', '.cjs'])

/**
 * Path fragments that mark a source file as running outside the browser.
 *
 * Matched against a slash-normalised, lowercased path. `src/main/` is the
 * decisive one for Electron projects, where a browser has no business being
 * involved in a main-process change at all.
 */
const NON_WEB_PATH_MARKERS: readonly string[] = Object.freeze([
  'src/main/',
  'src/server/',
  'src/preload/',
  '/server/',
  '/api/',
  '/scripts/',
  '/electron/',
  '/node_modules/',
  'vite.config.',
  'webpack.config.',
  'electron-builder.'
])

/**
 * Does this task plausibly need a browser to verify?
 *
 * A CSS-only change and a README edit do not. Loading a real page for those
 * would burn seconds to prove nothing and would put a meaningless "browser
 * passed" line in the timeline, which is its own kind of noise.
 *
 * `promptHint` is a secondary signal: a task that says "check it renders" is
 * asking for a browser even when the changed-path list is empty, and honouring
 * that is better than silently skipping what the user explicitly requested.
 *
 * @param changedPaths absolute paths the task actually changed
 * @param promptHint the user's prompt; matched case-insensitively
 */
export function isBrowserRelevant(changedPaths: readonly string[], promptHint = ''): boolean {
  if (changedPaths.some(isWebFile)) return true
  const hint = promptHint.toLowerCase()
  return BROWSER_RENDER_HINTS.some((needle) => hint.includes(needle))
}

/** Would a browser render this file? */
function isWebFile(filePath: string): boolean {
  const extension = extensionOf(filePath)
  if (ALWAYS_WEB_EXTENSIONS.includes(extension)) return true
  if (!AMBIGUOUS_WEB_EXTENSIONS.includes(extension)) return false
  const normalised = filePath.replace(/\\/g, '/').toLowerCase()
  return !NON_WEB_PATH_MARKERS.some((marker) => normalised.includes(marker))
}

/** Words that mean "look at this in a browser" when a user types them. */
const BROWSER_RENDER_HINTS: readonly string[] = Object.freeze([
  'in the browser',
  'render',
  'screenshot',
  'visual',
  'looks right',
  'looks wrong',
  'ui is',
  'css',
  'page loads',
  'loads in'
])

/**
 * Lowercased extension of a path, without depending on `node:path`.
 *
 * `node:path` is available in the main process, but this module is imported by
 * tests that must not need Node built-ins, and a path separator difference
 * between platforms is not worth a dependency for a `slice`.
 */
function extensionOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** Outcome vocabulary. `not_applicable` is deliberately distinct from `skip`. */
export type BrowserCheckOutcome = 'pass' | 'fail' | 'error' | 'skip' | 'not_applicable'

/** What the verify stage should report about the browser. */
export interface BrowserCheckResult {
  outcome: BrowserCheckOutcome
  /** One line, safe to show in a timeline and to put in a summary. */
  detail: string
  /** Set when the outcome is `not_applicable` or `skip`; explains what was and was not done. */
  reason?: string
}

/**
 * Pull console and network evidence out of raw tool payloads.
 *
 * Defensive on purpose. These are the shapes the browser tools currently
 * return, but a tool that changes its payload must not silently turn a real
 * failure into an empty count: an unrecognised shape yields `null`, which
 * `evaluateBrowserObservation` reports as unknown rather than as clean.
 *
 * @param consoleData payload of `browser_console_logs`
 * @param networkData payload of `browser_network_failures`
 */
export function readBrowserObservation(
  consoleData: unknown,
  networkData: unknown
): BrowserObservation {
  const consoleCounts = countsOf(consoleData)
  const networkCounts = countsOf(networkData)
  return {
    consoleErrors: consoleCounts,
    networkFailures: networkCounts,
    failureUrls: urlsOf(networkData)
  }
}

function countsOf(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  // `browser_network_failures` reports `total`; `browser_console_logs` reports
  // an explicit `errors` count alongside a `total` of all levels.
  const candidate = record.errors ?? record.total ?? record.count
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null
}

function urlsOf(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return []
  const failures = (data as Record<string, unknown>).failures
  if (!Array.isArray(failures)) return []
  return failures
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).url : null))
    .filter((url): url is string => typeof url === 'string')
}

/**
 * Turn observed diagnostics into an outcome.
 *
 * The important case is the last one: when the browser ran but reported nothing
 * this function understands, the answer is `error` with `unknown`. It is
 * emphatically **not** `pass`. A verification stage that cannot read its own
 * evidence must say so instead of waving the task through.
 *
 * @param availability from {@link browserAvailability}
 * @param relevant from {@link isBrowserRelevant}
 * @param observation what the browser reported, or null when it never ran
 */
export function evaluateBrowserObservation(
  availability: BrowserAvailability,
  relevant: boolean,
  observation: BrowserObservation | null
): BrowserCheckResult {
  if (!availability.available) {
    return { outcome: 'skip', detail: 'NOT RUN — ' + availability.reason, reason: availability.reason }
  }
  if (!relevant) {
    return {
      outcome: 'not_applicable',
      detail: 'NOT APPLICABLE — no web files changed and the task did not ask for a browser',
      reason: 'no web files changed and the task did not ask for a browser'
    }
  }
  if (observation === null) {
    return {
      outcome: 'error',
      detail: 'ERROR — the browser was applicable but no observation was collected',
      reason: 'the browser was applicable but no observation was collected'
    }
  }
  if (observation.consoleErrors === null || observation.networkFailures === null) {
    return {
      outcome: 'error',
      detail: 'ERROR — the browser ran but its report could not be read',
      reason: 'the browser ran but its report could not be read'
    }
  }

  const problems: string[] = []
  if (observation.consoleErrors > 0) problems.push(`${observation.consoleErrors} console error(s)`)
  if (observation.networkFailures > 0) {
    const detail = observation.failureUrls.length
      ? ` (${observation.failureUrls.slice(0, 3).join(', ')})`
      : ''
    problems.push(`${observation.networkFailures} failed request(s)${detail}`)
  }

  if (problems.length > 0) {
    return { outcome: 'fail', detail: `FAILED — ${problems.join('; ')}` }
  }
  return {
    outcome: 'pass',
    detail: 'PASSED — page loaded with no console errors and no failed requests'
  }
}

/** Canonical label per outcome, used in the timeline line. */
const OUTCOME_LABELS: Readonly<Record<BrowserCheckOutcome, string>> = Object.freeze({
  pass: 'PASSED',
  fail: 'FAILED',
  skip: 'NOT RUN',
  not_applicable: 'NOT APPLICABLE',
  error: 'ERROR'
})

/**
 * Render the outcome as the single timeline line the verify stage appends.
 *
 * The label is derived from `outcome` and the `detail` is stripped of any label
 * it already carries, then re-attached. Deriving rather than trusting matters:
 * when this just prefixed `detail`, any caller that omitted the label produced
 * `- browser: something happened`, a line that reports no outcome at all — the
 * same defect as the hard-coded `NOT RUN` it replaced, one layer down.
 */
export function formatBrowserLine(result: BrowserCheckResult): string {
  const label = OUTCOME_LABELS[result.outcome]
  const detail = result.detail.replace(/^(PASSED|FAILED|NOT RUN|NOT APPLICABLE|ERROR)\s*[—-]\s*/, '')
  return `- browser: ${label} — ${detail}`
}

/** Does this outcome mean "the browser found a problem"? */
export function browserFailed(result: BrowserCheckResult): boolean {
  return result.outcome === 'fail'
}