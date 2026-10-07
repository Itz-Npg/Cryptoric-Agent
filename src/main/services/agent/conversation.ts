/**
 * Conversation persistence.
 *
 * The transcript used to live only in renderer state, which meant a restart
 * erased it and the model had no memory of anything said before. This store is
 * the single owner of that history: the main process appends to it, the renderer
 * reads from it, and both the chat view and the model's context come from the
 * same file.
 *
 * Two properties make it trustworthy:
 *
 *  - **Atomic writes.** A temp file plus rename, so a crash mid-write leaves the
 *    previous transcript intact rather than a truncated file. Losing the last
 *    turn to a crash is worse than losing it to a deliberate clear.
 *  - **A bounded file.** Turns are capped on disk as well as in memory. An agent
 *    session that runs for days must not turn into an unbounded JSON blob that
 *    takes seconds to parse at boot.
 *
 * Tool turns are persisted alongside speech. They are the evidence that the agent
 * did the work rather than claiming to, and hiding them would make the transcript
 * read like a chat log about software instead of a record of it.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConversationTurn } from '@shared/types'

export type TurnRole = ConversationTurn['role']
export type { ConversationTurn }

interface ConversationFile {
  version: 2
  id: string
  updatedAt: string
  /** One entry per project root. `none` is the conversation with nothing open. */
  scopes: Record<string, { turns: ConversationTurn[] }>
}

/** Scope key for "no project open" — its own bucket, not a shared one. */
const NO_SCOPE = 'none'

function scopeKey(projectRoot: string | null): string {
  // Case-insensitive because Windows paths are; without this, opening the same
  // project as `C:\Proj` and `c:\proj` would start a second transcript.
  return projectRoot === null ? NO_SCOPE : projectRoot.toLowerCase()
}

/** Turns retained on disk. Old history is dropped oldest-first. */
const MAX_TURNS = 1000

/**
 * Turns sent to the model as prior context.
 *
 * Tool turns carry no speech of their own, and a `tool` role message is not
 * accepted by every provider in a plain chat completion. So each tool outcome is
 * folded into the assistant turn that reported it — which is also what actually
 * happens: the loop runs the tools, then the model writes about them. When a
 * tool turn is followed by a user turn instead (an interrupted run), its
 * summary is emitted on its own, because leaving it out would lose the only
 * record of what the agent did.
 */
const CONTEXT_TURNS = 60

/**
 * A line that is only separator or heading punctuation.
 *
 * Three characters is the threshold: `###` is a markdown rule, `---` is a setext
 * underline, and none of them is a sentence. The set is deliberately narrow —
 * a line of prose containing `=` must survive, which is why this is anchored to
 * the whole line rather than applied as a substring rule.
 */
