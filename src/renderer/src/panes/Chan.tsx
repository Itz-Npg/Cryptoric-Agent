/**
 * Cryptoric Chan.
 *
 * Two states, one surface:
 *
 *  - **Idle** — a calm assistant surface. A single input, nothing else.
 *  - **Working** — an execution timeline of concrete stages. Each completed stage
 *    is expandable and reveals what actually happened: files inspected, commands
 *    run, files changed, output, errors and timing.
 *
 * The timeline reports *actions*, never reasoning. There is no hidden
 * chain-of-thought in the product, and the UI does not pretend otherwise — what
 * is shown is what the agent did and what it observed.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTask, TimelineEntry, WorkspaceState } from '@shared/types'
import { Button, Chip, Dot, Icon, SectionHead, type IconName } from '../components/primitives'
import type { TranscriptEntry } from '../state/store'

/** Stages the pipeline runs, in order, with the state each is in. */
const STAGES = [
  'analyze',
  'plan',
  'implement',
  'verify',
  'review'
] as const

type StageName = (typeof STAGES)[number]

const STAGE_LABEL: Record<StageName, string> = {
  analyze: 'Analyzed project',
  plan: 'Planned the work',
  implement: 'Implemented changes',
  verify: 'Ran tests and verified',
  review: 'Reviewed the result'
}

export function ChanPanel({
  transcript,
  timeline,
  tasks,
  approvals,
  workspaceState,
  onSubmit,
  onResolveApproval,
  onClearConversation
}: {
  transcript: TranscriptEntry[]
  timeline: TimelineEntry[]
  tasks: AgentTask[]
  approvals: { id: string; toolId: string; title: string; detail: string; risk: string }[]
  workspaceState: WorkspaceState
  onSubmit: (prompt: string) => void
  onResolveApproval: (id: string, approved: boolean, remember?: boolean, toolId?: string) => void
  onClearConversation: () => void
}) {
  const activeTask = tasks.find((t) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status)) ?? null
  const idle = !activeTask && transcript.length === 0 && approvals.length === 0

  return (
    <div className="surface">
      {idle ? (
        <ChanIdle onSubmit={onSubmit} workspaceState={workspaceState} />
      ) : (
        <>
          <ChanConversation
            transcript={transcript}
            approvals={approvals}
            onResolveApproval={onResolveApproval}
            onClear={onClearConversation}
          />
          <ChanTimeline timeline={timeline} activeTask={activeTask} />
        </>
      )}
    </div>
  )
}

// -------------------------------------------------------------------- idle

