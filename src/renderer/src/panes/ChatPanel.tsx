/**
 * Cryptoric Chan chat panel.
 *
 * The conversation and the activity feed are separate concerns sharing one
 * column: messages explain *what* the agent decided, activity explains *when and
 * in what order* it happened. Merging them into a single chat stream would lose
 * the causality a developer needs when auditing an autonomous run.
 */

import { useEffect, useRef, useState } from 'react'
import type { AgentTask, TimelineEntry, WorkspaceState } from '@shared/types'
import { Chip, EmptyState, MicroLabel, Seal } from '../components/marks'
import type { TranscriptEntry } from '../state/store'

export function ChatPanel({
  transcript,
  approvals,
  timeline,
  tasks,
  workspaceState,
  onSubmit,
  onResolveApproval
}: {
  transcript: TranscriptEntry[]
  approvals: { id: string; title: string; detail: string; risk: string }[]
  timeline: TimelineEntry[]
  tasks: AgentTask[]
  workspaceState: WorkspaceState
  onSubmit: (prompt: string) => void
  onResolveApproval: (id: string, approved: boolean) => void
}) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [transcript.length, approvals.length])

  const activeTask = tasks.find((t) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status))

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onSubmit(text)
  }

  return (
    <section className="chat" aria-label="Cryptoric Chan">
      <div className="pane-header">
        <span className="chat-heading">Cryptoric Chan</span>
        <Seal state={workspaceState} title={`Workspace ${workspaceState}`} />
        <div style={{ flex: 1 }} />
        {activeTask ? <Chip tone="info">{activeTask.status}</Chip> : <Chip tone="neutral">idle</Chip>}
      </div>

      <div className="pane-body" ref={scrollRef} style={{ padding: 'var(--space-4)' }}>
        {transcript.length === 0 ? (
          <EmptyState
            title="Ask me to build…"
            hint="I detect what the project needs, install anything missing, and keep working without restarting this app."
          />
        ) : (
          transcript.map((entry) => (
            <article
              key={entry.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0, 1fr)',
                gap: 'var(--space-3)',
                padding: 'var(--space-2) 0',
                borderBottom: '1px solid var(--hairline)'
              }}
            >
              <span className="data dim" style={{ fontSize: 'var(--text-micro)', paddingTop: 2 }}>
                {entry.at.slice(11, 19)}
              </span>
              <p
                className="selectable"
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  color: entry.kind === 'error' ? 'var(--alert-ember)' : 'var(--ink-primary)'
                }}
              >
                {entry.text}
              </p>
            </article>
          ))
        )}

        {approvals.map((request) => (
          <div
            key={request.id}
            style={{
              marginTop: 'var(--space-4)',
              padding: 'var(--space-4)',
              border: '1px solid var(--accent-sulfur-edge)',
              background: 'var(--accent-sulfur-dim)',
              display: 'grid',
              gap: 'var(--space-3)'
            }}
            role="alertdialog"
            aria-label={request.title}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <Seal state="installing" />
              <span style={{ fontWeight: 600 }}>{request.title}</span>
            </div>
            <pre
              className="data selectable"
              style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--ink-secondary)', maxHeight: 180, overflow: 'auto' }}
            >
              {request.detail}
            </pre>
            <span className="data dim" style={{ fontSize: 'var(--text-micro)' }}>
              {request.risk}
            </span>
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              <button className="btn" data-variant="primary" onClick={() => onResolveApproval(request.id, true)}>
                approve once
              </button>
              <button className="btn" onClick={() => onResolveApproval(request.id, false)}>
                deny
              </button>
            </div>
          </div>
        ))}

        {transcript.length > 0 && <ActivityFeed timeline={timeline} />}
      </div>

      <div
        style={{
          flex: '0 0 auto',
          borderTop: '1px solid var(--hairline)',
          padding: 'var(--space-3)',
          display: 'grid',
          gap: 'var(--space-2)'
        }}
      >
        <textarea
          className="input"
          style={{ height: 54, padding: 'var(--space-2) var(--space-3)', resize: 'none', lineHeight: '1.45' }}
          placeholder="Ask me to build, run, debug or research…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          aria-label="Prompt Cryptoric Chan"
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn" data-variant="primary" onClick={send} disabled={draft.trim().length === 0}>
            send
          </button>
        </div>
      </div>
    </section>
  )
}

/** The most recent activity, inline beneath the conversation. */
function ActivityFeed({ timeline }: { timeline: TimelineEntry[] }) {
  const recent = timeline.slice(-6).reverse()
  if (recent.length === 0) return null
  return (
    <div style={{ marginTop: 'var(--space-5)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        <MicroLabel>activity</MicroLabel>
        <div style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
        {recent.map((entry) => (
          <li
            key={entry.id}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto minmax(0, 1fr) auto',
              alignItems: 'baseline',
              gap: 'var(--space-3)',
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
            <span className="data dim" style={{ fontSize: 'var(--text-micro)' }}>
              {entry.at.slice(11, 19)}
            </span>
            <span className="data selectable" style={{ color: 'var(--ink-secondary)' }}>
              {entry.message}
            </span>
            <span className="micro-label">{entry.role.replace(/_/g, ' ').toLowerCase()}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}