/**
 * `cryptoric` entry point.
 *
 * The only module that writes to stdout/stderr, reads stdin, installs signal
 * handlers, or sets an exit code. Everything it does is delegated to the parsed
 * command and the host, so the behaviour can be tested without a process.
 *
 * Note `process.exitCode`, never `process.exit()`. On Windows `process.exit`
 * truncates buffered stdout, which turns a completed run into an apparently
 * silent one — the output vanishes and only the code survives.
 */

import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

import { HELP_TEXT, parseArgs, type RunCommand } from './args'
import { CliHost, resolveStateDir, verdictFor } from './host'
import { Session } from './repl'
import { wordmarkWidth, type ChromeOptions } from './banner'
import { EXIT_CANCELLED, EXIT_USAGE, exitCodeFor } from './exit-code'
import {
  renderApprovalWarning,
  renderHeader,
  renderStageStart,
  renderSummary,
  renderTimelineEntry,
  type RenderOptions
} from './render'
import type { HostEvents } from './host'

const VERSION = '0.1.0'

const render: RenderOptions = {
  // Colour only when a human is watching AND nobody is capturing. Piping to a
  // file is the normal case in CI, and escape codes there are noise.
  color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
}

/**
 * Terminal geometry, used for the wordmark and the result box.
 *
 * The width is clamped rather than trusted: `columns` is undefined when stdout
 * is not a terminal, and a box built from `undefined` produces `NaN` dashes.
 */
function chromeOptions(): ChromeOptions {
  const width = Math.max(48, Math.min(process.stdout.columns ?? 88, 100))
  const color = render.color
  return {
    color,
    width,
    // The block wordmark needs its own width plus margin, or it wraps and
    // destroys the frame it is drawn in.
    wordmark: color && width >= wordmarkWidth() + 4
  }
}

function write(text: string): void {
  process.stdout.write(`${text}\n`)
}

/** Progress goes to stderr so `--json` keeps stdout parseable. */
function progress(text: string): void {
  process.stderr.write(`${text}\n`)
}

/**
 * Ask the human.
 *
 * A non-interactive stream is not a yes. Auto-approving because there is nobody
 * to ask is how a destructive command runs unattended in a cron job; refusing
 * loudly is the only safe reading of an absent human.
 */
function makeAuthorizer(mode: RunCommand['approval']): (title: string, detail: string) => Promise<boolean> {
  if (mode === 'allow') {
    progress(renderApprovalWarning(render))
    return async () => true
  }
  if (mode === 'deny') {
    return async () => false
  }

  return async (title, detail) => {
    if (!process.stdin.isTTY) {
      progress('refused: this operation needs approval, but stdin is not a terminal.')
      progress('         Re-run interactively, or pass --yes to pre-approve, or --deny to refuse.')
      return false
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const answer = await new Promise<string>((done) => {
        rl.question(`\n${title}\n${detail}\n  [y/N] `, done)
      })
      return /^y(es)?$/i.test(answer.trim())
    } finally {
      rl.close()
    }
  }
}

function makeEvents(json: boolean): HostEvents {
  return {
    note: (message, status, stage) => {
      if (json) return
      progress(
        renderTimelineEntry(
          {
            id: '',
            taskId: '',
            at: new Date().toISOString(),
            role: 'SYSTEM',
            stage,
            message,
            status
          },
          render
        )
      )
    },
    stageStart: (stage) => {
      if (json) return
      progress(renderStageStart(stage, render))
    },
    say: (text) => {
      if (json) return
      progress(text)
    }
  }
}

