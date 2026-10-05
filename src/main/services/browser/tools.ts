/**
 * Browser tools — Cryptoric Chan's view of a running application.
 *
 * These are the tools that make the local-development loop closed: start a dev
 * server, open its URL, read the console, look at the network, screenshot it,
 * interact, change a file, reload the *same* tab, read the console again. Every
 * tool here is a thin adapter over `BrowserTabManager` and `PageController`;
 * none of them re-implements policy or keeps its own browser state.
 *
 * Two conventions are worth stating once:
 *
 *  - **`tabId` is optional everywhere.** Omitted, a tool acts on the active tab.
 *    That is what makes "reuse the same tab" the path of least resistance
 *    rather than something the agent has to remember to do.
 *  - **Inspection is `safe`, interaction is `ask`.** Reading a page cannot
 *    change anything; clicking a button or submitting a form can, and the
 *    policy treats that difference as real rather than cosmetic.
 */

import { join } from 'node:path'
import { z } from 'zod'
import type { PermissionDomain, ToolDescriptor } from '@shared/types'
import type { BrowserTabManager, TabId } from './tabs'
import type { PageController } from './page'
import { writeScreenshot } from './page'
import { describeKey } from './keys'
import { existsSync, statSync } from 'node:fs'
import {
  ASSET_CATALOG,
  BLOCKED_EXTENSIONS,
  cleanWorkspace,
  generateAsset,
  verifyAsset,
  type AssetKind
} from './assets'
import {
  classifyTarget,
  clip,
  isLoopbackUrl,
  isProblemEntry,
  normalizeUrl,
  percentile,
  summarizeRequests
} from './dom'
import { describeSchema, type ToolContext, type ToolDefinition, type ToolResult } from '../tools/registry'

/**
 * Execution metadata for every tool in this module.
 *
 * Risk is blast radius, not caller: navigating to a remote URL is `medium`
 * because it causes an outbound request the machine did not make before, while
 * reading the console out of a tab you already opened is `safe`.
 */
const TOOL_META: Record<
  string,
  Pick<ToolDescriptor, 'category' | 'risk'> & { timeoutMs: number; mutates: boolean }
> = {
  browser_create_tab: { category: 'browser', risk: 'low', timeoutMs: 45_000, mutates: true },
  browser_close_tab: { category: 'browser', risk: 'low', timeoutMs: 30_000, mutates: true },
  browser_navigate: { category: 'browser', risk: 'medium', timeoutMs: 60_000, mutates: false },
  browser_back: { category: 'browser', risk: 'low', timeoutMs: 45_000, mutates: false },
  browser_forward: { category: 'browser', risk: 'low', timeoutMs: 45_000, mutates: false },
  browser_reload: { category: 'browser', risk: 'low', timeoutMs: 45_000, mutates: false },
  browser_wait: { category: 'browser', risk: 'safe', timeoutMs: 120_000, mutates: false },
  browser_click: { category: 'browser', risk: 'low', timeoutMs: 45_000, mutates: true },
  browser_type: { category: 'browser', risk: 'low', timeoutMs: 60_000, mutates: true },
  browser_press_key: { category: 'browser', risk: 'low', timeoutMs: 30_000, mutates: true },
  browser_select: { category: 'browser', risk: 'low', timeoutMs: 30_000, mutates: true },
  browser_scroll: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false },
  browser_get_url: { category: 'browser', risk: 'safe', timeoutMs: 15_000, mutates: false },
  browser_get_title: { category: 'browser', risk: 'safe', timeoutMs: 15_000, mutates: false },
  browser_get_text: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false },
  browser_get_dom: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false },
  browser_inspect_element: { category: 'browser', risk: 'safe', timeoutMs: 45_000, mutates: false },
  browser_query_selector: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false },
  browser_console_logs: { category: 'browser', risk: 'safe', timeoutMs: 15_000, mutates: false },
  browser_network_requests: { category: 'browser', risk: 'safe', timeoutMs: 15_000, mutates: false },
  browser_network_failures: { category: 'browser', risk: 'safe', timeoutMs: 15_000, mutates: false },
  browser_screenshot: { category: 'browser', risk: 'low', timeoutMs: 45_000, mutates: false },
  browser_evaluate_safe: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false },
  browser_get_accessibility_tree: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false },
  browser_double_click: { category: 'browser', risk: 'low', timeoutMs: 45_000, mutates: true },
  browser_hover: { category: 'browser', risk: 'low', timeoutMs: 30_000, mutates: false },
  browser_clear: { category: 'browser', risk: 'low', timeoutMs: 30_000, mutates: true },
  browser_check: { category: 'browser', risk: 'low', timeoutMs: 30_000, mutates: true },
  browser_uncheck: { category: 'browser', risk: 'low', timeoutMs: 30_000, mutates: true },
  browser_drag: { category: 'browser', risk: 'low', timeoutMs: 45_000, mutates: true },
  browser_upload_file: { category: 'browser', risk: 'low', timeoutMs: 60_000, mutates: true },
  browser_download_file: { category: 'browser', risk: 'low', timeoutMs: 60_000, mutates: true },
  browser_wait_for_download: { category: 'browser', risk: 'safe', timeoutMs: 60_000, mutates: false },
  browser_wait_for_navigation: { category: 'browser', risk: 'safe', timeoutMs: 60_000, mutates: false },
  browser_wait_for_element: { category: 'browser', risk: 'safe', timeoutMs: 120_000, mutates: false },
  browser_query_all: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false },
  browser_get_attributes: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false },
  browser_get_computed_style: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false },
  browser_get_storage: { category: 'browser', risk: 'safe', timeoutMs: 20_000, mutates: false },
  browser_set_storage: { category: 'browser', risk: 'low', timeoutMs: 30_000, mutates: true },
  browser_get_cookies: { category: 'browser', risk: 'safe', timeoutMs: 20_000, mutates: false },
  browser_clear_cookies: { category: 'browser', risk: 'low', timeoutMs: 30_000, mutates: true },
  browser_handle_dialog: { category: 'browser', risk: 'low', timeoutMs: 60_000, mutates: true },
  browser_handle_permission: { category: 'browser', risk: 'low', timeoutMs: 60_000, mutates: true }
}

/** Tools that can only work on a tab that has a live origin; used for better errors. */
const REQUIRES_ORIGIN = new Set([
  'browser_set_storage',
  'browser_get_storage'
])

export interface BrowserToolDeps {
  tabs: BrowserTabManager
}

const ok = (summary: string, data?: unknown, extra: Partial<ToolResult> = {}): ToolResult => ({
  ok: true,
  summary,
  ...(data !== undefined ? { data } : {}),
  ...extra
})

const fail = (summary: string, error: string, extra: Partial<ToolResult> = {}): ToolResult => ({
  ok: false,
  summary,
  error,
  ...extra
})

const tabIdArg = z.string().min(1).optional().describe('Tab to act on. Defaults to the active tab.')

/**
 * Resolve a tab for a tool call, or explain precisely why there is none.
 *
 * "No browser tab" is the single most common failure in a long session, and an
 * error that says which tab ids do exist turns it from a dead end into one
 * extra call.
 */
function resolveTab(
  tabs: BrowserTabManager,
  tabId?: TabId
): { ok: true; tabId: TabId; page: PageController } | { ok: false; message: string; open: unknown[] } {
  const state = tabs.resolve(tabId)
  if (!state) {
    const message = tabId
      ? `No browser tab with id ${tabId}.`
      : 'No browser tab is open. Call browser_create_tab first.'
    return { ok: false, message, open: tabs.list() }
  }
  if (state.view.webContents.isDestroyed()) {
    return { ok: false, message: `Browser tab ${state.id} is closed.`, open: tabs.list() }
  }
  return { ok: true, tabId: state.id, page: state.page }
}

function noTabResult(result: { message: string; open: unknown[] }): ToolResult {
  return fail('No browser tab', result.message, {
    metadata: { openTabs: result.open },
    warnings:
      result.open.length === 0
        ? ['Create a tab with browser_create_tab, for example browser_create_tab with url http://localhost:5173.']
        : undefined
  })
}

/** Turn a bridge reply into a tool result without inventing success. */
function bridgeResult(
  label: string,
  reply: { ok: boolean; reason?: string } & Record<string, unknown>
): ToolResult {
  if (reply.ok) return ok(label, reply)
  return fail(`${label} failed`, String(reply.reason ?? 'The page did not cooperate.'), {
    failureKind: 'failed'
  })
}

