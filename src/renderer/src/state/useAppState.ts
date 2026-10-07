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
  ConversationTurn,
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
import type { AuthStatus, BalanceInfo, ModeInfo, RecentProject, UpdateStatusDto } from '../../../preload'
import { describe } from './store'
import type { SignInPhase } from '@shared/account-view'
import type { TranscriptEntry } from './store'

export interface AppStateShape {
  booted: boolean
  bootError: string | null
  version: string
  project: ProjectProfile | null
  /** Projects opened before, newest first. The first page reads this as history. */
  recentProjects: RecentProject[]
  tools: ToolStatus[]
  gaps: EnvironmentGap[]
  install: Record<string, InstallProgress>
  snapshotId: number | null
  tasks: AgentTask[]
  timeline: TimelineEntry[]
  transcript: TranscriptEntry[]
  terminals: TerminalSessionInfo[]
  processes: ProcessInfo[]
  approvals: { id: string; toolId: string; title: string; detail: string; risk: string }[]
  workspaceState: WorkspaceState
  branch: string | null
  changeCount: number
  online: boolean
  notice: string | null
  models: ModelSummary[]
  budget: BudgetSummary
  update: UpdateStatusDto | null
  /** True once the user picks "later"; hides the prompt without forgetting it. */
  updateDismissed: boolean
  /** Who is signed in, if anyone. Null until the first status call returns. */
  auth: AuthStatus | null
  /** Where the browser round-trip has got to. */
  authPhase: SignInPhase
  /** The last sign-in failure, shown until the next attempt. */
  authError: string | null
  /** Which mode this install runs in. Null until it is read. */
  mode: ModeInfo | null
  /** Coins, and where they are counted. Null until it is read. */
  balance: BalanceInfo | null
}

const initial: AppStateShape = {
  booted: false,
  bootError: null,
  version: '0.0.0',
  project: null,
  recentProjects: [],
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
  budget: { usedCoins: 0, budgetCoins: 0, day: '', exceeded: false, enabled: false, model: '' },
  update: null,
  updateDismissed: false,
  auth: null,
  authPhase: 'idle',
  authError: null,
  mode: null,
  balance: null
}

type Action =
  | { type: 'booted'; version: string }
  | { type: 'boot-failed'; error: string }
  | { type: 'project'; project: ProjectProfile }
  | { type: 'recents'; projects: RecentProject[] }
  | { type: 'tools'; tools: ToolStatus[] }
  | { type: 'gaps'; gaps: EnvironmentGap[] }
  | { type: 'install'; progress: InstallProgress }
  | { type: 'snapshot'; id: number }
  | { type: 'task'; task: AgentTask }
  | { type: 'timeline'; entry: TimelineEntry }
  | { type: 'turn'; turn: ConversationTurn }
  | { type: 'transcript-loaded'; turns: ConversationTurn[] }
  | { type: 'terminals'; terminals: TerminalSessionInfo[] }
  | { type: 'process'; process: ProcessInfo }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  | { type: 'online'; online: boolean }
  | { type: 'git'; branch: string | null; changes: number }
  | { type: 'models'; models: ModelSummary[]; budget: BudgetSummary }
  | { type: 'notice'; notice: string | null }
  | { type: 'update'; update: UpdateStatusDto | null }
  | { type: 'update-dismissed'; dismissed: boolean }
  | { type: 'auth'; status: AuthStatus | null }
  | { type: 'auth-phase'; phase: SignInPhase; error?: string | null }
  | { type: 'mode'; mode: ModeInfo | null }
  | { type: 'balance'; balance: BalanceInfo | null }

const MAX_TIMELINE = 800
/**
 * Rendered transcript cap.
 *
 * Higher than the on-disk cap on purpose: the file is the record of what
 * happened, and the view is only showing the tail of it.
 */
const MAX_TRANSCRIPT = 400

