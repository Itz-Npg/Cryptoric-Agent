/**
 * The interactive session.
 *
 * `cryptoric` with no subcommand drops into this: a prompt box, a task typed
 * into it, the whole pipeline run, a result, then the prompt again.
 *
 * Design notes that are not obvious:
 *
 *  - **The host is built once.** Environment probing and skill discovery are
 *    slow and have nothing to do with the task, so a session that rebuilt them
 *    per prompt would make every keystroke feel like a cold start.
 *  - **One run at a time.** The pipeline is not reentrant from this surface and
 *    pretending otherwise would interleave two tasks' output into one stream.
 *  - **Slash commands are real.** `/tools` lists what this binary can actually
 *    call; it does not print a decorative list of things the CLI cannot do.
 */

import { createInterface, type Interface } from 'node:readline'
import { relative } from 'node:path'

import { CliHost } from './host'
import type { RunResult } from './host'
import { EXIT_CANCELLED, exitCodeFor } from './exit-code'
import { Spinner } from './spinner'
import {
  caret,
  promptBoxLines,
  renderHeaderBlock,
  renderPromptBox,
  replacePromptBox,
  verdictStyle,
  type ChromeOptions
} from './banner'

export interface SessionOptions {
  cwd: string
  chrome: ChromeOptions
  /** Pre-approve gated operations. Only ever true when `--yes` was passed. */
  allowApprovals: boolean
  env: NodeJS.ProcessEnv
  /**
   * Streams, injected rather than hardcoded.
   *
   * `process.stdin` cannot be driven from a test, and a UI that can only be
   * exercised by a human with a terminal is a UI that is never exercised. The
   * entry point still passes the real process streams and is still the only
   * place that checks `isTTY`, so this widens what is testable without
   * weakening what is enforced.
   */
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  /** Whether the output is a real terminal. Gates the spinner only. */
  isTTY?: boolean
}

export class Session {
  private readonly rl: Interface
  private readonly spinner: Spinner
  private readonly host: CliHost
  private readonly out: NodeJS.WritableStream
  private busy = false
  private quitting = false
  /** How many terminal lines the prompt box is currently occupying. */
  private promptLines = 0

  private constructor(
    private readonly options: SessionOptions,
    host: CliHost,
    rl: Interface
  ) {
    this.host = host
    this.rl = rl
    this.out = options.output ?? process.stdout
    this.spinner = new Spinner({
      stream: this.out,
      isTTY: options.isTTY ?? false,
      color: options.chrome.color
    })
  }

  static async create(options: SessionOptions): Promise<Session> {
    const sink = options.output ?? process.stdout
    const events = {
      note: (_message: string, _status: 'ok' | 'error' | 'pending' | 'info', stage: string) => {
        // The spinner owns a single line; anything else must take it first.
        activeSpinner?.stop()
        sink.write(`${caret(options.chrome)} ${stage}\n`)
      },
      stageStart: (stage: string) => {
        activeSpinner?.setLabel(stage)
      },
      say: (text: string) => {
        activeSpinner?.stop()
        sink.write(`${text}\n`)
      }
    }

    let activeSpinner: Spinner | null = null

    const host = await CliHost.create({
      cwd: options.cwd,
      approval: options.allowApprovals ? 'allow' : 'prompt',
      events,
      authorize: options.allowApprovals ? async () => true : denyInteractive,
      env: options.env
    })

    const rl = createInterface({
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
      terminal: true
    })
    const session = new Session(options, host, rl)
    activeSpinner = session.spinner
    return session
  }

  /** Prints the wordmark and header, then loops until the user leaves. */
  async run(): Promise<number> {
    const header = renderHeaderBlock(
      this.options.chrome,
      {
        project: this.options.cwd,
        model: this.host.modelName,
        tools: this.host.toolIds().length
      }
    )
    this.spinner.stop()
    this.out.write(`${header}\n`)
    this.drawPrompt()

    let lastCode = 0

    for await (const line of this.rl) {
      if (this.quitting) break
      const task = line.trim()
      if (task.length === 0) {
        this.drawPrompt()
        continue
      }

      if (task.startsWith('/')) {
        this.handleSlash(task)
        this.drawPrompt()
        continue
      }

      lastCode = await this.runTask(task)
      this.drawPrompt()
    }

    this.spinner.stop()
    this.out.write('\n')
    return lastCode
  }

