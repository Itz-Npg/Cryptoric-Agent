/**
 * Page control: everything the agent does to one tab's document.
 *
 * The split matters. `tabs.ts` owns lifecycle, storage and diagnostics; this
 * module owns the two ways a page can be driven:
 *
 *  - **Isolated-world bridge** for reading, and for anything the page's own
 *    framework must observe (setting a value, reading text, finding elements).
 *  - **DevTools protocol** for input. Clicks, keystrokes and scrolls are real
 *    OS-level-equivalent events, so React, Vue and canvas apps respond exactly
 *    as they do for a human. A synthetic `element.click()` bypasses the
 *    pointer and focus machinery and is the single most common reason an
 *    automated browser test "passes" against an app the user cannot use.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WebContents } from 'electron'
import bridgeSource from './page-bridge.js?raw'
import { clip } from './dom'
import { describeKey, modifierBit, modifiersMask, type KeyDescriptor } from './keys'

/**
 * Isolated world id for Cryptoric's helpers.
 *
 * Arbitrary but fixed: it must not collide with a framework's own isolated
 * world (Electron uses 0 for the main world and 999 for the "isolated world"
 * used by some embedders).
 */
const BRIDGE_WORLD = 9999

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reject if a Chromium call does not settle in time.
 *
 * Compositor and protocol calls can wedge on machines without a usable GPU
 * surface. Bounding them keeps a broken capture from becoming a hung tool call.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Chromium did not respond within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([work, guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Run a bridge method and normalise its outcome. */
export interface BridgeResult<T = Record<string, unknown>> {
  ok: boolean
  value?: T
  reason?: string
  [key: string]: unknown
}

/** One node of the DevTools accessibility tree. */
export interface AccessibilityNode {
  role: string
  name: string
  value: string
  description: string
  focused: boolean
  disabled: boolean
}

interface AxNode {
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  description?: { value?: unknown }
  focused?: boolean
  disabled?: boolean
}

export class PageController {
  /**
   * Attaches the DevTools protocol on first use.
   *
   * `debugger.attach` is idempotent-safe here because we check `isAttached`
   * first, which matters when the developer has DevTools open on the same tab.
   */
  private debuggerAttached = false

  /**
   * The protocol is not attached until the view has begun loading.
   *
   * Attaching to a `WebContentsView` that has never rendered is not merely
   * useless — on some builds it takes the renderer process down with it. The
   * tab manager calls `arm()` on the first load signal, and everything that
   * needs the protocol waits for that.
   */
  private armed = false
  private loadedOnce = false
  private pendingMetrics: { width: number; height: number } | null = null

  constructor(private readonly wc: WebContents) {}

  get contents(): WebContents {
    return this.wc
  }

  get destroyed(): boolean {
    return this.wc.isDestroyed()
  }

  // ------------------------------------------------------------ bridge I/O

  /**
   * Make sure this document has the Cryptoric bridge, then call into it.
   *
   * The isolated world is torn down on every navigation, so the check is not
   * paranoia — it is the normal path after `browser_navigate` and `reload`.
   */
  async call<T = Record<string, unknown>>(method: string, args: unknown = {}): Promise<BridgeResult<T>> {
    if (this.destroyed) return { ok: false, reason: 'The tab is closed.' }

    await this.ensureBridge()

    const call = `globalThis.__cryptoric[${JSON.stringify(method)}](${JSON.stringify(args ?? {})})`
    try {
      const value = (await this.wc.executeJavaScriptInIsolatedWorld(BRIDGE_WORLD, [{ code: call }])) as
        | BridgeResult<T>
        | undefined
      if (value === undefined) return { ok: false, reason: 'The page produced no result.' }
      return value
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A navigation mid-call invalidates the execution context, not the tab.
      return { ok: false, reason: `Page call "${method}" failed: ${message}` }
    }
  }

  private bridgeInstalled = false

  private async ensureBridge(): Promise<void> {
    if (this.bridgeInstalled) return
    try {
      const present = await this.wc.executeJavaScriptInIsolatedWorld(BRIDGE_WORLD, [
        { code: 'typeof globalThis.__cryptoric' }
      ])
      if (present === 'object') {
        this.bridgeInstalled = true
        return
      }
      await this.wc.executeJavaScriptInIsolatedWorld(BRIDGE_WORLD, [{ code: bridgeSource }])
      this.bridgeInstalled = true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Could not reach the page: ${message}. It may be mid-navigation or showing a browser-level error page.`
      )
    }
  }

  /** Called after a navigation, because the old bridge died with the document. */
  invalidate(): void {
    this.bridgeInstalled = false
  }

  /**
   * Attach the DevTools protocol.
   *
   * This must happen **before the first navigation**. Attaching part-way
   * through a page load leaves the renderer's input pipeline attached to the
   * previous document: `elementFromPoint` agrees with the coordinates, the
   * dispatch resolves successfully, and no click or keystroke ever reaches the
   * page. Attaching once, up front, is the only ordering that works.
   */
  async attachProtocol(): Promise<void> {
    if (this.destroyed) return
    if (this.wc.debugger.isAttached()) {
      this.debuggerAttached = true
      return
    }
    try {
      this.wc.debugger.attach('1.3')
      this.debuggerAttached = true
      this.armed = true
    } catch (err) {
      // The tab still works for reading and navigation; only input degrades.
      this.debuggerAttached = false
    }
  }

  /** The view has begun loading. */
  arm(): void {
    this.armed = true
  }

  /**
   * A load has committed, so it is safe to apply the viewport override.
   *
   * Timing matters more than it looks. `Emulation.setDeviceMetricsOverride`
   * applied while a navigation is still in flight leaves the renderer reporting
   * a viewport while still routing pointer events through the previous page's
   * widget tree: coordinates resolve to the right element under
   * `elementFromPoint`, the click reports success, and nothing happens. Applying
   * it after the document settles is the only ordering that works.
   */
  settleViewport(): void {
    this.armed = true
    this.loadedOnce = true
    void this.applyPendingMetrics()
  }

  // ------------------------------------------------------------------ waits

  /**
   * Resolve when the document finishes loading.
   *
   * `did-finish-load` alone is not enough: a dev server's client-side router
   * keeps rendering afterwards, so an agent that screenshots on `finish` sees
   * a spinner. Pairing it with `readyState === 'complete'` plus one settle tick
   * is the difference between a screenshot of the app and a screenshot of a
   * loading state.
   */
  async waitForLoad(timeoutMs = 30_000, signal?: AbortSignal): Promise<boolean> {
    if (this.destroyed) return false
    if (this.wc.isLoading()) {
      const settled = await new Promise<boolean>((resolve) => {
        const done = (value: boolean): void => {
          clearTimeout(timer)
          this.wc.off('did-finish-load', onDone)
          this.wc.off('did-fail-load', onFail)
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        }
        const onDone = (): void => done(true)
        const onFail = (): void => done(false)
        const onAbort = (): void => done(false)
        const timer = setTimeout(() => done(false), timeoutMs)
        timer.unref?.()
        this.wc.once('did-finish-load', onDone)
        this.wc.once('did-fail-load', onFail)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      if (!settled) return false
    }
    await this.settle()
    return true
  }

  /** One macrotask, so queued microtasks and one paint have run. */
  async settle(ticks = 2): Promise<void> {
    for (let i = 0; i < ticks; i += 1) await sleep(16)
  }

  /**
   * Poll the page for a condition.
   *
   * Polling rather than a page-side promise: the bridge is synchronous by
   * design, and `executeJavaScriptInIsolatedWorld` does not await a returned
   * promise, so a promise-returning waiter would hang until the tool timed out.
   */
  async waitFor(options: {
    selector?: string
    text?: string
    state?: 'attached' | 'detached' | 'visible'
    timeoutMs: number
    intervalMs?: number
    signal?: AbortSignal
  }): Promise<{ ok: boolean; reason?: string; elapsedMs: number }> {
    const started = Date.now()
    const deadline = started + options.timeoutMs
    const interval = options.intervalMs ?? 100

    for (;;) {
      if (options.signal?.aborted) {
        return { ok: false, reason: 'Cancelled while waiting.', elapsedMs: Date.now() - started }
      }
      const matched = await this.evaluate(options)
      if (matched) return { ok: true, elapsedMs: Date.now() - started }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          reason: this.describeWait(options),
          elapsedMs: Date.now() - started
        }
      }
      await sleep(interval)
      this.invalidateIfNavigating()
    }
  }

  private async evaluate(options: { selector?: string; text?: string; state?: string }): Promise<boolean> {
    const wantsGone = options.state === 'detached'
    if (options.selector) {
      const found = await this.call('query', { selector: options.selector, limit: 1 })
      if (!found.ok) return false
      const total = (found.total as number) ?? 0
      if (wantsGone) return total === 0
      if (options.state === 'visible') {
        const items = (found.items as { visible?: boolean }[]) ?? []
        return items.some((item) => item.visible)
      }
      return total > 0
    }
    if (options.text) {
      const body = await this.call('getText', { maxChars: 200000 })
      const text = String(body.value ?? (body.text as string) ?? '')
      return wantsGone ? !text.includes(options.text) : text.includes(options.text)
    }
    return false
  }

  private describeWait(options: { selector?: string; text?: string; state?: string }): string {
    const target = options.selector ? `selector ${options.selector}` : `text ${JSON.stringify(options.text)}`
    if (options.state === 'detached') return `Timed out waiting for ${target} to disappear.`
    if (options.state === 'visible') return `Timed out waiting for ${target} to become visible.`
    return `Timed out waiting for ${target} to exist.`
  }

  private invalidateIfNavigating(): void {
    if (this.wc.isLoading()) this.bridgeInstalled = false
  }

  // -------------------------------------------------------------- CDP input

  private async cdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.destroyed) throw new Error('The tab is closed.')
    if (!this.wc.debugger.isAttached()) await this.attachProtocol()
    if (!this.wc.debugger.isAttached()) {
      throw new Error('The DevTools protocol is not available for this tab, so input cannot be dispatched.')
    }
    return (await withDeadline(this.wc.debugger.sendCommand(method, params), 15_000)) as T
  }

  /** Focus the tab's web contents so Chromium routes input to it. */
  private focus(): void {
    try {
      this.wc.focus()
    } catch {
      // A detached view cannot take OS focus; CDP input still works.
    }
  }

  /**
   * A real click: hover, press, release.
   *
   * `mouseMoved` is not optional. Drop targets, menus and hover-reveal
   * affordances attach their handlers to `mouseover`, and skipping it produces
   * a click that lands on nothing.
   */
  async clickAt(point: { x: number; y: number }, clickCount = 1): Promise<void> {
    this.focus()
    await this.cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      buttons: 0
    })
    await this.cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount
    })
    await this.cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount
    })
  }

  async doubleClickAt(point: { x: number; y: number }): Promise<void> {
    await this.clickAt(point, 1)
    await sleep(40)
    await this.clickAt(point, 2)
  }

  /**
 * Type text into whatever currently has focus.
 *
 * Two modes, because they answer different questions:
 *
 *  - `insert` uses the protocol's text-insertion call. It is **exact**: every
 *    character arrives, including punctuation, emoji and non-Latin scripts that
 *    have no keyboard mapping. It fires `input` and `change`, which is what
 *    every framework listens to, but not a `keydown` per character.
 *  - `keys` dispatches a real key event per character. It exercises
 *    `keydown`/`keyup` handlers, character counters and mask fields — and it
 *    cannot type a character the current layout has no key for.
 *
 * Defaulting to `insert` is deliberate: a test that silently types `Aaarav@exampletest`
 * when asked for `aarav@example.test` is worse than one that fires no per-key
 * events, because it looks like it worked.
 */
async typeText(text: string, mode: 'insert' | 'keys' = 'insert', delayMs = 0): Promise<number> {
    this.focus()
    if (mode === 'insert') {
      await this.cdp('Input.insertText', { text })
      return [...text].length
    }

    let typed = 0
    for (const char of text) {
      const parsed = describeKey(char)
      const descriptor = parsed.descriptor
      if (!parsed.ok || !descriptor) continue
      await this.sendKey(descriptor, 'keyDown')
      typed += 1
      if (delayMs > 0) await sleep(delayMs)
    }
    return typed
  }

  /** Replace a field's contents with text, leaving the caret at the end. */
async replaceValue(text: string): Promise<void> {
    const chord = describeKey('Ctrl+A')
    if (chord.ok && chord.sequence) await this.pressKeys(chord.sequence)
    const backspace = describeKey('Backspace')
    if (backspace.ok && backspace.sequence) await this.pressKeys(backspace.sequence)
    await this.cdp('Input.insertText', { text })
  }

  /**
 * Press modifiers down, the target key, then release in reverse order.
 *
 * The modifier mask is accumulated and sent with **every** event, because the
 * DevTools protocol does not remember what is held. Omitting it is how
 * `Ctrl+A` ends up typing a capital `A` into a field: the page receives a
 * perfectly ordinary letter press and selects nothing.
 */
  async pressKeys(sequence: KeyDescriptor[]): Promise<void> {
    const target = sequence[sequence.length - 1]
    if (!target) throw new Error('No key to press.')
    this.focus()
    const modifiers = sequence.filter((d) => d.modifier)

    let mask = 0
    for (const modifier of modifiers) {
      mask |= modifierBit(modifier)
      await this.sendKey(modifier, 'rawKeyDown', mask, false)
    }

    mask |= modifierBit(target)
    // A chord's final key must not carry `text`. With text attached Chromium
    // treats it as an ordinary character press and types it, so `Ctrl+A`
    // selects nothing and leaves a literal `A` in the field.
    const producesText = modifiers.length === 0
    await this.sendKey(target, target.modifier ? 'rawKeyDown' : 'keyDown', mask, producesText)
    await this.sendKey(target, 'keyUp', mask, false)

    for (const modifier of [...modifiers].reverse()) {
      mask &= ~modifierBit(modifier)
      await this.sendKey(modifier, 'keyUp', mask, false)
    }
  }

  /**
 * Dispatch one key.
 *
 * `keyDown` carries `text` so Chromium both inserts the character and fires the
 * key events the page listens for. `unmodifiedText` is the same character
 * before Shift is applied, which is what lets a field holding `Ctrl+A` behave.
 * The matching `keyUp` is always sent: an unbalanced key leaves the page
 * thinking a modifier is still held.
 */
private async sendKey(
    descriptor: KeyDescriptor,
    type?: 'rawKeyDown' | 'keyDown' | 'keyUp',
    held?: number,
    withText = true
  ): Promise<void> {
    const modifiers = held ?? modifiersMask([descriptor])
    const kind = type ?? (descriptor.modifier ? 'rawKeyDown' : 'keyDown')
    const base: Record<string, unknown> = {
      type: kind,
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
      modifiers
    }
    if (kind !== 'keyUp' && withText && descriptor.text) {
      base.text = descriptor.text
      base.unmodifiedText = descriptor.text
    }
    await this.cdp('Input.dispatchKeyEvent', base)
    if (kind !== 'keyUp') {
      await this.cdp('Input.dispatchKeyEvent', { ...base, type: 'keyUp', modifiers })
    }
  }

  async scrollBy(dx: number, dy: number, point?: { x: number; y: number }): Promise<void> {
    const fallback = { x: 400, y: 300 }
    const at = point ?? fallback
    await this.cdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: at.x,
      y: at.y,
      button: 'none',
      buttons: 0,
      deltaX: dx,
      deltaY: dy,
      // Chromium needs this to treat the wheel event as precise rather than
      // line-based; without it a 600px scroll lands around 150px.
      pointerType: 'mouse'
    })
    await this.settle(1)
  }

  // ------------------------------------------------------------- inspection

  async screenshot(): Promise<Buffer> {
    // The native capture is tried first because it only needs the view to be
    // parented to *some* window, while `Page.captureScreenshot` needs a
    // compositor surface that is not always available (headless CI, a machine
    // with no GPU surface, a detached view).
    const native = await this.tryNativeCapture()
    if (native.length > 0) return native

    try {
      const result = (await this.cdp<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        fromSurface: true
      }))
      const png = Buffer.from(result.data, 'base64')
      if (png.length === 0) throw new Error('The protocol returned an empty image.')
      return png
    } catch (err) {
      throw new Error(
        `The tab could not be captured: ${err instanceof Error ? err.message : String(err)}. ` +
          'A screenshot needs the tab to be rendered in a window.'
      )
    }
  }

  /** Native capture, bounded — a wedged compositor must not hang the agent. */
  private async tryNativeCapture(): Promise<Buffer> {
    try {
      const image = await withDeadline(this.wc.capturePage(), 10_000)
      if (image.isEmpty()) return Buffer.alloc(0)
      return image.toPNG()
    } catch {
      return Buffer.alloc(0)
    }
  }

  /**
   * Capture the whole scrollable document, not just the viewport.
   *
   * `captureBeyondViewport` resizes the capture surface rather than stitching,
   * which is what makes a long page one image instead of a dozen fragments the
   * agent then has to reconcile.
   */
  async screenshotBeyondViewport(): Promise<Buffer> {
    const result = await this.cdp<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true
    })
    return Buffer.from(result.data, 'base64')
  }

  /**
   * The accessibility tree, as Chromium models it.
   *
   * This is the tree a screen reader consumes, which is a genuinely different
   * (and often more useful) view of the page than the DOM: it exposes the
   * accessible name of an icon-only button where the DOM shows only a class.
   */
  async accessibilityTree(maxNodes = 400): Promise<AccessibilityNode[]> {
    await this.ensureBridge()
    await this.cdp('Accessibility.enable').catch(() => undefined)
    const tree = await this.cdp<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree')
    const nodes = tree?.nodes ?? []
    return nodes.slice(0, maxNodes).map((node) => ({
      role: String(node.role?.value ?? ''),
      name: clip(String(node.name?.value ?? ''), 200).value,
      value: clip(String(node.value?.value ?? ''), 200).value,
      description: clip(String(node.description?.value ?? ''), 200).value,
      focused: node.focused === true,
      disabled: node.disabled === true
    }))
  }

  /**
   * Give the tab a viewport.
   *
   * A view that is not parented to a visible window reports `innerWidth: 0` and
   * lays out nothing: every element has a zero-sized box, so nothing is visible
   * and nothing can be clicked. Device-metrics override is the only mechanism
   * that gives such a renderer a real viewport.
   *
   * The request is remembered until the view is ready, so callers do not have to
   * order themselves around Chromium's startup.
   */
  async setDeviceMetrics(width: number, height: number): Promise<void> {
    this.pendingMetrics = {
      width: Math.max(200, Math.round(width)),
      height: Math.max(200, Math.round(height))
    }
    await this.applyPendingMetrics()
  }

  private async applyPendingMetrics(): Promise<void> {
    const metrics = this.pendingMetrics
    if (!metrics || !this.loadedOnce || this.destroyed) return
    try {
      // `Page.enable` first, and a positive `deviceScaleFactor`: Chromium ignores
      // the override without them, silently leaving the viewport at zero.
      await this.cdp('Page.enable')
      await this.cdp('Emulation.setDeviceMetricsOverride', {
        width: metrics.width,
        height: metrics.height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: metrics.width,
        screenHeight: metrics.height
      })
    } catch {
      // The viewport is an optimisation for layout; a tab that cannot report one
      // is still perfectly usable for reading and for navigation.
    }
  }

  /** True when the renderer reports a non-zero layout viewport. */
  async hasViewport(): Promise<boolean> {
    // `meta` is a bridge method that returns the report directly rather than a
    // wrapped result, so the fields are read off the reply itself.
    const meta = (await this.call<{ innerWidth?: number }>('meta')) as {
      innerWidth?: number
    }
    return (meta.innerWidth ?? 0) > 0
  }

  /** Apply any viewport request made before the view finished starting. */
  get ready(): boolean {
    return this.armed
  }

  dispose(): void {
    if (this.debuggerAttached && !this.destroyed) {
      try {
        this.wc.debugger.detach()
      } catch {
        // The tab may already be tearing down.
      }
      this.debuggerAttached = false
    }
  }
}

/**
 * Persist a screenshot under the browser cache directory.
 *
 * The cache directory lives in the application cache, never in the source
 * repository: an agent that screenshots a page during a task must not leave
 * megabytes of PNGs behind in a working tree the developer will commit.
 */
export async function writeScreenshot(path: string, data: Buffer): Promise<{ path: string; bytes: number }> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
  return { path, bytes: data.length }
}