/**
 * Browser tab manager.
 *
 * Cryptoric drives the Chromium that is already inside Electron. Nothing is
 * downloaded: there is no Playwright browser bundle, no separate Chromium, no
 * browser binary and no browser profile data in this repository. A tab *is* a
 * `WebContentsView` — the same engine that renders Cryptoric's own window.
 *
 * Design notes that matter:
 *
 *  - **One tab, many actions.** A tab outlives the tool calls that drive it, so
 *    "navigate → click → screenshot → reload → screenshot" reuses one page,
 *    one cache and one console log instead of starting a browser per action.
 *    That is the difference between testing a running app and taking unrelated
 *    screenshots of it.
 *  - **One session per tab.** Each tab gets its own persistent session
 *    directory under the app cache dir, so cookies and local storage are a real
 *    part of the tab's state rather than a shared global. Closing a temporary
 *    tab wipes that directory's contents; a persistent tab keeps them.
 *  - **Two views of one tab.** A tab is either attached to the Cryptoric window
 *    (visible panel) or detached (background). Automation behaves identically
 *    either way, because input goes through the DevTools protocol rather than
 *    OS focus, so the agent can keep working while a page runs unattended.
 *  - **Deny by default.** Every permission request is refused except two
 *    harmless capabilities, and each refusal is recorded so the agent can
 *    explain the failure instead of waiting on a dialog that never appears.
 */

import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  type Rectangle,
  type Session,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PageController } from './page'
import { consoleLevel } from './dom'

export type TabId = string

export interface TabRecord {
  id: TabId
  url: string
  title: string
  loading: boolean
  createdAt: string
  /** True when this tab is rendered inside the Cryptoric window. */
  visible: boolean
  /** Persisted session: survives until the task explicitly ends it. */
  persistent: boolean
  sessionPath: string
}

export interface ConsoleEntry {
  level: 'error' | 'warning' | 'info' | 'log'
  text: string
  source: string
  line: number | null
  at: string
}

export interface NetworkFailure {
  url: string
  error: string
  method: string
  at: string
}

export interface NetworkRequest {
  id: string
  url: string
  method: string
  status: number | null
  mimeType: string
  resourceType: string
  fromCache: boolean
  /** Milliseconds between request start and completion. */
  durationMs: number | null
  at: string
}

export interface PermissionDenial {
  permission: string
  details: string
  at: string
}

export interface StorageReport {
  origin: string
  storagePath: string | null
  cookieCount: number
  cookieNames: string[]
  localStorage: Record<string, string>
  sessionStorageKeys: string[]
}

/** Permissions a page may hold without asking Cryptoric. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write'])

const MAX_CONSOLE = 1000
const MAX_NETWORK = 500
const MAX_FAILURES = 200

/**
 * Viewport for a tab that is not currently attached to the window.
 *
 * A `WebContentsView` with zero bounds lays out nothing: every element has a
 * zero-sized rectangle, so nothing is "visible", and visibility is exactly what
 * an agent uses to decide what to click. A background tab therefore still gets
 * a real desktop-sized viewport — it is simply not on screen.
 */
const DETACHED_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 }

export class BrowserCapacityError extends Error {
  constructor(limit: number) {
    super(
      `The browser already has ${limit} open tabs and all of them are on screen. ` +
        'Close a tab, or pass an existing tab id, before opening another.'
    )
    this.name = 'BrowserCapacityError'
  }
}

export interface BrowserTabManagerOptions {
  userDataDir: string
  /** Window tabs are attached to; may be absent before boot completes. */
  getWindow(): BrowserWindow | null
  /** Maximum simultaneously open tabs; the oldest hidden one is evicted past this. */
  maxTabs?: number
  /**
   * Parent background tabs to a hidden offscreen window.
   *
   * On by default: it is what lets the agent screenshot and lay out a tab the
   * user is not looking at. Disable only on a machine where Chromium cannot
   * host a window at all; interaction still works there through device-metrics
   * emulation, but screenshots do not.
   */
  backgroundHost?: boolean
}