function ChanIdle({ onSubmit, workspaceState }: { onSubmit: (p: string) => void; workspaceState: WorkspaceState }) {
  const [draft, setDraft] = useState('')
  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onSubmit(text)
  }

  return (
    <div className="empty-view" style={{ gap: 0 }}>
      <div style={{ display: 'grid', justifyItems: 'center', gap: 16, paddingTop: '3vh' }}>
        <div style={{ display: 'grid', justifyItems: 'center', gap: 10 }}>
          <Dot tone={workspaceState === 'ERROR' ? 'error' : 'ok'} pulse={false} />
          <h2 className="title">Cryptoric Chan</h2>
          <p className="subtitle" style={{ maxWidth: '46ch', margin: 0 }}>
            Ask me to build, change, debug or explain something. Everything I do is shown as an expandable
            list of actions — never hidden deliberation.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, width: 'min(560px, 78vw)' }}>
          <input
            className="field"
            style={{ flex: 1, height: 42 }}
            placeholder="Describe what you want to build…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send()
            }}
            aria-label="Ask Cryptoric Chan"
          />
          <Button variant="primary" onClick={send} disabled={!draft.trim()} style={{ height: 42, padding: '0 20px' }}>
            Send
          </Button>
        </div>

        <ul
          style={{
            listStyle: 'none',
            margin: '18px 0 0',
            padding: 0,
            display: 'grid',
            gap: 9,
            width: 'min(560px, 78vw)'
          }}
        >
          {CAPABILITIES.map((item) => (
            <li key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <span style={{ color: 'var(--text-3)', display: 'inline-flex' }}>
                <Icon name={item.icon} size={16} />
              </span>
              <span style={{ fontWeight: 550 }}>{item.label}</span>
              <span className="caption truncate">{item.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

const CAPABILITIES: { icon: IconName; label: string; detail: string }[] = [
  { icon: 'environment', label: 'Detects runtimes', detail: 'reads what the project actually needs' },
  { icon: 'check', label: 'Installs what is missing', detail: 'verified, without restarting Cryptoric' },
  { icon: 'tasks', label: 'Runs the work', detail: 'each step expandable, with output and timing' }
]

// ------------------------------------------------------------ conversation

function ChanConversation({
  transcript,
  approvals,
  onResolveApproval,
  onClear
}: {
  transcript: TranscriptEntry[]
  approvals: { id: string; toolId: string; title: string; detail: string; risk: string }[]
  onResolveApproval: (id: string, approved: boolean, remember?: boolean, toolId?: string) => void
  onClear: () => void
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [transcript.length, approvals.length])

  return (
    <div className="scroll" style={{ padding: '20px 24px' }}>
      {/* The history is on disk and survives restarts, so it needs a way out.
          Hidden until there is something to clear, and confirmed before it
          discards: the transcript is the only record of what the agent did. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        {transcript.length > 0 && (
          <Button
            onClick={() => {
              if (typeof window !== 'undefined' && window.confirm('Clear this conversation history? This cannot be undone.')) {
                onClear()
              }
            }}
          >
            Clear history
          </Button>
        )}
      </div>

      {transcript.map((entry) => (
        <ConversationRow key={entry.id} entry={entry} />
      ))}

      {approvals.map((request) => (
        <div
          key={request.id}
          className="card"
          style={{ marginTop: 16, borderColor: 'var(--accent-line)' }}
          role="alertdialog"
          aria-label={request.title}
        >
          <div className="card-pad" style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <Dot tone="accent" pulse />
              <span style={{ fontWeight: 600 }}>{request.title}</span>
            </div>
            <pre
              className="mono selectable"
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                color: 'var(--text-2)',
                maxHeight: 200,
                overflow: 'auto',
                fontSize: 'var(--t-xs)'
              }}
            >
              {request.detail}
            </pre>
            <span className="caption">{request.risk}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" onClick={() => onResolveApproval(request.id, true)}>
                Approve once
              </Button>
              {/* Granting for the session is the difference between one prompt
                  and one prompt per file when the agent is doing a real job. */}
              <Button onClick={() => onResolveApproval(request.id, true, true, request.toolId)}>
                Allow for this session
              </Button>
              <Button onClick={() => onResolveApproval(request.id, false)}>Deny</Button>
            </div>
          </div>
        </div>
      ))}

      <div ref={endRef} />
    </div>
  )
}

/**
 * One transcript row.
 *
 * Three weights, matching the three things that actually happened: the
 * developer asked, the agent did something, the agent said what it did. Tool
 * rows are deliberately small — the execution timeline below carries the detail,
 * and duplicating it here would bury the reply.
 */
function ConversationRow({ entry }: { entry: TranscriptEntry }) {
  const time = (
    <span className="caption mono" style={{ fontSize: 'var(--t-xs)' }}>
      {entry.at.slice(11, 16)}
    </span>
  )

  if (entry.role === 'TOOL') {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto auto minmax(0, 1fr) auto',
          gap: 8,
          alignItems: 'baseline',
          padding: '5px 0'
        }}
      >
        <Dot tone={entry.kind === 'error' ? 'error' : 'ok'} pulse={false} />
        <span className="caption mono" style={{ fontSize: 'var(--t-xs)' }}>
          {entry.text.split('\n')[0]}
        </span>
        <span style={{ minWidth: 0 }} />
        {time}
      </div>
    )
  }

  const mine = entry.role === 'YOU'
  return (
    <div
      style={{
        display: 'grid',
        gap: 6,
        padding: '14px 0',
        borderTop: '1px solid var(--line)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Dot tone={entry.kind === 'error' ? 'error' : mine ? 'idle' : 'accent'} pulse={false} />
        <span className="caption">{mine ? 'You' : 'Cryptoric Chan'}</span>
        <div style={{ flex: 1 }} />
        {time}
      </div>
      <p
        className="selectable"
        style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          color: entry.kind === 'error' ? 'var(--err)' : mine ? 'var(--text-2)' : 'var(--text-1)',
          lineHeight: 1.6
        }}
      >
        {entry.text}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- timeline

function ChanTimeline({ timeline, activeTask }: { timeline: TimelineEntry[]; activeTask: AgentTask | null }) {
  const grouped = useMemo(() => groupByStage(timeline, activeTask), [timeline, activeTask])
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div
      style={{
        borderTop: '1px solid var(--line)',
        background: 'var(--surface-1)',
        maxHeight: '46%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0
      }}
    >
      <div style={{ padding: '14px 24px 10px' }}>
        <SectionHead>Execution</SectionHead>
      </div>
      <div className="scroll" style={{ padding: '0 24px 20px' }}>
        {grouped.map((group) => (
          <StageRow
            key={group.stage}
            group={group}
            open={open === group.stage}
            onToggle={() => setOpen((c) => (c === group.stage ? null : group.stage))}
          />
        ))}
      </div>
    </div>
  )
}

interface StageGroup {
  stage: StageName
  label: string
  status: 'done' | 'active' | 'pending' | 'error'
  startedAt: string | null
  finishedAt: string | null
  entries: TimelineEntry[]
  /** Counted facts shown in the collapsed row. */
  filesInspected: number
  commandsRun: number
  filesChanged: number
}

