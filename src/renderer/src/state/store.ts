/**
 * Renderer state.
 *
 * A single reducer-backed store. The renderer holds no privileged state of its
 * own: every fact it displays came from the main process, and every mutation
 * goes back through the preload bridge. That keeps the trust boundary at the
 * bridge instead of smeared across components.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type {
  AgentTask,
  ApprovalRequest,
  InstallProgress,
  MainEvent,
  ProcessInfo,
  ProjectProfile,
  TerminalSessionInfo,
  TimelineEntry,
  ToolStatus,
  WorkspaceState
} from '@shared/types'

export interface TranscriptEntry {
  id: string
  at: string
  kind: 'say' | 'note' | 'error'
  /**
   * Who spoke. `YOU` is the developer's prompt, `CHAN` the agent's reply, and
   * `TOOL` a record of something the agent actually ran — kept separate from
   * speech so a short answer is not padded out by its own mechanics.
   */
  role: 'CHAN' | 'YOU' | 'TOOL'
  text: string
}

export interface AppStateShape {
  booted: boolean
  bootError: string | null
  appInfo: Record<string, unknown> | null
  project: ProjectProfile | null
  tools: ToolStatus[]
  snapshotId: number | null
  snapshotReason: string | null
  install: Record<string, InstallProgress>
  tasks: AgentTask[]
  timeline: TimelineEntry[]
  transcript: TranscriptEntry[]
  terminals: TerminalSessionInfo[]
  processes: ProcessInfo[]
  approvals: ApprovalRequest[]
  workspaceState: WorkspaceState
  online: boolean
}

const initialState: AppStateShape = {
  booted: false,
  bootError: null,
  appInfo: null,
  project: null,
  tools: [],
  snapshotId: null,
  snapshotReason: null,
  install: {},
  tasks: [],
  timeline: [],
  transcript: [],
  terminals: [],
  processes: [],
  approvals: [],
  workspaceState: 'IDLE',
  online: navigator.onLine
}

type Action =
  | { type: 'booted'; info: Record<string, unknown> }
  | { type: 'boot-failed'; error: string }
  | { type: 'project'; project: ProjectProfile }
  | { type: 'tools'; tools: ToolStatus[] }
  | { type: 'snapshot'; snapshotId: number; reason: string }
  | { type: 'install-progress'; progress: InstallProgress }
  | { type: 'task'; task: AgentTask }
  | { type: 'timeline'; entry: TimelineEntry }
  | { type: 'say'; text: string }
  | { type: 'terminals'; terminals: TerminalSessionInfo[] }
  | { type: 'process'; process: ProcessInfo }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  | { type: 'online'; online: boolean }
  | { type: 'workspace'; state: WorkspaceState }

/** Timeline and transcript are capped so a long session cannot exhaust memory. */
const MAX_TIMELINE = 800
const MAX_TRANSCRIPT = 400