export class BrowserTabManager {
  private readonly tabs = new Map<TabId, TabState>()
  private readonly maxTabs: number
  private readonly closing = new Set<TabId>()
  private offscreen: BrowserWindow | null = null
  /** Profile directories that survived cleanup, for diagnostics. */
  private readonly profileCleanupFailures: string[] = []

  /** Browser profile/cache root. Outside the repository, and configurable. */
  readonly cacheDir: string

  constructor(private readonly options: BrowserTabManagerOptions) {
    this.maxTabs = options.maxTabs ?? 8
    this.cacheDir = join(options.userDataDir, 'browser')
    mkdirSync(this.cacheDir, { recursive: true })
  }

  /**
   * A window that hosts tabs the user is not currently looking at.
   *
   * A `WebContentsView` only renders when it is parented to a window, and
   * Chromium only composites a window it has actually shown: a `show: false`
   * window and an `offscreen` one both produce empty captures, which would make
   * every screenshot of a background tab a blank image. So the host is a real
   * window, parked far off-screen and excluded from the taskbar and focus, which
   * renders correctly while remaining completely invisible to the developer.
   *
   * The alternative — attaching the tab to the Cryptoric window — would mean an
   * agent screenshotting a second tab takes over the one they are using.
   */
  private backgroundHost(): BrowserWindow | null {
    if (this.options.backgroundHost === false) return null
    if (this.offscreen && !this.offscreen.isDestroyed()) return this.offscreen
    if (!app.isReady()) return null
    this.offscreen = new BrowserWindow({
      show: true,
      x: -32000,
      y: -32000,
      width: DETACHED_BOUNDS.width,
      height: DETACHED_BOUNDS.height,
      skipTaskbar: true,
      focusable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Cryptoric background browser host',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    return this.offscreen
  }

  /**
   * Create the background host up front.
   *
   * Worth doing during boot: it moves window creation off the first agent tool
   * call, which is the one place a slow compositor would be most visible.
   */
  ensureBackgroundHost(): boolean {
    return this.backgroundHost() !== null
  }

  list(): TabRecord[] {
    return [...this.tabs.values()].map(toRecord)
  }

  get(id: TabId): TabRecord | null {
    const state = this.tabs.get(id)
    return state ? toRecord(state) : null
  }

  has(id: TabId): boolean {
    return this.tabs.has(id)
  }

  /** The tab an agent should act on: an explicit id, else the most recent. */
  active(): TabRecord | null {
    const states = [...this.tabs.values()]
    const last = states[states.length - 1]
    return last ? toRecord(last) : null
  }

  /**
   * Resolve a tab id, falling back to the active tab.
   *
   * Every interaction tool takes an optional `tabId` so the agent can say
   * "the tab from three steps ago" without tracking ids by hand, while still
   * allowing an explicit reference when several tabs are live.
   */
  resolve(tabId?: TabId): TabState | null {
    if (tabId) return this.tabs.get(tabId) ?? null
    const states = [...this.tabs.values()]
    return states[states.length - 1] ?? null
  }

  page(tabId?: TabId): PageController | null {
    const state = this.resolve(tabId)
    return state && !state.view.webContents.isDestroyed() ? state.page : null
  }

  async open(input: { url?: string; visible?: boolean; persistent?: boolean } = {}): Promise<TabRecord> {
    await this.evictOverflow()

    const id = randomUUID()
    const sessionPath = join(this.cacheDir, id)
    mkdirSync(sessionPath, { recursive: true })

    // `session.fromPath` binds cookies and cache to this directory. There is
    // no partition option: the path *is* the identity, which is what keeps one
    // tab's storage from leaking into another's.
    const ses = session.fromPath(sessionPath, { cache: true })
    this.hardenSession(ses)

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        // The page is untrusted content. No Node, no preload bridge, its own
        // world — so a compromised dev server cannot reach Cryptoric.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false
      }
    })
    view.setBackgroundColor('#0b0d10')
    view.setBounds(DETACHED_BOUNDS)

    const state: TabState = {
      id,
      view,
      page: new PageController(view.webContents),
      session: ses,
      sessionPath,
      url: input.url ?? 'about:blank',
      title: '',
      loading: false,
      createdAt: new Date().toISOString(),
      visible: false,
      persistent: input.persistent ?? false,
      attached: false,
      parent: null,
      console: [],
      network: [],
      failures: [],
      permissions: [],
      starts: new Map<number, { at: number; tab: TabState }>()
    }

