/**
 * IPC router.
 *
 * The regression these tests exist for is not hypothetical. `updates:install` is
 * registered with `domain: 'env.modify'` (default `ask`) and
 * `requiresApproval: true`, so every click on "Restart & install" created an
 * approval request inside the main process and then waited on it. The router had
 * no way to push that request to the renderer — `RouterContext` carried no
 * `push` — so the prompt was never drawn, nobody resolved the waiter, and the
 * call silently expired at the queue's 120s timeout and reported
 * "Not approved.". The user-visible symptom was a button that did nothing.
 *
 * So the invariant pinned here is: **a gate that fires must be visible before it
 * waits.** Not after, not eventually.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS } from '../../src/shared/ipc-channels'
import { SCHEMAS } from '../../src/shared/ipc-schemas'
import { MAX_PROMPT_CHARS } from '../../src/shared/limits'
import type { MainEvent } from '../../src/shared/types'
import {
  DEFAULT_PERMISSION_RULES,
  ApprovalQueue,
  PermissionPolicy
} from '../../src/main/services/permissions/policy'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    }
  }
}))

// Imported after the mock so the module body sees the fake `ipcMain`.
const { IpcRouter } = await import('../../src/main/ipc/router')

interface Harness {
  router: InstanceType<typeof IpcRouter>
  approvals: ApprovalQueue
  pushed: MainEvent[]
  invoke: (channel: string, payload?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>
}

function harness(rules = DEFAULT_PERMISSION_RULES): Harness {
  const approvals = new ApprovalQueue()
  const pushed: MainEvent[] = []
  const sender = { id: 1 }

  const router = new IpcRouter({
    getTrustedWebContents: () => sender as never,
    policy: new PermissionPolicy(rules),
    approvals,
    push: (event) => pushed.push(event)
  })

  const invoke = async (channel: string, payload: unknown = {}) => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn({ sender }, payload)) as { ok: boolean; data?: unknown; error?: string }
  }

  return { router, approvals, pushed, invoke }
}

describe('IpcRouter approval gating', () => {
  beforeEach(() => handlers.clear())

  it('pushes the approval request before waiting on it', async () => {
    const h = harness()
    let ran = false
    h.router.register(CHANNELS.updatesInstall, {
      domain: 'env.modify',
      requiresApproval: true,
      handler: () => {
        ran = true
        return { ok: true }
      }
    })

    const pending = h.invoke(CHANNELS.updatesInstall)

    // The prompt must already be on screen while the call is still blocked.
    // Asserted synchronously: by the next tick the push has happened, and
    // waiting for `pending` would deadlock the very thing under test.
    expect(h.pushed, 'approval was never pushed to the renderer').toHaveLength(1)
    expect(h.pushed[0]).toMatchObject({ type: 'approval' })
    expect(ran, 'handler ran before the user approved').toBe(false)

    const request = (h.pushed[0] as { request: { id: string; toolId: string } }).request
    expect(request.toolId).toBe(CHANNELS.updatesInstall)

    h.approvals.resolve(request.id, true)
    const result = await pending
    expect(result.ok).toBe(true)
    expect(ran).toBe(true)
  })

  it('reports a denial instead of swallowing it', async () => {
    const h = harness()
    let ran = false
    h.router.register(CHANNELS.updatesInstall, {
      domain: 'env.modify',
      requiresApproval: true,
      handler: () => {
        ran = true
        return { ok: true }
      }
    })

    const pending = h.invoke(CHANNELS.updatesInstall)
    const request = (h.pushed[0] as { request: { id: string } }).request
    h.approvals.resolve(request.id, false)

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Not approved.')
    expect(ran).toBe(false)
  })

  it('describes a gated channel in words, not as its channel name', async () => {
    const h = harness()
    h.router.register(CHANNELS.updatesInstall, {
      domain: 'env.modify',
      requiresApproval: true,
      handler: () => ({ ok: true })
    })

    void h.invoke(CHANNELS.updatesInstall)
    const { title } = (h.pushed[0] as { request: { title: string } }).request
    // Rendered as a large blocking dialog, so the raw channel is not acceptable.
    expect(title).not.toContain(CHANNELS.updatesInstall)
    expect(title).toMatch(/^Allow Cryptoric to /)
  })

  it('does not prompt for a channel whose domain is allowed', async () => {
    const h = harness()
    h.router.register(CHANNELS.updatesDownload, {
      domain: 'network.read',
      requiresApproval: false,
      handler: () => ({ ok: true, data: { downloaded: true } })
    })

    const result = await h.invoke(CHANNELS.updatesDownload)
    expect(result.ok).toBe(true)
    expect(h.pushed).toHaveLength(0)
  })

  it('refuses a call from an untrusted sender without prompting', async () => {
    const h = harness()
    h.router.register(CHANNELS.updatesInstall, {
      domain: 'env.modify',
      requiresApproval: true,
      handler: () => ({ ok: true })
    })

    const fn = handlers.get(CHANNELS.updatesInstall)!
    const result = (await fn({ sender: { id: 999 } }, {})) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/untrusted sender/i)
    // A rejected sender must not be able to make the app display a prompt.
    expect(h.pushed).toHaveLength(0)
  })
})

describe('agent prompt schema', () => {
  const schema = SCHEMAS[CHANNELS.agentSubmit]

  it('accepts a large multi-line paste', () => {
    // The reported failure: a pasted stack trace or file was refused outright.
    // 100k characters of many-line content is well past the old 20,000 cap.
    const pasted = Array.from({ length: 2000 }, (_, i) => `line ${i}: const x = ${i} // detail`).join('\n')
    expect(pasted.length).toBeGreaterThan(20_000)

    const parsed = schema.safeParse({ prompt: pasted })
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
  })

  it('preserves newlines rather than folding them into one line', () => {
    const parsed = schema.safeParse({ prompt: 'first\nsecond\n\nthird' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data as { prompt: string }).prompt).toBe('first\nsecond\n\nthird')
    }
  })

  it('still refuses a prompt past the ceiling', () => {
    const parsed = schema.safeParse({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) })
    expect(parsed.success).toBe(false)
  })

  it('still refuses an empty prompt', () => {
    expect(schema.safeParse({ prompt: '' }).success).toBe(false)
  })

  it('keeps the ceiling far above any realistic paste', () => {
    // ~50k tokens. The old cap was roughly one screenful, which is what made a
    // large paste fail at the IPC boundary with no warning beforehand.
    expect(MAX_PROMPT_CHARS).toBeGreaterThanOrEqual(100_000)
  })
})