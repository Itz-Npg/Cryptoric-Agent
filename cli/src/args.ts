/**
 * Argument parsing for the `cryptoric` CLI.
 *
 * Deliberately hand-written and dependency-free. A parser library would be
 * another thing to keep in sync between the desktop app and the CLI, and the
 * grammar here is six commands and a handful of flags.
 *
 * Pure: `parseArgs` maps argv to a value and never reads `process`, never
 * touches the filesystem, never exits. That is what makes it testable, and
 * what lets `index.ts` own the single exit path.
 */

export type ApprovalMode =
  /** Ask on stdin. The only safe default. */
  | 'prompt'
  /** Pre-approve everything. Explicit opt-in via --yes. */
  | 'allow'
  /** Refuse everything gated. Explicit opt-in via --deny. */
  | 'deny'

export interface RunCommand {
  kind: 'run'
  /** The task text. Joining argv means quoting is the shell's job, not ours. */
  task: string
  cwd: string
  approval: ApprovalMode
  /** Emit a machine-readable result object instead of prose. */
  json: boolean
  /** Provider override; null means "use the environment default". */
  provider: string | null
  endpoint: string | null
  model: string | null
  /** Wall-clock ceiling for the whole run, in ms. 0 means no CLI-imposed cap. */
  timeoutMs: number
}

export interface ToolsCommand {
  kind: 'tools'
  json: boolean
}

export interface DoctorCommand {
  kind: 'doctor'
  json: boolean
}

export interface HelpCommand {
  kind: 'help'
}

export interface VersionCommand {
  kind: 'version'
}

export type Command = RunCommand | ToolsCommand | DoctorCommand | HelpCommand | VersionCommand

export type ParseResult = { ok: true; command: Command } | { ok: false; error: string }

/**
 * Flags that take a value. Anything else beginning with `--` is treated as a
 * boolean switch, so an unknown flag is a hard error rather than a silent
 * no-op — a typo that quietly disables a safety flag is exactly the failure
 * mode this CLI must not have.
 */
const VALUE_FLAGS = new Set([
  '--cwd',
  '--provider',
  '--endpoint',
  '--model',
  '--timeout'
])

const BOOLEAN_FLAGS = new Set(['--yes', '--deny', '--json', '--help', '-h', '--version', '-v'])

export const HELP_TEXT = `cryptoric — Cryptoric Chan in your terminal

Usage:
  cryptoric run "<task>"        Run the agent pipeline on a task
  cryptoric tools               List the tools this CLI actually has
  cryptoric doctor              Report environment and configuration
  cryptoric help                This text

Run options:
  --cwd <dir>          Project root to work in (default: current directory)
  --yes                Pre-approve gated operations (dangerous)
  --deny               Refuse gated operations; gated work will report BLOCKED
  --json               Machine-readable output
  --provider <name>    Model provider override
  --endpoint <url>     Model endpoint override
  --model <id>         Model id override
  --timeout <seconds>  Wall-clock cap for the run (default: 1800)

Environment:
  CRYPTORIC_API_KEY       API key for the selected provider
  CRYPTORIC_PROVIDER      Provider name (default: openrouter)
  CRYPTORIC_ENDPOINT      Provider endpoint URL
  CRYPTORIC_MODEL         Model id
  CRYPTORIC_HOME          State directory (default: ~/.cryptoric)

Exit codes:
  0 COMPLETED   the task finished and changed something
  1 FAILED      the task ran and did not succeed
  2 BLOCKED     the task could not proceed without a decision
  3 CANCELLED   interrupted
  64 USAGE      the command line was wrong
`

const DEFAULT_TIMEOUT_MS = 1_800_000

export function parseArgs(argv: readonly string[]): ParseResult {
  if (argv.length === 0) return { ok: true, command: { kind: 'help' } }

  const first = argv[0] as string

  if (first === '--help' || first === '-h' || first === 'help') return { ok: true, command: { kind: 'help' } }
  if (first === '--version' || first === '-v' || first === 'version') {
    return { ok: true, command: { kind: 'version' } }
  }

  if (first === 'tools' || first === 'doctor') {
    const rest = argv.slice(1)
    for (const token of rest) {
      if (token === '--json') continue
      return { ok: false, error: `Unknown option for \`${first}\`: ${token}` }
    }
    return {
      ok: true,
      command: first === 'tools' ? { kind: 'tools', json: rest.includes('--json') } : { kind: 'doctor', json: rest.includes('--json') }
    }
  }

  if (first !== 'run') {
    return { ok: false, error: `Unknown command: ${first}. Run \`cryptoric help\` for usage.` }
  }

  const taskParts: string[] = []
  let cwd = process.cwd()
  let approval: ApprovalMode = 'prompt'
  let json = false
  let provider: string | null = null
  let endpoint: string | null = null
  let model: string | null = null
  let timeoutMs = DEFAULT_TIMEOUT_MS

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] as string

    // `--flag=value` is accepted because it is what muscle memory types, and
    // silently ignoring the `=value` half would be worse than not supporting it.
    const eq = token.startsWith('--') && token.includes('=') ? token.indexOf('=') : -1
    const name = eq === -1 ? token : token.slice(0, eq)
    const inlineValue = eq === -1 ? null : token.slice(eq + 1)

    if (VALUE_FLAGS.has(name)) {
      const value = inlineValue ?? argv[i + 1]
      if (value === undefined || (inlineValue === null && value.startsWith('--'))) {
        return { ok: false, error: `${name} needs a value.` }
      }
      if (inlineValue === null) i += 1

      if (name === '--cwd') cwd = value
      else if (name === '--provider') provider = value
      else if (name === '--endpoint') endpoint = value
      else if (name === '--model') model = value
      else if (name === '--timeout') {
        const seconds = Number(value)
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return { ok: false, error: `--timeout needs a positive number of seconds, got "${value}".` }
        }
        timeoutMs = Math.round(seconds * 1000)
      }
      continue
    }

    if (BOOLEAN_FLAGS.has(name)) {
      if (name === '--help' || name === '-h') return { ok: true, command: { kind: 'help' } }
      if (name === '--yes') approval = 'allow'
      else if (name === '--deny') approval = 'deny'
      else if (name === '--json') json = true
      continue
    }

    if (token.startsWith('-') && token !== '-') {
      return { ok: false, error: `Unknown option: ${token}` }
    }

    taskParts.push(token)
  }

  const task = taskParts.join(' ').trim()
  if (task.length === 0) {
    return { ok: false, error: 'Nothing to run. Try: cryptoric run "add a readme"' }
  }

  return { ok: true, command: { kind: 'run', task, cwd, approval, json, provider, endpoint, model, timeoutMs } }
}