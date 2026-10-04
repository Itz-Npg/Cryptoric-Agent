/**
 * Bottom dock — a full-width tabbed band.
 *
 * Tabs: Environment · Git · Terminal · Processes · Changes.
 * Each shows real data from the main process. Git and Changes run live git
 * commands; Terminal streams real child-process output.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentTask,
  FileChange,
  GitStatus,
  InstallProgress,
  ProcessInfo,
  ProjectProfile,
  TerminalSessionInfo,
  ToolStatus
} from '@shared/types'
import { Chip, EmptyState, LedgerRow, MicroLabel, Seal, StatusBar3 } from '../components/marks'

type DockTab = 'environment' | 'git' | 'terminal' | 'processes' | 'changes'

const CATEGORY_LABEL: Record<ToolStatus['spec']['category'], string> = {
  javascript: 'JavaScript',
  python: 'Python',
  rust: 'Rust',
  jvm: 'JVM',
  go: 'Go',
  dotnet: '.NET',
  native: 'Native',
  vcs: 'Version control',
  container: 'Container'
}

export function Dock({
  tools,
  install,
  project,
  gaps,
  terminals,
  processes,
  tasks,
  snapshotId,
  onInstall,
  onRefreshEnv,
  onCreateTerminal,
  onStopProcess,
  onRestartProcess,
  onStopTask,
  onPauseTask,
  onResumeTask,
  onNotice
}: {
  tools: ToolStatus[]
  install: Record<string, InstallProgress>
  project: ProjectProfile | null
  gaps: { toolId: string; label: string; kind: string }[]
  terminals: TerminalSessionInfo[]
  processes: ProcessInfo[]
  tasks: AgentTask[]
  snapshotId: number | null
  onInstall: (toolId: string) => void
  onRefreshEnv: () => void
  onCreateTerminal: () => void
  onStopProcess: (id: string) => void
  onRestartProcess: (id: string) => void
  onStopTask: (id: string) => void
  onPauseTask: (id: string) => void
  onResumeTask: (id: string) => void
  onRefreshTree: () => void
  onNotice: (message: string | null) => void
}) {
  const [tab, setTab] = useState<DockTab>('environment')
  const [changes, setChanges] = useState<FileChange[]>([])
  const [changeCount, setChangeCount] = useState(0)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const session = terminals.find((t) => t.id === activeSessionId) ?? terminals[0] ?? null

  useEffect(() => {
    if (!session) return
    setActiveSessionId(session.id)
  }, [session?.id])

  // Poll git changes so the "Changes" badge reflects the working tree.
  const refreshChanges = useCallback(async () => {
    if (!project) {
      setChanges([])
      setChangeCount(0)
      return
    }
    try {
      const result = await window.cryptoric.git.diff()
      setChanges(result.files)
      setChangeCount(result.files.length)
    } catch {
      setChanges([])
      setChangeCount(0)
    }
  }, [project])

  useEffect(() => {
    void refreshChanges()
  }, [refreshChanges, tasks.length])

  return (
    <section className="dock" aria-label="Dock">
      <div className="dock-tabs" role="tablist" aria-label="Dock sections">
        {(
          [
            ['environment', 'Environment'],
            ['git', 'Git'],
            ['terminal', 'Terminal'],
            ['processes', 'Processes'],
            ['changes', 'Changes']
          ] as [DockTab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className="dock-tab"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'changes' && changeCount > 0 ? ` · ${changeCount}` : ''}
            {id === 'processes' && processes.length > 0 ? ` · ${processes.length}` : ''}
            {id === 'environment' && gaps.length > 0 ? ` · ${gaps.length}` : ''}
          </button>
        ))}
      </div>

      <div style={{ minHeight: 0, overflow: 'hidden' }}>
        {tab === 'environment' && (
          <EnvironmentTab
            tools={tools}
            install={install}
            gaps={gaps}
            project={project}
            snapshotId={snapshotId}
            onInstall={onInstall}
            onRefresh={onRefreshEnv}
          />
        )}
        {tab === 'git' && <GitTab project={project} onNotice={onNotice} />}
        {tab === 'terminal' && (
          <TerminalTab
            terminals={terminals}
            activeSessionId={activeSessionId}
            onSelect={setActiveSessionId}
            onCreate={onCreateTerminal}
          />
        )}
        {tab === 'processes' && (
          <ProcessesTab processes={processes} onStop={onStopProcess} onRestart={onRestartProcess} />
        )}
        {tab === 'changes' && <ChangesTab changes={changes} project={project} />}
      </div>

      {/* Tasks live in their own rail section, but the dock keeps a quiet summary. */}
      {tasks.length > 0 && tab === 'environment' && <span style={{ display: 'none' }}>{tasks.length}</span>}
      {tab === 'git' && (
        <TaskStrip tasks={tasks} onStop={onStopTask} onPause={onPauseTask} onResume={onResumeTask} />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function EnvironmentTab({
  tools,
  install,
  gaps,
  project,
  snapshotId,
  onInstall,
  onRefresh
}: {
  tools: ToolStatus[]
  install: Record<string, InstallProgress>
  gaps: { toolId: string; label: string; kind: string }[]
  project: ProjectProfile | null
  snapshotId: number | null
  onInstall: (id: string) => void
  onRefresh: () => void
}) {
  const gapIds = new Set(gaps.map((g) => g.toolId))
  const groups = new Map<ToolStatus['spec']['category'], ToolStatus[]>()
  for (const tool of tools) {
    const list = groups.get(tool.spec.category) ?? []
    list.push(tool)
    groups.set(tool.spec.category, list)
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'minmax(0, 1fr) auto', height: '100%' }}>
      <div className="pane-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', alignContent: 'start' }}>
        {tools.length === 0 && <EmptyState title="Probing runtimes…" hint="Cryptoric reads the OS environment directly." />}
        {sorted.map(([category, list]) => (
          <section key={category}>
            <div style={{ padding: 'var(--space-3) var(--space-4) var(--space-2)', position: 'sticky', top: 0, background: 'var(--surface-sunken)' }}>
              <MicroLabel>{CATEGORY_LABEL[category]}</MicroLabel>
            </div>
            <div className="ledger">
              {list
                .slice()
                .sort((a, b) => Number(gapIds.has(b.spec.id)) - Number(gapIds.has(a.spec.id)))
                .map((tool) => {
                  const progress = install[tool.spec.id]
                  const installing = progress && progress.phase !== 'done' && progress.phase !== 'failed'
                  return (
                    <LedgerRow
                      key={tool.spec.id}
                      state={installing ? 'installing' : tool.state}
                      title={tool.detail}
                      label={
                        <span style={{ display: 'grid' }}>
                          <span>{tool.spec.label}</span>
                          {installing && progress && <ProgressLine progress={progress} />}
                          {progress?.phase === 'done' && (
                            <span className="data" style={{ color: 'var(--signal-verdigris)', fontSize: 'var(--text-micro)' }}>
                              installed · environment refreshed · no restart required
                            </span>
                          )}
                          {progress?.phase === 'failed' && (
                            <span className="data" style={{ color: 'var(--alert-ember)', fontSize: 'var(--text-micro)' }}>
                              {progress.message}
                            </span>
                          )}
                        </span>
                      }
                      value={tool.version ?? (tool.state === 'missing' ? 'not installed' : tool.state)}
                      meta={gapIds.has(tool.spec.id) ? 'required' : undefined}
                      actions={
                        gapIds.has(tool.spec.id) ? (
                          <button
                            className="btn"
                            data-variant="primary"
                            style={{ height: 20, padding: '0 var(--space-3)', fontSize: 'var(--text-micro)' }}
                            onClick={(e) => {
                              e.stopPropagation()
                              onInstall(tool.spec.id)
                            }}
                          >
                            install
                          </button>
                        ) : undefined
                      }
                    />
                  )
                })}
            </div>
          </section>
        ))}
      </div>

      <div
        style={{
          borderTop: '1px solid var(--hairline)',
          padding: 'var(--space-2) var(--space-4)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)'
        }}
      >
        <span className="data dim" style={{ fontSize: 'var(--text-micro)' }}>
          snapshot {snapshotId ?? '—'}
        </span>
        {project && (
          <span className="data dim" style={{ fontSize: 'var(--text-micro)' }}>
            {project.kind} · {project.packageManager ?? 'no package manager'} · {project.manifests.length} manifest(s)
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn" data-variant="ghost" onClick={onRefresh}>
          refresh environment
        </button>
      </div>
    </div>
  )
}

function ProgressLine({ progress }: { progress: InstallProgress }) {
  const ratio = progress.ratio ?? 0
  const indeterminate = progress.ratio === null
  return (
    <span
      style={{ display: 'block', marginTop: 3, width: 140, height: 3, background: 'var(--hairline)', position: 'relative', overflow: 'hidden' }}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={progress.message}
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          transform: `scaleX(${ratio})`,
          transformOrigin: 'left',
          background: 'var(--info-coldsteel)',
          transition: 'transform 120ms linear'
        }}
      />
      {indeterminate && (
        <span style={{ position: 'absolute', inset: 0, width: '40%', background: 'var(--info-coldsteel)', opacity: 0.4 }} />
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function GitTab({
  project,
  onNotice
}: {
  project: ProjectProfile | null
  onNotice: (message: string | null) => void
}) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!project) return
    try {
      setStatus(await window.cryptoric.git.status())
    } catch {
      setStatus(null)
    }
  }, [project])

  useEffect(() => {
    void load()
  }, [load])

  if (!project) {
    return <EmptyState title="No project open" hint="Open a folder to use Git." />
  }

  const checkpoint = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.cryptoric.git.checkpoint()
      onNotice(
        result.created
          ? `Checkpoint ${result.commit} created — ${result.message}`
          : `No checkpoint created: ${result.error ?? 'nothing to commit'}`
      )
      await load()
    } catch (err) {
      onNotice(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'minmax(0, 1fr) auto', height: '100%' }}>
      <div className="pane-body">
        {!status?.isRepo && (
          <EmptyState title="Not a git repository" hint="Cryptoric can still edit files and run commands; checkpoints require git." />
        )}
        {status?.isRepo && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--hairline)' }}>
              <Chip tone="info">{status.branch ?? 'detached'}</Chip>
              {status.upstream && (
                <span className="data dim" style={{ fontSize: 'var(--text-micro)' }}>
                  {status.upstream} · ↑{status.ahead} ↓{status.behind}
                </span>
              )}
              <div style={{ flex: 1 }} />
              <span className="data dim" style={{ fontSize: 'var(--text-micro)' }}>
                {status.clean ? 'working tree clean' : `${status.entries.length} change(s)`}
              </span>
            </div>
            <div className="ledger">
              {status.entries.map((entry) => (
                <LedgerRow
                  key={`${entry.index}${entry.path}`}
                  state={entry.worktree === '?' ? 'unverified' : entry.staged ? 'present' : 'mismatched'}
                  label={entry.path}
                  value={`${entry.index}${entry.worktree}`}
                  meta={entry.staged ? 'staged' : 'unstaged'}
                />
              ))}
            </div>
          </>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--hairline)', padding: 'var(--space-2) var(--space-4)', display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
        <button className="btn" data-variant="primary" onClick={() => void checkpoint()} disabled={busy || !status?.isRepo}>
          create checkpoint
        </button>
        <span className="data dim" style={{ fontSize: 'var(--text-micro)' }}>
          stages everything and commits. Force-push, reset --hard and history rewrites are not exposed.
        </span>
      </div>
    </div>
  )
}

