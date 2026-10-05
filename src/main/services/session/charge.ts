/**
 * Who pays for a session, and how.
 *
 * This is the one decision that changes what a task costs, so it lives outside
 * the composition root where it can be tested against a real server. `index.ts`
 * supplies the parts and gets a function.
 *
 * The shape of the rule:
 *
 *  - **A resumed task is never charged again.** It continues the session it was
 *    interrupted in; the time was bought once and has partly elapsed.
 *  - **`local`** derives a balance from the gateway's allowance minus the local
 *    ledger and prices the session itself.
 *  - **`hosted`** asks the server, which owns the balance. The server's numbers
 *    are the grant. If it cannot be reached, or the account is not signed in,
 *    the task does not start — a network problem is not a free session.
 */

import { grantFromCharge, remainingMs, startSession, type GrantResult, type ModelTier, type SessionGrant } from '@shared/session-time'
import type { RunMode } from '@shared/mode'
import type { AgentServerClient } from '../server/client'

export interface ChargeDeps {
  mode: RunMode
  /** `null` in `local`; the reason `hosted` without a server is refused earlier. */
  server: AgentServerClient | null
  /**
   * Why this build cannot charge anyone, if it cannot.
   *
   * A half-configured build (a server URL with no mode, `hosted` with no token)
   * refuses here rather than quietly falling back to the local ledger, which
   * would show a balance the app is not actually spending.
   */
  blockedReason: string | null
  /** The account id to bill, or `null` when nobody is signed in. */
  accountId(): Promise<string | null>
  /** Coins available today, locally derived. Never called in `hosted`. */
  localBalance(): number
  /** The record of what was spent. The server is authoritative in `hosted`. */
  record(grant: SessionGrant): Promise<void>
  model(): string
  tier(): ModelTier
}

export interface ChargeTask {
  /** Doubles as the grant id, so a retry cannot buy a second session. */
  id: string
  projectRoot: string
  prompt: string
}

export const SIGN_IN_REQUIRED =
  'Sign in first — this build keeps your balance on a Cryptoric server, so the agent cannot run without an account.'

/**
 * Charge for one task and hand back the time it bought.
 *
 * Never throws. A failure here is a message the agent's stage will report, and
 * an exception would replace that message with a stack trace nobody asked for.
 */
export async function beginSession(
  deps: ChargeDeps,
  task: ChargeTask,
  resume: SessionGrant | null,
  now: number = Date.now()
): Promise<GrantResult> {
  if (resume && remainingMs(resume, now) > 0) {
    return { ok: true, grant: resume, remainingCoins: 0 }
  }

  if (deps.blockedReason) return { ok: false, error: deps.blockedReason }

  if (deps.mode === 'hosted') {
    const server = deps.server
    if (!server) {
      return { ok: false, error: 'This build is set to hosted but has no account server to bill.' }
    }
    const accountId = await deps.accountId()
    if (!accountId) return { ok: false, error: SIGN_IN_REQUIRED }

    const charged = await server.charge({ accountId, grantId: task.id, modelId: deps.model() })
    if (!charged.ok) {
      // 402 means the balance ran out, which is not a failure of the app and
      // deserves the server's own wording rather than a generic one.
      return { ok: false, error: charged.error }
    }

    const result = grantFromCharge({
      id: task.id,
      model: deps.model(),
      coins: charged.value.coins,
      minutes: charged.value.minutes,
      now,
      projectRoot: task.projectRoot,
      prompt: task.prompt
    })
    if (result.ok) {
      // Still recorded locally: this is what makes an interrupted session
      // resumable without asking the server to remember our prompts.
      await deps.record(result.grant)
    }
    return result
  }

  const result = startSession({
    id: task.id,
    model: deps.model(),
    tier: deps.tier(),
    available: deps.localBalance(),
    now,
    projectRoot: task.projectRoot,
    prompt: task.prompt
  })
  if (result.ok) await deps.record(result.grant)
  return result
}
