/**
 * Signature components.
 *
 * These four — `Seal`, `SpineRail`, `LedgerRow`, `StatusBar3` — are what make the
 * interface read as Cryptoric rather than as a generic workbench. They are drawn
 * as inline SVG on a 16px grid at 1.25 stroke width; no icon library is used, so
 * the whole glyph set shares one construction rule.
 */

import { useRef, type CSSProperties, type ReactNode } from 'react'
import type { ToolInstallState, WorkspaceState } from '@shared/types'

// ---------------------------------------------------------------------------
// Seal — the identity mark
// ---------------------------------------------------------------------------

const SEAL_PATHS: Record<ToolInstallState | WorkspaceState, JSX.Element> = {
  // An engraved bracket with a dot: sealed = full bracket, open = notched.
  present: (
    <path d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11" fill="none" stroke="currentColor" strokeWidth="1.25" />
  ),
  mismatched: (
    <path d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 1.5" />
  ),
  missing: <path d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11" fill="none" stroke="currentColor" strokeWidth="1.25" />,
  installing: (
    <path d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="4 2" />
  ),
  failed: (
    <>
      <path d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.25" />
    </>
  ),
  unverified: <path d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="1 2" />,
  ACTIVE: (
    <path d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11" fill="none" stroke="currentColor" strokeWidth="1.25" />
  ),
  IDLE: <path d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="1 2" />,
  RUNNING: (
    <path d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="4 2" />
  ),
  BUILDING: <path d="M4 12l3-8 3 8M5 9.5h4" fill="none" stroke="currentColor" strokeWidth="1.25" />,
  TESTING: <path d="M4 8.5l2.5 2.5L12 5" fill="none" stroke="currentColor" strokeWidth="1.25" />,
  ERROR: (
    <>
      <path d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.25" />
    </>
  ),
  OFFLINE: <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.25" />
}

export function Seal({ state, title }: { state: ToolInstallState | WorkspaceState; title?: string }) {
  return (
    <span className="seal" data-state={state} title={title} aria-label={title ?? state} role="img">
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        {SEAL_PATHS[state]}
        <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      </svg>
    </span>
  )
}

// ---------------------------------------------------------------------------
// SpineRail — the measured vertical scale
// ---------------------------------------------------------------------------

export function SpineRail({
  workspaceState,
  snapshotId,
  snapshotReason,
  online,
  taskCount
}: {
  workspaceState: WorkspaceState
  snapshotId: number | null
  snapshotReason: string | null
  online: boolean
  taskCount: number
}) {
  return (
    <nav
      aria-label="Workspace status rail"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-5)',
        padding: 'var(--space-4) 0',
        borderRight: '1px solid var(--hairline)',
        background: 'var(--surface-sunken)'
      }}
    >
      <Seal state={workspaceState} title={`Workspace ${workspaceState}`} />

      {/* Measurement ticks: 4px rule, 2px marks. Purely structural. */}
      <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
        {Array.from({ length: 18 }, (_, i) => (
          <span
            key={i}
            style={{
              width: i % 3 === 0 ? 10 : 5,
              height: 1,
              background: 'var(--hairline)',
              flex: '0 0 auto'
            }}
          />
        ))}
      </div>

      <div style={{ marginTop: 'auto', display: 'grid', gap: 'var(--space-3)', justifyItems: 'center' }}>
        <span
          className="data"
          style={{ fontSize: 9, color: 'var(--ink-tertiary)', writingMode: 'vertical-rl' }}
          title={`Environment snapshot ${snapshotId ?? '—'}${snapshotReason ? ` (${snapshotReason})` : ''}`}
        >
          {snapshotId !== null ? `env·${snapshotId}` : 'env·—'}
        </span>
        {taskCount > 0 && (
          <span className="data" style={{ fontSize: 9, color: 'var(--accent-sulfur)' }} title={`${taskCount} task(s)`}>
            {taskCount}
          </span>
        )}
        {!online && (
          <span className="micro-label" style={{ color: 'var(--alert-ember)' }} title="Offline">
            NET
          </span>
        )}
      </div>
    </nav>
  )
}

// ---------------------------------------------------------------------------
// LedgerRow — the defining data unit
// ---------------------------------------------------------------------------

