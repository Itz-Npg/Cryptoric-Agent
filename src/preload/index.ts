/**
 * Preload bridge.
 *
 * Runs in an isolated world with `contextIsolation: true` and `sandbox: true`.
 * The renderer receives a *fixed, named* API — never `ipcRenderer`, never
 * `require`, never `process`. That means a compromised renderer cannot reach a
 * channel that is not enumerated here, and cannot forge main-process events: the
 * `onMainEvent` subscription is the only push surface and it is read-only.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type IpcResult } from '@shared/ipc-channels'
import type { RunMode } from '@shared/mode'

/** Who is signed in. No token: the UI never holds one. */
export interface AuthAccount {
  accountId: string
  email: string | null
  name: string | null
  picture: string | null
  signedInAt: string
}

export interface AuthStatus {
  signedIn: boolean
  /** False when no OAuth client id is configured; `message` then says what to set. */
  configured: boolean
  account: AuthAccount | null
  message: string | null
}

/** What this install is: local-only, or pointed at the account server. */
export type ModeInfo =
  | {
      ok: true
      mode: RunMode
      serverUrl: string
      note: string
      description: string
      /** True when the agent may not run unless someone is signed in. */
      requiresAccount: boolean
    }
  | { ok: false; error: string }

/** Coins, and whether they are counted here or on the server. */
export type BalanceInfo =
  | {
      source: 'local' | 'server'
      ok: true
      balance: number
      /** The day's allowance, when the source knows one. */
      dailyCoins?: number
      accountId?: string
    }
  | { source: 'local' | 'server'; ok: false; error: string }
import type {
  AgentTask,
  ConversationTurn,
  DiagnosticEntry,
  EnvSnapshot,
  EnvironmentGap,
  FileContents,
  FileNode,
  FileSearchHit,
  FileWriteResult,
  GitCheckpointResult,
  GitDiffResult,
  GitStatus,
  MainEvent,
  PermissionRule,
  ProcessInfo,
  ProjectProfile,
  SkillDescriptor,
  TerminalSessionInfo,
  ToolStatus
} from '@shared/types'

type Unsubscribe = () => void

/**
 * Settings cross the bridge as an opaque structure.
 *
 * The preload runs sandboxed and must not pull zod (or anything else heavy) into
 * its bundle, so it describes the payload structurally instead of importing the
 * main-process schema. The main process is the only place that validates it.
 */
export interface SettingsValidation {
  ok: boolean
  issues: { path: string; message: string }[]
}

async function invoke<T>(channel: string, payload: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.data
}

export interface AppInfo {
  version: string
  name: string
  platform: string
  arch: string
  electron: string
  chrome: string
  node: string
  pid: number
  userData: string
}

export interface RecentProject {
  root: string
  name: string
  openedAt: string
}

export interface AppStatePatch {
  recentProjects?: RecentProject[]
  lastProjectRoot?: string | null
  updateChannel?: 'stable' | 'beta' | 'nightly'
  theme?: 'graphite' | 'bone'
  density?: 'compact' | 'default' | 'relaxed'
  motion?: 'full' | 'reduced'
  modelProvider?: 'none' | 'ollama' | 'openai-compatible' | 'openrouter' | 'apinex'
  modelEndpoint?: string
  modelName?: string
  dailyBudgetUsd?: number
  permissionOverrides?: Record<string, string>
  onboardingComplete?: boolean
}

export interface EnvironmentInspection {
  snapshot: EnvSnapshot
  tools: ToolStatus[]
}

export interface InstallOutcome {
  toolId: string
  ok: boolean
  error: string | null
  snapshotBefore: number
  snapshotAfter: number
  refreshedWithoutRestart: boolean
}

export interface PortScan {
  occupied: number[]
  freeCandidate: { port: number; usedRequested: boolean; free: boolean } | null
}

export interface SkillRoutingDecision {
  categories: string[]
  skillIds: string[]
  estimatedTokens: number
  skipped: { id: string; reason: string }[]
}

export interface DiagnosticsReport {
  app: AppInfo
  snapshot: EnvSnapshot
  tools: DiagnosticEntry[]
  security: Record<string, unknown>
}

