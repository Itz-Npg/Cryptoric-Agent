/**
 * Main workspace surfaces — one per rail section.
 *
 * Each surface owns a single job and renders real data from the main process.
 * Nothing here fakes state: an empty project genuinely shows the welcome state,
 * and a missing bridge shows an error rather than a placeholder.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AgentTask,
  EnvironmentGap,
  FileNode,
  FileSearchHit,
  ProjectProfile,
  SkillDescriptor,
  TimelineEntry,
  ToolDescriptor,
  ToolStatus
} from '@shared/types'
import { Chip, EmptyState, MicroLabel, Seal, StatusBar3 } from '../components/marks'

export interface SurfaceProps {
  project: ProjectProfile | null
  gaps: EnvironmentGap[]
  tools: ToolStatus[]
  notice: (message: string | null) => void
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export function HomeSurface({ project, gaps, tools, notice }: SurfaceProps & { onOpen: () => void }) {
  const [recent, setRecent] = useState<{ root: string; name: string; openedAt: string }[]>([])

  useEffect(() => {
    void window.cryptoric.project.list().then(setRecent).catch(() => undefined)
  }, [project])

  if (!project) {
    return (
      <div className="welcome">
        <MicroLabel>main workspace</MicroLabel>
        <h1 className="welcome-title">Open a project to get started</h1>
        <p className="welcome-body">
          Cryptoric Chan reads the folder's manifests, works out which runtimes it needs, installs
          anything missing from official sources, and keeps the session running — without restarting
          this app.
        </p>
        <button className="btn" data-variant="primary" onClick={() => window.cryptoric.project.open().catch((e: unknown) => notice(String(e)))}>
          open project…
        </button>
        {recent.length > 0 && (
          <div style={{ marginTop: 'var(--space-6)', width: 'min(560px, 80%)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
              <MicroLabel>recent</MicroLabel>
              <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
            </div>
            <div className="ledger" style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)' }}>
              {recent.map((r) => (
                <button
                  key={r.root}
                  className="ledger-row"
                  style={{ background: 'transparent', border: 'none', borderBottom: '1px solid var(--hairline)', cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => window.cryptoric.project.open(r.root).catch((e: unknown) => notice(String(e)))}
                >
                  <span className="ledger-label">{r.name}</span>
                  <span className="ledger-value" style={{ color: 'var(--ink-tertiary)' }}>{r.root}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  const present = tools.filter((t) => t.state === 'present').length

  return (
    <div style={{ padding: 'var(--space-6)', overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-4)', marginBottom: 'var(--space-5)' }}>
        <h1 style={{ fontSize: 'var(--text-emphasis)', fontWeight: 600, margin: 0 }}>{project.name}</h1>
        <Chip tone="info">{project.kind}</Chip>
        {project.isGitRepo && <Chip tone="neutral">git</Chip>}
        {project.packageManager && <Chip tone="neutral">{project.packageManager}</Chip>}
      </div>
      <p className="data dim selectable" style={{ marginTop: 0, fontSize: 'var(--text-micro)', wordBreak: 'break-all' }}>
        {project.root}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-5)', marginTop: 'var(--space-6)' }}>
        <Section title="environment" rows={[
          ['runtimes available', `${present} of ${tools.length}`],
          ['missing / mismatched', String(gaps.length)],
          ['package manager', project.packageManager ?? 'none detected'],
          ['dev server port', project.devServerPort ? String(project.devServerPort) : 'unknown']
        ]} />
        <Section
          title="manifests"
          rows={project.manifests.length === 0 ? [['—', 'none detected']] : project.manifests.map((m) => [m.file, m.constraint ?? m.kind])}
        />
        <Section
          title="scripts"
          rows={Object.keys(project.scripts).length === 0 ? [['—', 'none detected']] : Object.entries(project.scripts)}
        />
      </div>

      {gaps.length > 0 && (
        <div style={{ marginTop: 'var(--space-7)' }}>
          <MicroLabel style={{ color: 'var(--alert-ember)' }}>needs attention</MicroLabel>
          <div className="ledger" style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)', marginTop: 'var(--space-3)' }}>
            {gaps.map((gap) => (
              <div key={gap.toolId} className="ledger-row">
                <span className="ledger-label">
                  <Seal state={gap.kind === 'missing' ? 'missing' : 'mismatched'} />
                  <span>{gap.label}</span>
                </span>
                <span className="ledger-meta">{gap.requiredBy.join(', ') || 'project manifest'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        <MicroLabel>{title}</MicroLabel>
        <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
      </div>
      <div className="ledger" style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)' }}>
        {rows.map(([k, v]) => (
          <div key={k} className="ledger-row">
            <span className="ledger-label">
              <span style={{ fontSize: 'var(--text-data)' }}>{k}</span>
            </span>
            <span className="ledger-value">{v}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function FilesSurface({ project, notice }: SurfaceProps) {
  const [tree, setTree] = useState<FileNode[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FileSearchHit[]>([])
  const [loading, setLoading] = useState(false)

  const loadTree = useCallback(async () => {
    if (!project) return
    setLoading(true)
    try {
      setTree(await window.cryptoric.file.tree(undefined, 3))
    } catch (err) {
      notice(String(err))
    } finally {
      setLoading(false)
    }
  }, [project, notice])

  useEffect(() => {
    setTree([])
    setSelected(null)
    setContent('')
    void loadTree()
  }, [loadTree])

  const open = useCallback(
    async (path: string) => {
      try {
        const file = await window.cryptoric.file.read(path)
        setSelected(file.path)
        setContent(file.content)
      } catch (err) {
        notice(String(err))
      }
    },
    [notice]
  )

  const onSearch = useCallback(async () => {
    if (!query.trim()) {
      setResults([])
      return
    }
    try {
      setResults(await window.cryptoric.file.search(query, 60))
    } catch (err) {
      notice(String(err))
    }
  }, [query, notice])

  if (!project) {
    return <EmptyState title="No project open" hint="Files are scoped to the open project." />
  }

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', height: '100%', minHeight: 0 }}>
      <div className="pane-header">
        <input
          className="input"
          style={{ width: 260 }}
          placeholder="Search files and contents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onSearch()
          }}
          aria-label="Search files"
        />
        <button className="btn" data-variant="ghost" onClick={() => void onSearch()}>
          search
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn" data-variant="ghost" onClick={() => void loadTree()}>
          refresh
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', minHeight: 0 }}>
        <div style={{ borderRight: '1px solid var(--hairline)', overflow: 'auto' }}>
          {results.length > 0 ? (
            <div className="ledger">
              {results.map((r) => (
                <button
                  key={r.path}
                  className="ledger-row"
                  style={{ background: 'transparent', border: 'none', borderBottom: '1px solid var(--hairline)', cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => void open(r.path)}
                >
                  <span className="ledger-label">
                    <span style={{ fontSize: 'var(--text-data)' }}>{r.name}</span>
                  </span>
                  <span className="ledger-meta">{r.matches} match(es)</span>
                </button>
              ))}
            </div>
          ) : loading ? (
            <EmptyState title="Reading tree…" />
          ) : (
            <TreeNodes nodes={tree} depth={0} onOpen={open} selected={selected} />
          )}
        </div>

        <div style={{ overflow: 'auto', minWidth: 0 }}>
          {selected ? (
            <>
              <div style={{ padding: 'var(--space-2) var(--space-4)', borderBottom: '1px solid var(--hairline)', position: 'sticky', top: 0, background: 'var(--surface-void)' }}>
                <MicroLabel>{selected}</MicroLabel>
              </div>
              <pre className="data selectable" style={{ margin: 0, padding: 'var(--space-4)', fontSize: 'var(--text-data)', lineHeight: 1.5 }}>
                {content}
              </pre>
            </>
          ) : (
            <EmptyState title="Select a file" hint={`${tree.length} top-level entries.`} />
          )}
        </div>
      </div>
    </div>
  )
}

function TreeNodes({
  nodes,
  depth,
  onOpen,
  selected
}: {
  nodes: FileNode[]
  depth: number
  onOpen: (path: string) => void
  selected: string | null
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.path}>
          <button
            className="rail-item"
            style={{
              width: '100%',
              height: 'auto',
              minHeight: 22,
              padding: '2px var(--space-3)',
              paddingLeft: `calc(${depth} * 12px + var(--space-3))`,
              borderRadius: 0,
              fontSize: 'var(--text-micro)',
              fontFamily: 'var(--font-mono)',
              justifyContent: 'flex-start'
            }}
            aria-current={selected === node.path ? 'page' : undefined}
            onClick={() => onOpen(node.path)}
          >
            <span style={{ color: 'var(--ink-tertiary)' }}>{node.kind === 'dir' ? '▸' : '·'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
          </button>
          {node.children && node.children.length > 0 && (
            <TreeNodes nodes={node.children} depth={depth + 1} onOpen={onOpen} selected={selected} />
          )}
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export function AgentSurface({
  project,
  gaps,
  tools,
  onSubmit
}: SurfaceProps & { onSubmit: (p: string) => void }) {
  const [prompt, setPrompt] = useState('')
  const [skills, setSkills] = useState<SkillDescriptor[]>([])

  useEffect(() => {
    void window.cryptoric.skill.list().then(setSkills).catch(() => undefined)
  }, [project])

  const enabledSkills = useMemo(() => skills.filter((s) => s.enabled), [skills])
  const present = tools.filter((t) => t.state === 'present').length

  const suggestions = [
    { label: 'Analyse this project', prompt: 'Analyse this project and report what it needs to build.' },
    { label: 'Install missing runtimes', prompt: 'Install the runtimes this project is missing, then verify them.' },
    { label: 'Run the test suite', prompt: 'Run the project test suite and report the result.' }
  ].filter((s) => (s.label !== 'Install missing runtimes' || gaps.length > 0))

  return (
    <div style={{ padding: 'var(--space-6)', overflow: 'auto', height: '100%', display: 'grid', alignContent: 'start', gap: 'var(--space-6)' }}>
      <div>
        <MicroLabel>capability</MicroLabel>
        <h1 style={{ fontSize: 'var(--text-emphasis)', fontWeight: 600, margin: 'var(--space-3) 0 0' }}>
          Cryptoric Chan
        </h1>
        <p className="welcome-body" style={{ marginTop: 'var(--space-3)' }}>
          The agent runs a staged pipeline: analyse the project, plan, implement, run tests, then review.
          Every tool call is permission-checked and recorded on the timeline.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-5)' }}>
        <Section title="environment" rows={[
          ['runtimes ready', `${present} / ${tools.length}`],
          ['gaps to resolve', String(gaps.length)],
          ['skills enabled', `${enabledSkills.length} of ${skills.length}`]
        ]} />
        <Section title="stages" rows={[
          ['analyse', 'project manifests and required runtimes'],
          ['plan', 'derived steps and loaded skills'],
          ['implement', 'file changes, permission-gated'],
          ['verify', 'tests, processes, environment'],
          ['review', 'diff and security findings']
        ]} />
      </div>

      <div>
        <MicroLabel>start a task</MicroLabel>
        <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
          <input
            className="input"
            style={{ flex: 1, height: 34 }}
            placeholder={project ? `Ask Cryptoric Chan to work in ${project.name}…` : 'Open a project first…'}
            disabled={!project}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && prompt.trim()) {
                onSubmit(prompt.trim())
                setPrompt('')
              }
            }}
          />
          <button
            className="btn"
            data-variant="primary"
            disabled={!project || !prompt.trim()}
            onClick={() => {
              onSubmit(prompt.trim())
              setPrompt('')
            }}
          >
            run
          </button>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
          {suggestions.map((s) => (
            <button key={s.label} className="btn" data-variant="ghost" disabled={!project} onClick={() => onSubmit(s.prompt)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {skills.length > 0 && (
        <div>
          <MicroLabel>loaded skills</MicroLabel>
          <p style={{ color: 'var(--ink-tertiary)', fontSize: 'var(--text-data)', margin: 'var(--space-2) 0 var(--space-3)' }}>
            Only skills relevant to the current task are loaded into context. The rest are skipped.
          </p>
          <div className="ledger" style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)' }}>
            {skills.slice(0, 12).map((skill) => (
              <div key={skill.id} className="ledger-row">
                <span className="ledger-label">
                  <Seal state={skill.enabled ? 'present' : 'missing'} />
                  <span style={{ fontSize: 'var(--text-data)' }}>{skill.name}</span>
                </span>
                <span className="ledger-meta">{skill.scope}{skill.categories.length ? ` · ${skill.categories.slice(0, 2).join(', ')}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function TasksSurface({ tasks, timeline }: { tasks: AgentTask[]; timeline: TimelineEntry[] }) {
  const recent = timeline.slice(-150).reverse()

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', height: '100%', minHeight: 0 }}>
      <section style={{ borderRight: '1px solid var(--hairline)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="pane-header">
          <MicroLabel>tasks</MicroLabel>
          <div style={{ flex: 1 }} />
          <MicroLabel>{tasks.length}</MicroLabel>
        </div>
        <div className="pane-body">
          {tasks.length === 0 ? (
            <EmptyState title="No tasks" hint="Start one from the Agent surface." />
          ) : (
            <div className="ledger">
              {tasks.map((task) => (
                <div key={task.id} className="ledger-row" style={{ gridTemplateColumns: 'auto minmax(0, 1fr) auto' }}>
                  <StatusBar3
                    level={task.status === 'COMPLETED' ? 3 : task.status === 'FAILED' ? 0 : task.status === 'RUNNING' ? 2 : 1}
                    label={task.status}
                  />
                  <span style={{ display: 'grid', minWidth: 0 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
                    <span className="ledger-meta">
                      {task.status} · {task.role.replace(/_/g, ' ').toLowerCase()}
                      {task.error ? ` · ${task.error}` : ''}
                    </span>
                  </span>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <button className="btn" data-variant="ghost" onClick={() => void window.cryptoric.agent.stop(task.id)}>stop</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="pane-header">
          <MicroLabel>timeline</MicroLabel>
          <div style={{ flex: 1 }} />
          <MicroLabel>{timeline.length} events</MicroLabel>
        </div>
        <div className="pane-body" style={{ padding: 'var(--space-4)' }}>
          {recent.length === 0 ? (
            <EmptyState title="Nothing has run yet" />
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-3)' }}>
              {recent.map((entry) => (
                <li
                  key={entry.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                    gap: 'var(--space-3)',
                    alignItems: 'baseline',
                    paddingLeft: 'var(--space-4)',
                    borderLeft: `1px solid ${
                      entry.status === 'error'
                        ? 'var(--alert-ember-dim)'
                        : entry.status === 'ok'
                          ? 'var(--signal-verdigris-dim)'
                          : 'var(--hairline)'
                    }`
                  }}
                >
                  <span className="data dim" style={{ fontSize: 'var(--text-micro)' }}>{entry.at.slice(11, 19)}</span>
                  <span className="data selectable" style={{ color: 'var(--ink-secondary)' }}>{entry.message}</span>
                  <span className="micro-label">{entry.role.replace(/_/g, ' ').toLowerCase()}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function ToolsSurface({ tools, notice }: SurfaceProps) {
  const [descriptors, setDescriptors] = useState<ToolDescriptor[]>([])
  const [rules, setRules] = useState<{ domain: string; default: string }[]>([])
  const [skills, setSkills] = useState<SkillDescriptor[]>([])

  useEffect(() => {
    void Promise.all([
      window.cryptoric.agent.tools(),
      window.cryptoric.permission.list(),
      window.cryptoric.skill.list()
    ])
      .then(([t, p, s]) => {
        setDescriptors(t as ToolDescriptor[])
        setRules(p as { domain: string; default: string }[])
        setSkills(s)
      })
      .catch((e: unknown) => notice(String(e)))
  }, [notice])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--space-6)', padding: 'var(--space-6)', overflow: 'auto', height: '100%', alignContent: 'start' }}>
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <MicroLabel>agent tools</MicroLabel>
          <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
        </div>
        <div className="ledger" style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)' }}>
          {descriptors.map((tool) => (
            <div key={tool.id} className="ledger-row" style={{ alignItems: 'start', padding: 'var(--space-2) var(--space-4)' }}>
              <span style={{ display: 'grid', gap: 2 }}>
                <span className="data" style={{ color: 'var(--ink-primary)' }}>{tool.id}</span>
                <span style={{ fontSize: 'var(--text-micro)', color: 'var(--ink-tertiary)' }}>{tool.description}</span>
              </span>
              <span className="ledger-meta">{tool.tier}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <MicroLabel>permissions</MicroLabel>
          <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
        </div>
        <div className="ledger" style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)' }}>
          {rules.map((rule) => (
            <div key={rule.domain} className="ledger-row">
              <span className="ledger-label">
                <span style={{ fontSize: 'var(--text-data)' }}>{rule.domain}</span>
              </span>
              <Chip tone={rule.default === 'allow' ? 'ok' : rule.default === 'deny' ? 'error' : 'warn'}>{rule.default}</Chip>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <MicroLabel>skills</MicroLabel>
          <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
        </div>
        <div className="ledger" style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)' }}>
          {skills.length === 0 ? (
            <div className="ledger-row">
              <span className="ledger-label">
                <span style={{ fontSize: 'var(--text-data)' }}>no skills discovered</span>
              </span>
            </div>
          ) : (
            skills.map((skill) => (
              <div key={skill.id} className="ledger-row">
                <span className="ledger-label">
                  <Seal state={skill.enabled ? 'present' : 'missing'} />
                  <span style={{ display: 'grid', minWidth: 0 }}>
                    <span style={{ fontSize: 'var(--text-data)' }}>{skill.name}</span>
                    <span className="ledger-meta" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {skill.description || skill.id}
                    </span>
                  </span>
                </span>
                <button
                  className="btn"
                  data-variant="ghost"
                  onClick={() => {
                    void window.cryptoric.skill
                      .setEnabled(skill.id, !skill.enabled)
                      .then(() => window.cryptoric.skill.list())
                      .then(setSkills)
                      .catch((e: unknown) => notice(String(e)))
                  }}
                >
                  {skill.enabled ? 'disable' : 'enable'}
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <MicroLabel>runtimes</MicroLabel>
          <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
        </div>
        <div className="ledger" style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--radius-sm)' }}>
          {tools.map((tool) => (
            <div key={tool.spec.id} className="ledger-row">
              <span className="ledger-label">
                <Seal state={tool.state} title={tool.detail} />
                <span style={{ fontSize: 'var(--text-data)' }}>{tool.spec.label}</span>
              </span>
              <span className="ledger-value">{tool.version ?? tool.state}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}