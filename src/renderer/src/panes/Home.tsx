/**
 * Home.
 *
 * The first screen, and the one the app opens on. It is two things, in this
 * order of importance:
 *
 *  1. **A prompt.** The question, the field to answer it in, and four real
 *     suggestions wired to actual submissions rather than decoration.
 *  2. **The history you already have.** A conversation that disappears when you
 *     leave the pane is a conversation you have to remember the path back to.
 *     The recent projects and the last few turns of the open one are shown here,
 *     from the same store the chat reads, so the first page and the chat are
 *     looking at one history rather than two.
 *
 * Deliberately not a dashboard, and deliberately not an inventory of runtimes —
 * the Runtime Manager exists for that, one click away.
 */

import { useEffect, useMemo, useRef } from 'react'
import type { ProjectProfile } from '@shared/types'
import type { RecentProject } from '../../../preload'
import { Button, CryptoricMarkLarge, Dot, SectionHead } from '../components/primitives'
import { AgentPromptBar } from '../components/AgentPromptBar'
import type { ModelSummary } from './ModelPicker'
import type { TranscriptEntry } from '../state/store'

const SUGGESTIONS = [
  { key: 'build', label: 'Build something', prompt: 'Build a new project here and get it running.' },
  { key: 'fix', label: 'Fix a bug', prompt: 'Find and fix the failing tests in this project.' },
  { key: 'explore', label: 'Explore a project', prompt: 'Analyse this project and explain how it is structured.' },
  { key: 'run', label: 'Run & debug', prompt: 'Run this project, find what breaks, and fix it.' }
] as const

/** Turns of the open project shown as "pick up where you left off". */
const HISTORY_TURNS = 3

/**
 * A short, honest age.
 *
 * Rounded rather than precise: "2d ago" answers the question a person is asking
 * of a history list, and an exact timestamp makes them do the arithmetic.
 */
function when(iso: string, now = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 90) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(at).toLocaleDateString()
}

export function HomeSurface({
  project,
  ready,
  models,
  onSelectModel,
  onSubmit,
  onOpenProject,
  onOpenRecent,
  recentProjects,
  transcript,
  busy
}: {
  project: ProjectProfile | null
  ready: boolean
  models: ModelSummary[]
  onSelectModel: (id: string) => void
  onSubmit: (prompt: string) => void
  onOpenProject: () => void
  onOpenRecent: (root: string) => void
  recentProjects: RecentProject[]
  transcript: TranscriptEntry[]
  busy: boolean
}) {
  const markRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    markRef.current?.scrollIntoView({ block: 'nearest' })
  }, [project])

  const send = (prompt: string): void => {
    const text = prompt.trim()
    if (!text || !ready) return
    onSubmit(text)
  }

  // Only the developer's own turns. An assistant reply on the first page is the
  // chat, and duplicating the chat here would make this screen a worse chat.
  const recentTurns = useMemo(
    () => transcript.filter((entry) => entry.role === 'YOU').slice(-HISTORY_TURNS),
    [transcript]
  )
  const otherProjects = recentProjects.filter((p) => p.root !== project?.root)
  const hasHistory = recentTurns.length > 0 || otherProjects.length > 0

  return (
    <div className="empty-view" style={{ gap: 0 }}>
      <div
        ref={markRef}
        style={{ display: 'grid', justifyItems: 'center', gap: 18, paddingTop: '2vh', width: 'min(860px, 92vw)' }}
      >
        <CryptoricMarkLarge size={56} />

        <div style={{ textAlign: 'center', display: 'grid', gap: 10 }}>
          <h1 className="title-lg">What are we building?</h1>
          <p className="subtitle" style={{ maxWidth: '48ch', margin: 0 }}>
            Tell Cryptoric Chan what you want to create, modify, debug or understand.
          </p>
        </div>

        <AgentPromptBar
          project={project}
          models={models}
          onSelectModel={onSelectModel}
          busy={busy}
          onSubmit={send}
          width={640}
          maxRows={5}
        />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
          {SUGGESTIONS.map((s) => (
            <button key={s.key} className="btn" onClick={() => send(s.prompt)} disabled={!ready} title={s.prompt}>
              {s.label}
            </button>
          ))}
        </div>

        {!ready && (
          <div style={{ display: 'grid', justifyItems: 'center', gap: 14, marginTop: 10 }}>
            <Button onClick={onOpenProject}>Open a project</Button>
            <span className="caption">Cryptoric scopes everything it does to the open project.</span>
          </div>
        )}

        {hasHistory && (
          <div style={{ display: 'grid', gap: 14, width: 'min(640px, 82vw)', marginTop: 26, textAlign: 'left' }}>
            {recentTurns.length > 0 && (
              <div style={{ display: 'grid', gap: 2 }}>
                <SectionHead>Pick up where you left off</SectionHead>
                {recentTurns.map((entry) => (
                  <button
                    key={entry.id}
                    className="row"
                    data-clickable="true"
                    onClick={() => send(entry.text)}
                    title={entry.text}
                  >
                    <span className="truncate" style={{ minWidth: 0, flex: '1 1 auto' }}>
                      {entry.text}
                    </span>
                    <span className="caption mono" style={{ flex: 'none' }}>
                      {when(entry.at)}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {otherProjects.length > 0 && (
              <div style={{ display: 'grid', gap: 2 }}>
                <SectionHead>Recent projects</SectionHead>
                {otherProjects.slice(0, 5).map((p) => (
                  <button
                    key={p.root}
                    className="row"
                    data-clickable="true"
                    onClick={() => onOpenRecent(p.root)}
                    title={p.root}
                  >
                    <span style={{ flex: 'none', fontWeight: 550 }}>{p.name}</span>
                    <span className="caption truncate" style={{ flex: '1 1 auto', minWidth: 0 }}>
                      {p.root}
                    </span>
                    <span className="caption mono" style={{ flex: 'none' }}>
                      {when(p.openedAt)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function ReadyDot({ ready }: { ready: boolean }) {
  return <Dot tone={ready ? 'ok' : 'idle'} />
}
