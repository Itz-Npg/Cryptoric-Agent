/**
 * Exit codes.
 *
 * The pipeline already distinguishes COMPLETED / FAILED / BLOCKED / PARTIAL /
 * CANCELLED. Collapsing those onto 0 and 1 would throw away the distinction the
 * desktop app works hard to preserve, and would make "the agent correctly
 * refused to guess" indistinguishable from "the agent broke".
 *
 * So every verdict gets its own code, and the docstring in `args.ts` is the
 * contract. Anything that is not a verdict about the work is a usage error,
 * which is 64 — the BSD `sysexits.h` code for exactly this.
 */

import type { FinalVerdict } from '../../src/main/services/agent/evidence'

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_BLOCKED = 2
export const EXIT_CANCELLED = 3
export const EXIT_PARTIAL = 4
export const EXIT_USAGE = 64

export function exitCodeFor(verdict: FinalVerdict): number {
  switch (verdict) {
    case 'COMPLETED':
      return EXIT_OK
    case 'FAILED':
      return EXIT_FAILED
    case 'BLOCKED':
      return EXIT_BLOCKED
    case 'CANCELLED':
      return EXIT_CANCELLED
    case 'PARTIAL':
      return EXIT_PARTIAL
    default: {
      // A verdict this build has never heard of is a bug, not a success.
      // Exhaustiveness is enforced by the switch, and this branch catches a
      // verdict arriving at runtime from a newer wire format.
      const unknown: never = verdict
      throw new Error(`Unknown verdict: ${String(unknown)}`)
    }
  }
}