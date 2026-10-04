/**
 * Command palette (Ctrl/Cmd + K).
 *
 * Styled as an operator overlay rather than a search modal: monospace command
 * ids, a grouped result list, and keyboard-first navigation. It controls the
 * whole application, including actions that only exist in the main process
 * (installing a runtime, refreshing the environment, exporting diagnostics).
 */

import { useEffect, useMemo, useRef, useState } from 'react'

export interface Command {
  id: string
  title: string
  hint?: string
  group: string
  keys?: string
  run: () => void | Promise<void>
  /** Only offered when the predicate passes (e.g. a project is open). */
  available?: () => boolean
}

export function CommandPalette({
  commands,
  open,
  onClose
}: {
  commands: Command[]
  open: boolean
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const available = commands.filter((c) => c.available?.() ?? true)
    if (!q) return available.slice(0, 40)
    // Subsequence match so "ri" finds "Refresh environment".
    return available
      .filter((c) => subsequence(`${c.group} ${c.title} ${c.id}`, q))
      .slice(0, 40)
  }, [commands, query])

  useEffect(() => setCursor(0), [query])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const execute = async (command: Command | undefined): Promise<void> => {
    if (!command) return
    onClose()
    await command.run()
  }

  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(7, 8, 10, 0.62)',
        display: 'grid',
        placeItems: 'start center',
        paddingTop: '14vh',
        zIndex: 50
      }}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{
          width: 'min(720px, 90vw)',
          background: 'var(--surface-overlay)',
          border: '1px solid var(--hairline-strong)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--elevation-overlay)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '62vh',
          animation: 'palette-rise 120ms var(--ease-out)'
        }}
      >
        <style>{`@keyframes palette-rise { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }`}</style>

        <input
          autoFocus
          className="input"
          style={{
            height: 42,
            border: 'none',
            borderBottom: '1px solid var(--hairline)',
            borderRadius: 0,
            fontSize: 'var(--text-body)',
            background: 'transparent'
          }}
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(c + 1, filtered.length - 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              void execute(filtered[cursor])
            }
          }}
          aria-label="Command search"
        />

        <div ref={listRef} style={{ overflow: 'auto', padding: 'var(--space-2)' }}>
          {filtered.length === 0 && (
            <div className="empty" style={{ padding: 'var(--space-6)' }}>
              <span className="empty-title">No matching command</span>
            </div>
          )}
          {filtered.map((command, index) => {
            const groupChanged = index === 0 || filtered[index - 1]?.group !== command.group
            return (
              <div key={command.id}>
                {groupChanged && (
                  <div style={{ padding: 'var(--space-3) var(--space-3) var(--space-2)' }}>
                    <span className="micro-label">{command.group}</span>
                  </div>
                )}
                <button
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => void execute(command)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    alignItems: 'center',
                    gap: 'var(--space-4)',
                    width: '100%',
                    padding: 'var(--space-2) var(--space-3)',
                    border: 'none',
                    borderRadius: 'var(--radius-xs)',
                    background: index === cursor ? 'var(--surface-selected)' : 'transparent',
                    color: index === cursor ? 'var(--ink-primary)' : 'var(--ink-secondary)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    font: 'inherit'
                  }}
                >
                  <span style={{ display: 'grid', minWidth: 0 }}>
                    <span style={{ fontSize: 'var(--text-body)' }}>{command.title}</span>
                    {command.hint && (
                      <span className="ledger-meta" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {command.hint}
                      </span>
                    )}
                  </span>
                  {command.keys && <span className="micro-label">{command.keys}</span>}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Fuzzy subsequence match: every query character appears in order. */
export function subsequence(haystack: string, needle: string): boolean {
  let i = 0
  for (const char of needle) {
    i = haystack.indexOf(char, i)
    if (i === -1) return false
    i += 1
  }
  return true
}