async function commandRun(command: RunCommand): Promise<number> {
  const cwd = resolve(command.cwd)

  const host = await CliHost.create({
    cwd,
    approval: command.approval,
    events: makeEvents(command.json),
    authorize: makeAuthorizer(command.approval),
    env: process.env
  })

  if (!command.json) {
    write(renderHeader(cwd, host.modelName, render))
    if (!host.hasModel) {
      progress(
        'note: no model provider configured, so only the deterministic stages will run.'
      )
      progress('      Set CRYPTORIC_API_KEY, CRYPTORIC_ENDPOINT and CRYPTORIC_MODEL to enable the agent.')
    }
  }

  const controller = new AbortController()
  const onSignal = (): void => {
    progress('\ninterrupted — stopping the task (work already done is kept).')
    controller.abort()
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const timer =
    command.timeoutMs > 0
      ? setTimeout(() => {
          progress(`\ntimed out after ${Math.round(command.timeoutMs / 1000)}s — stopping.`)
          controller.abort()
        }, command.timeoutMs)
      : null

  try {
    const result = await host.run(command.task, controller.signal)

    if (command.json) {
      write(
        JSON.stringify(
          {
            verdict: result.verdict,
            reason: result.reason,
            answer: result.answer,
            changedPaths: result.task.changedPaths,
            usage: result.task.usage,
            durationMs: result.durationMs,
            evidence: result.task.evidence ?? null
          },
          null,
          2
        )
      )
    } else {
      write(
        renderSummary(
          {
            task: result.task,
            verdict: result.verdict,
            answer: result.answer,
            reason: result.reason,
            changedPaths: result.task.changedPaths,
            usage: result.task.usage,
            durationMs: result.durationMs
          },
          render
        )
      )
    }

    return result.verdict === 'CANCELLED' ? EXIT_CANCELLED : exitCodeFor(result.verdict)
  } finally {
    if (timer) clearTimeout(timer)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

async function commandTools(json: boolean): Promise<number> {
  const host = await CliHost.create({
    cwd: resolve(process.cwd()),
    approval: 'deny',
    events: makeEvents(true),
    authorize: async () => false,
    env: process.env
  })
  const ids = host.toolIds()
  if (json) {
    write(JSON.stringify({ tools: ids, model: host.modelName, stateDir: resolveStateDir(process.env) }, null, 2))
  } else {
    write(`${ids.length} tool(s) available in the CLI:\n`)
    for (const id of ids) write(`  ${id}`)
    write('')
    write('Browser tools are not available here: they need a window. Use the desktop app for those.')
  }
  return 0
}

async function commandDoctor(json: boolean): Promise<number> {
  const stateDir = resolveStateDir(process.env)
  const host = await CliHost.create({
    cwd: resolve(process.cwd()),
    approval: 'deny',
    events: makeEvents(true),
    authorize: async () => false,
    env: process.env
  })

  const report = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    stateDir,
    project: resolve(process.cwd()),
    model: host.modelName,
    modelConfigured: host.hasModel,
    tools: host.toolIds().length,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY)
  }

  if (json) {
    write(JSON.stringify(report, null, 2))
    return 0
  }

  write('cryptoric doctor\n')
  write(`  node        ${report.node}`)
  write(`  platform    ${report.platform}`)
  write(`  state dir   ${report.stateDir}`)
  write(`  project     ${report.project}`)
  write(`  tools       ${report.tools}`)
  write(`  model       ${report.model ?? 'not configured (deterministic stages only)'}`)
  write(`  interactive ${report.interactive ? 'yes' : 'no — gated operations will be refused'}`)
  return 0
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))

  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`)
    process.stderr.write('Run `cryptoric help` for usage.\n')
    process.exitCode = EXIT_USAGE
    return
  }

  const command = parsed.command
  switch (command.kind) {
    case 'chat': {
      if (!process.stdin.isTTY) {
        process.stderr.write('cryptoric: the interactive session needs a terminal.\n')
        process.stderr.write('For a pipe or a script, use: cryptoric run "<task>"\n')
        process.exitCode = EXIT_USAGE
        return
      }
      const session = await Session.create({
        cwd: resolve(process.cwd()),
        chrome: chromeOptions(),
        allowApprovals: false,
        env: process.env,
        isTTY: Boolean(process.stderr.isTTY)
      })
      process.exitCode = await session.run()
      return
    }
    case 'help':
      write(HELP_TEXT)
      return
    case 'version':
      write(VERSION)
      return
    case 'run':
      process.exitCode = await commandRun(command)
      return
    case 'tools':
      process.exitCode = await commandTools(command.json)
      return
    case 'doctor':
      process.exitCode = await commandDoctor(command.json)
      return
    default: {
      const exhaustive: never = command
      throw new Error(`Unhandled command: ${JSON.stringify(exhaustive)}`)
    }
  }
}

// A rejection here must set the code rather than throw, because a rejected
// promise at the top level exits 1 with an unhandled-rejection banner that
// hides whatever actually went wrong.
main().catch((error: unknown) => {
  process.stderr.write(`cryptoric: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

// Re-exported so tests can assert the verdict mapping without a process.
export { verdictFor }