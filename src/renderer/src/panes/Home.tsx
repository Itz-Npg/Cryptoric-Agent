/**
 * Home.
 *
 * The first screen. When no project is open this is a calm, centred prompt —
 * not a dashboard, and deliberately not an inventory of runtimes. The Runtime
 * Manager exists for that, one click away.
 *
 * The four suggestions below are wired to real submissions, not decoration.
 */

import { useEffect, useRef, useState } from 'react'
import type { ProjectProfile } from '@shared/types'
import { Button, CryptoricMarkLarge, Dot } from '../components/primitives'

const SUGGESTIONS = [
  { key: 'build', label: 'Build something', prompt: 'Build a new project here and get it running.' },
  { key: 'fix', label: 'Fix a bug', prompt: 'Find and fix the failing tests in this project.' },
  { key: 'explore', label: 'Explore a project', prompt: 'Analyse this project and explain how it is structured.' },
  { key: 'run', label: 'Run & debug', prompt: 'Run this project, find what breaks, and fix it.' }
] as const

export function HomeSurface({
  project,
  ready,
  onSubmit,
  onOpenProject
}: {
  project: ProjectProfile | null
  ready: boolean
  onSubmit: (prompt: string) => void
  onOpenProject: () => void
}) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [project])

  const send = (prompt: string): void => {
    const text = prompt.trim()
    if (!text || !ready) return
    setDraft('')
    onSubmit(text)
  }

  return (
    <div className="empty-view" style={{ gap: 0 }}>
      <div style={{ display: 'grid', justifyItems: 'center', gap: 18, paddingTop: '2vh' }}>
        <CryptoricMarkLarge size={56} />

        <div style={{ textAlign: 'center', display: 'grid', gap: 10 }}>
          <h1 className="title-lg">What are we building?</h1>
          <p className="subtitle" style={{ maxWidth: '48ch', margin: 0 }}>
            Tell Cryptoric Chan what you want to create, modify, debug or understand.
          </p>
        </div>

        <div
          style={{
            width: 'min(640px, 82vw)',
            display: 'flex',
            gap: 8,
            padding: 6,
            borderRadius: 'var(--r-lg)',
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            boxShadow: 'var(--elev-2)'
          }}
        >
          <input
            ref={inputRef}
            className="field"
            style={{ flex: 1, height: 42, background: 'transparent', border: 'none' }}
            placeholder="Describe what you want to build..."
            value={draft}
            disabled={!ready}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send(draft)
            }}
            aria-label="Describe what you want to build"
          />
          <Button variant="primary" onClick={() => send(draft)} disabled={!ready || !draft.trim()} style={{ height: 42, padding: '0 20px' }}>
            {ready ? 'Send' : 'No project'}
          </Button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s.key}
              className="btn"
              onClick={() => send(s.prompt)}
              disabled={!ready}
              title={s.prompt}
            >
              {s.label}
            </button>
          ))}
        </div>

        {!ready && (
          <div style={{ display: 'grid', justifyItems: 'center', gap: 14, marginTop: 26 }}>
            <Button onClick={onOpenProject}>Open a project</Button>
            <span className="caption">Cryptoric scopes everything it does to the open project.</span>
          </div>
        )}
      </div>
    </div>
  )
}

export function ReadyDot({ ready }: { ready: boolean }) {
  return <Dot tone={ready ? 'ok' : 'idle'} />
}