    this.wire(state)
    this.tabs.set(id, state)

    // Attach the protocol before the first navigation. Doing it later leaves
    // input routed through the previous document, which silently swallows every
    // click and keystroke while reporting success.
    await state.page.attachProtocol()

    // Ask for a viewport up front. It is applied once the document settles.
    void state.page.setDeviceMetrics(DETACHED_BOUNDS.width, DETACHED_BOUNDS.height).catch(() => undefined)

    if (input.visible !== false) this.setVisible(id, true)
    if (input.url) await this.navigate(id, input.url)
    return toRecord(state)
  }

  async navigate(tabId: TabId, url: string): Promise<{ ok: boolean; error?: string }> {
    const state = this.tabs.get(tabId)
    if (!state) return { ok: false, error: `No browser tab with id ${tabId}` }
    state.page.invalidate()
    try {
      await state.view.webContents.loadURL(url)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      state.failures.push({ url, error: message, method: 'GET', at: new Date().toISOString() })
      trim(state.failures, MAX_FAILURES)
      return { ok: false, error: message }
    }
  }

  back(tabId?: TabId): boolean {
    const wc = this.contentsOf(tabId)
    if (!wc || !wc.navigationHistory.canGoBack()) return false
    wc.navigationHistory.goBack()
    return true
  }

  forward(tabId?: TabId): boolean {
    const wc = this.contentsOf(tabId)
    if (!wc || !wc.navigationHistory.canGoForward()) return false
    wc.navigationHistory.goForward()
    return true
  }

  reload(tabId?: TabId, ignoreCache = false): boolean {
    const wc = this.contentsOf(tabId)
    if (!wc) return false
    // `reload` uses the HTTP cache; `reloadIgnoringCache` is the hard refresh a
    // developer means by "reload" after editing a file a bundler may not have
    // invalidated. Both live on WebContents; the flag picks between them.
    if (ignoreCache) wc.reloadIgnoringCache()
    else wc.reload()
    return true
  }

  /** Navigation history entries, newest first — the tab's own history. */
  history(tabId?: TabId): { url: string; title: string }[] {
    const wc = this.contentsOf(tabId)
    if (!wc) return []
    return wc.navigationHistory
      .getAllEntries()
      .map((entry) => ({ url: entry.url, title: entry.title }))
      .reverse()
  }

  /**
 * Show or hide the tab in the Cryptoric window.
 *
 * When there is no Cryptoric window — before boot completes, or during a headless
 * run — the tab still goes to the background host, because a view with no parent
 * window lays out nothing and cannot be screenshotted. `visible` stays false:
 * the tab is alive, but the user is not looking at it.
 */
  setVisible(tabId: TabId, visible: boolean): boolean {
    const state = this.tabs.get(tabId)
    if (!state) return false

    const win = visible ? this.options.getWindow() : null
    const liveWindow = win && !win.isDestroyed() ? win : null

    if (liveWindow) {
      // Only one tab is on screen: showing a second one hides the first, so
      // the panel never shows two overlapping documents.
      for (const other of this.tabs.values()) {
        if (other.id !== tabId && other.visible) this.setVisible(other.id, false)
      }
    }

    const host = liveWindow ?? this.backgroundHost()
    this.reparent(state, host, liveWindow ? this.boundsFor(liveWindow) : DETACHED_BOUNDS)
    state.visible = Boolean(liveWindow)
    return true
  }

  /** Parent a tab's view to a window and give it that window's geometry. */
  private reparent(state: TabState, win: BrowserWindow | null, bounds: Rectangle): void {
    try {
      if (win) {
        win.contentView.addChildView(state.view)
      } else if (state.parent) {
        state.parent.contentView.removeChildView(state.view)
      }
    } catch {
      // The parent may already be gone during shutdown; bounds still apply.
    }
    state.parent = win
    state.attached = Boolean(win)
    state.view.setBounds(bounds)
    state.page.setDeviceMetrics(bounds.width, bounds.height).catch(() => undefined)
  }

  /** Lay out the visible browser panel after a window resize or move. */
  layout(win?: BrowserWindow): void {
    const target = win ?? this.options.getWindow()
    if (!target || target.isDestroyed()) return
    for (const state of this.tabs.values()) {
      if (state.visible && state.parent === target) state.view.setBounds(this.boundsFor(target))
    }
  }

  /**
   * Resize a background tab's viewport.
   *
   * Responsive checks and screenshot sizing both need this: changing the
   * device metrics of a zero-sized view measures nothing.
   */
  resize(tabId: TabId, width: number, height: number): boolean {
    const state = this.tabs.get(tabId)
    if (!state || state.visible) return false
    const bounds = {
      x: 0,
      y: 0,
      width: Math.max(200, Math.round(width)),
      height: Math.max(200, Math.round(height))
    }
    state.view.setBounds(bounds)
    state.page.setDeviceMetrics(bounds.width, bounds.height).catch(() => undefined)
    return true
  }

  async close(tabId: TabId): Promise<boolean> {
    const state = this.tabs.get(tabId)
    if (!state) return false
    this.tabs.delete(tabId)
    if (this.closing.has(tabId)) return false
    this.closing.add(tabId)

    try {
      state.page.dispose()
      this.reparent(state, null, DETACHED_BOUNDS)
      if (!state.view.webContents.isDestroyed()) state.view.webContents.close()

      if (!state.persistent) {
        // A temporary tab leaves nothing behind: no cache, no cookies, no
        // history. The directory itself is removed from disk.
        await state.session.clearStorageData().catch(() => undefined)
        await state.session.clearCache().catch(() => undefined)
        if (!(await removeProfileDir(state.sessionPath))) {
          this.profileCleanupFailures.push(state.sessionPath)
        }
      } else {
        state.session.flushStorageData()
      }
    } finally {
      this.closing.delete(tabId)
    }
    return true
  }

  /** Close every non-persistent tab; used when a task ends. */
  async closeTemporary(): Promise<number> {
    const temporary = [...this.tabs.values()].filter((state) => !state.persistent)
    for (const state of temporary) await this.close(state.id)
    return temporary.length
  }

  /** Temporary profile directories that could not be deleted at close time. */
  cleanupFailures(): string[] {
    return [...this.profileCleanupFailures]
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.tabs.keys()]) await this.close(id)
    if (this.offscreen && !this.offscreen.isDestroyed()) this.offscreen.destroy()
    this.offscreen = null
  }

  // ----------------------------------------------------------- diagnostics

  consoleLogs(tabId?: TabId): ConsoleEntry[] {
    const state = this.resolve(tabId)
    return state ? [...state.console] : []
  }

  networkRequests(tabId?: TabId): NetworkRequest[] {
    const state = this.resolve(tabId)
    return state ? [...state.network] : []
  }

  networkFailures(tabId?: TabId): NetworkFailure[] {
    const state = this.resolve(tabId)
    return state ? [...state.failures] : []
  }

  deniedPermissions(tabId?: TabId): PermissionDenial[] {
    const state = this.resolve(tabId)
    return state ? [...state.permissions] : []
  }

  /** Drop collected logs so the next run measures only the next change. */
  clearDiagnostics(tabId?: TabId): void {
    const state = this.resolve(tabId)
    if (!state) return
    state.console.length = 0
    state.network.length = 0
    state.failures.length = 0
    state.starts.clear()
  }

  /** Cookies and web storage for a tab, read from its own session. */
  async storage(tabId?: TabId): Promise<StorageReport | null> {
    const state = this.resolve(tabId)
    if (!state) return null

    let cookieNames: string[] = []
    let cookieCount = 0
    try {
      const cookies = await state.session.cookies.get({})
      cookieCount = cookies.length
      cookieNames = cookies.slice(0, 100).map((c) => c.name)
    } catch {
      // A session that has not touched the cookie store yet can refuse.
    }

    let localStorage: Record<string, string> = {}
    let sessionStorageKeys: string[] = []
    let origin = ''
    try {
      const probe = await state.page.call<{ origin: string; localStorage: Record<string, string>; sessionStorageKeys: string[] }>('storage')
      if (probe.ok && probe.value) {
        origin = probe.value.origin ?? ''
        localStorage = probe.value.localStorage ?? {}
        sessionStorageKeys = probe.value.sessionStorageKeys ?? []
      }
    } catch {
      // A tab on about:blank has no origin to read.
    }

    return {
      origin,
      storagePath: state.session.getStoragePath(),
      cookieCount,
      cookieNames,
      localStorage,
      sessionStorageKeys
    }
  }

  // ------------------------------------------------------------- internals

  private contentsOf(tabId?: TabId): WebContents | null {
    const state = this.resolve(tabId)
    if (!state || state.view.webContents.isDestroyed()) return null
    return state.view.webContents
  }

  /**
   * The panel's on-screen rectangle.
   *
   * Anchored to the right of the Cryptoric rail so the browser sits beside the
   * workspace rather than covering it, and clamped so a very narrow window
   * still leaves the rail visible.
   */
  private boundsFor(win: BrowserWindow): Rectangle {
    const { width, height } = win.getContentBounds()
    const rail = 60
    const available = Math.max(240, width - rail)
    const panelWidth = Math.min(available, Math.max(360, Math.round(available * 0.62)))
    return { x: width - panelWidth, y: 0, width: panelWidth, height }
  }

  /**
   * Deny every permission except two harmless ones, and record the refusals.
   *
   * Reporting refusals matters more than it looks: silently denying leaves the
   * agent blocked on a promise the page will never resolve.
   */
  private hardenSession(ses: Session): void {
    const owner = (): TabState | undefined => [...this.tabs.values()].find((t) => t.session === ses)

    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const allowed = ALLOWED_PERMISSIONS.has(permission)
      if (!allowed) {
        owner()?.permissions.push({
          permission,
          details: typeof details === 'string' ? details : safeStringify(details),
          at: new Date().toISOString()
        })
      }
      callback(allowed)
    })
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))

    this.wireNetwork(ses, owner)
  }

  /**
   * Record requests and failures from the network stack.
   *
   * These come from `webRequest` rather than from injected script because the
   * failures an agent needs to see — a 500 from an API route, a refused
   * websocket, a blocked source map — never reach page-level instrumentation.
   */
  private wireNetwork(ses: Session, owner: () => TabState | undefined): void {
    const started = new Map<number, { at: number; tab: TabState }>()

    ses.webRequest.onBeforeRequest((details, callback) => {
      const state = owner()
      if (state) started.set(details.id, { at: Date.now(), tab: state })
      callback({})
    })

    ses.webRequest.onCompleted((details) => {
      const begin = started.get(details.id)
      const state = begin?.tab ?? owner()
      started.delete(details.id)
      if (!state) return
      state.network.push({
        id: String(details.id),
        url: details.url,
        method: details.method,
        status: details.statusCode,
        mimeType: contentTypeOf(details.responseHeaders),
        resourceType: details.resourceType,
        fromCache: Boolean(details.fromCache),
        durationMs: begin ? Date.now() - begin.at : null,
        at: new Date().toISOString()
      })
      trim(state.network, MAX_NETWORK)
    })

    ses.webRequest.onErrorOccurred((details) => {
      const begin = started.get(details.id)
      const state = begin?.tab ?? owner()
      started.delete(details.id)
      if (!state) return
      // A cancelled navigation is user intent, not a defect to report.
      if (details.error === 'net::ERR_ABORTED') return
      state.failures.push({
        url: details.url,
        error: details.error,
        method: details.method,
        at: new Date().toISOString()
      })
      trim(state.failures, MAX_FAILURES)
    })
  }

  private wire(state: TabState): void {
    const wc = state.view.webContents

    wc.on('page-title-updated', (_e, title, _explicitSet) => {
      state.title = title
    })
    wc.on('did-start-loading', () => {
      state.loading = true
      state.page.invalidate()
      // The renderer exists from here; the DevTools protocol is safe to attach.
      state.page.arm()
    })
    wc.on('did-start-navigation', () => state.page.arm())
    // Re-assert the viewport once the document has committed: a navigation
    // clears the emulation override, and without it input coordinates silently
    // stop matching what the page laid out.
    wc.on('did-stop-loading', () => {
      state.loading = false
      // Re-assert the viewport once the document has committed: a navigation
      // clears the emulation override, and without it pointer events stop
      // matching the layout the page reports.
      state.page.settleViewport()
    })
    wc.on('did-navigate', (_e, url) => {
      state.url = url
      state.page.invalidate()
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      state.url = url
    })
    wc.on('did-fail-load', (_e, errorCode, description, validatedURL, isMainFrame) => {
      // -3 is ERR_ABORTED: a redirect or a cancel, not a failure.
      if (errorCode === -3) return
      state.failures.push({
        url: validatedURL,
        error: isMainFrame ? `${description} (${errorCode})` : description,
        method: 'GET',
        at: new Date().toISOString()
      })
      trim(state.failures, MAX_FAILURES)
    })
    wc.on('console-message', (_e, level, message, line, sourceId) => {
      state.console.push({
        level: consoleLevel(level),
        text: message,
        source: sourceId ?? '',
        line: typeof line === 'number' ? line : null,
        at: new Date().toISOString()
      })
      trim(state.console, MAX_CONSOLE)
    })

    // A `window.open` becomes a navigation in this tab rather than a second
    // window the agent would lose track of.
    wc.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith('devtools://')) void wc.loadURL(url)
      return { action: 'deny' }
    })

    wc.on('render-process-gone', (_e, details) => {
      state.loading = false
      state.failures.push({
        url: state.url,
        error: `The renderer process exited (${details.reason}).`,
        method: 'GET',
        at: new Date().toISOString()
      })
    })
  }

  /**
   * Keep the tab count bounded.
   *
   * Only hidden tabs are evicted. Closing a tab the developer is looking at to
   * make room for a new one is never the right trade, so when every tab is
   * visible the caller is told to close one instead.
   */
  private async evictOverflow(): Promise<void> {
    while (this.tabs.size >= this.maxTabs) {
      let victim: TabState | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const state of this.tabs.values()) {
        if (state.visible) continue
        const created = Date.parse(state.createdAt)
        if (created < oldestAt) {
          oldestAt = created
          victim = state
        }
      }
      if (!victim) throw new BrowserCapacityError(this.maxTabs)
      await this.close(victim.id)
    }
  }

  }