function reducer(state: AppStateShape, action: Action): AppStateShape {
  switch (action.type) {
    case 'booted':
      return { ...state, booted: true, appInfo: action.info, bootError: null }
    case 'boot-failed':
      return { ...state, booted: true, bootError: action.error }
    case 'project':
      return { ...state, project: action.project }
    case 'tools':
      return { ...state, tools: action.tools }
    case 'snapshot':
      return { ...state, snapshotId: action.snapshotId, snapshotReason: action.reason }
    case 'install-progress': {
      const install = { ...state.install }
      if (action.progress.phase === 'done' || action.progress.phase === 'failed') {
        // Keep the terminal state visible for a beat, then let the UI drop it.
        install[action.progress.toolId] = action.progress
      } else {
        install[action.progress.toolId] = action.progress
      }
      return { ...state, install }
    }
    case 'task': {
      const tasks = state.tasks.filter((t) => t.id !== action.task.id)
      tasks.unshift(action.task)
      return { ...state, tasks, workspaceState: deriveWorkspaceState(action.task, state.workspaceState) }
    }
    case 'timeline': {
      const timeline = [...state.timeline, action.entry]
      return { ...state, timeline: timeline.slice(-MAX_TIMELINE) }
    }
    case 'say': {
      const entry: TranscriptEntry = {
        id: `${Date.now()}-${state.transcript.length}`,
        at: new Date().toISOString(),
        kind: 'say',
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
      return { ...state, online: action.online, workspaceState: action.online ? state.workspaceState : 'OFFLINE' }
    case 'workspace':
      return { ...state, workspaceState: action.state }
    default:
      return state
  }
}

function deriveWorkspaceState(task: AgentTask, previous: WorkspaceState): WorkspaceState {
  switch (task.status) {
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
      return previous === 'RUNNING' ? 'IDLE' : previous
  }
}

export function useAppStore(): {
  state: AppStateShape
  dispatch: React.Dispatch<Action>
  refreshEnvironment: () => Promise<void>
} {
  const [state, dispatch] = useReducer(reducer, initialState)
  // A missing bridge must degrade to an explicit error screen, never a blank
  // window: an effect that throws here would unmount the whole React tree.
  const bridge = typeof window !== 'undefined' ? window.cryptoric : undefined

  const refreshEnvironment = useCallback(async () => {
    if (!window.cryptoric) return
    try {
      const result = await window.cryptoric.env.inspect(true)
      dispatch({ type: 'snapshot', snapshotId: result.snapshot.id, reason: result.snapshot.reason })
      dispatch({ type: 'tools', tools: result.tools })
    } catch (err) {
      dispatch({ type: 'say', text: `Environment inspection failed: ${describe(err)}` })
    }
  }, [])

  // Seed everything once the bridge is available.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
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
        const info = await window.cryptoric.app.info()
        dispatch({ type: 'booted', info: info as unknown as Record<string, unknown> })
        await refreshEnvironment()
        const terminals = await window.cryptoric.terminal.list()
        dispatch({ type: 'terminals', terminals })
        const tasks = await window.cryptoric.agent.list()
        for (const task of tasks) dispatch({ type: 'task', task })
      } catch (err) {
        dispatch({ type: 'boot-failed', error: describe(err) })
      }
    })()
  }, [refreshEnvironment, bridge])

  // Main-process pushes. The renderer never fabricates these.
  useEffect(() => {
    if (!bridge) return
    const unsubscribe = window.cryptoric.onMainEvent((event: MainEvent) => {
      switch (event.type) {
        case 'timeline':
          dispatch({ type: 'timeline', entry: event.entry })
          if (event.entry.status === 'error' && event.entry.stage.startsWith('tool-')) {
            dispatch({
              type: 'say',
              text: event.entry.message
            })
          }
          break
        case 'task':
          dispatch({ type: 'task', task: event.task })
          break
        case 'install-progress':
          dispatch({ type: 'install-progress', progress: event.progress })
          break
        case 'env-changed':
          dispatch({ type: 'snapshot', snapshotId: event.snapshot.id, reason: event.snapshot.reason })
          dispatch({ type: 'tools', tools: event.tools })
          void window.cryptoric.terminal.list().then((t: TerminalSessionInfo[]) => dispatch({ type: 'terminals', terminals: t }))
          break
        case 'terminal-output':
          break
        case 'terminal-exit':
          void window.cryptoric.terminal.list().then((t: TerminalSessionInfo[]) => dispatch({ type: 'terminals', terminals: t }))
          break
        case 'process':
          dispatch({ type: 'process', process: event.process })
          break
        case 'approval':
          dispatch({ type: 'approval', request: event.request })
          break
        case 'log':
          if (event.level !== 'info') dispatch({ type: 'say', text: event.message })
          break
        case 'project':
          dispatch({ type: 'project', project: event.project })
          break
        default:
          break
      }
    })
    return unsubscribe
  }, [bridge])

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

  return useMemo(() => ({ state, dispatch, refreshEnvironment }), [state, refreshEnvironment])
}

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}