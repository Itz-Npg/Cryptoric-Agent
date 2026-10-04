/**
 * Shared UI primitives.
 *
 * A deliberately small kit: Rail, Topbar, StatusBar, Resizer, Dot, Chip, and the
 * Cryptoric mark. Everything else composes from these, so the app reads as one
 * designed system rather than a pile of bespoke panels.
 */

import { useRef, type ReactNode } from 'react'
import type { ToolInstallState, WorkspaceState } from '@shared/types'

// ---------------------------------------------------------------- identity

/**
 * The Cryptoric mark. A bold C with a cut leading edge, matching the app icon.
 * Drawn at 24px on a 24-unit grid.
 */
export function CryptoricMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="ca-c" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#67e8f9" />
          <stop offset="100%" stopColor="#0891b2" />
        </linearGradient>
      </defs>
      <path
        d="M17.2 4.6A9 9 0 1 0 17.2 19.4"
        fill="none"
        stroke="url(#ca-c)"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
      <path d="M9.6 9.1 15.9 14.9" stroke="url(#ca-c)" strokeWidth="2.2" strokeLinecap="round" opacity="0.75" />
    </svg>
  )
}

export function CryptoricMarkLarge({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="ca-c-lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#a5f3fc" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <path
        d="M17.2 4.6A9 9 0 1 0 17.2 19.4"
        fill="none"
        stroke="url(#ca-c-lg)"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path d="M9.6 9.1 15.9 14.9" stroke="url(#ca-c-lg)" strokeWidth="2.1" strokeLinecap="round" opacity="0.8" />
    </svg>
  )
}

// ------------------------------------------------------------------- icons

export type IconName =
  | 'home'
  | 'files'
  | 'agent'
  | 'tasks'
  | 'search'
  | 'environment'
  | 'settings'
  | 'terminal'
  | 'branch'
  | 'chevron'
  | 'check'
  | 'close'
  | 'sparkle'
  | 'coin'

const ICON_PATHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M3.5 10.4 12 3.6l8.5 6.8V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1z" />
    </>
  ),
  files: (
    <>
      <path d="M3.5 6.2a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2h8a1.5 1.5 0 0 1 1.5 1.5v10.4a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
    </>
  ),
  agent: (
    <>
      <path d="M12 3.6 14.1 9.2 19.6 11.3 14.1 13.4 12 19 9.9 13.4 4.4 11.3 9.9 9.2z" />
    </>
  ),
  tasks: (
    <>
      <path d="M4 7h10M4 12h13M4 17h8" />
      <circle cx="19" cy="17" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.4" />
      <path d="m20 20-4.6-4.6" />
    </>
  ),
  environment: (
    <>
      <rect x="3.5" y="4.5" width="17" height="6" rx="2" />
      <rect x="3.5" y="13.5" width="17" height="6" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  settings: (
    <>
      <path d="M5 7h14M5 12h14M5 17h14" />
      <circle cx="9.5" cy="7" r="2.1" />
      <circle cx="15" cy="12" r="2.1" />
      <circle cx="8" cy="17" r="2.1" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <path d="m7.5 10 2.6 2.4-2.6 2.4M13 15h4" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M7 8.2v7.6M17 11.2c0 3-2.4 4-5 4.6" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  sparkle: <path d="M12 3.5 13.9 9 19.5 11 13.9 13 12 18.5 10.1 13 4.5 11 10.1 9z" />,
  coin: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5v9M14.4 9.4c-.5-.7-1.4-1-2.4-1-1.3 0-2.3.7-2.3 1.7 0 2.4 4.6 1.3 4.6 3.7 0 1.1-1 1.8-2.4 1.8-1.1 0-2-.4-2.5-1.1" />
    </>
  )
}

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

// ------------------------------------------------------------------- atoms

export function Dot({ tone, pulse }: { tone: 'ok' | 'warn' | 'error' | 'accent' | 'idle'; pulse?: boolean }) {
  return <span className="dot" data-tone={tone} data-pulse={pulse ? 'true' : 'false'} />
}

export function Chip({
  tone = 'idle',
  children
}: {
  tone?: 'ok' | 'warn' | 'error' | 'accent' | 'idle'
  children: ReactNode
}) {
  return (
    <span className="chip" data-tone={tone === 'idle' ? undefined : tone}>
      {children}
    </span>
  )
}

export function SectionHead({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-head">
      <span>{children}</span>
      {action}
    </div>
  )
}

export function Button({
  children,
  onClick,
  variant,
  disabled,
  title,
  size,
  style
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  title?: string
  size?: 'lg'
  style?: React.CSSProperties
}) {
  return (
    <button
      className="btn"
      data-variant={variant}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ ...(size === 'lg' ? { height: 40, padding: '0 20px', fontSize: 'var(--t-base)' } : null), ...style }}
    >
      {children}
    </button>
  )
}

// ----------------------------------------------------------------- resizer

export function Resizer({
  axis,
  onDelta,
  onReset
}: {
  axis: 'x' | 'y'
  onDelta: (delta: number) => void
  onReset: () => void
}) {
  const dragging = useRef(false)
  const last = useRef(0)

  return (
    <div
      className="resizer"
      data-axis={axis}
      data-dragging={dragging.current ? 'true' : 'false'}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        dragging.current = true
        last.current = axis === 'x' ? e.clientX : e.clientY
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        const now = axis === 'x' ? e.clientX : e.clientY
        onDelta(now - last.current)
        last.current = now
      }}
      onPointerUp={(e) => {
        dragging.current = false
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') onDelta(-step)
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') onDelta(step)
        if (e.key === 'Home') onReset()
      }}
    />
  )
}

// -------------------------------------------------------------- state dots

/** Map a runtime/workspace state onto a dot tone. */
export type StateLike = ToolInstallState | WorkspaceState | import('@shared/types').TaskStatus

export function toneForInstallState(state: StateLike): 'ok' | 'warn' | 'error' | 'accent' | 'idle' {
  switch (state) {
    case 'present':
    case 'COMPLETED':
      return 'ok'
    case 'mismatched':
    case 'installing':
    case 'RUNNING':
      return 'accent'
    case 'failed':
    case 'ERROR':
      return 'error'
    case 'missing':
      return 'idle'
    case 'ACTIVE':
      return 'accent'
    case 'IDLE':
      return 'idle'
    case 'BUILDING':
    case 'TESTING':
      return 'warn'
    case 'OFFLINE':
    case 'unverified':
      return 'warn'
    default:
      return 'idle'
  }
}