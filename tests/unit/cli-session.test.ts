/**
 * The interactive CLI session, driven end to end.
 *
 * `process.stdin` cannot be fed from a test, so the session takes injected
 * streams and this exercises the real thing: a real host, a real pipeline, a
 * real task. Nothing here is stubbed — the only thing being faked is the
 * terminal, which is the part that has to be faked.
 *
 * What it proves:
 *   - the wordmark and prompt box actually render,
 *   - a submitted task runs the pipeline and produces a result block,
 *   - a run with no model reports BLOCKED and says nothing was written,
 *   - slash commands work inside the session,
 *   - and the conversation survives being closed and reopened.
 */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Session } from '../../cli/src/repl'
import type { ChromeOptions } from '../../cli/src/banner'
import { renderWordmark, renderPromptBox, wordmarkWidth } from '../../cli/src/banner'

/** Collects everything the session writes. */
class Capture extends Writable {
  text = ''
  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.text += chunk.toString('utf8')
    cb()
  }
}

let work: string
let stateDir: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'cryptoric-session-'))
  stateDir = join(work, '.cryptoric-home')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(work, 'package.json'), '{"name":"scratch","version":"1.0.0"}\n')
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

/** Colour on, so the escape sequences and the wordmark are actually exercised. */
const chrome: ChromeOptions = { color: true, width: 88, wordmark: true }

async function drive(lines: string[], options: { cwd?: string } = {}): Promise<{ output: string; code: number }> {
  const out = new Capture()
  const session = await Session.create({
    cwd: options.cwd ?? work,
    chrome,
    allowApprovals: false,
    // No API key, no endpoint, no model: the deterministic path.
    env: { CRYPTORIC_HOME: stateDir },
    input: Readable.from(lines.map((l) => `${l}\n`)),
    output: out,
    isTTY: false
  })
  const code = await session.run()
  return { output: out.text, code }
}

describe('banner rendering', () => {
  it('fits CRYPTORIC in five rows of block glyphs', () => {
    const plain = renderWordmark({ color: false, width: 88, wordmark: true })
    const rows = plain.split('\n')
    expect(rows).toHaveLength(5)
    expect(plain).toContain('█')
  })

  it('reports a width the caller can use to decide whether to draw it', () => {
    // A wordmark wider than the terminal wraps and destroys its own frame, so
    // the caller needs the number. 61 columns is the real value: nine 5-wide
    // glyphs plus two-column gaps.
    expect(wordmarkWidth()).toBe(61)
    // It must still fit the narrowest terminal worth supporting.
    expect(wordmarkWidth()).toBeLessThan(80)
  })

  it('draws no ragged glyph rows', () => {
    // Every row of a glyph has to be the same width or the wordmark shears as
    // it descends, which is invisible in code review and obvious on screen.
    for (const row of renderWordmark({ color: false, width: 88, wordmark: true }).split('\n')) {
      expect(row.length).toBe(61)
    }
  })

  it('draws a closed prompt box with a caret', () => {
    const box = renderPromptBox('', { color: false, width: 60, wordmark: false })
    const rows = box.split('\n')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('╭')
    expect(rows[0]).toContain('╮')
    expect(rows[2]).toContain('╰')
    expect(rows[2]).toContain('╯')
    expect(rows[1]).toContain('▸')
  })
})

