/**
 * Renderer state.
 *
 * One reducer, one place where main-process facts land. The renderer invents
 * nothing: every value shown came across the preload bridge. Actions are thin
 * wrappers that call the bridge and then let the resulting pushes update state.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type {
  AgentTask,
  ApprovalRequest,
  EnvironmentGap,
  InstallProgress,
  MainEvent,
  ProcessInfo,
  ProjectProfile,
  TerminalSessionInfo,
  TimelineEntry,
  ToolStatus,
  WorkspaceState
} from '@shared/types'
import type { BudgetSummary, ModelSummary } from '../panes/ModelPicker'
import { describe } from './store'
import type { TranscriptEntry } from './store'

export interface AppStateShape {
  booted: boolean
  bootError: string | null
  version: string
  project: ProjectProfile | null
  tools: ToolStatus[]
  gaps: EnvironmentGap[]
  install: Record<string, InstallProgress>
  snapshotId: number | null
  tasks: AgentTask[]
  timeline: TimelineEntry[]
  transcript: TranscriptEntry[]
  terminals: TerminalSessionInfo[]
  processes: ProcessInfo[]
  approvals: ApprovalRequest[]
  workspaceState: WorkspaceState
  branch: string | null
  changeCount: number
  online: boolean
  notice: string | null
  models: ModelSummary[]
  budget: BudgetSummary
}

const initial: AppStateShape = {
  booted: false,
  bootError: null,
  version: '0.0.0',
  project: null,
  tools: [],
  gaps: [],
  install: {},
  snapshotId: null,
  tasks: [],
  timeline: [],
  transcript: [],
  terminals: [],
  processes: [],
  approvals: [],
  workspaceState: 'IDLE',
  branch: null,
  changeCount: 0,
  online: navigator.onLine,
  notice: null,
  models: [],
  budget: { usedCoins: 0, budgetCoins: 0, day: '', exceeded: false, enabled: false, model: '' }
}

type Action =
  | { type: 'booted'; version: string }
  | { type: 'boot-failed'; error: string }
  | { type: 'project'; project: ProjectProfile }
  | { type: 'tools'; tools: ToolStatus[] }
  | { type: 'gaps'; gaps: EnvironmentGap[] }
  | { type: 'install'; progress: InstallProgress }
  | { type: 'snapshot'; id: number }
  | { type: 'task'; task: AgentTask }
  | { type: 'timeline'; entry: TimelineEntry }
  | { type: 'say'; text: string; kind?: 'say' | 'error' }
  | { type: 'terminals'; terminals: TerminalSessionInfo[] }
  | { type: 'process'; process: ProcessInfo }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  | { type: 'online'; online: boolean }
  | { type: 'git'; branch: string | null; changes: number }
  | { type: 'models'; models: ModelSummary[]; budget: BudgetSummary }
  | { type: 'notice'; notice: string | null }

const MAX_TIMELINE = 800
const MAX_TRANSCRIPT = 400

function reducer(state: AppStateShape, action: Action): AppStateShape {
  switch (action.type) {
    case 'booted':
      return { ...state, booted: true, version: action.version, bootError: null }
    case 'boot-failed':
      return { ...state, booted: true, bootError: action.error }
    case 'project':
      return { ...state, project: action.project }
    case 'tools':
      return { ...state, tools: action.tools }
    case 'gaps':
      return { ...state, gaps: action.gaps }
    case 'install':
      return { ...state, install: { ...state.install, [action.progress.toolId]: action.progress } }
    case 'snapshot':
      return { ...state, snapshotId: action.id }
    case 'task': {
      const tasks = state.tasks.filter((t) => t.id !== action.task.id)
      tasks.unshift(action.task)
      return { ...state, tasks, workspaceState: deriveState(action.task.status, state.workspaceState) }
    }
    case 'timeline':
      return { ...state, timeline: [...state.timeline, action.entry].slice(-MAX_TIMELINE) }
    case 'say': {
      const entry: TranscriptEntry = {
        id: `${Date.now()}-${state.transcript.length}`,
        at: new Date().toISOString(),
        kind: action.kind ?? 'say',
        role: 'CHAN',
        text: action.text
      }
      return { ...state, transcript: [...state.transcript, entry].slice(-MAX_TRANSCRIPT) }
    }
    case 'terminals':
      return { ...state, terminals: action.terminals }
    case 'process': {
      const processes = state.processes.filter((p) => p.id !== action.process.id)
      processes.unshift(action.process)
      return { ...state, processes }
    }
    case 'approval':
      return { ...state, approvals: [...state.approvals, action.request] }
    case 'approval-resolved':
      return { ...state, approvals: state.approvals.filter((a) => a.id !== action.id) }
    case 'online':
      return { ...state, online: action.online }
    case 'git':
      return { ...state, branch: action.branch, changeCount: action.changes }
    case 'models':
      return { ...state, models: action.models, budget: action.budget }
    case 'notice':
      return { ...state, notice: action.notice }
    default:
      return state
  }
}

function deriveState(status: AgentTask['status'], previous: WorkspaceState): WorkspaceState {
  switch (status) {
    case 'RUNNING':
      return 'RUNNING'
    case 'TESTING':
      return 'TESTING'
    case 'FAILED':
      return 'ERROR'
    case 'QUEUED':
    case 'PLANNING':
    case 'REVIEWING':
    case 'WAITING_FOR_USER':
      return 'ACTIVE'
    default:
      return previous === 'RUNNING' || previous === 'TESTING' ? 'IDLE' : previous
  }
}

export function useAppState(): { state: AppStateShape; actions: ReturnType<typeof useActions> } {
  const [state, dispatch] = useReducer(reducer, initial)

  const actions = useActions(dispatch)

  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    const bridge = typeof window !== 'undefined' ? window.cryptoric : undefined
    if (!bridge) {
      dispatch({
        type: 'boot-failed',
        error:
          'The preload bridge is unavailable, so Cryptoric Agent cannot reach its privileged services. This usually means the preload script failed to load.'
      })
      return
    }
    void (async () => {
      try {
        const info = await bridge.app.info()
        dispatch({ type: 'booted', version: info.version })
        await actions.refreshEnvironment()
        await actions.refreshGaps()
        await actions.syncTerminals()
        await actions.refreshModels()
        await actions.refreshGit()
        for (const task of await bridge.agent.list()) dispatch({ type: 'task', task })
      } catch (err) {
        dispatch({ type: 'boot-failed', error: describe(err) })
      }
    })()
  }, [actions])

  // Main-process pushes.
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.cryptoric : undefined
    if (!bridge) return
    const unsubscribe = bridge.onMainEvent((event: MainEvent) => {
      switch (event.type) {
        case 'timeline':
          dispatch({ type: 'timeline', entry: event.entry })
          break
        case 'task':
          dispatch({ type: 'task', task: event.task })
          break
        case 'install-progress':
          dispatch({ type: 'install', progress: event.progress })
          break
        case 'env-changed':
          dispatch({ type: 'snapshot', id: event.snapshot.id })
          dispatch({ type: 'tools', tools: event.tools })
          void actions.refreshGaps()
          void actions.syncTerminals()
          break
        case 'terminal-exit':
          void actions.syncTerminals()
          break
        case 'process':
          dispatch({ type: 'process', process: event.process })
          break
        case 'approval':
          dispatch({ type: 'approval', request: event.request })
          break
        case 'project':
          dispatch({ type: 'project', project: event.project })
          break
        case 'log':
          // Chan's narration arrives as an info log; without this the agent's
          // messages would never reach the transcript.
          dispatch({
            type: 'say',
            text: event.message,
            kind: event.level === 'error' ? 'error' : 'say'
          })
          break
        default:
          break
      }
    })
    return unsubscribe
  }, [actions])

  useEffect(() => {
    const onOnline = (): void => dispatch({ type: 'online', online: true })
    const onOffline = (): void => dispatch({ type: 'online', online: false })
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  return { state, actions }
}

function useActions(dispatch: React.Dispatch<Action>) {
  const refreshEnvironment = useCallback(async () => {
    if (!window.cryptoric) return
    try {
      const result = await window.cryptoric.env.inspect(true)
      dispatch({ type: 'snapshot', id: result.snapshot.id })
      dispatch({ type: 'tools', tools: result.tools })
    } catch (err) {
      dispatch({ type: 'notice', notice: describe(err) })
    }
  }, [dispatch])

  const refreshGaps = useCallback(async () => {
    if (!window.cryptoric) return
    try {
      dispatch({ type: 'gaps', gaps: await window.cryptoric.project.gaps() })
    } catch {
      dispatch({ type: 'gaps', gaps: [] })
    }
  }, [dispatch])

  const refreshModels = useCallback(async () => {
    if (!window.cryptoric) return
    try {
      const snapshot = await window.cryptoric.models.catalog()
      dispatch({ type: 'models', models: snapshot.models, budget: snapshot.budget })
    } catch {
      /* the picker degrades to "no model" */
    }
  }, [dispatch])

  const refreshGit = useCallback(async () => {
    if (!window.cryptoric) return
    try {
      const status = await window.cryptoric.git.status()
      dispatch({ type: 'git', branch: status.branch, changes: status.entries.length })
    } catch {
      dispatch({ type: 'git', branch: null, changes: 0 })
    }
  }, [dispatch])

  const syncTerminals = useCallback(async () => {
    if (!window.cryptoric) return
    try {
      dispatch({ type: 'terminals', terminals: await window.cryptoric.terminal.list() })
    } catch {
      /* ignore */
    }
  }, [dispatch])

  return useMemo(
    () => ({
      refreshGaps,
      refreshModels,
      refreshGit,
      syncTerminals,
      notify: (notice: string | null) => dispatch({ type: 'notice', notice }),

      openProject: async () => {
        try {
          const project = await window.cryptoric.project.open()
          dispatch({ type: 'project', project })
          dispatch({ type: 'notice', notice: `Opened ${project.name}` })
          await refreshGaps()
          await refreshGit()
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
        }
      },

      submitTask: async (prompt: string) => {
        try {
          const task = await window.cryptoric.agent.submit(prompt)
          dispatch({ type: 'task', task })
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
        }
      },

      install: async (toolId: string) => {
        dispatch({ type: 'notice', notice: `Installing ${toolId}…` })
        try {
          const outcome = await window.cryptoric.env.install(toolId)
          dispatch({
            type: 'notice',
            notice: outcome.ok
              ? `${toolId} ready — environment refreshed (snapshot ${outcome.snapshotBefore} → ${outcome.snapshotAfter}). Cryptoric Agent did not restart.`
              : `Could not install ${toolId}: ${outcome.error ?? 'unknown error'}`
          })
          await refreshEnvironment()
          await refreshGaps()
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
        }
      },

      refreshEnvironment: async () => {
        try {
          const result = await window.cryptoric.env.refresh()
          dispatch({ type: 'snapshot', id: result.snapshot.id })
          dispatch({ type: 'tools', tools: result.tools })
          await refreshGaps()
          await syncTerminals()
          dispatch({
            type: 'notice',
            notice: `Environment refreshed to snapshot ${result.snapshot.id}. New shells use it; existing ones were preserved.`
          })
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
        }
      },

      resolveApproval: async (id: string, approved: boolean) => {
        try {
          await window.cryptoric.approval.resolve(id, approved)
          dispatch({ type: 'approval-resolved', id })
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
        }
      },

      selectModel: async (modelId: string) => {
        try {
          await window.cryptoric.models.select(modelId)
          await refreshModels()
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
        }
      },

      diagnostics: async () => {
        const report = await window.cryptoric.diagnostics.run()
        return report
      },

      routeSkills: async (prompt: string) => window.cryptoric.skill.route(prompt)
    }),
    [refreshEnvironment, refreshGaps, refreshModels, refreshGit, syncTerminals, dispatch]
  )
}