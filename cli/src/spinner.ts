/**
 * Single-line spinner.
 *
 * The agent can go quiet for a long time while a model call is in flight, and a
 * CLI that prints nothing during that window is indistinguishable from one that
 * has hung. So something has to move.
 *
 * It is strictly single-line and yields the moment anything else writes. Two
 * spinners or a spinner plus pipeline output would otherwise interleave into
 * garbage, which is worse than no spinner at all.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export interface SpinnerOptions {
  stream: NodeJS.WritableStream
  /**
   * Whether the stream is a terminal.
   *
   * Passed in rather than read off the stream, because the injectable stream in
   * a test is a plain Writable and has no `isTTY`. A spinner that redraws a
   * line in a pipe produces a file full of `⠋` characters, so this flag is what
   * stops it.
   */
  isTTY?: boolean
  intervalMs?: number
  color: boolean
}

export class Spinner {
  private frame = 0
  private timer: NodeJS.Timeout | null = null
  private active = false
  private readonly intervalMs: number

  constructor(private readonly options: SpinnerOptions) {
    this.intervalMs = options.intervalMs ?? 90
  }

  private get enabled(): boolean {
    return Boolean(this.options.isTTY) && this.options.color
  }

  start(label: string): void {
    if (this.active) this.stop()
    this.frame = 0
    this.active = true
    this.paint(label)
    if (!this.enabled) return
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length
      this.paint(label)
    }, this.intervalMs)
    // Never hold the process open on the spinner's account.
    this.timer.unref?.()
  }

  private paint(label: string): void {
    const glyph = FRAMES[this.frame] as string
    const prefix = this.options.color ? `[36m${glyph}[0m` : '*'
    this.options.stream.write(`\r[2K${prefix} ${label}`)
  }

  /** Erase the spinner line. Safe to call when it is not running. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (!this.active) return
    this.active = false
    this.options.stream.write('\r[2K')
  }

  /** Swap the label without restarting, used as stages advance. */
  setLabel(label: string): void {
    if (!this.active) {
      this.start(label)
      return
    }
    this.paint(label)
  }

  get running(): boolean {
    return this.active
  }
}