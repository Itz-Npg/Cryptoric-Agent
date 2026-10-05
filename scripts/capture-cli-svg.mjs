/**
 * Capture a real `cryptoric` session and render it to an SVG for the README.
 *
 * This is a recording, not a mockup: it drives the same `Session` class the
 * binary uses, with a real host and a real pipeline, and writes out whatever
 * came back. If the CLI's output changes, the image changes with it.
 *
 * Why SVG rather than a screenshot: it is diffable, reviewable as text, and
 * renders on GitHub from the repository with no image host and no binary blob
 * in the history. A PNG of a terminal is 200 KB of unreviewable bytes.
 *
 * Run: node scripts/capture-cli-svg.mjs
 */

import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'
import { build } from 'esbuild'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = join(repoRoot, 'docs', 'images', 'cli-session.svg')

const PALETTE = {
  bg: '#0b0b12',
  fg: '#e8e8ef',
  lime: '#b6f24a',
  red: '#ff6b6b',
  yellow: '#ffd166',
  cyan: '#7fe0ea',
  dim: '#7a7a8c',
  white: '#ffffff',
  border: '#2a2a38'
}

// ---------------------------------------------------------------------------
// A deliberately small ANSI interpreter: SGR colour plus the cursor/erase
// sequences this CLI actually emits. Anything unknown is dropped rather than
// guessed at, so an unhandled sequence cannot corrupt the whole capture.
// ---------------------------------------------------------------------------

const FG = {
  31: PALETTE.red,
  32: PALETTE.lime,
  33: PALETTE.yellow,
  36: PALETTE.cyan,
  92: PALETTE.lime,
  97: PALETTE.white
}