describe('interactive session', () => {
  it('opens with the wordmark, the workspace and a prompt box', async () => {
    const { output } = await drive(['/exit'])
    // The wordmark is drawn from block glyphs, so it is asserted by its
    // material, not by the letters "CRYPTORIC" — those never appear.
    expect(output).toContain('█')
    expect(output).toContain('workspace')
    expect(output).toContain('╭')
    expect(output).toContain('Type a task and press Enter')
  })

  it('lists the real tool surface from /tools', async () => {
    const { output } = await drive(['/tools', '/exit'])
    expect(output).toMatch(/\d+ tool\(s\)/)
    // A real registry, not a decorative list.
    expect(output).toContain('read_file')
    expect(output).toContain('write_file')
    // Browser tools are deliberately absent: they need a window.
    expect(output).not.toContain('browser_navigate')
  })

  it('runs a submitted task and returns a verdict block', async () => {
    const { output, code } = await drive(['add a README.md describing this project', '/exit'])
    expect(output).toContain('verdict')
    expect(output).toContain('BLOCKED')
    // The run did nothing, so it must say so in the block itself.
    expect(output).toContain('nothing was written')
    expect(code).toBe(2)
  })

  it('does not claim success for a run that changed nothing', async () => {
    const { output } = await drive(['add a README.md', '/exit'])
    expect(output).not.toMatch(/verdict\s+COMPLETED/)
  })

  it('rejects an unknown slash command without ending the session', async () => {
    const { output, code } = await drive(['/nonsense', '/exit'])
    expect(output).toContain('Unknown command')
    expect(code).toBe(0)
  })

  it('handles a blank line without treating it as a task', async () => {
    const { output, code } = await drive(['', '/exit'])
    expect(code).toBe(0)
    // A blank line must not have started a run.
    expect(output).not.toContain('verdict')
  })

  it('survives many tasks in one session', async () => {
    const { output } = await drive(['first task', 'second task', 'third task', '/exit'])
    const verdicts = output.match(/verdict/g) ?? []
    expect(verdicts.length).toBe(3)
  })
})

describe('persistence across restarts', () => {
  /** Turns from a conversation file, whichever schema version it uses. */
  const turnsOf = (file: string): string[] => {
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      scopes: Record<string, { turns: { text: string }[] }>
    }
    return Object.values(data.scopes).flatMap((s) => s.turns.map((t) => t.text))
  }

  it('writes history into the project folder and keeps it after a restart', async () => {
    const projectFile = join(work, '.cryptoricagent', 'conversation.json')

    // First session.
    await drive(['remember that the sky is blue', '/exit'])
    expect(existsSync(projectFile)).toBe(true)
    expect(turnsOf(projectFile)).toContain('remember that the sky is blue')

    // Second session: a new Session and host over the same directories.
    await drive(['what did I just tell you', '/exit'])
    const after = turnsOf(projectFile)
    // Both tasks survive: this is the whole point of persisting history.
    expect(after).toContain('remember that the sky is blue')
    expect(after).toContain('what did I just tell you')
  })

  it('also keeps a copy in the app folder, so a deleted project is survivable', async () => {
    await drive(['a task worth keeping', '/exit'])
    const dir = join(stateDir, 'conversations')
    expect(existsSync(dir)).toBe(true)
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)

    const copied = turnsOf(join(dir, files[0] as string))
    expect(copied).toContain('a task worth keeping')
  })

  it('gives the same project the same id across sessions', async () => {
    const manifest = join(work, '.cryptoricagent', 'project.json')
    await drive(['first', '/exit'])
    const first = JSON.parse(readFileSync(manifest, 'utf8')) as { id: string }
    await drive(['second', '/exit'])
    const second = JSON.parse(readFileSync(manifest, 'utf8')) as { id: string }
    // A new id each open would silently split the history into a new file.
    expect(second.id).toBe(first.id)
  })

  it('scopes history per project, so two projects do not share a transcript', async () => {
    const other = mkdtempSync(join(tmpdir(), 'cryptoric-other-'))
    try {
      writeFileSync(join(other, 'package.json'), '{"name":"other","version":"1.0.0"}\n')

      await drive(['task for project A', '/exit'])
      await drive(['task for project B'], { cwd: other })

      const a = turnsOf(join(work, '.cryptoricagent', 'conversation.json'))
      const b = turnsOf(join(other, '.cryptoricagent', 'conversation.json'))

      expect(a).toContain('task for project A')
      expect(a).not.toContain('task for project B')
      expect(b).toContain('task for project B')
      expect(b).not.toContain('task for project A')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})