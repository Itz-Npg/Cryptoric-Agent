/**
 * Runtime Manager.
 *
 * Environment management is a headline capability, so it gets a dedicated
 * surface rather than a spreadsheet in a corner. The layout is deliberately
 * calm: a runtime, its version, and its state. Nothing is listed unless it
 * matters to the project or to the machine.
 *
 * The install flow is the point. When a runtime is missing, the row explains
 * what Cryptoric will do and offers one action; the app keeps running while the
 * install proceeds, and the row then shows the refresh that made it usable.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { EnvironmentGap, InstallProgress, ProjectProfile, ToolStatus } from '@shared/types'
import { Button, Chip, Dot, Icon, SectionHead, toneForInstallState } from '../components/primitives'

/** Groups chosen for what a developer actually asks about. */
const GROUPS: { id: string; label: string; toolIds: string[] }[] = [
  { id: 'core', label: 'Languages & runtimes', toolIds: ['node', 'python', 'rust', 'java', 'go', 'dotnet'] },
  { id: 'vcs', label: 'Version control & native', toolIds: ['git', 'cmake', 'ninja'] },
  { id: 'pm', label: 'Package managers', toolIds: ['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'cargo', 'maven', 'gradle'] },
  { id: 'optional', label: 'Optional', toolIds: ['docker', 'msvc'] }
]

export function RuntimeManager({
  tools,
  install,
  project,
  gaps,
  snapshotId,
  onInstall,
  onRefresh
}: {
  tools: ToolStatus[]
  install: Record<string, InstallProgress>
  project: ProjectProfile | null
  gaps: EnvironmentGap[]
  snapshotId: number | null
  onInstall: (toolId: string) => void
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const byId = useMemo(() => new Map(tools.map((t) => [t.spec.id, t])), [tools])
  const gapIds = useMemo(() => new Set(gaps.map((g) => g.toolId)), [gaps])

  // An install in progress or just finished explains itself, so open its row.
  const [lastEvent, setLastEvent] = useState<string | null>(null)
  useEffect(() => {
    const entry = Object.entries(install).find(([, p]) => p.phase === 'done' || p.phase === 'failed')
    if (entry) setLastEvent(entry[0])
  }, [install])

  return (
    <div className="scroll" style={{ padding: '28px 32px 48px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', display: 'grid', gap: 28 }}>
        <header style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <h1 className="title">Runtime Manager</h1>
            <p className="subtitle" style={{ margin: '6px 0 0' }}>
              {project
                ? `Runtimes available to ${project.name}, and anything this project still needs.`
                : 'Runtimes available on this machine. Open a project to see what it specifically requires.'}
            </p>
          </div>
          <div style={{ flex: 1 }} />
          <Button onClick={onRefresh} variant="ghost">
            Refresh
          </Button>
        </header>

        {gaps.length > 0 && (
          <section className="card" style={{ borderColor: 'var(--accent-line)' }}>
            <div className="card-pad" style={{ display: 'grid', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Dot tone="accent" pulse />
                <span style={{ fontWeight: 600 }}>
                  {gaps.length} runtime{gaps.length === 1 ? '' : 's'} needed by this project
                </span>
              </div>
              {gaps.map((gap) => (
                <MissingRuntime key={gap.toolId} gap={gap} onInstall={onInstall} />
              ))}
            </div>
          </section>
        )}

        {GROUPS.map((group) => {
          const rows = group.toolIds
            .map((id) => byId.get(id))
            .filter((t): t is ToolStatus => Boolean(t))
          if (rows.length === 0) return null
          return (
            <section key={group.id}>
              <SectionHead>{group.label}</SectionHead>
              <div className="card" style={{ overflow: 'hidden' }}>
                {rows.map((tool, index) => (
                  <RuntimeRow
                    key={tool.spec.id}
                    tool={tool}
                    install={install[tool.spec.id]}
                    required={gapIds.has(tool.spec.id)}
                    highlighted={lastEvent === tool.spec.id}
                    expanded={expanded === tool.spec.id}
                    first={index === 0}
                    onToggle={() => setExpanded((c) => (c === tool.spec.id ? null : tool.spec.id))}
                    onInstall={() => onInstall(tool.spec.id)}
                  />
                ))}
              </div>
            </section>
          )
        })}

        <p className="caption" style={{ margin: 0 }}>
          Environment snapshot {snapshotId ?? '—'} · installing a runtime refreshes this environment and
          spawns new shells with it. Cryptoric Agent itself keeps running.
        </p>
      </div>
    </div>
  )
}

function RuntimeRow({
  tool,
  install,
  required,
  highlighted,
  expanded,
  first,
  onToggle,
  onInstall
}: {
  tool: ToolStatus
  install?: InstallProgress
  required: boolean
  highlighted: boolean
  expanded: boolean
  first: boolean
  onToggle: () => void
  onInstall: () => void
}) {
  const busy = install && install.phase !== 'done' && install.phase !== 'failed'
  const state = busy ? 'installing' : tool.state
  const missing = tool.state === 'missing'

  return (
    <div
      style={{
        borderTop: first ? 'none' : '1px solid var(--line)',
        background: highlighted ? 'var(--accent-soft)' : undefined,
        transition: 'background var(--t-fast) var(--ease)'
      }}
    >
      <div
        className="row"
        data-clickable="true"
        onClick={onToggle}
        style={{ minHeight: 46, borderRadius: 0 }}
      >
        <Dot tone={toneForInstallState(state)} pulse={busy} />

        <div className="row-label" style={{ display: 'grid', gap: 1 }}>
          <span style={{ fontWeight: 550, fontSize: 'var(--t-base)' }}>{shortLabel(tool.spec.label)}</span>
          {busy && install && (
            <span style={{ display: 'block', marginTop: 5 }}>
              <InstallProgress progress={install} />
            </span>
          )}
        </div>

        <span className="mono" style={{ color: missing ? 'var(--text-3)' : 'var(--text-2)' }}>
          {missing ? 'Not installed' : (tool.version ?? tool.state)}
        </span>

        {required && !missing && <Chip tone="warn">update needed</Chip>}
        {required && missing && <Chip tone="accent">required</Chip>}

        {missing && (
          <Button
            onClick={() => {
              onInstall()
            }}
            disabled={busy}
          >
            {busy ? 'Installing' : 'Install'}
          </Button>
        )}

        {!missing && install?.phase === 'done' && <Chip tone="ok">just installed</Chip>}

        <span
          style={{
            color: 'var(--text-3)',
            display: 'inline-flex',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform var(--t-fast) var(--ease)'
          }}
        >
          <Icon name="chevron" size={14} />
        </span>
      </div>

      {expanded && (
        <div
          style={{
            padding: '4px 16px 18px 35px',
            display: 'grid',
            gap: 8,
            animation: 'expand var(--t-base) var(--ease)'
          }}
        >
          <style>{`@keyframes expand { from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: none } }`}</style>
          <Detail label="Status" value={tool.detail} />
          <Detail label="Executable" value={tool.path ?? '—'} mono />
          {tool.constraint && <Detail label="Required" value={tool.constraint} mono />}
          <Detail label="Last verified" value={tool.lastVerifiedAt ?? 'never'} mono />
          {tool.spec.installers.length > 0 && (
            <Detail
              label="Install routes"
              value={tool.spec.installers.map((i) => `${i.label} — ${i.trust}`).join('\n')}
            />
          )}
          {install?.phase === 'failed' && <Detail label="Install error" value={install.message} tone="error" />}
        </div>
      )}
    </div>
  )
}

function MissingRuntime({ gap, onInstall }: { gap: EnvironmentGap; onInstall: (id: string) => void }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--t-md)' }}>{shortLabel(gap.label)}</span>
        <Chip tone="idle">Not installed</Chip>
      </div>
      <p className="subtitle" style={{ margin: 0, maxWidth: '62ch' }}>
        Cryptoric can install {shortLabel(gap.label)} and configure the project environment automatically.
        The app keeps running — the runtime is verified on a refreshed environment before the task
        continues.
      </p>
      <div>
        <Button variant="primary" onClick={() => onInstall(gap.toolId)}>
          Install {gap.label}
        </Button>
      </div>
    </div>
  )
}

/**
 * Registry labels carry a qualifier ("Rust (rusto)", "Java (JDK)") that is noise
 * in a runtime list — the version and state beside it already say what matters.
 */
function shortLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim()
}

function Detail({
  label,
  value,
  mono,
  tone
}: {
  label: string
  value: string
  mono?: boolean
  tone?: 'error'
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: 12, alignItems: 'baseline' }}>
      <span className="caption">{label}</span>
      <span
        className={mono ? 'mono selectable' : 'selectable'}
        style={{
          color: tone === 'error' ? 'var(--err)' : 'var(--text-2)',
          whiteSpace: 'pre-wrap',
          fontSize: mono ? 'var(--t-xs)' : 'var(--t-sm)'
        }}
      >
        {value}
      </span>
    </div>
  )
}

