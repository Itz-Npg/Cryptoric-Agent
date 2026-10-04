/**
 * Command palette (Ctrl/Cmd + K).
 *
 * A calm overlay rather than a search modal: one field, ranked results, no
 * decorative chrome. It drives the whole application, including actions that
 * only exist in the main process (installing a runtime, refreshing the
 * environment, exporting diagnostics).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyScore } from '../../../shared/fuzzy'

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
    const available = commands.filter((c) => c.available?.() ?? true)
    const q = query.trim()
    if (!q) return available.slice(0, 40)
    // Ranked subsequence match so "ri" finds "Refresh environment" and "open"
    // finds "Open project", with the strongest candidate on top.
    return available
      .map((command) => ({
        command,
        score: Math.max(
          fuzzyScore(command.title, q),
          fuzzyScore(`${command.group} ${command.title}`, q) - 2
        )
      }))
      .filter((hit) => hit.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((hit) => hit.command)
  }, [commands, query])

  useEffect(() => setCursor(0), [query])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  const execute = async (command: Command | undefined): Promise<void> => {
    if (!command) return
    onClose()
    await command.run()
  }

  if (!open) return null

  return (
    <div className="palette-scrim" role="presentation" onClick={onClose}>
      <div
        className="palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="palette-input"
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

        <div ref={listRef} className="palette-list scroll">
          {filtered.length === 0 && (
            <div className="empty-view" style={{ height: 'auto', padding: '30px 20px' }}>
              <span className="subtitle">No matching command</span>
            </div>
          )}

          {filtered.map((command, index) => {
            const groupChanged = index === 0 || filtered[index - 1]?.group !== command.group
            const active = index === cursor
            return (
              <div key={command.id}>
                {groupChanged && (
                  <div className="palette-group">
                    <span>{command.group}</span>
                  </div>
                )}
                <button
                  className="palette-item"
                  data-active={active ? 'true' : undefined}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => void execute(command)}
                >
                  <span className="palette-item-label">
                    <span className="truncate">{command.title}</span>
                    {command.hint && <span className="palette-item-hint truncate">{command.hint}</span>}
                  </span>
                  {command.keys && <span className="kbd">{command.keys}</span>}
                </button>
              </div>
            )
          })}
        </div>

        <div className="palette-foot">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> to navigate
          </span>
          <span>
            <span className="kbd">↵</span> to run
          </span>
          <span>
            <span className="kbd">esc</span> to dismiss
          </span>
        </div>
      </div>
    </div>
  )
}