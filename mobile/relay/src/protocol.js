/**
 * The relay's task bookkeeping and the wire format shared with the phone.
 *
 * Split from the socket handling so the protocol is testable without opening a
 * port. A relay that can only be tested by connecting a real client is a relay
 * whose wire bugs are found on a phone.
 *
 * The field names here are a contract with `mobile/ios/Sources/CryptoricKit/RelayProtocol.swift`.
 * Both sides are unit tested against it; renaming a field on one side only is
 * the classic way a companion silently shows nothing.
 *
 * ES modules, because the repository's `package.json` sets `"type": "module"`.
 * A `require` here fails at import time with an error about module scope,
 * which reads like a Node version problem rather than a file-extension one.
 */

/**
 * Statuses the desktop can report.
 *
 * `blocked` is deliberately a first-class value rather than a flavour of
 * failure. This project has shipped "stopped without doing the work" twice, and
 * a companion that renders it as an error loses the distinction that matters.
 */
export const STATUSES = Object.freeze([
  'queued',
  'planning',
  'implementing',
  'verifying',
  'completed',
  'failed',
  'blocked',
  'cancelled'
])

/**
 * What an unknown status decodes to.
 *
 * `blocked` and never `completed`. A newer desktop build reporting a status
 * this build has not heard of must not be shown to the user as a success; the
 * safe reading is "it stopped, and we do not know how".
 */
export const UNKNOWN_STATUS = 'blocked'

export function isTerminal(status) {
  return ['completed', 'failed', 'blocked', 'cancelled'].includes(status)
}

export function isSuccess(status) {
  return status === 'completed'
}

/**
 * Normalise one task coming off the wire.
 *
 * Tolerant on the way in and strict on the way out: unknown statuses degrade,
 * missing fields become empty, but nothing is invented.
 */
export function normaliseTask(raw) {
  const status = STATUSES.includes(raw?.status) ? raw.status : UNKNOWN_STATUS
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? ''),
    status,
    stage: String(raw?.stage ?? ''),
    lastNote: String(raw?.lastNote ?? ''),
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
    changedPaths: Array.isArray(raw?.changedPaths) ? raw.changedPaths.map(String) : []
  }
}

/**
 * Holds the current task list and fans changes out to subscribers.
 *
 * No socket, no timer, no I/O: `RelayState` is the part worth testing, and
 * `serve` is the part that merely wires it to a server.
 */
export class RelayState {
  #tasks = new Map()
  #subscribers = new Set()
  #followUps = []

  /** Replace the whole list. Used by a `refresh` and by a full sync. */
  replace(tasks) {
    this.#tasks = new Map(
      (Array.isArray(tasks) ? tasks : []).map((raw) => {
        const task = normaliseTask(raw)
        return [task.id, task]
      })
    )
    this.#emit()
    return this.snapshot()
  }

  /** Insert or update one task. */
  upsert(raw) {
    const task = normaliseTask(raw)
    if (!task.id) return null
    const existing = this.#tasks.get(task.id)
    // A stale update must not overwrite a newer one. Reordered messages are
    // normal on a relay, and letting an old "queued" land after "completed"
    // would make a finished task look like it restarted itself.
    if (existing && new Date(existing.updatedAt) > new Date(task.updatedAt)) {
      return existing
    }
    this.#tasks.set(task.id, task)
    this.#emit()
    return task
  }

  get(id) {
    return this.#tasks.get(id) ?? null
  }

  snapshot() {
    return {
      tasks: [...this.#tasks.values()],
      generatedAt: new Date().toISOString()
    }
  }

  /** Tasks that stopped without completing. Never rendered as success. */
  needsAttention() {
    return this.snapshot().tasks.filter(
      (task) => isTerminal(task.status) && !isSuccess(task.status)
    )
  }

  /**
   * Record a follow-up for a task.
   *
   * Rejects an unknown task loudly. Silently accepting a message addressed to
   * a task that no longer exists produces the worst possible outcome: the
   * phone believes it sent something.
   */
  followUp(taskId, text) {
    const task = this.get(taskId)
    if (!task) throw new Error(`No such task: ${taskId}`)
    if (isTerminal(task.status)) {
      throw new Error(`Task ${taskId} already finished as ${task.status}`)
    }
    const trimmed = String(text ?? '').trim()
    if (!trimmed) throw new Error('A follow-up needs some text')
    const entry = { taskId, text: trimmed, at: new Date().toISOString() }
    this.#followUps.push(entry)
    this.upsert({ ...task, lastNote: trimmed })
    return entry
  }

  /** Cancel a running task, if it is still running. */
  cancel(taskId) {
    const task = this.get(taskId)
    if (!task) throw new Error(`No such task: ${taskId}`)
    if (isTerminal(task.status)) throw new Error(`Task ${taskId} already finished`)
    return this.upsert({ ...task, status: 'cancelled', updatedAt: new Date().toISOString() })
  }

  followUpsFor(taskId) {
    return this.#followUps.filter((entry) => entry.taskId === taskId)
  }

  subscribe(fn) {
    this.#subscribers.add(fn)
    return () => this.#subscribers.delete(fn)
  }

  #emit() {
    const payload = this.snapshot()
    for (const fn of this.#subscribers) {
      try {
        fn(payload)
      } catch (err) {
        // One broken subscriber must not stop the others being told.
        console.error('[relay] subscriber failed:', err?.message ?? err)
      }
    }
  }
}

/** Decode a command frame from a phone. Throws on anything malformed. */
export function decodeCommand(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Command must be an object')
  switch (raw.kind) {
    case 'followUp':
      if (typeof raw.taskId !== 'string' || !raw.taskId) throw new Error('followUp needs taskId')
      if (typeof raw.text !== 'string' || !raw.text.trim()) throw new Error('followUp needs text')
      return { kind: 'followUp', taskId: raw.taskId, text: raw.text.trim() }
    case 'cancel':
      if (typeof raw.taskId !== 'string' || !raw.taskId) throw new Error('cancel needs taskId')
      return { kind: 'cancel', taskId: raw.taskId }
    case 'refresh':
      return { kind: 'refresh' }
    default:
      throw new Error(`Unknown command: ${String(raw.kind)}`)
  }
}

export { STATUSES as statuses, UNKNOWN_STATUS as unknownStatus }