function reducer(state: AppStateShape, action: Action): AppStateShape {
  switch (action.type) {
    case 'booted':
      return { ...state, booted: true, version: action.version, bootError: null }
    case 'boot-failed':
      return { ...state, booted: true, bootError: action.error }
    case 'project':
      return { ...state, project: action.project }
    case 'recents':
      return { ...state, recentProjects: action.projects }
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
    case 'turn': {
      const transcript = state.transcript
      // Turns carry the main-process id, so a turn that arrives twice — a push
      // racing the boot fetch, for instance — replaces itself rather than
      // appearing twice.
      const existing = transcript.findIndex((entry) => entry.id === action.turn.id)
      const entry = toTranscriptEntry(action.turn)
      if (existing >= 0) {
        const next = [...transcript]
        next[existing] = entry
        return { ...state, transcript: next }
      }
      return { ...state, transcript: [...transcript, entry].slice(-MAX_TRANSCRIPT) }
    }
    case 'transcript-loaded': {
      const transcript = action.turns.map(toTranscriptEntry).slice(-MAX_TRANSCRIPT)
      return { ...state, transcript }
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
    case 'update':
      // A different version arriving un-dismisses the prompt: a new offer is a
      // new decision, and silently hiding it would be the app deciding for the
      // user.
      if (state.update?.availableVersion !== action.update?.availableVersion) {
        return { ...state, update: action.update, updateDismissed: false }
      }
      return { ...state, update: action.update }
    case 'update-dismissed':
      return { ...state, updateDismissed: action.dismissed }
    case 'auth':
      return { ...state, auth: action.status }
    case 'auth-phase':
      // A fresh phase clears the previous failure: leaving an old error beside
      // a new attempt reads as "this is what went wrong", which it is not.
      return {
        ...state,
        authPhase: action.phase,
        authError: action.error === undefined ? state.authError : action.error
      }
    case 'mode':
      return { ...state, mode: action.mode }
    case 'balance':
      return { ...state, balance: action.balance }
    default:
      return state
  }
}

/**
 * Project a stored turn onto the transcript row the chat view renders.
 *
 * `tool` turns become `note` rows: they are the evidence of work, not speech,
 * and rendering them at the same weight as a reply would make a short answer
 * look like a long one. Their `ok` flag drives the colour, so a failed tool is
 * visible without opening the execution timeline.
 */
function toTranscriptEntry(turn: ConversationTurn): TranscriptEntry {
  return {
    id: turn.id,
    at: turn.at,
    kind: turn.role === 'tool' ? (turn.ok === false ? 'error' : 'note') : 'say',
    role: turn.role === 'user' ? 'YOU' : turn.role === 'tool' ? 'TOOL' : 'CHAN',
    text: turn.text
  }
}

function deriveState(status: AgentTask['status'], previous: WorkspaceState): WorkspaceState {
  switch (status) {
    // Every named work state maps to a live workspace. Leaving these to the
    // `default` branch would have dropped ANALYZING / IMPLEMENTING / VERIFYING
    // to IDLE, so a task doing real work would show as an idle workspace.
    case 'ANALYZING':
    case 'PLANNING':
    case 'IMPLEMENTING':
    case 'VERIFYING':
    case 'REVIEWING':
    case 'FIXING':
    case 'CANCELLING':
      return 'ACTIVE'
    case 'RUNNING':
      return 'RUNNING'
    case 'TESTING':
      return 'TESTING'
    case 'FAILED':
    case 'BLOCKED':
      return 'ERROR'
    case 'COMPLETED':
      return 'IDLE'
    case 'CANCELLED':
    case 'PAUSED':
      return previous === 'RUNNING' || previous === 'TESTING' ? 'IDLE' : previous
    case 'QUEUED':
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
        // Identity and mode are read at boot so the account chip is honest on
        // the first paint rather than after a click.
        await actions.refreshAuth()
        await actions.refreshMode()
        await actions.refreshBalance()
        for (const task of await bridge.agent.list()) dispatch({ type: 'task', task })
        // History first, so a restart shows the conversation that already
        // happened rather than an empty pane the model nonetheless remembers.
        await actions.loadConversation()
        await actions.loadRecentProjects()
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
        case 'conversation':
          dispatch({ type: 'turn', turn: event.turn })
          break
        case 'log':
          // Deliberately not a transcript entry. Main-process logs are internal
          // progress (audit lines, credential seeding); the transcript is the
          // conversation, and mixing the two is what made the chat read as
          // machine chatter.
          break
        default:
          break
      }
    })

    // Update transitions arrive on their own channel: a check that started at
    // launch can finish long after Settings was opened.
    const unsubscribeUpdate = window.cryptoric.updates.onUpdate((status) => {
      dispatch({ type: 'update', update: status })
      if (status.state === 'available' && status.availableVersion) {
        dispatch({ type: 'notice', notice: `Version ${status.availableVersion} is available.` })
      }
    })

    return () => {
      unsubscribe()
      unsubscribeUpdate()
    }
  }, [actions])

  useEffect(() => {
    // Read the current update state at boot. Without this the panel would sit on
    // "Checking for updates…" until a background push happened to arrive, which
    // on a machine with no newer release never comes — an indefinite in-progress
    // state where the truth is available immediately.
    void window.cryptoric?.updates
      .status()
      .then((status) => dispatch({ type: 'update', update: status }))
      .catch(() => undefined)
  }, [])

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
  /**
   * Projects opened before, newest first.
   *
   * Read at boot and refreshed whenever a project opens, because a list that
   * only updated on restart would show the project you just opened as missing
   * from its own history.
   */
  const loadRecentProjects = useCallback(async () => {
    if (!window.cryptoric) return
    try {
      dispatch({ type: 'recents', projects: await window.cryptoric.project.list() })
    } catch (err) {
      dispatch({ type: 'notice', notice: describe(err) })
    }
  }, [dispatch])

  const loadConversation = useCallback(async () => {
    if (!window.cryptoric) return
    try {
      const snapshot = await window.cryptoric.conversation.list()
      dispatch({ type: 'transcript-loaded', turns: snapshot.turns })
    } catch (err) {
      dispatch({ type: 'notice', notice: describe(err) })
    }
  }, [dispatch])

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

  const refreshAuth = useCallback(async () => {
    if (!window.cryptoric) return null
    try {
      const status = await window.cryptoric.auth.status()
      dispatch({ type: 'auth', status })
      return status
    } catch {
      dispatch({ type: 'auth', status: null })
      return null
    }
  }, [dispatch])

  /**
   * Read the balance from wherever it lives.
   *
   * A failure is stored as the answer rather than thrown away: in a hosted
   * build "the server could not be reached" is exactly what the account pane
   * should say, and silently leaving the last number up would be a stale
   * balance presented as current.
   */
  const refreshBalance = useCallback(async () => {
    if (!window.cryptoric) return null
    try {
      const balance = await window.cryptoric.balance.get()
      dispatch({ type: 'balance', balance })
      return balance
    } catch (err) {
      dispatch({ type: 'balance', balance: { source: 'local', ok: false, error: describe(err) } })
      return null
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
      loadConversation,
      loadRecentProjects,
      notify: (notice: string | null) => dispatch({ type: 'notice', notice }),

      /**
       * Updates. Checking is passive and happens on its own; downloading is
       * only ever started from here, by the user, from Settings.
       */
      dismissUpdate: () => dispatch({ type: 'update-dismissed', dismissed: true }),

      checkForUpdates: async (force = false) => {
        try {
          const status = await window.cryptoric.updates.check(force)
          dispatch({ type: 'update', update: status })
          if (status.state === 'available') {
            dispatch({ type: 'notice', notice: `Version ${status.availableVersion} is available.` })
          } else if (status.state === 'error') {
            dispatch({ type: 'notice', notice: status.error ?? 'Update check failed.' })
          }
          return status
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
          return null
        }
      },

      downloadUpdate: async () => {
        try {
          const status = await window.cryptoric.updates.download()
          dispatch({ type: 'update', update: status })
          dispatch({
            type: 'notice',
            notice:
              status.state === 'downloaded'
                ? 'Update downloaded. Restart to install it.'
                : (status.error ?? 'Could not download the update.')
          })
          return status
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
          return null
        }
      },

      installUpdate: async () => {
        try {
          await window.cryptoric.updates.install()
          return true
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
          return false
        }
      },

      clearConversation: async () => {
        try {
          const snapshot = await window.cryptoric.conversation.clear()
          dispatch({ type: 'transcript-loaded', turns: snapshot.turns })
          dispatch({ type: 'notice', notice: 'Conversation history cleared.' })
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
        }
      },

      openProject: async (root?: string) => {
        try {
          const project = await window.cryptoric.project.open(root)
          dispatch({ type: 'project', project })
          dispatch({ type: 'notice', notice: `Opened ${project.name}` })
          await refreshGaps()
          await refreshGit()
          // The project just opened is now the most recent one.
          await loadRecentProjects()
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
        }
      },

      /**
       * Stop the running task.
       *
       * `agent:stop` was wired through the main process, the router, the
       * preload bridge and the schema, and then had no control anywhere in the
       * renderer — so the one thing a user must always be able to do, halt the
       * agent, was unreachable from the interface.
       */
      stopTask: async (taskId: string) => {
        try {
          const stopped = await window.cryptoric.agent.stop(taskId)
          dispatch({
            type: 'notice',
            notice: stopped ? 'Stopped. The agent will not run anything further.' : 'That task had already finished.'
          })
          // The task object comes back through the event stream; asking for the
          // list here keeps the button honest if the stop lost a race.
          const snapshot = await window.cryptoric.agent.list()
          for (const task of snapshot) dispatch({ type: 'task', task })
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

      resolveApproval: async (id: string, approved: boolean, remember?: boolean, toolId?: string) => {
        try {
          await window.cryptoric.approval.resolve(id, approved, remember, toolId)
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

      /**
       * Sign in.
       *
       * The main process owns the loopback listener and the code exchange; this
       * only reports where the round-trip has got to, and re-reads the session
       * afterwards so the chip reflects what was actually stored rather than
       * what the browser implied.
       */
      refreshAuth,
      refreshBalance,

      startSignIn: async () => {
        // One in-flight phase for the whole round trip. `auth.start` resolves
        // only once the redirect has been redeemed, so nothing between the
        // click and that answer can be honestly labelled "opening".
        dispatch({ type: 'auth-phase', phase: 'pending', error: null })
        try {
          const result = await window.cryptoric.auth.start()
          dispatch({ type: 'auth-phase', phase: 'idle', error: result.ok ? null : (result.error ?? 'Sign-in did not start.') })
          await refreshAuth()
          // Signing in changes whose balance this is, so the number is re-read
          // rather than left showing the previous account's coins.
          if (result.ok) await refreshBalance()
          dispatch({
            type: 'notice',
            notice: result.ok ? 'Signed in. Your coin balance is now tied to this account.' : null
          })
          return result
        } catch (err) {
          dispatch({ type: 'auth-phase', phase: 'idle', error: describe(err) })
          await refreshAuth()
          return { ok: false, error: describe(err) }
        }
      },

      /** Finish a sign-in from a redirect the user pasted by hand. */
      completeSignIn: async (code: string, state: string) => {
        try {
          const result = await window.cryptoric.auth.complete(code, state)
          dispatch({ type: 'auth-phase', phase: 'idle', error: result.ok ? null : (result.error ?? 'Sign-in failed.') })
          await refreshAuth()
          await refreshBalance()
          if (result.ok) dispatch({ type: 'notice', notice: 'Signed in.' })
          return result
        } catch (err) {
          dispatch({ type: 'auth-phase', phase: 'idle', error: describe(err) })
          return { ok: false, error: describe(err) }
        }
      },

      signOut: async () => {
        try {
          await window.cryptoric.auth.signOut()
          // The phase is dropped here as well as in main: cancelling an
          // in-flight attempt resolves `auth.start` with "cancelled", and a
          // UI still claiming to wait would be wrong.
          dispatch({ type: 'auth-phase', phase: 'idle', error: null })
          await refreshAuth()
          await refreshBalance()
          dispatch({ type: 'notice', notice: 'Signed out. The account token was deleted from this computer.' })
        } catch (err) {
          dispatch({ type: 'notice', notice: describe(err) })
        }
      },

      refreshMode: async () => {
        if (!window.cryptoric) return null
        try {
          const mode = await window.cryptoric.mode.get()
          dispatch({ type: 'mode', mode })
          return mode
        } catch {
          dispatch({ type: 'mode', mode: null })
          return null
        }
      },

      routeSkills: async (prompt: string) => window.cryptoric.skill.route(prompt)
    }),
    [refreshEnvironment, refreshGaps, refreshModels, refreshGit, refreshAuth, refreshBalance, syncTerminals, loadConversation, loadRecentProjects, dispatch]
  )
}