function StageRow({ group, open, onToggle }: { group: StageGroup; open: boolean; onToggle: () => void }) {
  const icon =
    group.status === 'done' ? (
      <Icon name="check" size={15} />
    ) : group.status === 'error' ? (
      <Icon name="close" size={15} />
    ) : group.status === 'active' ? (
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: '50%',
          border: '2px solid var(--accent)',
          borderTopColor: 'transparent',
          animation: 'spin 720ms linear infinite'
        }}
      />
    ) : (
      <span style={{ width: 11, height: 11, borderRadius: '50%', border: '1.5px solid var(--text-3)' }} />
    )

  return (
    <div style={{ borderTop: '1px solid var(--line)' }}>
      <div
        className="row"
        data-clickable="true"
        onClick={onToggle}
        style={{
          borderRadius: 0,
          padding: '0 4px',
          color:
            group.status === 'pending' ? 'var(--text-3)' : group.status === 'error' ? 'var(--err)' : 'var(--text-1)'
        }}
      >
        <span
          style={{
            width: 20,
            display: 'inline-flex',
            justifyContent: 'center',
            color:
              group.status === 'done'
                ? 'var(--ok)'
                : group.status === 'active'
                  ? 'var(--accent)'
                  : group.status === 'error'
                    ? 'var(--err)'
                    : 'var(--text-3)'
          }}
        >
          {icon}
        </span>
        <span className="row-label" style={{ fontWeight: 500 }}>
          {group.label}
        </span>

        {group.startedAt && group.finishedAt && (
          <span className="caption mono" style={{ fontSize: 'var(--t-xs)' }}>
            {Math.max(0, Date.parse(group.finishedAt) - Date.parse(group.startedAt))} ms
          </span>
        )}

        <span
          style={{
            color: 'var(--text-3)',
            display: 'inline-flex',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform var(--t-fast) var(--ease)'
          }}
        >
          <Icon name="chevron" size={13} />
        </span>
      </div>

      {open && (
        <div style={{ padding: '4px 4px 16px 28px', display: 'grid', gap: 8, animation: 'chan-expand var(--t-base) var(--ease)' }}>
          <style>{`@keyframes chan-expand { from { opacity: 0; transform: translateY(-3px) } to { opacity: 1; transform: none } }`}</style>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Chip tone="idle">{group.entries.length} action(s)</Chip>
            {group.filesInspected > 0 && <Chip tone="idle">{group.filesInspected} file(s) inspected</Chip>}
            {group.commandsRun > 0 && <Chip tone="idle">{group.commandsRun} command(s)</Chip>}
            {group.filesChanged > 0 && <Chip tone="accent">{group.filesChanged} file(s) changed</Chip>}
          </div>
          {group.entries.map((entry) => (
            <div key={entry.id} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 9, alignItems: 'baseline' }}>
              <span className="caption mono" style={{ fontSize: 'var(--t-xs)' }}>
                {entry.at.slice(11, 19)}
              </span>
              <span
                className="mono selectable"
                style={{
                  fontSize: 'var(--t-xs)',
                  color: entry.status === 'error' ? 'var(--err)' : 'var(--text-2)',
                  wordBreak: 'break-word'
                }}
              >
                {entry.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Fold a flat timeline into the fixed stage sequence. */
export function groupByStage(timeline: TimelineEntry[], activeTask: AgentTask | null): StageGroup[] {
  const byStage = new Map<StageName, TimelineEntry[]>()
  const relevant = activeTask ? timeline.filter((e) => e.taskId === activeTask.id) : timeline

  for (const entry of relevant) {
    const stage = STAGES.find((s) => entry.stage === s || entry.stage.startsWith(`${s}-`) || entry.stage === `${s}`)
    if (!stage) continue
    const list = byStage.get(stage) ?? []
    list.push(entry)
    byStage.set(stage, list)
  }

  const firstSeen = STAGES.findIndex((s) => byStage.has(s))
  const activeIndex = activeTask
    ? STAGES.findIndex((s) => byStage.has(s) && byStage.get(s)?.some((e) => e.status === 'pending'))
    : -1

  return STAGES.map((stage, index) => {
    const entries = byStage.get(stage) ?? []
    const hasError = entries.some((e) => e.status === 'error')
    const isActive = index === activeIndex || (activeTask && entries.some((e) => e.status === 'pending') && index === (firstSeen < 0 ? 0 : firstSeen + 1))
    const started = entries[0]?.at ?? null
    const finished = entries.length > 0 ? (entries[entries.length - 1] as TimelineEntry).at : null

    return {
      stage,
      label: STAGE_LABEL[stage],
      status: hasError ? 'error' : isActive ? 'active' : entries.length > 0 ? 'done' : 'pending',
      startedAt: started,
      finishedAt: finished,
      entries,
      filesInspected: countMatching(entries, /(inspect|read|tree|detect)/i),
      commandsRun: countMatching(entries, /(command|terminal|exec|process|test|build)/i),
      filesChanged: countMatching(entries, /(edit|wrote|write|changed|patch)/i)
    }
  })
}

function countMatching(entries: TimelineEntry[], pattern: RegExp): number {
  return entries.filter((e) => pattern.test(`${e.stage} ${e.message}`)).length
}