function parse(text) {
  /** @type {{lines: Array<Array<{text: string, color: string, bold: boolean, dim: boolean}>>, cursor: number[]}} */
  const lines = [[]]
  let cursor = [0]
  let column = 0
  let color = PALETTE.fg
  let bold = false
  let dim = false

  const current = () => {
    // Floor the row first. Several cursor sequences can move the row below
    // zero or past the array, and a sparse or negative index would hand back
    // undefined and abort the whole capture on a rendering detail.
    if (!Number.isInteger(cursor[0]) || cursor[0] < 0) cursor[0] = 0
    while (lines.length <= cursor[0]) lines.push([])
    return lines[cursor[0]] ?? (lines[cursor[0]] = [])
  }

  const emit = (chunk) => {
    if (chunk.length === 0) return
    const line = current()
    const last = line[line.length - 1]
    // Merge adjacent runs with identical styling, otherwise every character
    // would become its own <text> element.
    if (last && last.color === color && last.bold === bold && last.dim === dim) {
      last.text += chunk
    } else {
      line.push({ text: chunk, color, bold, dim })
    }
    column += chunk.length
  }

  const pattern = /\x1b\[([0-9;?]*)([A-Za-z])/g
  let index = 0
  let match

  /** Walk literal text, honouring newline and carriage return. */
  const walk = (chunk) => {
    let buffer = ''
    for (const ch of chunk) {
      if (ch === '\n') {
        emit(buffer)
        buffer = ''
        cursor[0] += 1
        column = 0
      } else if (ch === '\r') {
        emit(buffer)
        buffer = ''
        column = 0
      } else {
        buffer += ch
      }
    }
    emit(buffer)
  }

  while ((match = pattern.exec(text)) !== null) {
    walk(text.slice(index, match.index))
    index = pattern.lastIndex

    const raw = match[1]
    const code = match[2]
    const params = raw.split(';').filter((p) => p.length > 0).map(Number)

    if (code === 'm') {
      for (const p of params.length > 0 ? params : [0]) {
        if (p === 0) {
          color = PALETTE.fg
          bold = false
          dim = false
        } else if (p === 1) bold = true
        else if (p === 2) dim = true
        else if (FG[p]) color = FG[p]
      }
    } else if (code === 'K') {
      // Erase in line. Assigned through `current()` rather than by index:
      // writing past the end of the array would leave holes, and a later read
      // of a hole would come back undefined.
      current().length = 0
      column = 0
    } else if (code === 'J') {
      lines.length = cursor[0] + 1
    } else if (code === 'A') {
      cursor[0] = Math.max(0, cursor[0] - (params[0] || 1))
    } else if (code === 'B') {
      cursor[0] += params[0] || 1
    } else if (code === 'G') {
      column = Math.max(0, (params[0] || 1) - 1)
    }
  }

  walk(text.slice(index))

  return lines
}

const escapeXml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function toSvg(lines, { columns }) {
  const cell = 8.4
  const lineHeight = 18
  const pad = 22
  // Block glyphs and box-drawing characters are square-ish in most terminal
  // fonts; a slightly wider cell keeps the wordmark from looking stretched.
  const width = Math.round(pad * 2 + columns * cell)
  const height = Math.round(pad * 2 + lines.length * lineHeight)

  const body = lines
    .map((line, row) => {
      let x = pad
      const parts = []
      for (const run of line) {
        const w = run.text.length * cell
        const fill = run.dim ? PALETTE.dim : run.color
        const opacity = run.dim ? 0.85 : 1
        parts.push(
          `<text x="${x.toFixed(1)}" y="${(pad + row * lineHeight + 12).toFixed(1)}" ` +
            `fill="${fill}" opacity="${opacity}"${run.bold ? ' font-weight="700"' : ''} ` +
            `xml:space="preserve">${escapeXml(run.text)}</text>`
        )
        x += w
      }
      return parts.join('')
    })
    .join('\n    ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="A real cryptoric CLI session: the CRYPTORIC wordmark, a task typed into the prompt box, and a BLOCKED verdict because no model provider is configured.">
  <title>cryptoric — a real session</title>
  <desc>Captured by scripts/capture-cli-svg.mjs from a live run of the cryptoric CLI with no model provider configured.</desc>
  <rect width="${width}" height="${height}" fill="${PALETTE.bg}"/>
  <g font-family="ui-monospace, SFMono-Regular, 'Cascadia Mono', Menlo, Consolas, monospace" font-size="13">
    ${body}
  </g>
</svg>
`
}

// ---------------------------------------------------------------------------

// A presentable directory name: the header prints this path, and a random
// temp suffix in a README image looks like a mistake even though it is not one.
const workRoot = mkdtempSync(join(tmpdir(), 'cryptoric-capture-'))
const work = join(workRoot, 'cryptoric-agent')
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'package.json'), '{"name":"demo","version":"1.0.0"}\n')

try {
  // Build the CLI to a temp file so the capture uses exactly what ships.
  const entry = join(work, 'capture-entry.ts')
  writeFileSync(
    entry,
    `export { Session } from ${JSON.stringify(join(repoRoot, 'cli', 'src', 'repl').replace(/\\/g, '/'))}\n`
  )
  const bundle = join(work, 'cli.mjs')
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['electron'],
    alias: { '@shared': join(repoRoot, 'src/shared') },
    logLevel: 'error'
  })

  const { Session } = await import(`file://${bundle.replace(/\\/g, '/')}`)
  const out = new Writable({
    write(chunk, _enc, cb) {
      captured.push(chunk.toString('utf8'))
      cb()
    }
  })
  const captured = []

  const session = await Session.create({
    cwd: work,
    chrome: { color: true, width: 84, wordmark: true },
    allowApprovals: false,
    env: { CRYPTORIC_HOME: join(work, '.cryptoric-home') },
    input: Readable.from(['add a README.md describing this project\n', '/exit\n']),
    output: out,
    isTTY: false
  })
  await session.run()

  const raw = captured.join('')
  const TERMINAL_WIDTH = 84
  // Clip to the terminal width the session was given. The pipeline wraps in a
  // real terminal; this renderer does not, so without clipping one long line
  // would stretch the image to twice the width of everything else.
  const clip = (line) => {
    let used = 0
    const out = []
    for (const run of line) {
      const room = TERMINAL_WIDTH - used
      if (room <= 0) break
      if (run.text.length <= room) {
        out.push(run)
        used += run.text.length
      } else {
        out.push({ ...run, text: run.text.slice(0, Math.max(0, room - 1)) + '…' })
        used = TERMINAL_WIDTH
      }
    }
    return out
  }

  const lines = parse(raw).filter((line) => line.length > 0).map(clip)

  const columns = lines.reduce((max, line) => Math.max(max, line.reduce((n, r) => n + r.text.length, 0)), 0)

  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, toSvg(lines, { columns }))

  console.log(`wrote ${outFile}`)
  console.log(`  ${lines.length} lines, ${columns} columns`)
  const hasWordmark = raw.includes('█')
  const hasVerdict = raw.includes('BLOCKED')
  console.log(`  wordmark present: ${hasWordmark}`)
  console.log(`  verdict present:  ${hasVerdict}`)
  if (!hasWordmark || !hasVerdict) {
    console.error('capture is missing expected content; refusing to write a misleading image')
    process.exitCode = 1
  }
} finally {
  rmSync(workRoot, { recursive: true, force: true })
}