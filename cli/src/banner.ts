/**
 * Terminal chrome: wordmark, session header, prompt box.
 *
 * The look comes from the Cryptoric Agent brand page — near-black field, heavy
 * condensed uppercase wordmark with a lime ghost offset behind it, monospace
 * labels, lime reserved for the things that are live (the caret, the verdict, the
 * counters).
 *
 * Constraints that shaped this:
 *
 *  - **No new dependency.** Hand-drawn ANSI, because the box is a prompt and a
 *    spinner, not a framework.
 *  - **It must degrade.** Piped output, a dumb terminal and `NO_COLOR` all have
 *    to produce readable text, so every glyph here is chosen to survive a
 *    stripped environment, and the block font is only drawn when the terminal
 *    looks like it can take it.
 */

/**
 * A 5-row block font, one entry per unique letter of CRYPTORIC.
 *
 * Redrawn from the first cut: C and O now curve instead of ending in square
 * corners, Y and I are symmetric, and every bar is a full column wide so the
 * glyphs read as type rather than as a bitmap at a glance. The grid is
 * unchanged — five columns, five rows — because the width the caller centres
 * with is part of the contract with the prompt box.
 */
const GLYPHS: Record<string, string[]> = {
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  R: ['████ ', '█  █ ', '████ ', '█  █ ', '█  █ '],
  Y: ['█   █', '█   █', ' ███ ', '  █  ', '  █  '],
  P: ['████ ', '█  █ ', '████ ', '█    ', '█    '],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████']
}

const WORD = 'CRYPTORIC'
const GAP = '  '

export interface ChromeOptions {
  color: boolean
  /** Draw the block wordmark. Off for narrow or non-ANSI terminals. */
  wordmark: boolean
  width: number
}

const RESET = '[0m'
const LIME = '[92m'
const WHITE = '[97m'
const DIM = '[2m'
const BOLD = '[1m'

function paint(text: string, code: string, on: boolean): string {
  return on ? `${code}${text}${RESET}` : text
}

/** Width of the rendered wordmark, for centring. */
export function wordmarkWidth(): number {
  const letters = [...WORD]
  return letters.reduce((sum, ch) => sum + (GLYPHS[ch]?.[0]?.length ?? 0), 0) + GAP.length * (letters.length - 1)
}

function glyphRows(): string[] {
  const letters = [...WORD]
  const height = 5
  const rows: string[] = []
  for (let r = 0; r < height; r += 1) {
    rows.push(letters.map((ch) => GLYPHS[ch]?.[r] ?? ' '.repeat(5)).join(GAP))
  }
  return rows
}

/**
 * The wordmark.
 *
 * Each white row is preceded by the *next* green row, indented by one space.
 * Because the glyphs are solid blocks, that draws the green ghost behind and
 * below — the same offset-reveal the brand page uses — rather than painting
 * over it.
 */
export function renderWordmark(options: ChromeOptions): string {
  const rows = glyphRows()
  const out: string[] = []

  for (let r = 0; r < rows.length; r += 1) {
    const shadow = rows[r + 1]
    if (shadow) out.push(paint(` ${shadow}`, LIME, options.color))
    out.push(paint(rows[r] as string, options.color ? `${BOLD}${WHITE}` : '', options.color))
  }

  if (!options.color) {
    // Without colour the ghost would be invisible, so the wordmark loses its
    // decoration rather than printing two identical copies.
    return rows.join('\n')
  }
  return out.join('\n')
}

/** The session header shown once at start. */
export function renderHeaderBlock(options: ChromeOptions, info: { project: string; model: string | null; tools: number }): string {
  const lines: string[] = []
  if (options.wordmark) {
    const pad = Math.max(0, Math.floor((options.width - wordmarkWidth()) / 2))
    lines.push(' '.repeat(pad) + renderWordmark(options))
    lines.push('')
  }

  const label = (text: string, value: string, live = false): string =>
    `  ${paint(text.padEnd(9), DIM, options.color)} ${paint(value, live ? LIME : WHITE, options.color && live ? true : options.color)}`

  lines.push(label('workspace', info.project))
  lines.push(label('model', info.model ?? 'not configured — deterministic stages only', Boolean(info.model)))
  lines.push(label('tools', `${info.tools} available`))
  lines.push('')
  lines.push(`  ${paint('Type a task and press Enter. Ctrl+C to leave, Ctrl+D to exit.', DIM, options.color)}`)
  lines.push('')
  return lines.join('\n')
}

const BOX_TOP_L = '╭'
const BOX_TOP_R = '╮'
const BOX_BOT_L = '╰'
const BOX_BOT_R = '╯'
const BOX_V = '│'

/**
 * The prompt box.
 *
 * Drawn as an empty frame with the caret left at the end, so the cursor sits
 * where typing happens without the app having to move it.
 */
export function renderPromptBox(caret: string, options: ChromeOptions): string {
  const inner = Math.max(12, options.width - 6)
  const bar = paint(BOX_V, DIM, options.color)
  const edge = paint('─'.repeat(inner), DIM, options.color)
  const marker = paint('▸', LIME, options.color)

  return [
    `  ${paint(BOX_TOP_L, DIM, options.color)}${edge}${paint(BOX_TOP_R, DIM, options.color)}`,
    `  ${bar} ${marker} ${caret}`,
    `  ${paint(BOX_BOT_L, DIM, options.color)}${edge}${paint(BOX_BOT_R, DIM, options.color)}`
  ].join('\n')
}

/**
 * Redraw the prompt frame in place after a submission.
 *
 * Without this the box would be reprinted below itself once per task, and a
 * session of twenty tasks would scroll twenty stale frames into the log.
 */
export function replacePromptBox(previousLines: number): string {
  if (previousLines <= 0) return ''
  return `[${previousLines}A[0J`
}

export function promptBoxLines(): number {
  return 3
}

/** One-shot header, for `cryptoric "task"` and piped runs. */
export function renderRunHeader(options: ChromeOptions, task: string): string {
  const lines: string[] = []
  if (options.wordmark) {
    const pad = Math.max(0, Math.floor((options.width - wordmarkWidth()) / 2))
    lines.push(' '.repeat(pad) + renderWordmark(options))
    lines.push('')
  }
  lines.push(`  ${paint('task', DIM, options.color)} ${task}`)
  lines.push('')
  return lines.join('\n')
}

/** The lime progress caret that precedes live pipeline output. */
export function caret(options: ChromeOptions): string {
  return paint('▸', LIME, options.color)
}

/** Green pill used for a completed verdict. */
export function verdictStyle(verdict: string, options: ChromeOptions): string {
  if (!options.color) return verdict
  if (verdict === 'COMPLETED') return `${BOLD}${LIME}${verdict}${RESET}`
  if (verdict === 'FAILED') return `${BOLD}[31m${verdict}${RESET}`
  return `${BOLD}[33m${verdict}${RESET}`
}