export function LedgerRow({
  label,
  value,
  meta,
  state,
  title,
  onClick,
  actions,
  selected
}: {
  label: ReactNode
  value: ReactNode
  meta?: ReactNode
  state?: ToolInstallState
  title?: string
  onClick?: () => void
  actions?: ReactNode
  selected?: boolean
}) {
  return (
    <div
      className="ledger-row"
      data-selected={selected ? 'true' : 'false'}
      title={title}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onClick()
        }
      }}
    >
      <span className="ledger-label">
        {state && <Seal state={state} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
        {actions}
        <span className="ledger-value" title={typeof value === 'string' ? value : undefined}>
          {value}
        </span>
        {meta && <span className="ledger-meta">{meta}</span>}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// StatusBar3 — tri-state glyph
// ---------------------------------------------------------------------------

export function StatusBar3({ level, label }: { level: 0 | 1 | 2 | 3; label?: string }) {
  return (
    <span
      className="status-bar3"
      data-level={level}
      title={label}
      style={{ color: level === 3 ? 'var(--signal-verdigris)' : level === 0 ? 'var(--ink-disabled)' : 'var(--accent-sulfur)' }}
      aria-label={label ?? `status level ${level}`}
    >
      <span />
      <span />
      <span />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Splitter
// ---------------------------------------------------------------------------

export function Splitter({
  orientation,
  onDelta,
  onReset
}: {
  orientation: 'x' | 'y'
  onDelta: (delta: number) => void
  onReset: () => void
}) {
  const dragging = useRef(false)
  const last = useRef(0)

  return (
    <div
      className="splitter"
      data-orientation={orientation}
      data-dragging={dragging.current ? 'true' : 'false'}
      role="separator"
      aria-orientation={orientation === 'x' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        dragging.current = true
        last.current = orientation === 'x' ? e.clientX : e.clientY
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        const current = orientation === 'x' ? e.clientX : e.clientY
        onDelta(current - last.current)
        last.current = current
      }}
      onPointerUp={(e) => {
        dragging.current = false
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 12
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') onDelta(-step)
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') onDelta(step)
        if (e.key === 'Home') onReset()
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function MicroLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span className="micro-label" style={style}>
      {children}
    </span>
  )
}

export function Chip({
  tone,
  children
}: {
  tone: 'ok' | 'warn' | 'error' | 'info' | 'neutral'
  children: ReactNode
}) {
  return (
    <span className="chip" data-tone={tone === 'neutral' ? undefined : tone}>
      {children}
    </span>
  )
}

export function EmptyState({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-title">{title}</span>
      {hint && <span style={{ fontSize: 'var(--text-data)', maxWidth: '42ch' }}>{hint}</span>}
      {children}
    </div>
  )
}

/**
 * Rail icons.
 *
 * Hand-drawn on the same 16px grid at 1.25 stroke as the seal, so the glyph set
 * is internally consistent. No third-party icon library, no emoji.
 */
export function RailIcon({ id }: { id: 'home' | 'files' | 'agent' | 'tasks' | 'tools' }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.25,
    strokeLinecap: 'square' as const,
    strokeLinejoin: 'miter' as const
  }
  switch (id) {
    case 'home':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="3.25" {...common} />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" {...common} />
        </svg>
      )
    case 'files':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 3.5h4l1.25 1.75h5.75v7.25h-11z" {...common} />
          <path d="M2.5 6.5h11" {...common} opacity="0.5" />
        </svg>
      )
    case 'agent':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2.5l4.5 2.5v5L8 12.5 3.5 10V5z" {...common} />
          <circle cx="8" cy="7.5" r="1.5" fill="currentColor" />
        </svg>
      )
    case 'tasks':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" {...common} />
          <circle cx="12" cy="11.5" r="1.5" fill="currentColor" />
        </svg>
      )
    case 'tools':
      return (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="2.25" {...common} />
          <path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5M3.4 3.4l1.8 1.8M10.8 10.8l1.8 1.8M12.6 3.4l-1.8 1.8M5.2 10.8l-1.8 1.8" {...common} opacity="0.6" />
        </svg>
      )
    default:
      return null
  }
}