export function buildBrowserTools(deps: BrowserToolDeps): ToolDefinition[] {
  const { tabs } = deps

  const tool = (
    descriptor: ToolDescriptor,
    domain: PermissionDomain,
    schema: z.ZodTypeAny,
    execute: (input: never, ctx: ToolContext) => Promise<ToolResult>,
    dependsOn?: string[]
  ): ToolDefinition => {
    const meta = TOOL_META[descriptor.id]
    if (!meta) {
      // A tool without declared risk and timeout silently inherits none, which
      // is how a browser tool ends up unbounded and mis-categorised in the UI.
      throw new Error(`browser tool ${descriptor.id} has no entry in TOOL_META`)
    }
    return {
      descriptor: {
        ...meta,
        ...descriptor,
        platforms: descriptor.platforms ?? ['*'],
        inputSchema: describeSchema(schema)
      },
      domain,
      schema,
      dependsOn,
      execute: execute as ToolDefinition['execute']
    }
  }

  return [
    // ------------------------------------------------------------- lifecycle

    tool(
      {
        id: 'browser_create_tab',
        label: 'Open browser tab',
        description:
          'Open a browser tab inside Cryptoric and optionally navigate it. A bare host:port such as localhost:5173 is accepted and defaults to http. Reuses the app\'s own Chromium; nothing is downloaded.',
        dependsOn: [],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        url: z.string().optional().describe('URL to open. Omit for a blank tab.'),
        visible: z.boolean().optional().describe('Show the tab in the Cryptoric window. Default true.'),
        persistent: z
          .boolean()
          .optional()
          .describe('Keep cookies and cache for this tab. Default false, which wipes them on close.')
      }),
      async (input: { url?: string; visible?: boolean; persistent?: boolean }) => {
        let target: string | undefined
        if (input.url) {
          const normalized = normalizeUrl(input.url)
          if (!normalized.ok) return fail('Refused to open the tab', normalized.error)
          target = normalized.url
        }
        const tab = await tabs.open({
          url: target,
          visible: input.visible,
          persistent: input.persistent
        })
        return ok(`Opened ${tab.url}`, { tab, cacheDir: tabs.cacheDir })
      }
    ),

    tool(
      {
        id: 'browser_close_tab',
        label: 'Close browser tab',
        description:
          'Close a browser tab. A temporary tab also deletes its cookies, cache and profile directory; a persistent tab keeps them.',
        dependsOn: ['browser_create_tab'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        tabId: tabIdArg,
        temporaryOnly: z
          .boolean()
          .optional()
          .describe('Close every temporary tab instead of one. Used to clean up at the end of a task.')
      }),
      async (input: { tabId?: string; temporaryOnly?: boolean }, ctx: ToolContext) => {
        if (input.temporaryOnly) {
          const closed = await tabs.closeTemporary()
          // The generated test assets belong to this task and nowhere else, so
          // they go with the tabs rather than accumulating in the temp dir.
          const assetsCleaned = cleanWorkspace(ctx.taskId ?? 'adhoc')
          return ok(`Closed ${closed} temporary tab${closed === 1 ? '' : 's'}`, {
            closed,
            assetsCleaned,
            cleanupFailures: tabs.cleanupFailures()
          })
        }
        const target = tabs.resolve(input.tabId)
        if (!target) return noTabResult({ message: 'No matching browser tab.', open: tabs.list() })
        await tabs.close(target.id)
        return ok(`Closed tab ${target.id}`, { remaining: tabs.list() })
      }
    ),

    // ------------------------------------------------------------ navigation

    tool(
      {
        id: 'browser_navigate',
        label: 'Navigate',
        description:
          'Load a URL in a tab and wait for the page to settle. Returns the page title, final URL and whether the target is the local machine.',
        dependsOn: ['browser_create_tab'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({ url: z.string().min(1).describe('URL, or a bare host:port such as localhost:3000'), tabId: tabIdArg }),
      async (input: { url: string; tabId?: string }, ctx: ToolContext) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const normalized = normalizeUrl(input.url)
        if (!normalized.ok) return fail('Refused to navigate', normalized.error)

        const started = Date.now()
        const result = await tabs.navigate(target.tabId, normalized.url)
        if (!result.ok) {
          return fail('Navigation failed', result.error ?? 'The page did not load.', {
            failureKind: 'failed',
            metadata: { url: normalized.url }
          })
        }
        await target.page.waitForLoad(30_000, ctx.signal)

        const record = tabs.get(target.tabId)
        return ok(`Loaded ${record?.url ?? normalized.url} in ${Date.now() - started}ms`, {
          tab: record,
          requested: normalized.url,
          finalUrl: record?.url ?? normalized.url,
          title: record?.title ?? '',
          target: classifyTarget(normalized.url),
          loopback: isLoopbackUrl(normalized.url)
        })
      }
    ),

    tool(
      {
        id: 'browser_back',
        label: 'Go back',
        description: 'Go back one entry in the tab history. Reports false when there is nowhere to go.',
        dependsOn: ['browser_navigate'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({ tabId: tabIdArg }),
      async (input: { tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)
        const moved = tabs.back(target.tabId)
        await target.page.waitForLoad(20_000).catch(() => undefined)
        return ok(moved ? 'Went back' : 'No previous page', {
          moved,
          url: tabs.get(target.tabId)?.url ?? '',
          history: tabs.history(target.tabId)
        })
      }
    ),

    tool(
      {
        id: 'browser_forward',
        label: 'Go forward',
        description: 'Go forward one entry in the tab history. Reports false when there is nowhere to go.',
        dependsOn: ['browser_back'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({ tabId: tabIdArg }),
      async (input: { tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)
        const moved = tabs.forward(target.tabId)
        await target.page.waitForLoad(20_000).catch(() => undefined)
        return ok(moved ? 'Went forward' : 'No next page', {
          moved,
          url: tabs.get(target.tabId)?.url ?? '',
          history: tabs.history(target.tabId)
        })
      }
    ),

    tool(
      {
        id: 'browser_reload',
        label: 'Reload',
        description:
          'Reload the tab in place. This is the step that verifies a code change: the same tab, the same session, a fresh document.',
        dependsOn: ['browser_navigate'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        tabId: tabIdArg,
        ignoreCache: z.boolean().optional().describe('Hard reload, bypassing the HTTP cache.'),
        clearLogs: z.boolean().optional().describe('Discard console and network logs first, so only this reload is measured.')
      }),
      async (input: { tabId?: string; ignoreCache?: boolean; clearLogs?: boolean }, ctx: ToolContext) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)
        if (input.clearLogs) tabs.clearDiagnostics(target.tabId)

        const started = Date.now()
        tabs.reload(target.tabId, input.ignoreCache)
        await target.page.waitForLoad(30_000, ctx.signal)
        const record = tabs.get(target.tabId)
        return ok(`Reloaded ${record?.url ?? ''} in ${Date.now() - started}ms`, {
          tab: record,
          ignoreCache: input.ignoreCache ?? false,
          errors: tabs.consoleLogs(target.tabId).filter(isProblemEntry).length,
          networkFailures: tabs.networkFailures(target.tabId).length
        })
      }
    ),

    // ----------------------------------------------------------------- waits

    tool(
      {
        id: 'browser_wait',
        label: 'Wait',
        description:
          'Wait until something is true: a selector exists, a selector becomes visible or disappears, or the page text contains a string. Polls the live page rather than sleeping a fixed amount.',
        dependsOn: ['browser_navigate'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z
        .object({
          selector: z.string().optional().describe('CSS selector, or text="..." / text~="...".'),
          text: z.string().optional().describe('Wait for this substring in the page text.'),
          state: z
            .enum(['attached', 'visible', 'detached'])
            .optional()
            .describe('attached: exists. visible: exists and is rendered. detached: gone.'),
          timeoutMs: z.number().int().min(100).max(120_000).optional().describe('Default 15000.'),
          tabId: tabIdArg
        })
        .refine((v) => Boolean(v.selector || v.text), {
          message: 'Give a selector or some text to wait for.'
        }),
      async (input: { selector?: string; text?: string; state?: 'attached' | 'visible' | 'detached'; timeoutMs?: number; tabId?: string }, ctx: ToolContext) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const result = await target.page.waitFor({
          selector: input.selector,
          text: input.text,
          state: input.state,
          timeoutMs: input.timeoutMs ?? 15_000,
          signal: ctx.signal
        })
        if (!result.ok) {
          return fail('Wait timed out', String(result.reason), {
            failureKind: 'timeout',
            metadata: { elapsedMs: result.elapsedMs, url: tabs.get(target.tabId)?.url ?? '' }
          })
        }
        return ok(`Condition met after ${result.elapsedMs}ms`, {
          elapsedMs: result.elapsedMs,
          url: tabs.get(target.tabId)?.url ?? ''
        })
      }
    ),

    // ------------------------------------------------------------ interaction

    tool(
      {
        id: 'browser_click',
        label: 'Click',
        description:
          'Click an element with a real pointer event at its on-screen position, so hover, focus and framework handlers all fire the way they do for a user.',
        dependsOn: ['browser_navigate'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        selector: z.string().min(1).describe('CSS selector, or text="Sign in" to match visible text.'),
        index: z.number().int().min(0).optional().describe('Which match to use when the selector matches several. Default: the first visible one.'),
        clickCount: z.number().int().min(1).max(3).optional().describe('2 for a double click. Default 1.'),
        tabId: tabIdArg
      }),
      async (input: { selector: string; index?: number; clickCount?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const result = await target.page.clickSelector(input.selector, {
          index: input.index,
          clickCount: input.clickCount ?? 1
        })
        if (!result.ok) return fail('Click failed', String(result.reason ?? 'The click did not land.'), {
          metadata: { selector: input.selector }
        })
        return ok(`Clicked ${input.selector}`, {
          selector: input.selector,
          element: result.descriptor,
          scrolled: result.scrolled ?? false,
          point: result.point,
          consoleErrors: tabs.consoleLogs(target.tabId).filter(isProblemEntry).length
        })
      }
    ),

    tool(
      {
        id: 'browser_type',
        label: 'Type',
        description:
          'Focus a field and type text as real key events, so masked inputs, autocomplete and key handlers behave correctly. Use browser_press_key for single keys and chords.',
        dependsOn: ['browser_navigate'],
        tier: 'ask',
        inputSchema: {},
        sensitiveArgs: ['text']
      },
      'browser.interact',
      z.object({
        selector: z.string().min(1).describe('The input, textarea or contenteditable to type into.'),
        text: z.string().describe('Text to type. Redacted from the audit log because this is where a secret passes.'),
        mode: z
          .enum(['insert', 'keys'])
          .optional()
          .describe('insert (default): exact text with input/change events. keys: one real key event per character, for keydown handlers and masked fields.'),
        clear: z.boolean().optional().describe('Select all and replace. Default true.'),
        index: z.number().int().min(0).optional(),
        delayMs: z.number().int().min(0).max(200).optional().describe('Per-character delay in keys mode, for apps that debounce input.'),
        submit: z.boolean().optional().describe('Press Enter afterwards.'),
        tabId: tabIdArg
      }),
      async (input: {
        selector: string
        text: string
        mode?: 'insert' | 'keys'
        clear?: boolean
        index?: number
        delayMs?: number
        submit?: boolean
        tabId?: string
      }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const focused = await target.page.call('focus', { selector: input.selector, index: input.index })
        if (!focused.ok) return bridgeResult(`Focus ${input.selector}`, focused)

        const mode = input.mode ?? 'insert'
        let typed = 0
        let clearedBy = 'skipped'
        try {
          if (input.clear !== false) {
            clearedBy = await target.page.clearField(input.selector, input.index)
            await target.page.replaceValue(input.text, input.selector, input.index)
          } else {
            typed = await target.page.typeText(input.text, mode, input.delayMs ?? 0)
          }
        } catch (err) {
          return fail('Typing failed', err instanceof Error ? err.message : String(err))
        }
        typed = [...input.text].length

        if (input.submit) {
          const enter = describeKey('Enter')
          if (enter.ok && enter.sequence) await target.page.pressKeys(enter.sequence)
        }
        await target.page.settle(3)

        // Report what the page now holds, never what was typed.
        const after = await target.page.call('getValue', { selector: input.selector, index: input.index })
        const landed = (after.value as { value?: string } | undefined)?.value
        if (input.clear !== false && mode === 'insert' && landed !== input.text) {
          // The point of reading the value back is to notice when the page did
          // not accept what was asked for, rather than reporting a pass.
          return fail('The field did not accept the text', `Expected ${input.text.length} characters, the field holds ${JSON.stringify(landed)}`, {
            metadata: { selector: input.selector }
          })
        }
        return ok(`Typed ${typed} characters into ${input.selector}`, {
          selector: input.selector,
          mode,
          characters: typed,
          clearedBy,
          submitted: input.submit ?? false,
          element: focused.descriptor,
          field: after.ok ? after.value : null
        })
      }
    ),

    tool(
      {
        id: 'browser_press_key',
        label: 'Press key',
        description:
          'Press a key or a chord such as Ctrl+S, Enter or ArrowDown. The tab must already have focus, which browser_click and browser_type provide.',
        dependsOn: ['browser_click'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        key: z.string().min(1).describe('Key name, or a chord such as "Ctrl+Shift+P". "abc" types three characters.'),
        repeat: z.number().int().min(1).max(50).optional().describe('Press it this many times.'),
        tabId: tabIdArg
      }),
      async (input: { key: string; repeat?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const parsed = describeKey(input.key)
        if (!parsed.ok) return fail('Unknown key', String(parsed.error))
        const sequence = parsed.sequence ?? (parsed.descriptor ? [parsed.descriptor] : [])
        if (sequence.length === 0) return fail('Unknown key', `Could not resolve "${input.key}".`)

        const repeat = input.repeat ?? 1
        for (let i = 0; i < repeat; i += 1) await target.page.pressKeys(sequence)
        await target.page.settle(2)
        return ok(`Pressed ${input.key}${repeat > 1 ? ` ${repeat} times` : ''}`, { key: input.key, repeat })
      }
    ),

    tool(
      {
        id: 'browser_select',
        label: 'Select option',
        description:
          'Choose an option in a <select>, or set a checkbox or radio. Matches on the option value or its visible text.',
        dependsOn: ['browser_navigate'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        selector: z.string().min(1).describe('The select, input[type=checkbox] or input[type=radio].'),
        value: z.string().describe('Option value or option text; true/false for a checkbox.'),
        index: z.number().int().min(0).optional(),
        tabId: tabIdArg
      }),
      async (input: { selector: string; value: string; index?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const result = await target.page.call('setValue', {
          selector: input.selector,
          value: input.value,
          index: input.index
        })
        if (!result.ok) return bridgeResult(`Select ${input.selector}`, result)
        await target.page.settle(2)
        return ok(`Selected "${input.value}" in ${input.selector}`, {
          selector: input.selector,
          value: result.value,
          kind: result.kind,
          available: result.available
        })
      }
    ),

    tool(
      {
        id: 'browser_scroll',
        label: 'Scroll',
        description:
          'Scroll the page or a scrollable element: down, up, top, bottom, by a pixel amount, or until a selector is in view.',
        dependsOn: ['browser_navigate'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        direction: z.enum(['down', 'up', 'top', 'bottom', 'by']).optional().describe('Default down.'),
        amount: z.number().int().min(-20_000).max(20_000).optional().describe('Pixels for direction "by". Default 600.'),
        selector: z.string().optional().describe('Scroll this element instead of the page.'),
        tabId: tabIdArg
      }),
      async (input: { direction?: 'down' | 'up' | 'top' | 'bottom' | 'by'; amount?: number; selector?: string; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const direction = input.direction ?? 'down'
        if (direction === 'top' || direction === 'bottom') {
          const result = await target.page.call('scrollTo', {
            selector: input.selector,
            y: direction === 'bottom' ? 1_000_000_000 : 0
          })
          return ok(`Scrolled to ${direction}`, { position: result.value ?? result.meta })
        }

        const pixels = input.amount ?? 600
        const dy = direction === 'up' ? -Math.abs(pixels) : Math.abs(pixels)

        let point: { x: number; y: number } | undefined
        if (input.selector) {
          const found = await target.page.call('reveal', { selector: input.selector })
          if (!found.ok) return bridgeResult(`Scroll to ${input.selector}`, found)
          const rect = found.rect as { centerX: number; centerY: number }
          point = { x: rect.centerX, y: rect.centerY }
        }

        await target.page.scrollBy(0, dy, point)
        const after = await target.page.call('meta')
        return ok(`Scrolled ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px`, {
          direction,
          pixels: dy,
          position: after.value ?? after.meta
        })
      }
    ),

    // ------------------------------------------------------------ inspection

    tool(
      {
        id: 'browser_get_url',
        label: 'Get URL',
        description: 'Read the tab\'s current URL, title and loading state.',
        dependsOn: ['browser_navigate'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({ tabId: tabIdArg }),
      async (input: { tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)
        const tab = tabs.get(target.tabId)
        return ok(tab?.url ?? '', {
          url: tab?.url ?? '',
          title: tab?.title ?? '',
          loading: tab?.loading ?? false,
          target: classifyTarget(tab?.url ?? '')
        })
      }
    ),

    tool(
      {
        id: 'browser_get_title',
        label: 'Get title',
        description: 'Read the document title of the tab.',
        dependsOn: ['browser_navigate'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({ tabId: tabIdArg }),
      async (input: { tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)
        const tab = tabs.get(target.tabId)
        return ok(tab?.title || '(untitled)', { title: tab?.title ?? '', url: tab?.url ?? '' })
      }
    ),

    tool(
      {
        id: 'browser_get_text',
        label: 'Get page text',
        description:
          'Read the rendered text of the page, or of one element. Uses innerText, so hidden nodes are excluded the way a user would not see them.',
        dependsOn: ['browser_navigate'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        selector: z.string().optional().describe('Limit to one element. Omit for the whole page.'),
        index: z.number().int().min(0).optional(),
        maxChars: z.number().int().min(200).max(500_000).optional().describe('Default 20000.'),
        tabId: tabIdArg
      }),
      async (input: { selector?: string; index?: number; maxChars?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const max = input.maxChars ?? 20_000
        const result = await target.page.call('getText', {
          selector: input.selector,
          index: input.index,
          maxChars: max
        })
        if (!result.ok) return bridgeResult('Read text', result)

        const text = String(result.text ?? '')
        const trimmed = clip(text, max)
        return ok(`${trimmed.truncated ? 'First' : 'All'} ${trimmed.value.length} characters of page text`, {
          selector: input.selector ?? null,
          text: trimmed.value,
          truncated: trimmed.truncated,
          originalLength: trimmed.originalLength
        })
      }
    ),

    tool(
      {
        id: 'browser_get_dom',
        label: 'Get DOM',
        description: 'Read the outerHTML of the page or of one element, for when the text is fine but the markup is wrong.',
        dependsOn: ['browser_navigate'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        selector: z.string().optional().describe('Limit to one element. Omit for the whole document.'),
        index: z.number().int().min(0).optional(),
        maxChars: z.number().int().min(200).max(1_000_000).optional().describe('Default 60000.'),
        tabId: tabIdArg
      }),
      async (input: { selector?: string; index?: number; maxChars?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const max = input.maxChars ?? 60_000
        const result = await target.page.call('getDom', {
          selector: input.selector,
          index: input.index,
          maxChars: max
        })
        if (!result.ok) return bridgeResult('Read DOM', result)

        const html = String(result.html ?? '')
        const trimmed = clip(html, max)
        return ok(`${trimmed.truncated ? 'First' : 'All'} ${trimmed.value.length} characters of markup`, {
          selector: input.selector ?? null,
          html: trimmed.value,
          truncated: trimmed.truncated,
          originalLength: trimmed.originalLength
        })
      }
    ),

    tool(
      {
        id: 'browser_inspect_element',
        label: 'Inspect element',
        description:
          "Everything about one element in one call: its markup, the computed styles that decide how it renders, its on-screen box, and a reusable selector. Pick it by selector, or by x/y when a user has pointed at it. This is the tool for 'why does this look like that' — reading markup and computed style separately costs two round trips and invites pairing them with the wrong node.",
        dependsOn: ['browser_navigate'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        selector: z.string().optional().describe('CSS selector for the element.'),
        index: z.number().int().min(0).optional().describe('Which match, when several. Default 0.'),
        x: z.number().optional().describe('Pick whatever is under this viewport x, instead of a selector.'),
        y: z.number().optional().describe('Pick whatever is under this viewport y, instead of a selector.'),
        includeScreenshot: z.boolean().optional().describe('Also capture the viewport, for visual context. Default false.'),
        maxChars: z.number().int().min(200).max(200_000).optional().describe('Markup cap. Default 8000.'),
        tabId: tabIdArg
      }),
      async (input: { selector?: string; index?: number; x?: number; y?: number; includeScreenshot?: boolean; maxChars?: number; tabId?: string }, ctx: ToolContext) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        // Pointing at something needs both coordinates. Accepting one alone
        // would silently fall back to the document element and hand back the
        // whole page labelled as if a specific node had been inspected.
        const hasX = typeof input.x === 'number'
        const hasY = typeof input.y === 'number'
        if (hasX !== hasY) {
          return fail(
            'Incomplete coordinates',
            'Give both x and y to pick an element by point, or neither to use a selector.'
          )
        }
        const byPoint = hasX && hasY && !input.selector
        if (!byPoint && !input.selector) {
          return fail(
            'Nothing to inspect',
            'Give a selector, or both x and y to pick what is under the pointer.'
          )
        }

        const result = await target.page.call('inspect', {
          selector: byPoint ? undefined : input.selector,
          index: input.index,
          x: byPoint ? input.x : undefined,
          y: byPoint ? input.y : undefined,
          maxChars: input.maxChars ?? 8000
        })
        if (!result.ok) return bridgeResult('Inspect element', result)

        const data = result as Record<string, unknown>
        const element = (data.element ?? {}) as Record<string, unknown>
        const tag = String(element.tag ?? '?')
        const name = String(element.name ?? '')
        const text = String(element.text ?? '').slice(0, 80)

        const payload: Record<string, unknown> = {
          selector: data.selector,
          selectorMatches: data.selectorMatches,
          pickedBy: data.pickedBy,
          element,
          html: data.html,
          htmlLength: data.htmlLength,
          htmlTruncated: Number(data.htmlLength ?? 0) > String(data.html ?? '').length,
          style: data.style,
          rect: data.rect,
          url: data.url
        }

        // Best-effort. The inspection is the point; a capture that fails on a
        // machine without a compositor must not turn a good answer into a
        // failure, and must not be reported as if it had succeeded either.
        if (input.includeScreenshot) {
          try {
            const image = await target.page.screenshot()
            if (image.length > 0) {
              const stamp = new Date().toISOString().replace(/[:.]/g, '-')
              const safeTask = (ctx.taskId ?? 'adhoc').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
              const path = join(tabs.cacheDir, 'screenshots', safeTask, `inspect-${stamp}-${target.tabId.slice(0, 8)}.png`)
              const written = await writeScreenshot(path, image)
              const artifact = ctx.recordArtifact({
                taskId: ctx.taskId ?? null,
                kind: 'screenshot',
                path: written.path,
                bytes: written.bytes,
                summary: `Viewport containing <${tag}${name ? ` id="${name}"` : ''}>`
              })
              payload.screenshot = { path: written.path, bytes: written.bytes, artifactId: artifact.id }
            } else {
              payload.screenshot = { error: 'The tab produced an empty image.' }
            }
          } catch (error) {
            payload.screenshot = { error: error instanceof Error ? error.message : String(error) }
          }
        }

        return ok(
          `<${tag}${name ? ` id="${name}"` : ''}> — ${text || 'no text'} · selector ${String(data.selector)} ` +
            `(${String(data.selectorMatches)} match${Number(data.selectorMatches) === 1 ? '' : 'es'})`,
          payload
        )
      }
    ),

    tool(
      {
        id: 'browser_query_selector',
        label: 'Query selector',
        description:
          'List what a selector matches: tag, id, classes, role, visible text, attributes and on-screen position. This is how an agent discovers the selectors it did not know.',
        dependsOn: ['browser_navigate'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        selector: z.string().min(1).describe('CSS selector, or text="..." / text~="...".'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
        visibleOnly: z.boolean().optional().describe('Return only elements that are actually rendered.'),
        tabId: tabIdArg
      }),
      async (input: { selector: string; limit?: number; visibleOnly?: boolean; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const result = await target.page.call('query', {
          selector: input.selector,
          limit: input.limit ?? 50
        })
        if (!result.ok) return bridgeResult(`Query ${input.selector}`, result)

        const all = (result.items as Record<string, unknown>[]) ?? []
        const items = input.visibleOnly ? all.filter((item) => item.visible === true) : all
        return ok(`${result.total} match${result.total === 1 ? '' : 'es'} for ${input.selector}, showing ${items.length}`, {
          selector: input.selector,
          total: result.total,
          returned: items.length,
          items
        })
      }
    ),

    tool(
      {
        id: 'browser_console_logs',
        label: 'Console logs',
        description:
          'Read what the page logged, including uncaught errors and failed resource loads. This is the primary evidence that a code change broke something.',
        dependsOn: ['browser_create_tab'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        level: z.enum(['all', 'error', 'warning', 'info', 'log']).optional().describe('Default all.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Most recent N. Default 100.'),
        clear: z.boolean().optional().describe('Clear the buffer after reading, so the next measurement is clean.'),
        tabId: tabIdArg
      }),
      async (input: { level?: string; limit?: number; clear?: boolean; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const all = tabs.consoleLogs(target.tabId)
        const filtered =
          input.level && input.level !== 'all' ? all.filter((entry) => entry.level === input.level) : all
        const limit = input.limit ?? 100
        const recent = filtered.slice(-limit)

        const errors = all.filter((e) => e.level === 'error')
        const warnings = all.filter((e) => e.level === 'warning')
        if (input.clear) tabs.clearDiagnostics(target.tabId)

        return ok(`${errors.length} errors and ${warnings.length} warnings; showing ${recent.length} entries`, {
          total: all.length,
          errors: errors.length,
          warnings: warnings.length,
          entries: recent,
          cleared: input.clear ?? false,
          url: tabs.get(target.tabId)?.url ?? ''
        })
      }
    ),

    tool(
      {
        id: 'browser_network_requests',
        label: 'Network requests',
        description:
          'List the requests the page made, with status and duration, plus a summary of status codes and the slowest request.',
        dependsOn: ['browser_create_tab'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        contains: z.string().optional().describe('Only requests whose URL contains this.'),
        status: z
          .enum(['all', 'error', 'slow', 'pending'])
          .optional()
          .describe('error: 4xx/5xx. slow: over 1000ms. Default all.'),
        resourceType: z.string().optional().describe('script, xhr, document, stylesheet, image, font, media.'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 100.'),
        tabId: tabIdArg
      }),
      async (input: { contains?: string; status?: string; resourceType?: string; limit?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        let requests = tabs.networkRequests(target.tabId)
        if (input.contains) {
          const needle = input.contains.toLowerCase()
          requests = requests.filter((r) => r.url.toLowerCase().includes(needle))
        }
        if (input.resourceType) {
          const wanted = input.resourceType.toLowerCase()
          requests = requests.filter((r) => r.resourceType.toLowerCase() === wanted)
        }
        if (input.status === 'error') requests = requests.filter((r) => (r.status ?? 0) >= 400)
        if (input.status === 'slow') requests = requests.filter((r) => (r.durationMs ?? 0) > 1000)

        const all = tabs.networkRequests(target.tabId)
        const durations = new Map<string, number>()
        for (const request of all) {
          if (request.durationMs !== null) durations.set(request.url, request.durationMs)
        }
        const timed = all.map((r) => r.durationMs ?? 0)
        const summary = summarizeRequests(
          all,
          durations,
          tabs.networkFailures(target.tabId).length
        )

        return ok(
          `${requests.length} of ${summary.total} requests` +
            (Object.keys(summary.byStatus).length
              ? ` — ${Object.entries(summary.byStatus).map(([k, v]) => `${k}: ${v}`).join(', ')}`
              : ''),
          {
            summary,
            p95Ms: percentile(timed, 95),
            requests: requests.slice(-(input.limit ?? 100))
          }
        )
      }
    ),

    tool(
      {
        id: 'browser_network_failures',
        label: 'Network failures',
        description:
          'List requests that never completed — refused connections, DNS failures, blocked resources — which console logs alone often miss.',
        dependsOn: ['browser_create_tab'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
        tabId: tabIdArg
      }),
      async (input: { limit?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const failures = tabs.networkFailures(target.tabId)
        return ok(failures.length ? `${failures.length} failed requests` : 'No failed requests', {
          total: failures.length,
          failures: failures.slice(-(input.limit ?? 50)),
          deniedPermissions: tabs.deniedPermissions(target.tabId)
        })
      }
    ),

    tool(
      {
        id: 'browser_screenshot',
        label: 'Screenshot',
        description:
          'Capture the rendered page to a PNG in the application cache directory and return its path. The file is outside the source repository.',
        dependsOn: ['browser_create_tab'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        fullPage: z.boolean().optional().describe('Capture beyond the viewport. Default false.'),
        tabId: tabIdArg
      }),
      async (input: { fullPage?: boolean; tabId?: string }, ctx: ToolContext) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const data = input.fullPage
          ? await target.page.screenshotBeyondViewport()
          : await target.page.screenshot()
        if (data.length === 0) return fail('Screenshot failed', 'The tab produced an empty image.')

        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const safeTask = (ctx.taskId ?? 'adhoc').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
        const path = join(tabs.cacheDir, 'screenshots', safeTask, `${stamp}-${target.tabId.slice(0, 8)}.png`)
        const written = await writeScreenshot(path, data)

        const artifact = ctx.recordArtifact({
          taskId: ctx.taskId ?? null,
          kind: 'screenshot',
          path: written.path,
          bytes: written.bytes,
          summary: `Screenshot of ${tabs.get(target.tabId)?.url ?? 'the active tab'}`
        })
        return ok(`Saved ${written.bytes} bytes to ${written.path}`, {
          path: written.path,
          bytes: written.bytes,
          artifactId: artifact.id,
          url: tabs.get(target.tabId)?.url ?? '',
          fullPage: input.fullPage ?? false
        })
      }
    ),

    tool(
      {
        id: 'browser_evaluate_safe',
        label: 'Inspect page',
        description:
          'Run a named inspection probe over the page: summary, element, form, images, headings or timing. Probes report facts; they do not execute agent-written script, because that would be arbitrary code in the developer\'s own origin.',
        dependsOn: ['browser_navigate'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        probe: z
          .enum(['summary', 'element', 'form', 'images', 'headings', 'timing'])
          .optional()
          .describe('Default summary.'),
        selector: z.string().optional().describe('Required by the element probe; scopes the form probe.'),
        index: z.number().int().min(0).optional(),
        tabId: tabIdArg
      }),
      async (input: { probe?: string; selector?: string; index?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const probe = input.probe ?? 'summary'
        if (probe === 'element' && !input.selector) {
          return fail('Probe needs a selector', 'The element probe requires a selector.')
        }
        const result = await target.page.call('probe', {
          probe,
          selector: input.selector,
          index: input.index
        })
        if (!result.ok) return bridgeResult(`Probe ${probe}`, result)
        return ok(`Probe ${probe} complete`, result)
      }
    ),

    tool(
      {
        id: 'browser_get_accessibility_tree',
        label: 'Accessibility tree',
        description:
          'Read the accessibility tree as Chromium models it: roles and accessible names. Finds controls that the DOM describes only as a class, and unlabelled buttons.',
        dependsOn: ['browser_navigate'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        role: z.string().optional().describe('Only nodes with this role, e.g. button, link, textbox.'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 200.'),
        tabId: tabIdArg
      }),
      async (input: { role?: string; limit?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const tree = await target.page.accessibilityTree(Math.max(input.limit ?? 200, 500))
        const filtered = input.role
          ? tree.filter((node) => node.role.toLowerCase() === input.role!.toLowerCase())
          : tree
        const limit = input.limit ?? 200
        const shown = filtered.slice(0, limit)

        const unnamed = filtered.filter((node) => !node.name && INTERACTIVE_ROLES.has(node.role))
        return ok(
          `${filtered.length} nodes${input.role ? ` with role ${input.role}` : ''}; ${unnamed.length} interactive nodes have no accessible name`,
          { total: filtered.length, nodes: shown, unnamedInteractive: unnamed.slice(0, 50) }
        )
      }
    ),

    // ---------------------------------------------------- interaction extras

    tool(
      {
        id: 'browser_double_click',
        label: 'Double click',
        description:
          'Double-click an element with a real pointer event, for rows that open on a double click and text that selects a word.',
        dependsOn: ['browser_click'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        selector: z.string().min(1).describe('CSS selector, or text="..." to match visible text.'),
        index: z.number().int().min(0).optional(),
        tabId: tabIdArg
      }),
      async (input: { selector: string; index?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const result = await target.page.clickSelector(input.selector, { index: input.index, clickCount: 2 })
        if (!result.ok) return fail('Double click failed', String(result.reason ?? 'The double click did not land.'), {
          metadata: { selector: input.selector }
        })
        return ok(`Double clicked ${input.selector}`, {
          selector: input.selector,
          element: result.descriptor,
          scrolled: result.scrolled ?? false,
          point: result.point,
          consoleErrors: tabs.consoleLogs(target.tabId).filter(isProblemEntry).length
        })
      }
    ),

    tool(
      {
        id: 'browser_hover',
        label: 'Hover',
        description:
          'Move the pointer over an element without clicking, then confirm what is actually under the pointer. This is how hover-reveal menus, tooltips and drag handles are exercised.',
        dependsOn: ['browser_click'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        selector: z.string().min(1).describe('CSS selector, or text="..." to match visible text.'),
        index: z.number().int().min(0).optional(),
        tabId: tabIdArg
      }),
      async (input: { selector: string; index?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const aimed = await target.page.hoverSelector(input.selector, input.index)
        if (!aimed.ok) return fail('Hover failed', String(aimed.reason ?? 'The pointer could not reach it.'), {
          metadata: { selector: input.selector }
        })
        const point = aimed.point!

        // Reading the element back is the only way to tell "hovered the menu
        // trigger" from "hovered empty space at the same coordinate".
        const under = await target.page.call('elementAt', point)
        if (!under.ok) {
          return fail('Nothing under the pointer', String(under.reason ?? 'The pointer landed on empty space.'), {
            metadata: { selector: input.selector, point }
          })
        }
        const landed = (under.element as { testId?: string; id?: string; tag?: string } | undefined) ?? {}
        return ok(`Hovered ${input.selector}`, {
          selector: input.selector,
          point,
          element: aimed.descriptor,
          scrolled: aimed.scrolled ?? false,
          underPointer: under.element,
          landedOn: `${landed.tag ?? '?'}${landed.id ? `#${landed.id}` : ''}${landed.testId ? `[${landed.testId}]` : ''}`,
          path: under.path,
          viewport: under.viewport
        })
      }
    ),

    tool(
      {
        id: 'browser_clear',
        label: 'Clear field',
        description:
          'Empty a field the way a user does — select all, delete — and report what the field holds afterwards, so a field that refuses to clear is visible immediately.',
        dependsOn: ['browser_type'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        selector: z.string().min(1).describe('The input, textarea or contenteditable to empty.'),
        index: z.number().int().min(0).optional(),
        tabId: tabIdArg
      }),
      async (input: { selector: string; index?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const focused = await target.page.call('focus', { selector: input.selector, index: input.index })
        if (!focused.ok) return bridgeResult(`Focus ${input.selector}`, focused)
        const method = await target.page.clearField(input.selector, input.index)
        await target.page.settle(2)

        const after = await target.page.call('getValue', { selector: input.selector, index: input.index })
        const held = (after.value as { value?: string } | undefined)?.value ?? ''
        if (held !== '') {
          return fail('The field did not clear', `The field still holds ${JSON.stringify(held.slice(0, 120))}.`, {
            metadata: { selector: input.selector, method }
          })
        }
        return ok(`Cleared ${input.selector}`, {
          selector: input.selector,
          empty: true,
          method,
          element: focused.descriptor
        })
      }
    ),

    tool(
      {
        id: 'browser_check',
        label: 'Check box',
        description:
          'Tick a checkbox or radio with a real click and verify it is ticked. An element that is disabled is reported as such instead of silently left alone.',
        dependsOn: ['browser_select'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        selector: z.string().min(1).describe('An input[type=checkbox] or input[type=radio].'),
        index: z.number().int().min(0).optional(),
        tabId: tabIdArg
      }),
      async (input: { selector: string; index?: number; tabId?: string }) => setChecked(tabs, input, true)
    ),

    tool(
      {
        id: 'browser_uncheck',
        label: 'Uncheck box',
        description: 'Clear a checkbox with a real click and verify it is clear.',
        dependsOn: ['browser_check'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        selector: z.string().min(1).describe('An input[type=checkbox].'),
        index: z.number().int().min(0).optional(),
        tabId: tabIdArg
      }),
      async (input: { selector: string; index?: number; tabId?: string }) => setChecked(tabs, input, false)
    ),

    tool(
      {
        id: 'browser_drag',
        label: 'Drag',
        description:
          'Drag one element onto another with a real pointer: press, travel past Chromium\'s drag threshold in small steps, release. Used for reordering, sliders and drop targets.',
        dependsOn: ['browser_click'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        from: z.string().min(1).describe('Selector for the element to grab.'),
        to: z.string().min(1).describe('Selector for the element to drop onto.'),
        fromIndex: z.number().int().min(0).optional(),
        toIndex: z.number().int().min(0).optional(),
        steps: z.number().int().min(2).max(60).optional().describe('Intermediate moves. Default 12.'),
        tabId: tabIdArg
      }),
      async (input: { from: string; to: string; fromIndex?: number; toIndex?: number; steps?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        // The gesture is run inside the page controller: measuring, verifying
        // what is under the pointer and pressing must happen with nothing in
        // between, and a tool-level round trip per step is exactly what lets the
        // page scroll out from under the coordinates.
        const result = await target.page.dragSelector(input.from, input.to, {
          index: input.fromIndex,
          toIndex: input.toIndex,
          steps: input.steps
        })
        if (!result.ok) {
          return fail('Drag failed', String(result.reason ?? 'The drag did not start.'), {
            metadata: { from: input.from, to: input.to }
          })
        }
        return ok(`Dragged ${input.from} onto ${input.to}`, {
          from: { selector: input.from, element: result.from?.descriptor, point: result.from?.rect },
          to: { selector: input.to, element: result.to?.descriptor, point: result.to?.rect },
          steps: result.steps ?? 12,
          consoleErrors: tabs.consoleLogs(target.tabId).filter(isProblemEntry).length
        })
      }
    ),

    // ------------------------------------------------------------- inspection

    tool(
      {
        id: 'browser_query_all',
        label: 'Query all matches',
        description:
          'List every element a selector matches, optionally with all of their attributes. Use it to choose a stable selector: data-testid, id, name and role are what survive a rewrite, so they are what the agent should be clicking.',
        dependsOn: ['browser_query_selector'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        selector: z.string().min(1).describe('CSS selector, or text="..." / text~="...".'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
        attributes: z.boolean().optional().describe('Include every attribute of each match.'),
        visibleOnly: z.boolean().optional().describe('Only elements that are actually rendered.'),
        tabId: tabIdArg
      }),
      async (input: { selector: string; limit?: number; attributes?: boolean; visibleOnly?: boolean; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const limit = input.limit ?? 50
        const result = await target.page.call('query', { selector: input.selector, limit })
        if (!result.ok) return bridgeResult(`Query ${input.selector}`, result)

        let items = (result.items as Record<string, unknown>[]) ?? []
        if (input.visibleOnly) items = items.filter((item) => item.visible === true)

        if (input.attributes) {
          for (const item of items.slice(0, 25)) {
            const one = await target.page.call('attributes', {
              selector: input.selector,
              index: item.index as number
            })
            item.attributes = one.ok ? one.attributes : null
          }
        }
        return ok(`${result.total} match${result.total === 1 ? '' : 'es'} for ${input.selector}, showing ${items.length}`, {
          selector: input.selector,
          total: result.total,
          returned: items.length,
          kind: result.kind,
          attributesIncluded: input.attributes ?? false,
          items
        })
      }
    ),

    tool(
      {
        id: 'browser_get_attributes',
        label: 'Get attributes',
        description:
          'Read every attribute of one element, plus its inline style. This is how an agent confirms a test id, aria-label, href, data-state or required flag actually exists.',
        dependsOn: ['browser_query_selector'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        selector: z.string().min(1).describe('CSS selector, or text="..." / text~="...".'),
        index: z.number().int().min(0).optional(),
        tabId: tabIdArg
      }),
      async (input: { selector: string; index?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const result = await target.page.call('attributes', { selector: input.selector, index: input.index })
        if (!result.ok) return bridgeResult(`Read attributes of ${input.selector}`, result)
        const attributes = (result.attributes as Record<string, string>) ?? {}
        const keys = Object.keys(attributes)
        return ok(`${keys.length} attributes on ${input.selector}`, {
          selector: input.selector,
          count: keys.length,
          attributes,
          inlineStyle: result.style ?? {},
          element: result.element
        })
      }
    ),

    tool(
      {
        id: 'browser_get_computed_style',
        label: 'Get computed style',
        description:
          'Read the resolved CSS for one element — including whether it is really rendered, whether it overflows the viewport, its background and its measured contrast ratio. With no selector it reports page-level layout facts: viewport size, document size, horizontal overflow, the widest offenders and broken images.',
        dependsOn: ['browser_query_selector'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        selector: z.string().min(1).optional().describe('Omit for a page-level layout report.'),
        properties: z.array(z.string().min(1)).max(60).optional().describe('CSS properties to read. Omit for all.'),
        index: z.number().int().min(0).optional(),
        tabId: tabIdArg
      }),
      async (input: { selector?: string; properties?: string[]; index?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        if (!input.selector) {
          const layout = await target.page.call('layoutReport', {})
          if (!layout.ok) return bridgeResult('Read layout', layout)
          const report = layout as unknown as Record<string, unknown>
          return ok(
            `${report.images ?? 0} images, ${report.brokenImages ?? 0} broken; ` +
              `${report.horizontalOverflow ? 'horizontal overflow' : 'no horizontal overflow'} at ${(report.viewport as { width?: number })?.width ?? '?'}px`,
            report
          )
        }

        const result = await target.page.call('computedStyle', {
          selector: input.selector,
          index: input.index,
          properties: input.properties
        })
        if (!result.ok) return bridgeResult(`Read style of ${input.selector}`, result)

        const contrast = result.contrast as number | null
        const fontPx = Number.parseFloat(String(result.fontSize ?? '0')) || 0
        // WCAG 1.4.3: 3:1 for large text (18.66px bold or 24px regular), 4.5:1
        // otherwise. Without a measured contrast there is nothing to judge.
        const threshold = fontPx >= 24 ? 3 : 4.5
        const lowContrast = typeof contrast === 'number' ? contrast < threshold : false

        return ok(
          `Resolved ${Object.keys((result.properties as object) ?? {}).length} properties for ${input.selector}` +
            (contrast !== null ? `; contrast ${contrast}:1` : ''),
          {
            selector: input.selector,
            properties: result.properties,
            visible: result.visible,
            rect: result.rect,
            overflowsViewport: result.overflowsViewport,
            clipped: result.clipped,
            color: result.color,
            backgroundColor: result.backgroundColor,
            fontSize: result.fontSize,
            contrast,
            lowContrast,
            contrastThreshold: typeof contrast === 'number' ? threshold : null
          }
        )
      }
    ),

    // ------------------------------------------------------------ file inputs

    tool(
      {
        id: 'browser_upload_file',
        label: 'Upload file',
        description:
          'Attach files to a file input, or drop them on an element. Files can be given as paths, or generated on the spot as real PNG/JPEG/WebP/GIF/SVG/PDF/ZIP/CSV/JSON/XML/text assets — generated in a temporary directory outside the project, and never an executable.',
        dependsOn: ['browser_navigate'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        selector: z.string().min(1).describe('The input[type=file], or the drop target.'),
        paths: z.array(z.string().min(1)).max(20).optional().describe('Existing files to attach. Must exist on disk.'),
        generate: z
          .array(z.enum(['png', 'jpg', 'webp', 'svg', 'gif', 'txt', 'csv', 'json', 'xml', 'pdf', 'zip', 'empty', 'malformed', 'large'] as [AssetKind, ...AssetKind[]]))
          .max(10)
          .optional()
          .describe('Generate these asset kinds instead of using existing files.'),
        mode: z.enum(['select', 'drop']).optional().describe('select: file input. drop: dispatch a real drop. Default select.'),
        index: z.number().int().min(0).optional(),
        tabId: tabIdArg
      }),
      async (input: {
        selector: string
        paths?: string[]
        generate?: AssetKind[]
        mode?: 'select' | 'drop'
        index?: number
        tabId?: string
      }, ctx: ToolContext) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)
        if ((tabs.get(target.tabId)?.url ?? '').startsWith('about:')) {
          return fail('The tab has no page', 'Navigate to a page before uploading a file.')
        }

        const wanted = [...(input.paths ?? []), ...(input.generate ?? [])]
        if (wanted.length === 0) {
          return fail('Nothing to upload', 'Nothing to upload: give paths to existing files or generate to create assets.', {
            metadata: { availableKinds: ASSET_CATALOG.map((a) => a.kind) }
          })
        }

        const files: { path: string; name: string; bytes: number; origin: string; note?: string }[] = []
        for (const kind of input.generate ?? []) {
          try {
            const asset = generateAsset({ kind }, ctx.taskId ?? undefined)
            const check = verifyAsset(asset.path)
            if (!check.exists || !check.readable || check.bytes !== asset.bytes) {
              return fail('Generated asset did not verify', `${asset.name} was written but could not be read back at the same size.`)
            }
            files.push({ path: asset.path, name: asset.name, bytes: asset.bytes, origin: 'generated', note: asset.note })
          } catch (err) {
            return fail('Asset generation refused', err instanceof Error ? err.message : String(err))
          }
        }
        for (const path of input.paths ?? []) {
          const lower = path.toLowerCase()
          const blocked = BLOCKED_EXTENSIONS.find((ext) => lower.endsWith(ext))
          if (blocked) {
            return fail('Refused to upload an executable', `${blocked} is an executable extension; upload tests use documents and images.`)
          }
          const check = verifyAsset(path)
          if (!check.exists) return fail('File not found', `No file at ${path}.`)
          files.push({
            path,
            name: path.split(/[\\/]/).pop() ?? path,
            bytes: check.bytes,
            origin: 'existing',
            note: check.readable ? 'readable' : 'present but not readable'
          })
        }

        const paths = files.map((f) => f.path)
        const mode = input.mode ?? 'select'
        if (mode === 'drop') {
          const found = await target.page.call('reveal', { selector: input.selector, index: input.index })
          if (!found.ok) return bridgeResult(`Drop on ${input.selector}`, found)
          const rect = found.rect as { centerX: number; centerY: number }
          await target.page.dropFiles({ x: rect.centerX, y: rect.centerY }, paths)
          return ok(`Dropped ${files.length} file${files.length === 1 ? '' : 's'} on ${input.selector}`, {
            selector: input.selector,
            mode,
            files,
            note: 'A drop is delivered to the page; confirm receipt with the element\'s own state.'
          })
        }

        try {
          await target.page.setFiles(input.selector, paths)
        } catch (err) {
          return fail('Could not attach files', err instanceof Error ? err.message : String(err), {
            metadata: { selector: input.selector }
          })
        }
        await target.page.settle(2)

        const after = await target.page.call('getValue', { selector: input.selector, index: input.index })
        const value = (after.value as { fileCount?: number; files?: unknown[]; value?: string } | undefined) ?? {}
        const count = value.fileCount ?? 0
        if (count === 0) {
          return fail('The page did not accept the files', `${input.selector} still reports no selected file.`, {
            metadata: { selector: input.selector, files }
          })
        }
        return ok(`Attached ${count} file${count === 1 ? '' : 's'} to ${input.selector}`, {
          selector: input.selector,
          mode,
          files,
          accepted: count,
          acceptedFiles: value.files ?? [],
          element: after.descriptor ?? null
        })
      }
    ),

    tool(
      {
        id: 'browser_download_file',
        label: 'Download file',
        description:
          'Trigger a download — by clicking a link or by navigating to a URL — and wait for it to finish, then confirm the file really landed on disk with bytes in it. Saved under the application cache, never inside the project.',
        dependsOn: ['browser_navigate'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        selector: z.string().min(1).optional().describe('A link to click.'),
        url: z.string().min(1).optional().describe('A URL to navigate to instead of clicking.'),
        index: z.number().int().min(0).optional(),
        timeoutMs: z.number().int().min(1000).max(120_000).optional().describe('Default 20000.'),
        tabId: tabIdArg
      }),
      async (input: { selector?: string; url?: string; index?: number; timeoutMs?: number; tabId?: string }, ctx: ToolContext) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)
        if (!input.selector && !input.url) {
          return fail('Nothing to download', 'Give a selector to click or a URL to navigate to.')
        }

        if (input.selector) {
          const clicked = await target.page.clickSelector(input.selector, { index: input.index })
          if (!clicked.ok) return fail('Download link click failed', String(clicked.reason ?? 'The link was not clicked.'))
        } else {
          const normalized = normalizeUrl(input.url!)
          if (!normalized.ok) return fail('Refused to navigate', normalized.error)
          const started = await tabs.navigate(target.tabId, normalized.url)
          if (!started.ok) return fail('Navigation failed', started.error ?? 'The page did not load.')
        }

        const record = await tabs.waitForDownload({
          tabId: target.tabId,
          timeoutMs: input.timeoutMs ?? 20_000,
          signal: ctx.signal
        })
        if (!record) {
          return fail('No download completed', `Nothing finished downloading within ${input.timeoutMs ?? 20_000}ms.`, {
            failureKind: 'timeout',
            metadata: { attempted: tabs.downloads(target.tabId), downloadDir: tabs.downloadDir }
          })
        }
        if (record.state !== 'completed') {
          return fail(`Download ${record.state}`, `${record.filename} ended as ${record.state} after ${record.received} bytes.`, {
            failureKind: 'failed',
            metadata: { record }
          })
        }

        const onDisk = record.savePath && existsSync(record.savePath) ? statSync(record.savePath).size : 0
        if (onDisk === 0) {
          return fail('The download produced no file', `${record.filename} reported complete but nothing is at ${record.savePath}.`, {
            failureKind: 'failed',
            metadata: { record }
          })
        }
        const artifact = ctx.recordArtifact({
          taskId: ctx.taskId ?? null,
          kind: 'other',
          path: record.savePath,
          bytes: onDisk,
          summary: `Downloaded ${record.filename} from ${record.url}`
        })
        return ok(`Downloaded ${record.filename} (${onDisk} bytes)`, {
          filename: record.filename,
          path: record.savePath,
          bytes: onDisk,
          url: record.url,
          mimeType: record.mimeType,
          artifactId: artifact.id,
          downloadDir: tabs.downloadDir
        })
      }
    ),

    tool(
      {
        id: 'browser_wait_for_download',
        label: 'Wait for download',
        description:
          'Wait for a download to finish without triggering one — for a file that starts on page load, or one another step already clicked. Reports the terminal state rather than assuming success.',
        dependsOn: ['browser_create_tab'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        filename: z.string().min(1).optional().describe('Wait for this exact file name.'),
        timeoutMs: z.number().int().min(500).max(120_000).optional().describe('Default 20000.'),
        tabId: tabIdArg
      }),
      async (input: { filename?: string; timeoutMs?: number; tabId?: string }, ctx: ToolContext) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const timeoutMs = input.timeoutMs ?? 20_000
        const record = await tabs.waitForDownload({
          tabId: target.tabId,
          filename: input.filename,
          timeoutMs,
          signal: ctx.signal
        })
        if (!record) {
          return fail('No download completed', `Nothing finished downloading within ${timeoutMs}ms.`, {
            failureKind: 'timeout',
            metadata: { attempted: tabs.downloads(target.tabId), downloadDir: tabs.downloadDir }
          })
        }
        const onDisk = record.savePath && existsSync(record.savePath) ? statSync(record.savePath).size : 0
        return ok(
          record.state === 'completed'
            ? `Downloaded ${record.filename} (${onDisk} bytes)`
            : `Download ${record.state}: ${record.filename} (${record.received} bytes)`,
          { record, bytes: onDisk, existsOnDisk: onDisk > 0 }
        )
      }
    ),

    // ----------------------------------------------------------- more waiting

    tool(
      {
        id: 'browser_wait_for_navigation',
        label: 'Wait for navigation',
        description:
          'Wait for the tab to finish loading a new document — either any URL change or one containing a given string. Reports the URL it settled on, so a redirect that goes somewhere unexpected is visible.',
        dependsOn: ['browser_navigate'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        url: z.string().min(1).optional().describe('Substring the final URL must contain.'),
        expectChange: z.boolean().optional().describe('Require the URL to differ from the current one. Default true.'),
        timeoutMs: z.number().int().min(100).max(120_000).optional().describe('Default 20000.'),
        tabId: tabIdArg
      }),
      async (input: { url?: string; expectChange?: boolean; timeoutMs?: number; tabId?: string }, ctx: ToolContext) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const before = tabs.get(target.tabId)?.url ?? ''
        const wantChange = input.expectChange !== false
        const timeoutMs = input.timeoutMs ?? 20_000
        const deadline = Date.now() + timeoutMs
        const started = Date.now()

        for (;;) {
          if (ctx.signal?.aborted) {
            return fail('Cancelled', 'The wait for navigation was cancelled.', { failureKind: 'cancelled' })
          }
          const record = tabs.get(target.tabId)
          const now = record?.url ?? ''
          const loading = record?.loading ?? false
          const matches = input.url ? now.includes(input.url) : !wantChange || now !== before
          if (matches && !loading) {
            return ok(`Settled on ${now} after ${Date.now() - started}ms`, {
              from: before,
              to: now,
              changed: now !== before,
              matched: input.url ?? null,
              title: record?.title ?? '',
              elapsedMs: Date.now() - started
            })
          }
          if (Date.now() >= deadline) {
            return fail('Navigation did not settle', `Still on ${now}${loading ? ' and still loading' : ''} after ${timeoutMs}ms.`, {
              failureKind: 'timeout',
              metadata: { from: before, current: now, loading, waitingFor: input.url ?? 'any change' }
            })
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    ),

    tool(
      {
        id: 'browser_wait_for_element',
        label: 'Wait for element',
        description:
          'Wait for an element to appear, become visible, become enabled, or disappear, then describe it. Reports the element it found rather than a bare boolean.',
        dependsOn: ['browser_wait'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        selector: z.string().min(1).describe('CSS selector, or text="..." / text~="...".'),
        state: z.enum(['attached', 'visible', 'detached', 'hidden']).optional().describe('Default visible.'),
        timeoutMs: z.number().int().min(100).max(120_000).optional().describe('Default 15000.'),
        index: z.number().int().min(0).optional(),
        tabId: tabIdArg
      }),
      async (input: { selector: string; state?: string; timeoutMs?: number; index?: number; tabId?: string }, ctx: ToolContext) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const state = (input.state ?? 'visible') as 'attached' | 'visible' | 'detached' | 'hidden'
        const waitState = state === 'hidden' ? 'detached' : state
        const result = await target.page.waitFor({
          selector: input.selector,
          state: waitState,
          timeoutMs: input.timeoutMs ?? 15_000,
          signal: ctx.signal
        })
        if (!result.ok) {
          return fail('Element did not arrive', String(result.reason), {
            failureKind: 'timeout',
            metadata: { selector: input.selector, state, elapsedMs: result.elapsedMs }
          })
        }
        if (waitState === 'detached') {
          return ok(`${input.selector} is gone after ${result.elapsedMs}ms`, {
            selector: input.selector,
            state,
            elapsedMs: result.elapsedMs
          })
        }
        const found = await target.page.call('locate', { selector: input.selector, index: input.index })
        const attributes = await target.page.call('attributes', { selector: input.selector, index: input.index })
        return ok(`${input.selector} is ${state} after ${result.elapsedMs}ms`, {
          selector: input.selector,
          state,
          elapsedMs: result.elapsedMs,
          element: found.ok ? found.descriptor : null,
          attributes: attributes.ok ? attributes.attributes : null
        })
      }
    ),

    // ---------------------------------------------------------------- storage

    tool(
      {
        id: 'browser_get_storage',
        label: 'Get storage',
        description:
          'Read what the page can see: localStorage, sessionStorage and the cookie names for the tab\'s own session. Values are returned; cookie values never are.',
        dependsOn: ['browser_create_tab'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({ tabId: tabIdArg }),
      async (input: { tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const report = await tabs.storage(target.tabId)
        if (!report) return noTabResult({ message: 'No browser tab.', open: tabs.list() })
        if (report.origin === '' || report.origin === 'null') {
          return fail('This page has no storage', `${tabs.get(target.tabId)?.url ?? 'This origin'} cannot use web storage (about:blank or a file: page has no origin).`, {
            metadata: { url: tabs.get(target.tabId)?.url ?? '' }
          })
        }
        return ok(
          `${Object.keys(report.localStorage).length} local and ${Object.keys(report.sessionStorage).length} session keys; ${report.cookieCount} cookies`,
          report
        )
      }
    ),

    tool(
      {
        id: 'browser_set_storage',
        label: 'Set storage',
        description:
          'Write, remove or clear a localStorage or sessionStorage key, then read it back and report the stored value. This is how an agent sets up an auth token or a feature flag without touching the application source.',
        dependsOn: ['browser_get_storage'],
        tier: 'ask',
        inputSchema: {},
        sensitiveArgs: ['value']
      },
      'browser.interact',
      z.object({
        area: z.enum(['local', 'session']).optional().describe('Default local.'),
        key: z.string().min(1).optional().describe('Key to write or remove.'),
        value: z.string().optional().describe('Value to store. Strings only, exactly as the page would read it.'),
        remove: z.boolean().optional().describe('Remove the key instead of writing it.'),
        clear: z.boolean().optional().describe('Clear the whole area instead of touching one key.'),
        tabId: tabIdArg
      }),
      async (input: { area?: 'local' | 'session'; key?: string; value?: string; remove?: boolean; clear?: boolean; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)
        if (REQUIRES_ORIGIN.has('browser_set_storage') && (tabs.get(target.tabId)?.url ?? '').startsWith('about:')) {
          return fail('This page has no storage', 'about:blank has no origin, so localStorage and sessionStorage do not exist. Navigate first.')
        }
        if (!input.clear && !input.remove && !input.key) {
          return fail('Nothing to write', 'Give a key, or pass remove or clear.')
        }

        const area = input.area ?? 'local'
        const write = await target.page.call('setStorage', {
          area,
          key: input.key,
          value: input.value,
          remove: input.remove,
          clear: input.clear
        })
        if (!write.ok) return bridgeResult(`Write ${area}Storage`, write)

        // Read the value back rather than trusting the write's own success flag:
        // a full quota or a serialisation error is a silent no-op in some pages.
        const back = await target.page.call('storage', {})
        if (!back.ok) {
          return bridgeResult(`Verify ${area}Storage`, back)
        }
        const stored = back as unknown as {
          localStorage?: Record<string, string>
          sessionStorage?: Record<string, string>
        }
        const table = area === 'session' ? stored.sessionStorage ?? {} : stored.localStorage ?? {}

        if (input.clear) {
          const left = Object.keys(table).length
          if (left > 0) return fail('The area did not clear', `${left} keys remain in ${area}Storage.`, { metadata: { left } })
          return ok(`Cleared ${area}Storage`, { area, cleared: true, remaining: 0 })
        }
        if (input.remove) {
          if (input.key! in table) {
            return fail('The key was not removed', `${input.key} is still in ${area}Storage.`, { metadata: { key: input.key } })
          }
          return ok(`Removed ${input.key} from ${area}Storage`, { area, removed: input.key, remaining: Object.keys(table).length })
        }
        const landed = table[input.key!]
        if (landed !== String(input.value ?? '')) {
          return fail('The value did not land', `Read back ${JSON.stringify(landed)} instead of what was written.`, {
            metadata: { key: input.key, area }
          })
        }
        return ok(`Set ${area}Storage["${input.key}"]`, {
          area,
          key: input.key,
          stored: landed,
          length: landed.length,
          remaining: Object.keys(table).length
        })
      }
    ),

    tool(
      {
        id: 'browser_get_cookies',
        label: 'Get cookies',
        description:
          'List the cookies for the tab\'s own session with their flags and lifetimes. Values are never returned: a cookie is a credential, and its length is what an auth test actually needs.',
        dependsOn: ['browser_create_tab'],
        tier: 'safe',
        inputSchema: {}
      },
      'browser.read',
      z.object({
        filter: z.string().min(1).optional().describe('Only cookies whose name contains this.'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 100.'),
        tabId: tabIdArg
      }),
      async (input: { filter?: string; limit?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const all = await tabs.cookies(target.tabId)
        const filtered = input.filter
          ? all.filter((cookie) => cookie.name.toLowerCase().includes(input.filter!.toLowerCase()))
          : all
        const shown = filtered.slice(0, input.limit ?? 100)
        return ok(`${filtered.length} cookies${input.filter ? ` matching "${input.filter}"` : ''}`, {
          total: all.length,
          returned: shown.length,
          cookies: shown,
          valuesIncluded: false,
          sessionOnly: filtered.filter((c) => c.session).length,
          storagePath: (await tabs.storage(target.tabId))?.storagePath ?? null
        })
      }
    ),

    tool(
      {
        id: 'browser_clear_cookies',
        label: 'Clear cookies',
        description:
          'Delete cookies from the tab\'s session — all of them, or only one origin\'s — and report how many went. This is how a logout test starts from a clean session.',
        dependsOn: ['browser_get_cookies'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        url: z.string().min(1).optional().describe('Only clear this origin. Omit to clear every cookie in the session.'),
        tabId: tabIdArg
      }),
      async (input: { url?: string; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const result = await tabs.clearCookies(target.tabId, input.url)
        if (!result.ok) return fail('Could not clear cookies', result.message ?? 'The session refused the request.')
        const remaining = await tabs.cookies(target.tabId)
        return ok(`Cleared ${result.cleared} cookie${result.cleared === 1 ? '' : 's'}; ${remaining.length} remain`, {
          cleared: result.cleared,
          remaining: remaining.length,
          remainingNames: remaining.slice(0, 50).map((c) => c.name),
          scope: input.url ?? 'all origins'
        })
      }
    ),

    // -------------------------------------------------------- dialogs/permissions

    tool(
      {
        id: 'browser_handle_dialog',
        label: 'Handle dialog',
        description:
          'Answer an alert, confirm, prompt or beforeunload dialog. Every dialog is captured and auto-dismissed so a page can never freeze the agent; this tool waits for one, then accepts or dismisses it with an optional prompt response.',
        dependsOn: ['browser_click'],
        tier: 'ask',
        inputSchema: {},
        sensitiveArgs: ['response']
      },
      'browser.interact',
      z.object({
        action: z.enum(['accept', 'dismiss', 'list']).optional().describe('Default accept. list: report pending dialogs without answering.'),
        dialogId: z.string().min(1).optional().describe('Answer this dialog. Default: the oldest pending one.'),
        response: z.string().optional().describe('Text for a prompt() dialog.'),
        timeoutMs: z.number().int().min(100).max(120_000).optional().describe('How long to wait for a dialog. Default 5000.'),
        tabId: tabIdArg
      }),
      async (input: { action?: 'accept' | 'dismiss' | 'list'; dialogId?: string; response?: string; timeoutMs?: number; tabId?: string }, ctx: ToolContext) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const action = input.action ?? 'accept'
        if (action === 'list') {
          const pending = tabs.pendingDialogs(target.tabId)
          return ok(pending.length ? `${pending.length} pending dialog${pending.length === 1 ? '' : 's'}` : 'No pending dialogs', {
            pending
          })
        }

        const timeoutMs = input.timeoutMs ?? 5_000
        const deadline = Date.now() + timeoutMs
        let dialog = input.dialogId
          ? tabs.pendingDialogs(target.tabId).find((d) => d.id === input.dialogId) ?? null
          : tabs.pendingDialogs(target.tabId)[0] ?? null

        while (!dialog && Date.now() < deadline && !ctx.signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 80))
          const pending = tabs.pendingDialogs(target.tabId)
          dialog = input.dialogId ? pending.find((d) => d.id === input.dialogId) ?? null : pending[0] ?? null
        }
        if (!dialog) {
          return fail('No dialog appeared', `Nothing opened a dialog within ${timeoutMs}ms.`, {
            failureKind: 'timeout',
            metadata: { url: tabs.get(target.tabId)?.url ?? '' }
          })
        }

        const answered = await tabs.answerDialog(target.tabId, dialog.id, action, input.response)
        if (!answered.ok) return fail('Could not answer the dialog', answered.message ?? 'The page stopped listening.')
        await target.page.settle(2)
        return ok(`${action === 'accept' ? 'Accepted' : 'Dismissed'} a ${dialog.type} dialog`, {
          dialog,
          action,
          responseGiven: input.response !== undefined,
          url: tabs.get(target.tabId)?.url ?? ''
        })
      }
    ),

    tool(
      {
        id: 'browser_handle_permission',
        label: 'Handle permission',
        description:
          'Grant or deny a browser permission for a tab — fullscreen, pointer lock, clipboard — and report whether the page actually asked for it. Everything else stays denied; each refusal is recorded so a blocked feature is explained rather than mysterious.',
        dependsOn: ['browser_create_tab'],
        tier: 'ask',
        inputSchema: {}
      },
      'browser.interact',
      z.object({
        permission: z
          .enum(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock'])
          .optional()
          .describe('Omit to report the current grants and refusals.'),
        allow: z.boolean().optional().describe('Grant (true) or deny (false). Omit with a permission to report only.'),
        waitMs: z.number().int().min(0).max(30_000).optional().describe('After deciding, wait this long to see whether the page requests it.'),
        tabId: tabIdArg
      }),
      async (input: { permission?: string; allow?: boolean; waitMs?: number; tabId?: string }) => {
        const target = resolveTab(tabs, input.tabId)
        if (!target.ok) return noTabResult(target)

        const current = tabs.permissions(target.tabId)
        if (!input.permission || input.allow === undefined) {
          return ok(
            `${Object.keys(current.granted).length} explicit grants, ${current.denied.length} refusals`,
            { ...current, grantable: ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock'] }
          )
        }

        const before = current.denied.length
        const decision = tabs.setPermission(target.tabId, input.permission, input.allow)
        if (!decision.ok) return fail('Permission refused', decision.message ?? 'Cryptoric will not grant that.')

        let requested = false
        const waitMs = input.waitMs ?? 0
        if (waitMs > 0) {
          const deadline = Date.now() + waitMs
          while (Date.now() < deadline) {
            if (tabs.permissions(target.tabId).denied.length > before) { requested = true; break }
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
        const after = tabs.permissions(target.tabId)
        return ok(
          `${input.allow ? 'Granted' : 'Denied'} ${input.permission}` +
            (waitMs > 0 ? `; the page ${requested ? 'asked for it' : 'did not ask for it'}` : ''),
          { permission: input.permission, allow: input.allow, requested, waitedMs: waitMs, ...after }
        )
      }
    )
  ]
}

/** `browser_check` and `browser_uncheck` differ only in the state they demand. */
async function setChecked(
  tabs: BrowserTabManager,
  input: { selector: string; index?: number; tabId?: string },
  want: boolean
): Promise<ToolResult> {
  const target = resolveTab(tabs, input.tabId)
  if (!target.ok) return noTabResult(target)
  const label = want ? 'Check' : 'Uncheck'

  const found = await target.page.call('reveal', { selector: input.selector, index: input.index })
  if (!found.ok) return bridgeResult(`${label} ${input.selector}`, found)
  const descriptor = found.descriptor as { type?: string; disabled?: boolean } | undefined
  if (descriptor?.disabled) {
    return fail(`${label} failed`, `${input.selector} is disabled, so it cannot be ${want ? 'checked' : 'unchecked'}.`, {
      metadata: { selector: input.selector }
    })
  }

  const result = await target.page.call('setValue', {
    selector: input.selector,
    value: want ? 'true' : 'false',
    index: input.index
  })
  if (!result.ok) return bridgeResult(`${label} ${input.selector}`, result)
  await target.page.settle(2)

  const after = await target.page.call('getValue', { selector: input.selector, index: input.index })
  const checked = (after.value as { checked?: boolean } | undefined)?.checked === true
  if (checked !== want) {
    return fail(`${label} failed`, `The element reports checked=${checked}.`, {
      metadata: { selector: input.selector, expected: want }
    })
  }
  return ok(`${want ? 'Checked' : 'Unchecked'} ${input.selector}`, {
    selector: input.selector,
    checked,
    kind: result.kind ?? descriptor?.type ?? null,
    element: after.descriptor ?? found.descriptor ?? null
  })
}

/** Roles a keyboard or screen-reader user can operate. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'menuitem',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'option'
])
