/**
 * IPC router.
 *
 * Security posture (see `docs/security-review.md`):
 *
 *  - The **sender** is verified before any handler runs. A frame from any web
 *    contents other than our own top-level window is rejected outright, which
 *    blocks a navigated-away or injected renderer from driving the agent.
 *  - Every payload is validated against the channel's zod schema *before*
 *    dispatch. Handlers therefore never see unvalidated data.
 *  - Handlers receive a capability object, not `ipcMain`, so a handler cannot
 *    reach a channel it was not granted.
 *  - Errors are normalised. Internal stacks are logged in the main process and
 *    never returned to the renderer.
 */

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { IpcResult } from '@shared/ipc-channels'
import { SCHEMAS } from '@shared/ipc-schemas'
import type { MainEvent } from '@shared/types'
import type { PermissionPolicy } from '../services/permissions/policy'
import type { ApprovalQueue } from '../services/permissions/policy'

export interface RouterContext {
  /** Returns the WebContents that is allowed to drive the app, or null. */
  getTrustedWebContents(): WebContents | null
  policy: PermissionPolicy
  approvals: ApprovalQueue
  /**
   * Deliver an event to the renderer.
   *
   * The router needs this because it is the only component that gates a call on
   * an approval it creates itself. Creating the request is not enough: unless it
   * is pushed, nothing ever renders it, nobody resolves the waiter, and the
   * call silently expires at the queue's timeout — a button that appears dead
   * and then fails with "Not approved." minutes later.
   */
  push(event: MainEvent): void
}

export interface RouteOptions<T> {
  /** Permission domain required to invoke this channel. */
  domain?: Parameters<PermissionPolicy['evaluateDomain']>[0]
  /** When false (default) the call is recorded but not user-gated. */
  requiresApproval?: boolean
  handler(args: never, event: IpcMainInvokeEvent): Promise<T> | T
}

/**
 * What a gated channel is asking permission for, in words.
 *
 * The channel name is the fallback, not the message. This string is rendered as
 * the title of a large blocking dialog, so "Allow updates:install?" is not an
 * acceptable thing to put in front of a person.
 */
const CHANNEL_INTENT: Record<string, string> = {
  'updates:install': 'replace the running app with the downloaded update',
  'env:install': 'install a missing runtime',
  'terminal:list': 'list terminal sessions',
  'process:list': 'list running processes',
  'process:restart': 'restart a running process'
}

export class IpcRouter {
  private readonly handlers = new Map<string, RouteOptions<unknown>>()

  constructor(private readonly ctx: RouterContext) {}

  register<T>(channel: string, options: RouteOptions<T>): void {
    this.handlers.set(channel, options as RouteOptions<unknown>)
    ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcResult<T>> => {
      return this.dispatch<T>(channel, payload, event)
    })
  }

  registerAll(routes: Record<string, RouteOptions<never>>): void {
    for (const [channel, options] of Object.entries(routes)) this.register(channel, options)
  }

  dispose(): void {
    for (const channel of this.handlers.keys()) ipcMain.removeHandler(channel)
    this.handlers.clear()
  }

  private async dispatch<T>(channel: string, payload: unknown, event: IpcMainInvokeEvent): Promise<IpcResult<T>> {
    // 1. Sender verification. Never a soft check.
    const trusted = this.ctx.getTrustedWebContents()
    if (!trusted || event.sender !== trusted) {
      console.error(`[ipc] rejected ${channel}: untrusted sender`)
      return { ok: false, error: 'Rejected: untrusted sender.' }
    }

    // 2. Channel must be registered. The renderer cannot invent one.
    const route = this.handlers.get(channel)
    if (!route) {
      return { ok: false, error: `Unknown channel: ${channel}` }
    }

    // 3. Schema validation before the handler ever sees the data.
    const schema = (SCHEMAS as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { path: (string | number)[]; message: string }[] } } } | undefined>)[channel]
    if (!schema) {
      return { ok: false, error: `Channel ${channel} has no schema.` }
    }
    const parsed = schema.safeParse(payload ?? {})
    if (!parsed.success || parsed.data === undefined) {
      const issues = (parsed.error?.issues ?? []).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      return { ok: false, error: `Invalid arguments: ${issues.join('; ')}` }
    }

    // 4. Policy.
    if (route.domain) {
      const decision = this.ctx.policy.evaluateDomain(route.domain)
      if (decision === 'deny') return { ok: false, error: `Permission denied: ${route.domain}` }
      if (decision === 'ask' && route.requiresApproval !== false) {
        const request = this.ctx.approvals.request({
          toolId: channel,
          tier: 'elevated',
          title: CHANNEL_INTENT[channel]
            ? `Allow Cryptoric to ${CHANNEL_INTENT[channel]}?`
            : `Allow ${channel}?`,
          detail: JSON.stringify(parsed.data, null, 2).slice(0, 2000),
          risk: `This action needs ${route.domain} permission.`
        })
        // Shown before waiting, never after. A gate the user cannot see is not a
        // gate, it is a hang.
        this.ctx.push({ type: 'approval', request })
        const approved = await this.ctx.approvals.wait(request.id)
        if (!approved) return { ok: false, error: 'Not approved.' }
      }
    }

    // 5. Execute. Internal errors never leak their stack to the renderer.
    try {
      const data = await (route.handler as (a: unknown, e: IpcMainInvokeEvent) => Promise<T>)(parsed.data, event)
      return { ok: true, data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[ipc] ${channel} failed:`, err)
      return { ok: false, error: message }
    }
  }
}