/**
 * Application updates.
 *
 * The provider is GitHub Releases and the transport is `electron-updater`, but
 * all of that sits behind `UpdatePort` so the policy — when to check, when to
 * download, what to tell the user — is testable without a network or a packaged
 * build.
 *
 * Three rules, because an updater that lies is worse than no updater:
 *
 *  1. **Never claim to be up to date when it could not check.** A development
 *     build has no update feed at all: `electron-updater` refuses to run, and
 *     reporting that as "up to date" would be a false success state. The real
 *     reason is reported instead.
 *  2. **Check on a schedule, download only when asked.** A background
 *     download that starts on its own spends bandwidth and swaps a running
 *     application out from under the user. Checking is cheap; downloading is
 *     the user's decision, and this service never makes it for them.
 *  3. **A failed check is a failure, not a silent no-op.** The reason reaches
 *     the UI verbatim.
 */

export type UpdateState =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateStatus {
  state: UpdateState
  /** Version actually running, straight from the package manifest. */
  currentVersion: string
  /** Version on the feed, when one was found. */
  availableVersion: string | null
  releaseNotes: string | null
  releaseDate: string | null
  progress: UpdateProgress | null
  /** Why this build cannot check, when `state` is `unsupported`. */
  unavailableReason: string | null
  error: string | null
  /** Where a human can read what changed. */
  releasePageUrl: string | null
}

export interface UpdatePort {
  /** Version of the running build. */
  readonly currentVersion: string
  /**
   * Whether this build can check at all. A reason is required when it cannot:
   * "no update feed" and "up to date" are different answers.
   */
  canCheck(): { ok: boolean; reason: string | null }
  /** Ask the feed what exists. Resolves with `null` when there is nothing newer. */
  check(): Promise<{
    version: string | null
    releaseNotes: string | null
    releaseDate: string | null
    releasePageUrl: string | null
  }>
  /** Fetch the installer. Only ever called after the user asks. */
  download(onProgress: (progress: UpdateProgress) => void): Promise<{ version: string | null }>
  /** Swap the installed build. Ends the process. */
  install(): void
}

export interface UpdateServiceDeps {
  port: UpdatePort
  /** Tell the user something changed. Called for state transitions worth seeing. */
  notify?: (status: UpdateStatus) => void
  /** Minimum gap between automatic checks. */
  checkIntervalMs?: number
  now?: () => number
}

const IDLE = (currentVersion: string): UpdateStatus => ({
  state: 'idle',
  currentVersion,
  availableVersion: null,
  releaseNotes: null,
  releaseDate: null,
  progress: null,
  unavailableReason: null,
  error: null,
  releasePageUrl: null
})

/** One day. Long enough not to nag, short enough to notice a release. */
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export class UpdateService {
  private status: UpdateStatus
  private lastCheckedAt = 0
  private inFlight: Promise<UpdateStatus> | null = null

  constructor(private readonly deps: UpdateServiceDeps) {
    this.status = IDLE(deps.port.currentVersion)
    this.lastCheckedAt = -Infinity
  }

  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  /**
   * Check the feed, unless a check already ran inside the interval.
   *
   * Concurrent callers share one request. Two parallel checks against GitHub is
   * two chances to hit the anonymous rate limit for no benefit.
   */
  async check(opts: { force?: boolean } = {}): Promise<UpdateStatus> {
    if (this.inFlight) return this.inFlight

    const now = this.deps.now ?? Date.now
    const interval = this.deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    if (!opts.force && now() - this.lastCheckedAt < interval) {
      return this.getStatus()
    }

    const run = this.runCheck().finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async runCheck(): Promise<UpdateStatus> {
    const now = this.deps.now ?? Date.now
    const capability = this.deps.port.canCheck()

    if (!capability.ok) {
      // Not an error and not "up to date". The distinction is the whole point.
      return this.set({
        ...this.status,
        state: 'unsupported',
        unavailableReason: capability.reason,
        error: null
      })
    }

    this.lastCheckedAt = now()
    this.set({ ...this.status, state: 'checking', error: null })

    try {
      const found = await this.deps.port.check()

      if (!found.version) {
        return this.set({
          ...this.status,
          state: 'not-available',
          availableVersion: null,
          releaseNotes: null,
          releaseDate: null,
          releasePageUrl: found.releasePageUrl,
          error: null
        })
      }

      return this.set({
        ...this.status,
        state: 'available',
        availableVersion: found.version,
        releaseNotes: found.releaseNotes,
        releaseDate: found.releaseDate,
        releasePageUrl: found.releasePageUrl,
        error: null
      })
    } catch (err) {
      return this.set({
        ...this.status,
        state: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /**
   * Download the update the user was told about.
   *
   * Refuses when there is nothing to fetch. A download button that "succeeds"
   * while fetching nothing is the exact failure mode this whole file exists to
   * avoid.
   */
  async download(): Promise<UpdateStatus> {
    if (this.status.state === 'downloading') return this.getStatus()
    if (this.status.state !== 'available' && this.status.state !== 'downloaded') {
      return this.set({
        ...this.status,
        state: this.status.state === 'idle' ? 'idle' : this.status.state,
        error: 'There is no update to download. Check for updates first.'
      })
    }

    const capability = this.deps.port.canCheck()
    if (!capability.ok) {
      return this.set({ ...this.status, state: 'unsupported', unavailableReason: capability.reason })
    }

    this.set({ ...this.status, state: 'downloading', error: null, progress: null })

    try {
      const result = await this.deps.port.download((progress) => {
        this.set({ ...this.status, progress })
      })
      return this.set({
        ...this.status,
        state: 'downloaded',
        availableVersion: result.version ?? this.status.availableVersion,
        progress: null
      })
    } catch (err) {
      return this.set({
        ...this.status,
        state: 'error',
        progress: null,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /** Install a downloaded update and restart into it. */
  install(): UpdateStatus {
    if (this.status.state !== 'downloaded') {
      return this.set({ ...this.status, error: 'Nothing has been downloaded yet.' })
    }
    this.deps.port.install()
    return this.getStatus()
  }

  private set(next: UpdateStatus): UpdateStatus {
    this.status = next
    this.deps.notify?.({ ...next })
    return this.getStatus()
  }
}