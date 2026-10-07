/**
 * Audit sink: the tool audit trail, written to disk.
 *
 * The in-memory ring buffer in `ToolRuntime` answers "what just happened";
 * this answers "what happened last Tuesday", which the ring cannot do once it
 * has rolled over. The format is JSON Lines — one record per line, append-only
 * — because it degrades honestly: a partially written last line (a crash
 * mid-write) corrupts exactly one record instead of the whole file, and no
 * step ever rewrites history.
 *
 * Two bounds keep it from becoming its own problem: the file rotates at
 * `MAX_BYTES` (the old file is kept as `.1`, so recent history is always one
 * rotation deep), and writes are fire-and-forget — an audit disk failure must
 * never fail the tool call it is describing.
 *
 * The file is created with mode 0600: audit records include tool arguments,
 * and arguments can contain paths and values the user does not want another
 * local account reading.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolAuditRecord } from '@shared/types'

/** Rotate the live file once it passes this size; one previous file is kept. */
const MAX_BYTES = 2 * 1024 * 1024

export class AuditSink {
  private disabled = false

  constructor(private readonly file: string) {}

  /** Append one record. Never throws: the sink observes, it does not gate. */
  write(record: ToolAuditRecord): void {
    if (this.disabled) return
    try {
      this.rotateIfNeeded()
      mkdirSync(dirname(this.file), { recursive: true })
      // A trailing newline keeps line-oriented readers correct even when the
      // previous write was interrupted mid-line.
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      // One failure is a warning; repeated failure would spam the log, so the
      // sink steps aside rather than degrading every subsequent call.
      console.warn('[audit] write failed, audit file disabled:', err)
      this.disabled = true
    }
  }

  private rotateIfNeeded(): void {
    let size = 0
    try {
      size = statSync(this.file).size
    } catch {
      return // not created yet
    }
    if (size < MAX_BYTES) return
    renameSync(this.file, `${this.file}.1`)
  }
}
