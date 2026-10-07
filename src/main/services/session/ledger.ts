/**
 * The session ledger: what has been bought, and what was left.
 *
 * Every charge is a row, never a running total. A balance that lives only as a
 * number can be edited, and a number in a settings file is a number someone can
 * type. A ledger of rows is auditable — the balance is derived, so tampering
 * with one row is visible in the sum rather than being the sum itself.
 *
 * Appends are queued and flushed, exactly like the conversation store, and for
 * the same reason that store learned it the hard way: `append` returning does
 * not mean the write is on disk, and a charge that is still in memory when the
 * app exits is time the user paid for and lost.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { coinsChargedOn, type SessionGrant } from '@shared/session-time'

/** Rows kept before the oldest for a given day are dropped. */
const MAX_ROWS = 500

export class SessionLedger {
  private grants: SessionGrant[] = []
  private loaded = false
  /** In-flight load, so two callers cannot both read and both reset the list. */
  private loading: Promise<void> | null = null
  /** Serialises writes so two charges cannot interleave into one file. */
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  /**
   * Read the ledger once, however many callers arrive at once.
   *
   * Memoising the in-flight promise is not an optimisation. Two tasks starting
   * together on first launch both see `loaded === false`, both read the file,
   * and the second read assigned `[]` *after* the first had already pushed its
   * charge — silently destroying a payment. Which is exactly what happens now
   * that two projects can run in parallel.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const raw = await readFile(this.file, 'utf8')
          const parsed = JSON.parse(raw) as { grants?: SessionGrant[] }
          this.grants = Array.isArray(parsed.grants) ? parsed.grants : []
        } catch {
          // A missing or unreadable ledger starts empty. That is the honest
          // failure: the user is owed the full daily allowance rather than
          // being charged for grants we cannot read back.
          this.grants = []
        }
        this.loaded = true
      })()
    }
    await this.loading
  }

  /** Boot-time load. Safe to call more than once. */
  async load(): Promise<void> {
    await this.ensureLoaded()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    // 0o600 like the settings store: purchase history is the user's business,
    // not a world-readable file in a shared home directory.
    await writeFile(this.file, JSON.stringify({ grants: this.grants }, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
  }

  /**
   * Record a charge and make it durable before returning.
   *
   * Awaiting the write is the point. A charge that is only in memory when the
   * process exits is free time handed to a user who will be charged again for
   * it tomorrow.
   */
  async record(grant: SessionGrant): Promise<void> {
    await this.ensureLoaded()
    this.grants.push(grant)
    if (this.grants.length > MAX_ROWS) this.grants = this.grants.slice(-MAX_ROWS)
    await this.flush()
  }

  /** Mark a session as finished, so it is not offered for resume. */
  async markConsumed(id: string): Promise<void> {
    await this.ensureLoaded()
    const grant = this.grants.find((g) => g.id === id)
    if (!grant || grant.consumed) return
    grant.consumed = true
    await this.flush()
  }

  private flush(): Promise<void> {
    this.pending = this.pending.then(() => this.persist())
    return this.pending
  }

  /** Wait for every queued write to land. Called before the app quits. */
  async settled(): Promise<void> {
    await this.pending
  }

  list(): SessionGrant[] {
    return [...this.grants]
  }

  /** Coins already spent on one UTC day. */
  chargedOn(day: string): number {
    return coinsChargedOn(this.grants, day)
  }
}

/** Where the ledger lives for one app instance. */
export function ledgerPath(appDataDir: string): string {
  return join(appDataDir, 'sessions.json')
}