const SEPARATOR_LINE = /^[\s=_*~#\-–—·•.]{3,}$/

/**
 * A run of separator characters *inside* a line.
 *
 * Eight or more in a row is not prose — it is a rule someone pasted along with
 * the prompt. This is what turned the task list into `id="qv7k3r" ============`
 * when the title was simply the first sixty characters.
 */
const INLINE_SEPARATOR_RUN = /[=_*~#\-–—]{8,}/g

/** `name="value"` left behind when HTML is pasted as plain text. */
const ATTRIBUTE_SOUP = /\b[a-zA-Z-]{2,20}\s*=\s*"[^"]{0,120}"|\b[a-zA-Z-]{2,20}\s*=\s*'[^']{0,120}'/g

export class ConversationStore {
  private scopes = new Map<string, { turns: ConversationTurn[] }>()
  /** The project the read/write helpers act on. */
  private current: string = NO_SCOPE
  private id: string = randomUUID()
  private readonly file: string
  /** Serialises writes so two appends cannot interleave their read-modify-write. */
  private queue: Promise<void> = Promise.resolve()

  constructor(filePath: string) {
    this.file = filePath
    this.load()
  }

  // ------------------------------------------------------------------- read

  /**
   * Point the store at a project.
   *
   * Called whenever a project is opened, closed or switched. The history is not
   * discarded — each project keeps its own — but the model must not read another
   * project's transcript as if it were its own.
   */
  setProject(projectRoot: string | null): void {
    const next = scopeKey(projectRoot)
    if (next === this.current && this.scopes.has(next)) return
    this.current = next
    if (!this.scopes.has(next)) this.scopes.set(next, { turns: [] })
    this.schedule()
  }

  /** The project this store is currently scoped to, for display. */
  get scope(): string {
    return this.current
  }

  private active(): { turns: ConversationTurn[] } {
    const existing = this.scopes.get(this.current)
    if (existing) return existing
    const created: { turns: ConversationTurn[] } = { turns: [] }
    this.scopes.set(this.current, created)
    return created
  }

  all(): ConversationTurn[] {
    return this.active().turns.map((t) => ({ ...t }))
  }

  /** Roots that have a transcript, for a project switcher. */
  scopesWithHistory(): string[] {
    return [...this.scopes.entries()]
      .filter(([, scope]) => scope.turns.length > 0)
      .map(([key]) => key)
  }

  get conversationId(): string {
    return this.id
  }

  get updatedAt(): string | null {
    const turns = this.active().turns
    return turns.length > 0 ? turns[turns.length - 1]?.at ?? null : null
  }

  /**
   * Prior turns in the shape the model gateway takes, oldest first.
   *
   * Tool turns become `tool` messages, which only some providers accept in a
   * non-streaming request; a turn is therefore only included once its result
   * has been folded into the assistant turn that reported it.
   */
  contextMessages(limit = CONTEXT_TURNS): { role: 'user' | 'assistant'; content: string }[] {
    const window = this.active().turns.slice(-limit)
    const out: { role: 'user' | 'assistant'; content: string }[] = []
    // Tool outcomes waiting for the assistant turn that reports them.
    let pending: string[] = []

    for (const turn of window) {
      if (turn.role === 'tool') {
        pending.push(`[${turn.ok === false ? 'failed' : 'ok'}] ${turn.tool ?? 'tool'}: ${summarise(turn.text)}`)
        continue
      }

      if (turn.role === 'assistant') {
        const prefix = pending.length > 0 ? `${pending.join('\n')}\n` : ''
        pending = []
        out.push({ role: 'assistant', content: prefix + turn.text })
        continue
      }

      // A user turn with unreported tool results behind it: emit them as their
      // own assistant message rather than losing them.
      if (pending.length > 0) {
        out.push({ role: 'assistant', content: pending.join('\n') })
        pending = []
      }
      out.push({ role: 'user', content: turn.text })
    }

    if (pending.length > 0) {
      out.push({ role: 'assistant', content: pending.join('\n') })
    }
    return out
  }

  // ------------------------------------------------------------------ write

  append(turn: Omit<ConversationTurn, 'id' | 'at'> & { at?: string }): ConversationTurn {
    const entry: ConversationTurn = {
      id: randomUUID(),
      at: turn.at ?? new Date().toISOString(),
      role: turn.role,
      text: turn.text,
      ...(turn.tool !== undefined ? { tool: turn.tool } : {}),
      ...(turn.ok !== undefined ? { ok: turn.ok } : {})
    }
    const scope = this.active()
    scope.turns.push(entry)
    if (scope.turns.length > MAX_TURNS) scope.turns = scope.turns.slice(-MAX_TURNS)
    this.schedule()
    return entry
  }

  appendUser(text: string): ConversationTurn {
    return this.append({ role: 'user', text })
  }

  appendAssistant(text: string): ConversationTurn {
    return this.append({ role: 'assistant', text })
  }

  appendTool(tool: string, text: string, ok: boolean): ConversationTurn {
    return this.append({ role: 'tool', tool, text, ok })
  }

  /** Drop this project's history and start a new conversation id. */
  clear(): ConversationTurn[] {
    this.scopes.set(this.current, { turns: [] })
    this.id = randomUUID()
    this.schedule()
    return this.all()
  }

  /** Resolve once every queued write has landed. Used by tests and by quit. */
  async flush(): Promise<void> {
    await this.queue
  }

  // --------------------------------------------------------------- private

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      // A missing transcript is the normal first-run case, not an error.
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ConversationFile>
      if (typeof parsed.id === 'string' && parsed.id) this.id = parsed.id

      if (parsed.version === 2 && parsed.scopes && typeof parsed.scopes === 'object') {
        for (const [key, scope] of Object.entries(parsed.scopes)) {
          const turns = scope?.turns
          if (Array.isArray(turns)) this.scopes.set(key, { turns: turns.filter(isTurn).slice(-MAX_TURNS) })
        }
        return
      }

      // Version 1 was a single unscoped transcript. It becomes the history for
      // whatever project is open at the moment of the upgrade, so nobody loses
      // the conversation they were having.
      const legacyTurns = (parsed as { turns?: unknown }).turns
      if (typeof parsed.version === 'number' && parsed.version < 2 && Array.isArray(legacyTurns)) {
        this.scopes.set(NO_SCOPE, { turns: legacyTurns.filter(isTurn).slice(-MAX_TURNS) })
      }
    } catch {
      // Corrupt JSON must not stop the app from booting. The transcript is
      // derived data; refusing to start because of it would be worse than
      // losing it. It is left on disk untouched so it can be inspected.
      console.warn('[conversation] unreadable transcript, starting empty:', this.file)
    }
  }

  private schedule(): void {
    this.queue = this.queue.then(() => this.writeNow()).catch((err) => {
      console.warn('[conversation] write failed:', err)
    })
  }

  private writeNow(): void {
    const payload: ConversationFile = {
      version: 2,
      id: this.id,
      updatedAt: new Date().toISOString(),
      scopes: Object.fromEntries([...this.scopes.entries()].map(([key, scope]) => [key, { turns: scope.turns }]))
    }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    // Mode 0o600, matching the credential store: transcripts hold whatever the
    // agent read — command output, file contents, sometimes secrets the tools
    // surfaced — and on a multi-user machine the default 0644 would put that
    // in reach of every local account. `rename` preserves the tmp file's mode,
    // so the permission survives the atomic swap.
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

function isTurn(value: unknown): value is ConversationTurn {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Partial<ConversationTurn>
  return (
    typeof t.id === 'string' &&
    typeof t.at === 'string' &&
    typeof t.text === 'string' &&
    (t.role === 'user' || t.role === 'assistant' || t.role === 'tool')
  )
}

/** One line, bounded, for folding a tool result into model context. */
function summarise(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * Turn a raw prompt into a task title.
 *
 * `prompt.slice(0, 60)` is what put a run of `=` and a fragment of pasted HTML
 * in the task list. Pasted content carries structure that is not prose —
 * separator rules, code fences, attribute soup — and none of it belongs in a
 * one-line label. This keeps the first genuine sentence, collapses whitespace,
 * and falls back to a neutral label when the prompt is all structure.
 */
export function deriveTitle(prompt: string, limit = 72): string {
  const cleaned = prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(ATTRIBUTE_SOUP, ' ')
    .replace(INLINE_SEPARATOR_RUN, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !SEPARATOR_LINE.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleaned.length === 0) return 'Untitled task'
  if (cleaned.length <= limit) return cleaned

  // Cut at a word boundary so the title does not end mid-word.
  const cut = cleaned.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}