  private handleSlash(input: string): void {
    const command = input.split(/\s+/)[0] ?? ''
    switch (command) {
      case '/exit':
      case '/quit':
        this.quitting = true
        this.rl.close()
        return
      case '/help':
        this.out.write(
          [
            '',
            '  /tools    what this CLI can actually call',
            '  /doctor   environment and configuration',
            '  /cwd      show the workspace root',
            '  /exit     leave the session',
            ''
          ].join('\n')
        )
        return
      case '/tools': {
        const ids = this.host.toolIds()
        this.out.write(`\n  ${ids.length} tool(s):\n`)
        for (const id of ids) this.out.write(`    ${id}\n`)
        this.out.write('\n')
        return
      }
      case '/doctor':
        this.out.write(
          [
            '',
            `  model      ${this.host.modelName ?? 'not configured (deterministic stages only)'}`,
            `  tools      ${this.host.toolIds().length}`,
            `  model api  ${this.host.hasModel ? 'configured' : 'missing — set CRYPTORIC_API_KEY'}`,
            ''
          ].join('\n')
        )
        return
      case '/cwd':
        this.out.write(`\n  ${this.options.cwd}\n\n`)
        return
      default:
        this.out.write(`\n  Unknown command ${String(command)}. Try /help.\n\n`)
        return
    }
  }

  private drawPrompt(): void {
    if (this.quitting) return
    this.out.write(replacePromptBox(this.promptLines))
    this.out.write(`${renderPromptBox('', this.options.chrome)}\n`)
    this.promptLines = promptBoxLines()
    this.rl.prompt(true)
  }

  /** One task, start to finish, ending in a result block. */
  private async runTask(task: string): Promise<number> {
    if (this.busy) return 0
    this.busy = true

    const controller = new AbortController()
    const onInterrupt = (): void => {
      if (!this.spinner.running) {
        this.quitting = true
        this.rl.close()
        return
      }
      this.spinner.stop()
      this.out.write('\n  stopping — work already done is kept\n')
      controller.abort()
    }
    process.once('SIGINT', onInterrupt)

    this.spinner.start('starting')
    this.out.write(`\n  ${caret(this.options.chrome)} ${task}\n`)

    let result: RunResult
    try {
      result = await this.host.run(task, controller.signal)
    } catch (error: unknown) {
      this.spinner.stop()
      const message = error instanceof Error ? error.message : String(error)
      this.out.write(`\n  ${verdictStyle('FAILED', this.options.chrome)}  ${message}\n\n`)
      this.busy = false
      process.off('SIGINT', onInterrupt)
      return 1
    }

    this.spinner.stop()
    process.off('SIGINT', onInterrupt)
    this.out.write(this.renderResult(result))
    this.busy = false

    return result.verdict === 'CANCELLED' ? EXIT_CANCELLED : exitCodeFor(result.verdict)
  }

  /** The result block: bordered, verdict-first, and explicit about doing nothing. */
  private renderResult(result: RunResult): string {
    const c = this.options.chrome
    const width = Math.min(Math.max(c.width - 4, 40), 78)
    const edge = c.color ? '[2m' : ''
    const reset = c.color ? '[0m' : ''
    const paintDim = (t: string): string => (c.color ? `${edge}${t}${reset}` : t)
    const lime = (t: string): string => (c.color ? `[92m${t}${reset}` : t)

    const lines: string[] = []
    lines.push('')
    lines.push(`  ${paintDim('╭' + '─'.repeat(width) + '╮')}`)

    const row = (label: string, value: string): string => {
      const head = `  ${paintDim('│')} ${label.padEnd(9)} `
      // Pad before painting so the escape codes are not counted as width.
      const body = `${value}${' '.repeat(Math.max(0, width - label.length - 13))}`
      return `${head}${body}${paintDim('│')}`
    }

    lines.push(row('verdict', verdictStyle(result.verdict, c)))
    if (result.reason) lines.push(row('reason', result.reason))
    if (result.answer && result.answer !== result.reason) lines.push(row('answer', result.answer))

    const changed = result.task.changedPaths
    if (changed.length === 0) {
      lines.push(row('changes', c.color ? `[33mnothing was written[0m` : 'nothing was written'))
    } else {
      lines.push(row('changes', lime(`${changed.length} file(s)`)))
      for (const path of changed.slice(0, 10)) {
        lines.push(`  ${paintDim('│')} ${' '.repeat(10)}${path}${' '.repeat(Math.max(0, width - path.length - 12))}${paintDim('│')}`)
      }
      if (changed.length > 10) {
        lines.push(`  ${paintDim('│')} ${' '.repeat(10)}… and ${changed.length - 10} more`)
      }
    }

    const usage = result.task.usage
    lines.push(
      row('usage', `${usage.inputTokens} in · ${usage.outputTokens} out · ${(result.durationMs / 1000).toFixed(1)}s`)
    )
    lines.push(`  ${paintDim('╰' + '─'.repeat(width) + '╯')}`)
    lines.push('')
    return lines.join('\n')
  }

  /** Path shown in the header when the cwd is inside a project. */
  static describeRoot(cwd: string): string {
    return relative(process.cwd(), cwd) || '.'
  }
}

/**
 * Refuse, do not guess.
 *
 * An approval request with nobody present to answer it is not consent. This
 * returns false rather than blocking forever on a read that will never come.
 */
async function denyInteractive(): Promise<boolean> {
  process.stderr.write('  refused: this needs approval and there is no interactive terminal\n')
  return false
}