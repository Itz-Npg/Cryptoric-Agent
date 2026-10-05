/**
 * Execution display helpers.
 *
 * Lives in `shared/` rather than beside the engine because the renderer needs it
 * and `tsconfig.web.json` only reaches `src/renderer/**` and `src/shared/**`.
 * Imports nothing, for the same reason `limits.ts` does: nothing dragged into
 * the renderer bundle that does not belong there.
 */

/** Rendered in place of a duration when a phase never executed. */
export const NOT_RUN = 'NOT_RUN'

/**
 * Duration of a phase, or null when it never ran.
 *
 * `0 ms` is a false claim. The previous renderer computed
 * `Math.max(0, Date.parse(finished) - Date.parse(started))` and printed the
 * result whenever both timestamps existed — which they did even for a stage that
 * started and stopped in the same millisecond, so a no-op run rendered as five
 * green ticks all reading `0 ms`. A phase that never executed has no duration to
 * report, and `null` renders as NOT_RUN, which is the truth.
 */
export function phaseDuration(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  const ms = end - start
  return ms >= 0 ? ms : null
}

/** `1,243 ms`, or `NOT_RUN` when there is nothing to measure. */
export function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  const ms = phaseDuration(startedAt, finishedAt)
  return ms === null ? NOT_RUN : `${ms.toLocaleString()} ms`
}