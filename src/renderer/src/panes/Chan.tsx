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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTask, TimelineEntry, WorkspaceState } from '@shared/types'
import { isTerminalTaskStatus } from '@shared/types'
import { MAX_PROMPT_CHARS } from '@shared/limits'
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
  onClearConversation,
  onStop
}: {
  transcript: TranscriptEntry[]
  timeline: TimelineEntry[]
  tasks: AgentTask[]
  /**
   * Counted, not rendered. The cards live in the global overlay so a prompt
   * raised from any pane is visible; see `components/ApprovalPrompt.tsx`.
   */
  approvals: { id: string; toolId: string; title: string; detail: string; risk: string }[]
  workspaceState: WorkspaceState
  onSubmit: (prompt: string) => void
  onClearConversation: () => void
  onStop: (taskId: string) => void
}) {
  const activeTask = tasks.find((t) => !isTerminalTaskStatus(t.status)) ?? null
  const idle = !activeTask && transcript.length === 0 && approvals.length === 0

  return (
    <div className="surface">
      {/* A running agent must always be stoppable. The control appears only
          while a task is live, so it never sits there inviting a click that
          would do nothing. */}
      {activeTask && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 24px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--surface-1)'
          }}
        >
          <span className="caption" style={{ flex: 1 }}>
            {activeTask.status === 'CANCELLING' ? 'Cancelling' : `Running — ${activeTask.status.toLowerCase()}`}
          </span>
          <Button
            variant="ghost"
            // Disabled once cancelling, so a second click cannot be read as a
            // request that has not taken effect yet.
            disabled={activeTask.status === 'CANCELLING'}
            onClick={() => onStop(activeTask.id)}
          >
            {activeTask.status === 'CANCELLING' ? 'Stopping' : 'Stop'}
          </Button>
        </div>
      )}
      {idle ? (
        <ChanIdle onSubmit={onSubmit} workspaceState={workspaceState} />
      ) : (
        <>
          <ChanConversation
            transcript={transcript}
            approvalCount={approvals.length}
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

        <PromptComposer onSubmit={onSubmit} />

        <ul
          style={{
            listStyle: 'none',
            margin: '18px 0 0',
            padding: 0,
            display: 'grid',
            gap: 9,
            width: 'min(760px, 88vw)'
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

const COMPOSER_MAX_HEIGHT = 420

/**
 * The prompt composer.
 *
 * This was a single-line `<input>`, which is wrong in two independent ways for
 * the thing people actually do here, which is paste:
 *
 *  1. **Chromium strips newlines when pasting into an `<input>`.** A pasted
 *     stack trace, diff or config file silently arrived as one long line, so the
 *     agent was asked something different from what was on the clipboard. That
 *     is data loss at the moment of asking, which is the worst place to lose it.
 *  2. **A fixed 42px strip cannot show what you pasted.** Even with the
 *     newlines kept, a big prompt scrolled horizontally inside one line.
 *
 * So it is an auto-growing `<textarea>`: newlines survive, the box expands with
 * the content up to a cap and then scrolls, and the live character counter is
 * read from the same constant the IPC schema enforces — so the limit is visible
 * *before* submission instead of arriving afterwards as a rejected argument.
 */
export function PromptComposer({ onSubmit }: { onSubmit: (p: string) => void }) {
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback((): void => {
    const el = ref.current
    if (!el) return
    // Height has to be collapsed before `scrollHeight` is re-read, or the box
    // can only ever grow and never shrink when text is deleted.
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
  }, [])

  useEffect(resize, [draft, resize])

  const over = draft.length > MAX_PROMPT_CHARS
  const send = (): void => {
    const text = draft.trim()
    if (!text || over) return
    setDraft('')
    onSubmit(text)
  }

  return (
    <div style={{ display: 'grid', gap: 7, width: 'min(760px, 88vw)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={ref}
          className="field"
          rows={1}
          placeholder="Describe what you want to build — paste code, logs or a whole file straight in."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line. Holding Shift is the
            // universal "I mean a newline here", and a textarea makes that
            // possible at all — an `<input>` cannot represent the distinction.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          aria-label="Ask Cryptoric Chan"
          style={{
            flex: 1,
            height: 46,
            minHeight: 46,
            maxHeight: COMPOSER_MAX_HEIGHT,
            // `.field` is built for a 34px single-line control; a textarea needs
            // vertical padding and its own resize handle policy.
            padding: '12px 12px',
            lineHeight: 1.55,
            resize: 'none',
            overflowY: 'auto',
            fontFamily: 'var(--font)',
            fontSize: 'var(--t-sm)'
          }}
        />
        <Button
          variant="primary"
          onClick={send}
          disabled={!draft.trim() || over}
          style={{ height: 46, padding: '0 20px' }}
        >
          Send
        </Button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, paddingLeft: 2 }}>
        <span className="caption">Enter to send · Shift+Enter for a new line</span>
        <span
          className="caption mono"
          // Reported honestly, and only drawn attention to when it is real.
          // A limit that cannot be hit is noise; one that can is shown in red
          // while the user is still editing.
          style={{ color: over ? 'var(--err)' : undefined }}
        >
          {draft.length.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()}
        </span>
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
  approvalCount,
  onClear
}: {
  transcript: TranscriptEntry[]
  /** Count only. The cards themselves render in the global overlay. */
  approvalCount: number
  onClear: () => void
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [transcript.length, approvalCount])

  return (
    <div className="scroll" style={{ padding: '20px 24px', flex: '1 1 0' }}>
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
        // `flex: 0 0 auto` is load-bearing. With the default `flex-shrink: 1`
        // the browser weights shrinkage by flex-basis, so the transcript —
        // thousands of pixels tall — absorbed almost the entire deficit and left
        // this panel 34px tall with its content clipped. It then does not grow
        // or shrink, and takes its content height up to the cap.
        flex: '0 0 auto',
        // A floor, so a short stage list is still readable rather than reduced
        // to a title bar.
        minHeight: 96
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

/**
 * Fold a flat timeline into the fixed stage sequence.
 *
 * Completion is keyed on the stage's `-end` marker, never on "this stage has at
 * least one entry". The old version inferred done-ness from the mere presence of
 * a timeline entry, and the runtime emitted that entry when the stage *began* —
 * so `Implemented changes` showed a green tick while the agent was still inside
 * implementation, and stayed ticked if the stage hung there forever. The tick is
 * a claim about work that finished; it has to be derived from work that finished.
 */
export function groupByStage(timeline: TimelineEntry[], activeTask: AgentTask | null): StageGroup[] {
  const byStage = new Map<StageName, TimelineEntry[]>()
  const relevant = activeTask ? timeline.filter((e) => e.taskId === activeTask.id) : timeline

  for (const entry of relevant) {
    const stage = STAGES.find((s) => entry.stage === s || entry.stage.startsWith(`${s}-`))
    if (!stage) continue
    const list = byStage.get(stage) ?? []
    list.push(entry)
    byStage.set(stage, list)
  }

  return STAGES.map((stage) => {
    const entries = byStage.get(stage) ?? []
    const startedEntry = entries.find((e) => e.stage === `${stage}-start`)
    const endedEntry = entries.find((e) => e.stage === `${stage}-end`)
    const failedEntry = entries.find((e) => e.stage === `${stage}-failed`)

    const started = startedEntry?.at ?? entries[0]?.at ?? null
    const finished = failedEntry?.at ?? endedEntry?.at ?? null
    const hasError = Boolean(failedEntry) || entries.some((e) => e.status === 'error')

    // Started and not finished is the only definition of "active". A stage that
    // never started is pending, and a stage with an end or a failure is done.
    const isActive = Boolean(startedEntry) && !finished

    const status: StageGroup['status'] = hasError
      ? 'error'
      : finished
        ? 'done'
        : isActive
          ? 'active'
          : entries.length > 0
            ? 'done'
            : 'pending'

    return {
      stage,
      label: STAGE_LABEL[stage],
      status,
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