function TaskStrip({
  tasks,
  onStop,
  onPause,
  onResume
}: {
  tasks: AgentTask[]
  onStop: (id: string) => void
  onPause: (id: string) => void
  onResume: (id: string) => void
}) {
  if (tasks.length === 0) return null
  return (
    <div style={{ borderTop: '1px solid var(--hairline)', padding: 'var(--space-2) var(--space-4)', display: 'grid', gap: 'var(--space-2)' }}>
      {tasks.slice(0, 3).map((task) => (
        <div key={task.id} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto auto auto', gap: 'var(--space-3)', alignItems: 'center' }}>
          <StatusBar3 level={task.status === 'COMPLETED' ? 3 : task.status === 'FAILED' ? 0 : 2} label={task.status} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--text-data)' }}>
            {task.title}
          </span>
          <span className="micro-label">{task.status}</span>
          {task.status === 'PAUSED' ? (
            <button className="btn" data-variant="ghost" onClick={() => onResume(task.id)}>resume</button>
          ) : (
            <button className="btn" data-variant="ghost" onClick={() => onPause(task.id)}>pause</button>
          )}
          <button className="btn" data-variant="ghost" onClick={() => onStop(task.id)}>stop</button>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

function TerminalTab({
  terminals,
  activeSessionId,
  onSelect,
  onCreate
}: {
  terminals: TerminalSessionInfo[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
}) {
  const session = terminals.find((t) => t.id === activeSessionId) ?? terminals[0] ?? null

  if (!session) {
    return (
      <EmptyState title="No terminal session" hint="Open a shell to run commands directly.">
        <button className="btn" data-variant="primary" onClick={onCreate} style={{ justifySelf: 'center' }}>
          open shell
        </button>
      </EmptyState>
    )
  }

  return <TerminalView session={session} onSelect={onSelect} />
}

function TerminalView({
  session,
  onSelect
}: {
  session: TerminalSessionInfo
  onSelect: (id: string) => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    onSelect(session.id)
    const unsubscribe = window.cryptoric.onMainEvent((event) => {
      if (event.type === 'terminal-output' && event.sessionId === session.id) {
        setLines((prev) => [...prev.slice(-400), event.chunk])
      }
    })
    return unsubscribe
  }, [session.id, onSelect])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [lines.length])

  return (
    <div
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey) return
        if (e.key.length === 1) {
          void window.cryptoric.terminal.write(session.id, e.key)
          e.preventDefault()
        } else if (e.key === 'Enter') {
          void window.cryptoric.terminal.write(session.id, '\n')
          e.preventDefault()
        } else if (e.key === 'Backspace') {
          void window.cryptoric.terminal.write(session.id, '\b')
          e.preventDefault()
        }
      }}
      role="textbox"
      aria-label={`Terminal session ${session.label}`}
      style={{ height: '100%', overflow: 'auto', padding: 'var(--space-3) var(--space-4)', background: 'var(--surface-sunken)', outline: 'none' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
        <MicroLabel>{session.shell}</MicroLabel>
        <span className="data dim" style={{ fontSize: 'var(--text-micro)' }}>
          pid {session.pid ?? '—'} · snapshot {session.envSnapshotId}
        </span>
        {session.envStale && <Chip tone="warn">older environment</Chip>}
        {session.status === 'exited' && <Chip tone="neutral">exited {session.exitCode ?? ''}</Chip>}
      </div>
      <pre className="data selectable" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--ink-secondary)' }}>
        {lines.join('')}
        <span
          style={{
            display: 'inline-block',
            width: 7,
            height: 'var(--text-data)',
            background: 'var(--accent-sulfur)',
            verticalAlign: 'text-bottom',
            marginLeft: 2
          }}
        />
      </pre>
      <div ref={bottomRef} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

function ProcessesTab({
  processes,
  onStop,
  onRestart
}: {
  processes: ProcessInfo[]
  onStop: (id: string) => void
  onRestart: (id: string) => void
}) {
  if (processes.length === 0) {
    return <EmptyState title="No supervised processes" hint="Start a dev server and Cryptoric tracks its port and logs." />
  }
  return (
    <div className="ledger">
      {processes.map((proc) => (
        <div key={proc.id} className="ledger-row" style={{ gridTemplateColumns: 'auto minmax(0, 1fr) auto' }}>
          <Seal
            state={
              proc.status === 'running' ? 'installing' : proc.status === 'failed' ? 'failed' : 'present'
            }
          />
          <span style={{ display: 'grid', minWidth: 0 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{proc.label}</span>
            <span className="ledger-meta">
              {proc.command} · {proc.status}
              {proc.port ? ` · :${proc.port}` : ''}
              {proc.exitCode !== null ? ` · exit ${proc.exitCode}` : ''}
              {proc.envStale ? ' · older environment' : ''}
            </span>
          </span>
          <span style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="btn" data-variant="ghost" onClick={() => onRestart(proc.id)}>
              restart
            </button>
            <button className="btn" data-variant="ghost" onClick={() => onStop(proc.id)}>
              stop
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

function ChangesTab({ changes, project }: { changes: FileChange[]; project: ProjectProfile | null }) {
  const [selected, setSelected] = useState(0)

  if (!project) return <EmptyState title="No project open" />
  if (changes.length === 0) {
    return <EmptyState title="No changes in the working tree" hint="Files the agent edits will appear here as a live diff." />
  }

  const current = changes[Math.min(selected, changes.length - 1)]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', height: '100%', minHeight: 0 }}>
      <div style={{ borderRight: '1px solid var(--hairline)', overflow: 'auto' }}>
        {changes.map((change, index) => (
          <button
            key={change.path}
            className="rail-item"
            style={{ width: '100%', gridTemplateColumns: 'auto minmax(0,1fr)', height: 'auto', padding: 'var(--space-2) var(--space-3)' }}
            aria-current={index === selected ? 'page' : undefined}
            onClick={() => setSelected(index)}
          >
            <span className="data" style={{ fontSize: 'var(--text-micro)', color: 'var(--ink-tertiary)' }}>
              {change.status}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--text-micro)' }}>
              {change.path}
            </span>
          </button>
        ))}
      </div>
      <div style={{ overflow: 'auto', minWidth: 0 }}>
        {current && (
          <>
            <div style={{ display: 'flex', gap: 'var(--space-3)', padding: 'var(--space-2) var(--space-4)', borderBottom: '1px solid var(--hairline)', alignItems: 'center' }}>
              <MicroLabel>{current.path}</MicroLabel>
              <span className="data" style={{ color: 'var(--diff-add)', fontSize: 'var(--text-micro)' }}>
                +{current.additions}
              </span>
              <span className="data" style={{ color: 'var(--diff-del)', fontSize: 'var(--text-micro)' }}>
                −{current.deletions}
              </span>
            </div>
            <pre className="data selectable" style={{ margin: 0, padding: 'var(--space-3) var(--space-4)', fontSize: 'var(--text-data)' }}>
              {current.binary ? 'Binary file — no textual diff available.' : current.patch}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}