export interface ModelSummaryDto {
  id: string
  label: string
  provider: string
  kind: 'local' | 'hosted'
  inputPerMillion: number | null
  outputPerMillion: number | null
  active: boolean
}

export interface BudgetSummaryDto {
  usedCoins: number
  budgetCoins: number
  day: string
  exceeded: boolean
  enabled: boolean
  model: string
}

export interface ModelCatalogSnapshot {
  models: ModelSummaryDto[]
  budget: BudgetSummaryDto
}

/**
 * Update state as the renderer sees it.
 *
 * Mirrors `UpdateStatus` in the main process. `state: 'unsupported'` is a real
 * outcome, not a failure: a development build genuinely has no update feed, and
 * reporting that as "up to date" would be a false all-clear.
 */
export interface UpdateStatusDto {
  state:
    | 'idle'
    | 'unsupported'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
  currentVersion: string
  availableVersion: string | null
  releaseNotes: string | null
  releaseDate: string | null
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
  unavailableReason: string | null
  error: string | null
  releasePageUrl: string | null
}

/**
 * The persisted conversation, as the renderer sees it.
 *
 * Read once at boot and then kept live by `conversation` push events, so the
 * chat view shows the same history the model is given.
 */
export interface ConversationSnapshot {
  id: string
  turns: ConversationTurn[]
}

export interface ModelKeyReportDto {
  ok: boolean
  configured: boolean
  label: string | null
  usage: number | null
  limit: number | null
  limitRemaining: number | null
  isFreeTier: boolean | null
  error: string | null
}

