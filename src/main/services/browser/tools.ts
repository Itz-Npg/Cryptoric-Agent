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
  browser_query_selector: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false },
  browser_console_logs: { category: 'browser', risk: 'safe', timeoutMs: 15_000, mutates: false },
  browser_network_requests: { category: 'browser', risk: 'safe', timeoutMs: 15_000, mutates: false },
  browser_network_failures: { category: 'browser', risk: 'safe', timeoutMs: 15_000, mutates: false },
  browser_screenshot: { category: 'browser', risk: 'low', timeoutMs: 45_000, mutates: false },
  browser_evaluate_safe: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false },
  browser_get_accessibility_tree: { category: 'browser', risk: 'safe', timeoutMs: 30_000, mutates: false }
}

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
  ): ToolDefinition => ({
    descriptor: {
      ...TOOL_META[descriptor.id],
      ...descriptor,
      platforms: descriptor.platforms ?? ['*'],
      inputSchema: describeSchema(schema)
    },
    domain,
    schema,
    dependsOn,
    execute: execute as ToolDefinition['execute']
  })

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
      async (input: { tabId?: string; temporaryOnly?: boolean }) => {
        if (input.temporaryOnly) {
          const closed = await tabs.closeTemporary()
          return ok(`Closed ${closed} temporary tab${closed === 1 ? '' : 's'}`, { closed })
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

        const found = await target.page.call('locate', { selector: input.selector, index: input.index })
        if (!found.ok) return bridgeResult(`Click ${input.selector}`, found)

        const rect = found.rect as { centerX: number; centerY: number }
        const point = { x: rect.centerX, y: rect.centerY }
        if (input.clickCount === 2) await target.page.doubleClickAt(point)
        else await target.page.clickAt(point, input.clickCount ?? 1)
        await target.page.settle(3)

        return ok(`Clicked ${input.selector}`, {
          selector: input.selector,
          matches: found.count,
          element: found.descriptor,
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
        inputSchema: {}
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
        try {
          if (input.clear !== false) await target.page.replaceValue(input.text)
          else typed = await target.page.typeText(input.text, mode, input.delayMs ?? 0)
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
          const found = await target.page.call('locate', { selector: input.selector })
          if (!found.ok) return bridgeResult(`Scroll to ${input.selector}`, found)
          const rect = found.rect as { centerX: number; centerY: number }
          point = { x: rect.centerX, y: rect.centerY }
        } else {
          point = undefined
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
    )
  ]
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