interface TabState {
  id: TabId
  view: WebContentsView
  page: PageController
  session: Session
  sessionPath: string
  url: string
  title: string
  loading: boolean
  createdAt: string
  visible: boolean
  persistent: boolean
  attached: boolean
  /** Window the view is currently parented to; null when fully detached. */
  parent: BrowserWindow | null
  console: ConsoleEntry[]
  network: NetworkRequest[]
  failures: NetworkFailure[]
  permissions: PermissionDenial[]
  /** In-flight request ids, for turning a request into a duration. */
  starts: Map<number, { at: number; tab: TabState }>
}

function toRecord(state: TabState): TabRecord {
  return {
    id: state.id,
    url: state.url,
    title: state.title,
    loading: state.loading,
    createdAt: state.createdAt,
    visible: state.visible,
    persistent: state.persistent,
    sessionPath: state.sessionPath
  }
}

/** Bound a ring buffer from the front so a runaway dev server cannot exhaust memory. */
function trim(list: unknown[], max: number): void {
  if (list.length > max) list.splice(0, list.length - max)
}

/**
 * Delete a temporary profile directory.
 *
 * The retries are **asynchronous on purpose**. Windows holds a short-lived
 * exclusive lock on files a Chromium session has just written, and the lock is
 * only released once the main process gets a turn — a synchronous backoff loop
 * would block that turn and make the removal impossible, not merely slow.
 *
 * A directory that still resists after every attempt is untidy rather than
 * incorrect, so the failure is recorded for diagnostics and nothing throws.
 */
async function removeProfileDir(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true })
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  return false
}

/** `text/html; charset=utf-8` → `text/html`. Absent header → empty string. */
function contentTypeOf(headers: Record<string, string[]> | undefined): string {
  if (!headers) return ''
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type' && values?.length) {
      return String(values[0]).split(';')[0]?.trim() ?? ''
    }
  }
  return ''
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value) ?? String(value)
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return String(value)
  }
}