const api = {
  app: {
    info: () => invoke<AppInfo>(CHANNELS.appInfo, {})
  },
  state: {
    get: () => invoke<AppStatePatch>(CHANNELS.stateGet, {}),
    set: (patch: AppStatePatch) => invoke<AppStatePatch>(CHANNELS.stateSet, { patch })
  },
  settings: {
    get: () => invoke<Record<string, unknown>>(CHANNELS.settingsGet, {}),
    resolve: (projectRoot: string | null) =>
      invoke<Record<string, unknown>>(CHANNELS.settingsResolve, { projectRoot }),
    update: (patch: Record<string, unknown>) =>
      invoke<SettingsValidation>(CHANNELS.settingsUpdate, { patch }),
    reset: (selector: { path?: string; section?: string; all?: boolean }) =>
      invoke<Record<string, unknown>>(CHANNELS.settingsReset, selector),
    export: () => invoke<Record<string, unknown>>(CHANNELS.settingsExport, {}),
    import: (payload: unknown, mode: 'merge' | 'replace' = 'merge') =>
      invoke<SettingsValidation>(CHANNELS.settingsImport, { payload, mode }),
    setProjectOverride: (projectRoot: string, override: Record<string, unknown> | null) =>
      invoke<SettingsValidation>(CHANNELS.settingsProjectOverride, { projectRoot, override })
  },
  project: {
    open: (root?: string) => invoke<ProjectProfile>(CHANNELS.projectOpen, { root: root ?? '' }),
    close: () => invoke<null>(CHANNELS.projectClose, {}),
    list: () => invoke<RecentProject[]>(CHANNELS.projectList, {}),
    gaps: () => invoke<EnvironmentGap[]>(CHANNELS.projectGaps, {})
  },
  env: {
    inspect: (includeAll?: boolean) => invoke<EnvironmentInspection>(CHANNELS.envInspect, { includeAll }),
    install: (toolId: string, version?: string, installerId?: string) =>
      invoke<InstallOutcome>(CHANNELS.envInstall, { toolId, version, installerId }),
    cancelInstall: (toolId: string) => invoke<boolean>(CHANNELS.envCancelInstall, { toolId }),
    refresh: () => invoke<EnvironmentInspection>(CHANNELS.envRefresh, {}),
    snapshot: () => invoke<EnvSnapshot>(CHANNELS.envSnapshot, {})
  },
  terminal: {
    create: (cwd?: string, label?: string) => invoke<TerminalSessionInfo>(CHANNELS.terminalCreate, { cwd, label }),
    write: (sessionId: string, data: string) => invoke<boolean>(CHANNELS.terminalWrite, { sessionId, data }),
    refresh: (sessionId: string, closeOld?: boolean) =>
      invoke<TerminalSessionInfo>(CHANNELS.terminalRefresh, { sessionId, closeOld }),
    close: (sessionId: string) => invoke<boolean>(CHANNELS.terminalClose, { sessionId }),
    list: () => invoke<TerminalSessionInfo[]>(CHANNELS.terminalList, {})
  },
  process: {
    start: (input: { label: string; command: string; args?: string[]; cwd: string; expectedPort?: number }) =>
      invoke<ProcessInfo>(CHANNELS.processStart, input),
    list: () => invoke<ProcessInfo[]>(CHANNELS.processList, {}),
    stop: (processId: string) => invoke<boolean>(CHANNELS.processStop, { processId }),
    restart: (processId: string) => invoke<ProcessInfo>(CHANNELS.processRestart, { processId }),
    logs: (processId: string) => invoke<string>(CHANNELS.processLogs, { processId })
  },
  port: {
    scan: (from: number, to: number) => invoke<PortScan>(CHANNELS.portScan, { from, to })
  },
  git: {
    status: () => invoke<GitStatus>(CHANNELS.gitStatus, {}),
    diff: (path?: string) => invoke<GitDiffResult>(CHANNELS.gitDiff, { path }),
    checkpoint: (message?: string) => invoke<GitCheckpointResult>(CHANNELS.gitCheckpoint, { message }),
    commit: (message: string) => invoke<GitCheckpointResult>(CHANNELS.gitCommit, { message })
  },
  file: {
    read: (path: string) => invoke<FileContents>(CHANNELS.fileRead, { path }),
    write: (path: string, content: string) => invoke<FileWriteResult>(CHANNELS.fileWrite, { path, content }),
    search: (query: string, limit?: number) => invoke<FileSearchHit[]>(CHANNELS.fileSearch, { query, limit }),
    tree: (path?: string, depth?: number) => invoke<FileNode[]>(CHANNELS.fileTree, { path, depth })
  },
  agent: {
    submit: (prompt: string, title?: string, role?: string) => invoke<AgentTask>(CHANNELS.agentSubmit, { prompt, title, role }),
    list: () => invoke<AgentTask[]>(CHANNELS.agentList, {}),
    stop: (taskId: string) => invoke<boolean>(CHANNELS.agentStop, { taskId }),
    pause: (taskId: string) => invoke<boolean>(CHANNELS.agentPause, { taskId }),
    resume: (taskId: string) => invoke<boolean>(CHANNELS.agentResume, { taskId }),
    tools: () => invoke<unknown[]>(CHANNELS.toolsList, {})
  },
  conversation: {
    list: () => invoke<ConversationSnapshot>(CHANNELS.conversationList, {}),
    clear: () => invoke<ConversationSnapshot>(CHANNELS.conversationClear, {})
  },
  approval: {
    list: () => invoke<unknown[]>(CHANNELS.approvalList, {}),
    resolve: (id: string, approved: boolean, remember?: boolean, toolId?: string) =>
      invoke<boolean>(CHANNELS.approvalResolve, { id, approved, remember, toolId })
  },
  skill: {
    list: () => invoke<SkillDescriptor[]>(CHANNELS.skillList, {}),
    setEnabled: (id: string, enabled: boolean) => invoke<boolean>(CHANNELS.skillSetEnabled, { id, enabled }),
    route: (prompt: string, paths?: string[]) => invoke<SkillRoutingDecision>(CHANNELS.skillRoute, { prompt, paths })
  },
  permission: {
    list: () => invoke<PermissionRule[]>(CHANNELS.permissionList, {}),
    set: (domain: string, decision: 'allow' | 'ask' | 'deny', scope?: string) =>
      invoke<PermissionRule[]>(CHANNELS.permissionSet, { domain, decision, scope })
  },
  models: {
    catalog: () => invoke<ModelCatalogSnapshot>(CHANNELS.modelsCatalog, {}),
    select: (modelId: string) => invoke<ModelCatalogSnapshot>(CHANNELS.modelsSelect, { modelId }),
    available: () => invoke<{ ok: boolean; models: { id: string }[]; error: string | null }>(CHANNELS.modelsAvailable, {}),
    setBudget: (coins: number) => invoke<ModelCatalogSnapshot>(CHANNELS.modelsSetBudget, { coins }),
    setProvider: (input: {
      provider: 'none' | 'ollama' | 'openai-compatible' | 'openrouter' | 'apinex'
      endpoint: string
      model: string
      credentialKey: string | null
      referer?: string
    }) => invoke<ModelCatalogSnapshot>(CHANNELS.modelsSetProvider, input),
    verifyKey: () => invoke<ModelKeyReportDto>(CHANNELS.modelsVerifyKey, {}),
    setKey: (apiKey: string) => invoke<ModelKeyReportDto>(CHANNELS.modelsSetKey, { apiKey }),
    /**
     * Add or update a provider the user brought: a base URL, an API key and the
     * model ids it serves. The key goes to the encrypted credential store in the
     * main process and is never returned.
     */
    saveCustomProvider: (input: {
      id?: string
      label: string
      baseUrl: string
      apiKey?: string
      models: string[]
      contextWindow?: number | null
      maxOutputTokens?: number | null
    }) => invoke<{ ok: boolean; error: string | null; id: string | null }>(CHANNELS.modelsCustomSave, input),
    removeCustomProvider: (id: string) =>
      invoke<{ ok: boolean; error: string | null }>(CHANNELS.modelsCustomRemove, { id })
  },
  updates: {
    status: () => invoke<UpdateStatusDto>(CHANNELS.updatesStatus, {}),
    /** Ask the release feed what exists. Cheap, and safe to call often. */
    check: (force = false) => invoke<UpdateStatusDto>(CHANNELS.updatesCheck, { force }),
    /** Fetch the installer. Only the user should trigger this. */
    download: () => invoke<UpdateStatusDto>(CHANNELS.updatesDownload, {}),
    /** Swap the installed build and restart into it. */
    install: () => invoke<UpdateStatusDto>(CHANNELS.updatesInstall, {}),
    /**
     * Update transitions pushed from main, so a check that starts at launch
     * still reaches the screen even if Settings is not open.
     */
    onUpdate(handler: (status: UpdateStatusDto) => void): Unsubscribe {
      const listener = (_e: Electron.IpcRendererEvent, status: UpdateStatusDto): void => handler(status)
      ipcRenderer.on(CHANNELS.pushUpdate, listener)
      return () => ipcRenderer.removeListener(CHANNELS.pushUpdate, listener)
    }
  },
  diagnostics: {
    run: () => invoke<DiagnosticsReport>(CHANNELS.diagnostics, {})
  },
  /**
   * Sign in with Google.
   *
   * `start` opens the system browser and returns the URL as well, so a user
   * whose browser did not open can copy it. No token ever crosses this bridge
   * back to the renderer: `status` reports whether someone is signed in and who,
   * and that is all the UI needs.
   */
  auth: {
    status: () => invoke<AuthStatus>(CHANNELS.authStatus, {}),
    start: () => invoke<{ ok: boolean; url?: string; redirectUri?: string; error?: string }>(CHANNELS.authStart, {}),
    complete: (code: string, state: string) =>
      invoke<{ ok: boolean; account?: AuthAccount; error?: string }>(CHANNELS.authComplete, { code, state }),
    signOut: () => invoke<{ ok: boolean }>(CHANNELS.authSignOut, {})
  },
  /**
   * Which mode this install runs in, and whether that needs an account.
   *
   * `ok: false` is a real outcome, not an error to swallow: half a configuration
   * is reported rather than quietly treated as `local`.
   */
  mode: {
    get: () => invoke<ModeInfo>(CHANNELS.modeGet, {})
  },
  /**
   * Coins available, and where they live.
   *
   * `source` is part of the answer rather than something the UI decides: in a
   * hosted build the number is the server's, and the UI must say so.
   */
  balance: {
    get: () => invoke<BalanceInfo>(CHANNELS.balanceGet, {})
  },
  /** Subscribe to main-process pushes. Returns an unsubscribe function. */
  onMainEvent(handler: (event: MainEvent) => void): Unsubscribe {
    const listener = (_e: Electron.IpcRendererEvent, event: MainEvent): void => handler(event)
    ipcRenderer.on(CHANNELS.push, listener)
    return () => ipcRenderer.removeListener(CHANNELS.push, listener)
  }
}

export type CryptoricApi = typeof api

contextBridge.exposeInMainWorld('cryptoric', api)