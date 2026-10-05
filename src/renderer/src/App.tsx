/**
 * Cryptoric Agent shell.
 *
 * Information architecture:
 *
 *   rail (60px, expandable)  │  contextual stage
 *   topbar: brand · project · … · palette · model · balance · Chan
 *   statusbar: runtimes · branch · changes · ready · version
 *
 * The stage shows one thing at a time. Home is a prompt; a project turns the
 * stage into a working surface; Chan is reachable from the rail and never
 * permanently consumes the centre when the developer is reading code.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EnvironmentGap, ProjectProfile } from '@shared/types'
import { CommandPalette, type Command } from './palette/CommandPalette'
import {
  Button,
  Chip,
  CryptoricMark,
  Dot,
  Icon,
  Resizer,
  Toast,
  toneForInstallState,
  type IconName
} from './components/primitives'
import { HomeSurface } from './panes/Home'
import { ChanPanel } from './panes/Chan'
import { ApprovalOverlay } from './components/ApprovalPrompt'
import { RuntimeManager, useRuntimeSummary } from './panes/RuntimeManager'
import { Workspace, type WorkspaceView } from './panes/Workspace'
import { ModelPicker, StatusBar, type BudgetSummary, type ModelSummary } from './panes/ModelPicker'
import { SettingsSurface, ToolsSurface } from './panes/Settings'
import { UpdatePrompt } from './panes/UpdatePrompt'
import { AccountChip, AccountPane } from './panes/Account'
import { useAppState } from './state/useAppState'
import { describe } from './state/store'

type Section = 'home' | 'files' | 'agent' | 'tasks' | 'search' | 'environment' | 'account' | 'settings'

const NAV: { id: Section; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'agent', label: 'Agent', icon: 'agent' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'environment', label: 'Environment', icon: 'environment' },
  { id: 'account', label: 'Account', icon: 'account' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
]

export function App() {
  const { state, actions } = useAppState()
  const openProjectRef = useRef<(() => void) | null>(null)

  const [section, setSection] = useState<Section>('home')
  const [railOpen, setRailOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [view, setView] = useState<WorkspaceView>('files')
  const [theme, setTheme] = useState<'graphite' | 'bone'>('graphite')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setRailOpen((v) => !v)
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openProjectRef.current?.()
      }
      if (e.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const busy = useMemo(
    () => state.tasks.some((t) => ['RUNNING', 'PLANNING', 'TESTING', 'REVIEWING'].includes(t.status)),
    [state.tasks]
  )

  const openProject = useCallback(async () => {
    await actions.openProject()
    setSection('files')
  }, [actions])

  openProjectRef.current = () => {
    void openProject()
  }

  const commands = useMemo<Command[]>(
    () => [
      { id: 'project.open', group: 'Workspace', title: 'Open project…', hint: 'Detect manifests and required runtimes', run: () => void openProject() },
      ...NAV.map((n) => ({ id: `nav.${n.id}`, group: 'Go to', title: n.label, run: () => setSection(n.id) })),
      {
        id: 'view.files',
        group: 'View',
        title: 'Workspace → Files',
        run: () => {
          setSection('files')
          setView('files')
        }
      },
      { id: 'view.diff', group: 'View', title: 'Workspace → Changes', run: () => { setSection('files'); setView('diff') } },
      { id: 'view.terminal', group: 'View', title: 'Workspace → Terminal', run: () => { setSection('files'); setView('terminal') } },
      { id: 'env.refresh', group: 'Environment', title: 'Refresh environment', hint: 'No restart required', run: () => void actions.refreshEnvironment() },
      {
        id: 'env.install',
        group: 'Environment',
        title: 'Install a missing runtime',
        hint: state.gaps.length ? `Needed: ${state.gaps.map((g) => g.label).join(', ')}` : 'No gaps detected',
        available: () => state.gaps.length > 0,
        run: () => void actions.install(state.gaps[0]?.toolId ?? 'node')
      },      {
        id: 'env.open',
        group: 'Environment',
        title: 'Open Runtime Manager',
        run: () => setSection('environment')
      },
      {
        id: 'account.signin',
        group: 'Account',
        title: state.auth?.signedIn ? 'Sign out' : 'Sign in with Google',
        hint: state.auth?.configured === false ? 'No OAuth client id configured' : 'Opens your browser',
        run: async () => {
          if (state.auth?.signedIn) await actions.signOut()
          else await actions.startSignIn()
        }
      },
      {
        id: 'mode.show',
        group: 'Account',
        title: 'Which mode is this build?',
        hint: state.mode?.ok === true ? state.mode.description : state.mode?.ok === false ? state.mode.error : 'unknown',
        run: async () => {
          const mode = await actions.refreshMode()
          actions.notify(
            mode === null
              ? 'Mode could not be read.'
              : mode.ok
                ? `${mode.description}${mode.serverUrl ? ` (${mode.serverUrl})` : ''}`
                : mode.error
          )
        }
      },
      {
        id: 'theme.toggle',
        group: 'View',
        title: `Switch to ${theme === 'graphite' ? 'Bone' : 'Graphite'} theme`,
        run: () => setTheme((t) => (t === 'graphite' ? 'bone' : 'graphite'))
      },
      {
        id: 'rail.toggle',
        group: 'View',
        title: 'Expand navigation rail',
        hint: 'Ctrl+B',
        run: () => setRailOpen((v) => !v)
      },
      {
        id: 'diagnostics.run',
        group: 'Diagnostics',
        title: 'Run diagnostics',
        run: async () => {
          const report = await actions.diagnostics()
          actions.notify(
            `Diagnostics — Electron ${report.app.electron} · Node ${report.app.node} · ${report.tools.filter((t) => !t.ok).length} runtime(s) unavailable`
          )
        }
      },
      {
        id: 'skills.route',
        group: 'Skills',
        title: 'Show skill routing',
        hint: 'Which skills apply, and which were skipped',
        run: async () => {
          const d = await actions.routeSkills(state.transcript.at(-1)?.text ?? '')
          actions.notify(
            d.skillIds.length
              ? `Loaded ${d.skillIds.join(', ')} (~${d.estimatedTokens} tokens). ${d.skipped.length} skill(s) skipped.`
              : `No skill matched. ${d.skipped.length} considered and skipped — nothing was dumped into context.`
          )
        }
      }
    ],
    [theme, openProject, state.gaps, state.transcript, actions]
  )

  if (state.bootError) {
    return (
      <div className="app">
        <div className="empty-view">
          <CryptoricMark size={44} />
          <span className="title">Cryptoric Agent could not start</span>
          <span className="subtitle" style={{ maxWidth: '52ch' }}>
            {state.bootError}
          </span>
        </div>
      </div>
    )
  }

  const runtimeSummary = useRuntimeSummary(state.tools)

  return (
    <div className="app">
      {/* ---------------------------------------------------------- topbar */}
      <header className="topbar">
        <button
          className="topbar-brand"
          onClick={() => setRailOpen((v) => !v)}
          title="Toggle navigation (Ctrl+B)"
        >
          <CryptoricMark size={22} />
          <span className="topbar-name">Cryptoric Agent</span>
        </button>

        <button className="topbar-project" onClick={() => void openProject()} title="Open project">
          {state.project ? (
            <>
              <Icon name="files" size={14} />
              <span className="truncate">{state.project.name}</span>
            </>
          ) : (
            <>
              <span style={{ color: 'var(--text-3)' }}>Open a project</span>
            </>
          )}
        </button>

        <div style={{ flex: 1 }} />

        <button className="topbar-btn" onClick={() => setPaletteOpen(true)}>
          <Icon name="search" size={14} />
          <span className="kbd">Ctrl K</span>
        </button>

        <ModelPicker
          models={state.models}
          budget={state.budget}
          onSelect={(id) => void actions.selectModel(id)}
          onConfigure={() => setSection('settings')}
        />

        <button
          className="topbar-btn"
          data-on={busy ? 'true' : undefined}
          onClick={() => setSection('agent')}
          title={busy ? 'Cryptoric Chan is working' : 'Cryptoric Chan'}
        >
          <Dot tone={busy ? 'accent' : 'ok'} pulse={busy} />
          Chan
        </button>

        {/* The chip sits in the topbar rather than only inside Account: a
            hosted build must be able to say "sign in" before the agent is
            ever asked to run, and burying that in a pane makes it invisible
            until someone goes looking. */}
        <AccountChip
          status={state.auth}
          phase={state.authPhase}
          error={state.authError}
          onOpen={() => setSection('account')}
        />
      </header>

      {/* ------------------------------------------------------------ body */}
      <div className="body">
        <nav className="rail" data-open={railOpen} aria-label="Sections">
          {NAV.map((item) => (
            <button
              key={item.id}
              className="rail-btn"
              data-section={item.id}
              data-tip={item.label}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => setSection(item.id)}
            >
              <Icon name={item.icon} size={19} />
              {railOpen && <span className="rail-label">{item.label}</span>}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {!state.online && (
            <span style={{ display: 'inline-flex', color: 'var(--warn)', padding: 6 }} title="Offline">
              <Dot tone="warn" />
            </span>
          )}
        </nav>

        <div className="stage">
          {section === 'home' && (
            <HomeSurface
              project={state.project}
              ready={state.project !== null}
              onSubmit={(p) => {
                // Chan's answer lands in the transcript, so show the transcript.
                // Submitting and staying on the prompt reads as nothing happening.
                setSection('agent')
                void actions.submitTask(p)
              }}
              onOpenProject={() => void openProject()}
            />
          )}

          {(section === 'files' || section === 'search') && (
            <Workspace
              view={section === 'search' ? 'files' : view}
              onView={setView}
              project={state.project}
              tasks={state.tasks}
              timeline={state.timeline}
              terminals={state.terminals}
              processes={state.processes}
              onRefreshProcessTree={actions.syncTerminals}
            />
          )}

          {section === 'agent' && (
            <ChanPanel
              transcript={state.transcript}
              timeline={state.timeline}
              tasks={state.tasks}
              approvals={state.approvals}
              workspaceState={state.workspaceState}
              onSubmit={(p) => {
                // Chan's answer lands in the transcript, so show the transcript.
                // Submitting and staying on the prompt reads as nothing happening.
                setSection('agent')
                void actions.submitTask(p)
              }}
              onClearConversation={() => void actions.clearConversation()}
              onStop={(taskId) => void actions.stopTask(taskId)}
            />
          )}

          {section === 'tasks' && (
            <div className="surface">
              <TasksOverview tasks={state.tasks} timeline={state.timeline} />
            </div>
          )}

          {section === 'environment' && (
            <RuntimeManager
              tools={state.tools}
              install={state.install}
              project={state.project}
              gaps={state.gaps}
              snapshotId={state.snapshotId}
              onInstall={(id) => void actions.install(id)}
              onRefresh={() => void actions.refreshEnvironment()}
            />
          )}

          {section === 'account' && (
            <AccountPane
              status={state.auth}
              phase={state.authPhase}
              error={state.authError}
              hosted={state.mode?.ok === true && state.mode.mode === 'hosted'}
              balance={state.balance}
              onSignIn={() => void actions.startSignIn()}
              onSignOut={() => void actions.signOut()}
              onComplete={(code, state_) => void actions.completeSignIn(code, state_)}
              onRefreshBalance={() => void actions.refreshBalance()}
            />
          )}

          {section === 'settings' && (
            <SettingsSurface
              state={state}
              models={state.models}
              onSelectModel={(id) => void actions.selectModel(id)}
              onSetTheme={setTheme}
              onRefresh={() => void actions.refreshEnvironment()}
              onCheckForUpdates={(force) => actions.checkForUpdates(force)}
              onDownloadUpdate={() => actions.downloadUpdate()}
              onInstallUpdate={() => actions.installUpdate()}
            />
          )}
        </div>
      </div>

      {/* -------------------------------------------------------- statusbar */}
      <StatusBar
        runtimeSummary={runtimeSummary}
        branch={state.branch}
        changes={state.changeCount}
        ready={!busy}
        version={state.version}
        online={state.online}
      />

      {state.notice && (
        <Toast message={state.notice} onDismiss={() => actions.notify(null)} />
      )}

      {/* A permission prompt outranks every pane and every dialog below it.
          Approvals are raised by gated IPC channels that can be triggered from
          anywhere — Settings, the runtime list, the process tree — so a prompt
          scoped to one pane is a prompt the user may never see. */}
      <ApprovalOverlay
        approvals={state.approvals}
        onResolve={(id, approved, remember, toolId) =>
          // The `remember` and `toolId` arguments must be forwarded. This
          // handler used to drop them, which silently turned "Allow for this
          // session" into "Approve once" — the button appeared to work and the
          // agent prompted again on the very next file.
          void actions.resolveApproval(id, approved, remember, toolId)
        }
      />

      {/* An update found in the background asks here rather than only in
          Settings, because by the time a user opens Settings they have already
          forgotten a dialog they never saw. */}
      {state.update?.state === 'available' || state.update?.state === 'downloaded' ? (
        state.updateDismissed ? null : (
          <UpdatePrompt
            status={state.update}
            busy={false}
            onDownload={() => void actions.downloadUpdate()}
            onInstall={() => void actions.installUpdate()}
            onDismiss={() => actions.dismissUpdate()}
          />
        )
      ) : null}

      <CommandPalette commands={commands} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}

// ------------------------------------------------------------------- tasks

function TasksOverview({
  tasks,
  timeline
}: {
  tasks: import('@shared/types').AgentTask[]
  timeline: import('@shared/types').TimelineEntry[]
}) {
  const recent = timeline.slice(-60).reverse()

  if (tasks.length === 0 && recent.length === 0) {
    return (
      <div className="empty-view">
        <span className="title">Nothing running</span>
        <span className="subtitle" style={{ maxWidth: '42ch' }}>
          Tasks you start will appear here with their full execution history.
        </span>
      </div>
    )
  }

  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', flex: 1 }}>
      <div className="surface" style={{ padding: 20, overflow: 'auto' }}>
        <div className="section-head">Tasks</div>
        <div style={{ display: 'grid', gap: 8 }}>
          {tasks.map((task) => (
            <div key={task.id} className="card card-pad" style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Dot tone={toneForInstallState(task.status)} />
                <span style={{ fontWeight: 550 }} className="truncate">
                  {task.title}
                </span>
                <div style={{ flex: 1 }} />
                <Chip tone={task.status === 'COMPLETED' ? 'ok' : task.status === 'FAILED' ? 'error' : 'idle'}>
                  {task.status}
                </Chip>
              </div>
              <span className="caption">{task.role.replace(/_/g, ' ').toLowerCase()}</span>
              {task.error && <span style={{ color: 'var(--err)', fontSize: 'var(--t-sm)' }}>{task.error}</span>}
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="ghost" onClick={() => void window.cryptoric.agent.pause(task.id)}>
                  Pause
                </Button>
                <Button variant="ghost" onClick={() => void window.cryptoric.agent.stop(task.id)}>
                  Stop
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="surface" style={{ padding: 20, overflow: 'auto' }}>
        <div className="section-head">Activity</div>
        <div style={{ display: 'grid', gap: 7 }}>
          {recent.map((entry) => (
            <div key={entry.id} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 10, alignItems: 'baseline' }}>
              <span className="caption mono" style={{ fontSize: 'var(--t-xs)' }}>
                {entry.at.slice(11, 19)}
              </span>
              <span
                className="mono selectable"
                style={{ fontSize: 'var(--t-xs)', color: entry.status === 'error' ? 'var(--err)' : 'var(--text-2)' }}
              >
                {entry.message}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ tools

export { ToolsSurface, toneForInstallState, describe }
export type { EnvironmentGap, ProjectProfile, BudgetSummary, ModelSummary }
export { Resizer }