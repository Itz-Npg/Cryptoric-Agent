/**
 * Cryptoric Agent workbench.
 *
 * Information architecture (DESIGN.md, "Instrument Console"):
 *
 *   ┌ topbar ─ brand · Project · Search · ⌘K · Chan status ────────────┐
 *   │ rail │                  main workspace               │  chat    │
 *   │ Home │                                                   │ Cryptoric│
 *   │ Files│                                                   │  Chan    │
 *   │ Agent│                                                   │          │
 *   │ Tasks│                                                   │ activity │
 *   │ Tools│                                                   │          │
 *   ├ dock ─ Environment │ Git │ Terminal │ Processes │ Changes ──────┤
 *
 * Three nested grids (.workspace → .main → .dock). The nesting is deliberate:
 * a single flat grid lets auto-placement strand panes in unnamed cells.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentTask,
  EnvironmentGap,
  ProcessInfo,
  ProjectProfile,
  TerminalSessionInfo,
  ToolStatus
} from '@shared/types'
import { CommandPalette, type Command } from './palette/CommandPalette'
import { Chip, EmptyState, RailIcon, Seal, Splitter, StatusBar3 } from './components/marks'
import { ChatPanel } from './panes/ChatPanel'
import { Dock } from './panes/Dock'
import { HomeSurface, FilesSurface, AgentSurface, TasksSurface, ToolsSurface } from './panes/surfaces'
import { describe, useAppStore } from './state/store'

const MIN_RAIL = 104
const MAX_RAIL = 220
const MIN_CHAT = 300
const MAX_CHAT = 560
const MIN_DOCK = 140
const MAX_DOCK = 620

type Section = 'home' | 'files' | 'agent' | 'tasks' | 'tools'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'files', label: 'Files' },
  { id: 'agent', label: 'Agent' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'tools', label: 'Tools' }
]

export function App() {
  const { state, refreshEnvironment } = useAppStore()

  const [section, setSection] = useState<Section>('home')
  const [railWidth, setRailWidth] = useState(132)
  const [chatWidth, setChatWidth] = useState(340)
  const [dockHeight, setDockHeight] = useState(232)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [gaps, setGaps] = useState<EnvironmentGap[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [theme, setTheme] = useState<'graphite' | 'bone'>('graphite')

  // ---------------------------------------------------------------- effects

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if (e.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const refreshGaps = useCallback(async () => {
    if (!state.project) {
      setGaps([])
      return
    }
    try {
      setGaps(await window.cryptoric.project.gaps())
    } catch (err) {
      setNotice(describe(err))
    }
  }, [state.project])

  useEffect(() => {
    void refreshGaps()
  }, [refreshGaps, state.snapshotId])

  // ---------------------------------------------------------------- actions

  const handleInstall = useCallback(
    async (toolId: string) => {
      try {
        const outcome = await window.cryptoric.env.install(toolId)
        setNotice(
          outcome.ok
            ? `${toolId} installed and verified · environment refreshed (snapshot ${outcome.snapshotBefore} → ${outcome.snapshotAfter}) · Cryptoric Agent did not restart`
            : `Install failed: ${outcome.error ?? 'unknown error'}`
        )
        await refreshEnvironment()
        await refreshGaps()
      } catch (err) {
        setNotice(describe(err))
      }
    },
    [refreshEnvironment, refreshGaps]
  )

  const handleRefreshEnv = useCallback(async () => {
    try {
      await window.cryptoric.env.refresh()
      await refreshEnvironment()
      await refreshGaps()
      setNotice('Environment refreshed. New shells get the updated PATH; existing ones were preserved.')
    } catch (err) {
      setNotice(describe(err))
    }
  }, [refreshEnvironment, refreshGaps])

  const openProject = useCallback(async () => {
    try {
      const project = await window.cryptoric.project.open()
      setNotice(`Opened ${project.name} — ${project.kind}, ${project.manifests.length} manifest(s)`)
      setSection('files')
    } catch (err) {
      setNotice(describe(err))
    }
  }, [])

  const submitTask = useCallback(async (prompt: string) => {
    try {
      await window.cryptoric.agent.submit(prompt)
    } catch (err) {
      setNotice(describe(err))
    }
  }, [])

  const busy = useMemo(
    () => state.tasks.some((t) => ['RUNNING', 'PLANNING', 'TESTING', 'REVIEWING'].includes(t.status)),
    [state.tasks]
  )

  // ---------------------------------------------------------------- palette

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'project.open',
        group: 'Workspace',
        title: 'Open project…',
        keys: 'Ctrl+O',
        hint: 'Detect manifests, required runtimes and package manager',
        run: openProject
      },
      ...SECTIONS.map((s) => ({
        id: `section.${s.id}`,
        group: 'Go to',
        title: s.label,
        run: () => setSection(s.id)
      })),
      {
        id: 'env.install',
        group: 'Environment',
        title: 'Install a missing runtime',
        hint: gaps.length > 0 ? `Needed here: ${gaps.map((g) => g.label).join(', ')}` : 'No gaps detected',
        available: () => gaps.length > 0,
        run: () => handleInstall(gaps[0]?.toolId ?? 'node')
      },
      {
        id: 'env.refresh',
        group: 'Environment',
        title: 'Refresh environment',
        hint: 'Re-read the OS environment without restarting Cryptoric Agent',
        run: handleRefreshEnv
      },
      {
        id: 'env.inspect',
        group: 'Environment',
        title: 'Inspect all runtimes',
        run: refreshEnvironment
      },
      {
        id: 'theme.toggle',
        group: 'View',
        title: `Switch to ${theme === 'graphite' ? 'Bone Ledger' : 'Graphite'} theme`,
        run: () => setTheme((t) => (t === 'graphite' ? 'bone' : 'graphite'))
      },
      {
        id: 'diagnostics.run',
        group: 'Diagnostics',
        title: 'Run diagnostics',
        run: async () => {
          try {
            const report = await window.cryptoric.diagnostics.run()
            const missing = report.tools.filter((t) => !t.ok).length
            setNotice(
              `Diagnostics — Electron ${report.app.electron} · Node ${report.app.node} · pid ${report.app.pid} · ${report.tools.length} runtimes (${missing} unavailable)`
            )
          } catch (err) {
            setNotice(describe(err))
          }
        }
      },
      {
        id: 'diagnostics.copy',
        group: 'Diagnostics',
        title: 'Copy diagnostics to clipboard',
        run: async () => {
          try {
            await navigator.clipboard.writeText(JSON.stringify(await window.cryptoric.diagnostics.run(), null, 2))
            setNotice('Diagnostics copied to clipboard.')
          } catch (err) {
            setNotice(describe(err))
          }
        }
      },
      {
        id: 'skills.route',
        group: 'Skills',
        title: 'Show skill routing for the last request',
        hint: 'Which skills apply, and which were deliberately skipped',
        run: async () => {
          try {
            const d = await window.cryptoric.skill.route(state.transcript.at(-1)?.text ?? '')
            setNotice(
              d.skillIds.length > 0
                ? `Loaded ${d.skillIds.length} skill(s) (~${d.estimatedTokens} tokens): ${d.skillIds.join(', ')}. ${d.skipped.length} skipped.`
                : `No skill matched. ${d.skipped.length} skill(s) considered and skipped — nothing was dumped into context.`
            )
          } catch (err) {
            setNotice(describe(err))
          }
        }
      }
    ],
    [theme, gaps, openProject, handleInstall, handleRefreshEnv, refreshEnvironment, state.transcript]
  )

  // ----------------------------------------------------------------- render

  if (state.bootError) {
    return (
      <div style={{ display: 'grid', placeContent: 'center', height: '100vh', gap: 'var(--space-4)' }}>
        <EmptyState title="Cryptoric Agent could not start" hint={state.bootError} />
      </div>
    )
  }

  const shared = { project: state.project, gaps, tools: state.tools, notice: setNotice }

  return (
    <div
      className="workspace"
      style={
        {
          '--rail-width': `${railWidth}px`,
          '--chat-width': `${chatWidth}px`,
          '--dock-height': `${dockHeight}px`
        } as React.CSSProperties
      }
    >
      {/* ------------------------------------------------------------ topbar */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <BrandMark />
          </span>
          <span className="brand-name">Cryptoric</span>
        </div>

        <button className="topbar-item" onClick={() => void openProject()}>
          {state.project ? state.project.name : 'Project'}
          <span className="dim">·</span>
          <span className="dim">open</span>
        </button>

        <button className="topbar-item" onClick={() => setSection('files')}>
          Search files
        </button>

        <button className="topbar-item" onClick={() => setPaletteOpen(true)}>
          Command palette <span className="kbd">Ctrl K</span>
        </button>

        <div style={{ flex: 1 }} />

        <span className="micro-label" style={{ marginRight: 'var(--space-2)' }}>
          agent
        </span>
        <button
          className="topbar-item"
          data-active={busy ? 'true' : undefined}
          onClick={() => setSection('agent')}
          title={busy ? 'Cryptoric Chan is working' : 'Cryptoric Chan is idle'}
        >
          <Seal state={busy ? 'installing' : 'present'} />
          Chan
          <StatusBar3 level={busy ? 2 : 1} label={busy ? 'working' : 'idle'} />
        </button>
      </header>

      {/* --------------------------------------------------------------- main */}
      <div className="main">
        <nav className="rail" aria-label="Sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className="rail-item"
              aria-current={section === s.id ? 'page' : undefined}
              onClick={() => setSection(s.id)}
            >
              <RailIcon id={s.id} />
              {s.label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {!state.online && <Chip tone="error">offline</Chip>}
        </nav>
        <Splitter
          orientation="x"
          onDelta={(d) => setRailWidth((w) => clamp(w + d, MIN_RAIL, MAX_RAIL))}
          onReset={() => setRailWidth(132)}
        />

        <main className="workspace-surface">
          {section === 'home' && <HomeSurface {...shared} onOpen={() => void openProject()} />}
          {section === 'files' && <FilesSurface {...shared} />}
          {section === 'agent' && <AgentSurface {...shared} onSubmit={(p) => void submitTask(p)} />}
          {section === 'tasks' && <TasksSurface tasks={state.tasks} timeline={state.timeline} />}
          {section === 'tools' && <ToolsSurface {...shared} />}
        </main>

        <Splitter
          orientation="x"
          onDelta={(d) => setChatWidth((w) => clamp(w - d, MIN_CHAT, MAX_CHAT))}
          onReset={() => setChatWidth(340)}
        />

        <ChatPanel
          transcript={state.transcript}
          approvals={state.approvals}
          timeline={state.timeline}
          tasks={state.tasks}
          workspaceState={state.workspaceState}
          onSubmit={(p) => void submitTask(p)}
          onResolveApproval={(id, approved) => void window.cryptoric.approval.resolve(id, approved)}
        />
      </div>

      <Splitter
        orientation="y"
        onDelta={(d) => setDockHeight((h) => clamp(h - d, MIN_DOCK, MAX_DOCK))}
        onReset={() => setDockHeight(232)}
      />

      {/* --------------------------------------------------------------- dock */}
      <Dock
        tools={state.tools}
        install={state.install}
        project={state.project}
        gaps={gaps}
        terminals={state.terminals}
        processes={state.processes}
        tasks={state.tasks}
        snapshotId={state.snapshotId}
        onInstall={(id) => void handleInstall(id)}
        onRefreshEnv={() => void handleRefreshEnv()}
        onCreateTerminal={() => void window.cryptoric.terminal.create()}
        onStopProcess={(id) => void window.cryptoric.process.stop(id)}
        onRestartProcess={(id) => void window.cryptoric.process.restart(id)}
        onStopTask={(id) => void window.cryptoric.agent.stop(id)}
        onPauseTask={(id) => void window.cryptoric.agent.pause(id)}
        onResumeTask={(id) => void window.cryptoric.agent.resume(id)}
        onRefreshTree={() => setSection('files')}
        onNotice={setNotice}
      />

      {notice && (
        <div
          role="status"
          style={{
            position: 'fixed',
            bottom: 14,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--surface-overlay)',
            border: '1px solid var(--hairline-strong)',
            borderRadius: 'var(--radius-sm)',
            padding: 'var(--space-3) var(--space-4)',
            boxShadow: 'var(--elevation-popover)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-4)',
            maxWidth: 'min(860px, 78vw)',
            zIndex: 30
          }}
        >
          <span className="data selectable" style={{ fontSize: 'var(--text-data)' }}>
            {notice}
          </span>
          <button className="btn" data-variant="ghost" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      )}

      <CommandPalette commands={commands} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}

/** The Cryptoric mark, drawn on the same 16px grid as every other glyph. */
function BrandMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 2.5H13v11h-2.5M5.5 13.5H3v-11h2.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.25" opacity="0.45" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </svg>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export type SurfaceProps = {
  project: ProjectProfile | null
  gaps: EnvironmentGap[]
  tools: ToolStatus[]
  notice: (message: string | null) => void
}

export type { AgentTask, ProcessInfo, TerminalSessionInfo }