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
import type {
  AgentTask,
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
  modelProvider?: 'none' | 'ollama' | 'openai-compatible'
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

const api = {
  app: {
    info: () => invoke<AppInfo>(CHANNELS.appInfo, {})
  },
  state: {
    get: () => invoke<AppStatePatch>(CHANNELS.stateGet, {}),
    set: (patch: AppStatePatch) => invoke<AppStatePatch>(CHANNELS.stateSet, { patch })
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
  approval: {
    list: () => invoke<unknown[]>(CHANNELS.approvalList, {}),
    resolve: (id: string, approved: boolean, remember?: boolean) =>
      invoke<boolean>(CHANNELS.approvalResolve, { id, approved, remember })
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
  diagnostics: {
    run: () => invoke<DiagnosticsReport>(CHANNELS.diagnostics, {})
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