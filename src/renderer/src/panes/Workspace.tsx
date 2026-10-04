/**
 * Working surface.
 *
 * Contextual by design: the workspace shows the panels the current task needs,
 * not every surface at once. Files and editor sit together; diff, terminal and
 * processes take over the stage when they are what the work needs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTask,
  FileChange,
  FileNode,
  FileSearchHit,
  ProcessInfo,
  ProjectProfile,
  TerminalSessionInfo,
  TimelineEntry
} from '@shared/types'
import { Button, Chip, Dot, Icon, Resizer, SectionHead } from '../components/primitives'

export type WorkspaceView = 'files' | 'diff' | 'terminal' | 'processes'

export function Workspace({
  view,
  onView,
  project,
  tasks,
  timeline,
  terminals,
  processes,
  onRefreshProcessTree
}: {
  view: WorkspaceView
  onView: (v: WorkspaceView) => void
  project: ProjectProfile | null
  tasks: AgentTask[]
  timeline: TimelineEntry[]
  terminals: TerminalSessionInfo[]
  processes: ProcessInfo[]
  onRefreshProcessTree: () => void
}) {
  if (!project) {
    return (
      <div className="empty-view">
        <span className="title">No project open</span>
        <span className="subtitle" style={{ maxWidth: '40ch' }}>
          Cryptoric scopes files, git and terminal sessions to the project you open.
        </span>
      </div>
    )
  }

  return (
    <div className="surface">
      <ViewBar view={view} onView={onView} />
      {view === 'files' && <FilesAndEditor />}
      {view === 'diff' && <DiffView tasks={tasks} timeline={timeline} />}
      {view === 'terminal' && (
        <TerminalView terminals={terminals} onRefreshProcessTree={onRefreshProcessTree} />
      )}
      {view === 'processes' && <ProcessView processes={processes} />}
    </div>
  )
}

function ViewBar({ view, onView }: { view: WorkspaceView; onView: (v: WorkspaceView) => void }) {
  const items: { id: WorkspaceView; label: string; icon: 'files' | 'branch' | 'terminal' | 'environment' }[] = [
    { id: 'files', label: 'Files', icon: 'files' },
    { id: 'diff', label: 'Changes', icon: 'branch' },
    { id: 'terminal', label: 'Terminal', icon: 'terminal' },
    { id: 'processes', label: 'Processes', icon: 'environment' }
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 14px', borderBottom: '1px solid var(--line)' }}>
      {items.map((item) => (
        <button
          key={item.id}
          className="topbar-btn"
          data-on={view === item.id ? 'true' : undefined}
          onClick={() => onView(item.id)}
        >
          <Icon name={item.icon} size={15} />
          {item.label}
        </button>
      ))}
      <div style={{ flex: 1 }} />
    </div>
  )
}

// ------------------------------------------------------------ files + code

function FilesAndEditor() {
  const [tree, setTree] = useState<FileNode[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<FileSearchHit[] | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(260)

  const load = useCallback(async () => {
    try {
      setTree(await window.cryptoric.file.tree(undefined, 3))
    } catch {
      setTree([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const open = useCallback(async (path: string) => {
    try {
      const file = await window.cryptoric.file.read(path)
      setSelected(file.path)
      setContent(file.content)
    } catch {
      setSelected(null)
      setContent('')
    }
  }, [])

  const search = useCallback(async () => {
    if (!query.trim()) {
      setHits(null)
      return
    }
    try {
      setHits(await window.cryptoric.file.search(query, 80))
    } catch {
      setHits(null)
    }
  }, [query])

  return (
    <div className="split" style={{ gridTemplateColumns: `${sidebarWidth}px 6px minmax(0, 1fr)`, flex: 1 }}>
      <div className="surface" style={{ background: 'var(--surface-1)' }}>
        <div style={{ padding: 12, display: 'grid', gap: 8 }}>
          <input
            className="field"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search()
            }}
            aria-label="Search files"
          />
        </div>
        <div className="scroll" style={{ padding: '0 8px 12px' }}>
          {hits ? (
            hits.map((hit) => (
              <FileRow
                key={hit.path}
                label={hit.name}
                hint={`${hit.matches} match${hit.matches === 1 ? '' : 'es'}`}
                active={selected === hit.path}
                onClick={() => void open(hit.path)}
              />
            ))
          ) : tree.length === 0 ? (
            <span className="caption" style={{ padding: 12, display: 'block' }}>
              No files found in this project.
            </span>
          ) : (
            <TreeList nodes={tree} depth={0} selected={selected} onOpen={open} />
          )}
        </div>
      </div>

      <Resizer axis="x" onDelta={(d) => setSidebarWidth((w) => clamp(w + d, 200, 520))} onReset={() => setSidebarWidth(260)} />

      <div className="surface">
        {selected ? (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 16px',
                borderBottom: '1px solid var(--line)'
              }}
            >
              <Icon name="files" size={14} />
              <span className="caption mono truncate">{selected}</span>
              <div style={{ flex: 1 }} />
              <span className="caption">{content.split('\n').length} lines</span>
            </div>
            <div className="scroll" style={{ padding: 0 }}>
              <pre
                className="mono selectable"
                style={{ margin: 0, padding: '16px 20px', lineHeight: 1.65, color: 'var(--text-2)', fontSize: 'var(--t-xs)' }}
              >
                {content}
              </pre>
            </div>
          </>
        ) : (
          <div className="empty-view">
            <span className="title">Nothing open</span>
            <span className="subtitle">Pick a file to read it.</span>
          </div>
        )}
      </div>
    </div>
  )
}

function TreeList({
  nodes,
  depth,
  selected,
  onOpen
}: {
  nodes: FileNode[]
  depth: number
  selected: string | null
  onOpen: (path: string) => void
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.path}>
          <FileRow
            label={node.name}
            hint={node.kind === 'dir' ? undefined : formatBytes(node.size)}
            indent={depth}
            active={selected === node.path}
            onClick={() => onOpen(node.path)}
            chevron={node.kind === 'dir' ? node.children && node.children.length > 0 : undefined}
          />
          {node.children && node.children.length > 0 && (
            <TreeList nodes={node.children} depth={depth + 1} selected={selected} onOpen={onOpen} />
          )}
        </div>
      ))}
    </>
  )
}

function FileRow({
  label,
  hint,
  indent = 0,
  active,
  onClick,
  chevron
}: {
  label: string
  hint?: string
  indent?: number
  active?: boolean
  onClick: () => void
  chevron?: boolean
}) {
  return (
    <div
      className="row"
      data-clickable="true"
      onClick={onClick}
      style={{
        minHeight: 28,
        paddingLeft: 10 + indent * 13,
        paddingRight: 10,
        background: active ? 'var(--accent-soft)' : undefined,
        color: active ? 'var(--accent)' : 'var(--text-2)'
      }}
    >
      <span style={{ width: 14, display: 'inline-flex', color: 'var(--text-3)' }}>
        {chevron ? <Icon name="chevron" size={12} /> : null}
      </span>
      <span className="row-label truncate" style={{ fontSize: 'var(--t-sm)' }}>
        {label}
      </span>
      {hint && <span className="caption mono" style={{ fontSize: 'var(--t-xs)' }}>{hint}</span>}
    </div>
  )
}

// -------------------------------------------------------------------- diff

function DiffView({ tasks, timeline }: { tasks: AgentTask[]; timeline: TimelineEntry[] }) {
  const [changes, setChanges] = useState<FileChange[]>([])
  const [selected, setSelected] = useState(0)

  const reload = useCallback(async () => {
    try {
      const result = await window.cryptoric.git.diff()
      setChanges(result.files)
      setSelected(0)
    } catch {
      setChanges([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload, tasks.length])

  const changedByAgent = useMemo(
    () => timeline.filter((e) => /(edit|wrote|write|changed|patch)/i.test(`${e.stage} ${e.message}`)).length,
    [timeline]
  )

  if (changes.length === 0) {
    return (
      <div className="empty-view">
        <span className="title">No changes</span>
        <span className="subtitle" style={{ maxWidth: '44ch' }}>
          {changedByAgent > 0
            ? `${changedByAgent} edit action(s) were recorded, but the working tree matches HEAD.`
            : 'Files Cryptoric Chan edits will show here as a live diff.'}
        </span>
        <Button variant="ghost" onClick={() => void reload()}>
          Refresh
        </Button>
      </div>
    )
  }

  const current = changes[Math.min(selected, changes.length - 1)]

  return (
    <div className="split" style={{ gridTemplateColumns: '260px 6px minmax(0, 1fr)', flex: 1 }}>
      <div className="surface" style={{ background: 'var(--surface-1)', padding: '10px 8px' }}>
        {changes.map((change, index) => (
          <FileRow
            key={change.path}
            label={change.path}
            hint={`+${change.additions} −${change.deletions}`}
            active={index === selected}
            onClick={() => setSelected(index)}
          />
        ))}
      </div>
      <Resizer axis="x" onDelta={() => undefined} onReset={() => undefined} />
      <div className="surface">
        {current && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', borderBottom: '1px solid var(--line)' }}>
              <Dot tone={current.status === 'A' ? 'ok' : 'accent'} />
              <span className="truncate" style={{ fontWeight: 550 }}>
                {current.path}
              </span>
              <div style={{ flex: 1 }} />
              <Chip tone="ok">+{current.additions}</Chip>
              <Chip tone="error">−{current.deletions}</Chip>
            </div>
            <div className="scroll">
              {current.binary ? (
                <p className="caption" style={{ padding: 20 }}>
                  Binary file — no textual diff.
                </p>
              ) : (
                current.patch.split('\n').map((line, i) => (
                  <div
                    key={i}
                    className="mono selectable"
                    style={{
                      padding: '0 18px',
                      whiteSpace: 'pre',
                      background: line.startsWith('+')
                        ? 'var(--ok-soft)'
                        : line.startsWith('-')
                          ? 'var(--err-soft)'
                          : undefined,
                      color: line.startsWith('+')
                        ? 'var(--ok)'
                        : line.startsWith('-')
                          ? 'var(--err)'
                          : 'var(--text-2)'
                    }}
                  >
                    {line || ' '}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- terminal

function TerminalView({
  terminals,
  onRefreshProcessTree
}: {
  terminals: TerminalSessionInfo[]
  onRefreshProcessTree: () => void
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const session = terminals.find((t) => t.id === activeId) ?? terminals[0] ?? null
  const [lines, setLines] = useState<string[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!session) return
    setActiveId(session.id)
  }, [session?.id])

  useEffect(() => {
    if (!session) return
    const unsubscribe = window.cryptoric.onMainEvent((event) => {
      if (event.type === 'terminal-output' && event.sessionId === session.id) {
        setLines((prev) => [...prev.slice(-500), event.chunk])
      }
    })
    return unsubscribe
  }, [session?.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [lines.length])

  if (!session) {
    return (
      <div className="empty-view">
        <span className="title">No terminal</span>
        <span className="subtitle" style={{ maxWidth: '44ch' }}>
          Open a shell to run commands in this project. It receives the current environment, so a
          runtime installed moments ago is already available.
        </span>
        <Button variant="primary" onClick={() => void window.cryptoric.terminal.create().then(onRefreshProcessTree)}>
          Open shell
        </Button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
        <Icon name="terminal" size={14} />
        <span className="caption">{session.shell}</span>
        <span className="caption mono" style={{ fontSize: 'var(--t-xs)' }}>
          pid {session.pid ?? '—'} · env {session.envSnapshotId}
        </span>
        {session.envStale && <Chip tone="warn">older environment</Chip>}
        <div style={{ flex: 1 }} />
        <Button
          variant="ghost"
          onClick={() => void window.cryptoric.terminal.refresh(session.id, false).then(onRefreshProcessTree)}
          title="Open a new shell on the refreshed environment"
        >
          Refresh shell
        </Button>
        {terminals.length > 1 && (
          <select
            className="field"
            style={{ width: 180 }}
            value={session.id}
            onChange={(e) => {
              setActiveId(e.target.value)
              setLines([])
            }}
            aria-label="Terminal sessions"
          >
            {terminals.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <div
        className="scroll"
        tabIndex={0}
        style={{ padding: '16px 18px', outline: 'none' }}
        onKeyDown={(e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          if (e.key.length === 1) {
            void window.cryptoric.terminal.write(session.id, e.key)
            e.preventDefault()
          } else if (e.key === 'Enter') {
            void window.cryptoric.terminal.write(session.id, '\r\n')
            e.preventDefault()
          } else if (e.key === 'Backspace') {
            void window.cryptoric.terminal.write(session.id, '\b')
            e.preventDefault()
          }
        }}
        role="textbox"
        aria-label="Terminal"
      >
        <pre className="mono selectable" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-2)', fontSize: 'var(--t-xs)', lineHeight: 1.6 }}>
          {lines.join('')}
          <span
            style={{
              display: 'inline-block',
              width: 7,
              height: 13,
              background: 'var(--accent)',
              verticalAlign: 'text-bottom',
              marginLeft: 1
            }}
          />
        </pre>
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- processes

function ProcessView({ processes }: { processes: ProcessInfo[] }) {
  if (processes.length === 0) {
    return (
      <div className="empty-view">
        <span className="title">No running processes</span>
        <span className="subtitle" style={{ maxWidth: '44ch' }}>
          Dev servers, watchers and test runs started by Cryptoric appear here with their port and logs.
        </span>
      </div>
    )
  }
  return (
    <div className="scroll" style={{ padding: 20 }}>
      <SectionHead>Supervised processes</SectionHead>
      <div className="card" style={{ overflow: 'hidden' }}>
        {processes.map((proc, index) => (
          <div
            key={proc.id}
            className="row"
            style={{ borderTop: index === 0 ? 'none' : '1px solid var(--line)', borderRadius: 0, minHeight: 48 }}
          >
            <Dot
              tone={proc.status === 'running' ? 'accent' : proc.status === 'failed' ? 'error' : 'ok'}
              pulse={proc.status === 'running'}
            />
            <div className="row-label" style={{ display: 'grid' }}>
              <span style={{ fontWeight: 550 }}>{proc.label}</span>
              <span className="caption mono truncate" style={{ fontSize: 'var(--t-xs)' }}>
                {proc.command}
                {proc.port ? ` · :${proc.port}` : ''}
                {proc.exitCode !== null ? ` · exit ${proc.exitCode}` : ''}
                {proc.envStale ? ' · older environment' : ''}
              </span>
            </div>
            {proc.envStale && <Chip tone="warn">stale env</Chip>}
            <Button variant="ghost" onClick={() => void window.cryptoric.process.restart(proc.id)}>
              Restart
            </Button>
            <Button variant="ghost" onClick={() => void window.cryptoric.process.stop(proc.id)}>
              Stop
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export type { ProjectProfile }