export function InstallProgress({ progress }: { progress: InstallProgress }) {
  const ratio = progress.ratio ?? 0
  const indeterminate = progress.ratio === null
  return (
    <span style={{ display: 'grid', gap: 5, width: 200 }}>
      <span className="caption" style={{ fontSize: 'var(--t-xs)' }}>
        {progress.message}
      </span>
      <span
        style={{
          display: 'block',
          height: 3,
          borderRadius: 2,
          background: 'var(--surface-4)',
          position: 'relative',
          overflow: 'hidden'
        }}
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
            background: 'var(--accent)',
            transition: 'transform 120ms linear'
          }}
        />
        {indeterminate && (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              width: '38%',
              background: 'var(--accent)',
              opacity: 0.4
            }}
          />
        )}
      </span>
    </span>
  )
}

/** Small inline runtime summary used by the status bar and the home screen. */
export function useRuntimeSummary(tools: ToolStatus[]): { label: string; tone: 'ok' | 'warn' | 'error' | 'idle' }[] {
  return useMemo(() => {
    const interesting: string[] = ['node', 'python', 'rust', 'java', 'go', 'git']
    return interesting
      .map((id) => tools.find((t) => t.spec.id === id))
      .filter((t): t is ToolStatus => Boolean(t))
      .map((t) => ({
        label: `${(t.spec.label.split(' ')[0] ?? t.spec.label)}${t.version ? ` ${t.version.split('.')[0]}` : ''}`,
        tone:
          t.state === 'present'
            ? 'ok'
            : t.state === 'mismatched'
              ? 'warn'
              : t.state === 'missing'
                ? 'idle'
                : ('warn' as const)
      }))
  }, [tools])
}

export function useRefreshOnInstall(install: Record<string, InstallProgress>, refresh: () => void): void {
  const last = useRef<string | null>(null)
  useEffect(() => {
    const done = Object.values(install).find((p) => p.phase === 'done' || p.phase === 'failed')
    if (done && last.current !== `${done.toolId}:${done.phase}`) {
      last.current = `${done.toolId}:${done.phase}`
      refresh()
    }
  }, [install, refresh])
}

export type { ProjectProfile }