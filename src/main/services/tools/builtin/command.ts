/**
 * Command execution as a tool.
 *
 * Built on `runCaptured`, which already owns timeouts, cancellation and output
 * bounding. This module adds the two things a tool needs that a bare executor
 * does not: an argv-shaped schema, and permission handling that is derived from
 * the *actual* command rather than from a label the caller supplies.
 *
 * The Windows caveat is the interesting part. Node refuses to spawn a `.cmd` or
 * `.bat` without a shell, and the supported workaround is `cmd.exe /c`, which
 * parses metacharacters. Rather than paper over that with `shell: true` — which
 * turns every argument into syntax — arguments containing cmd metacharacters are
 * **refused**. That makes injection impossible rather than unlikely, and the
 * refusal names the offending argument so the agent can route around it.
 */

import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { z } from 'zod'
import type { PermissionDomain, ToolDescriptor } from '@shared/types'
import { checkPath, classifyCommand, tierRank } from '../../permissions/policy'
import { findExecutableOnPath } from '../../env/layers'
import { runCaptured } from '../exec'
import { describeSchema, type ToolContext, type ToolDefinition, type ToolResult } from '../registry'
import type { EnvironmentManager } from '../../env/manager'

export interface CommandToolDeps {
  env: EnvironmentManager
  /** Roots the command may run inside. Empty means nothing is permitted. */
  getRoots(): string[]
}

const fail = (
  summary: string,
  error: string,
  failureKind?: ToolResult['failureKind']
): ToolResult => ({
  ok: false,
  summary,
  error,
  ...(failureKind ? { failureKind } : {})
})

/**
 * Characters `cmd.exe` interprets.
 *
 * A batch file can only be executed through `cmd.exe`, so an argument
 * containing one of these would be parsed rather than passed. Refusing is the
 * only way to keep the argument data; quoting is not sufficient because cmd
 * expands these inside double quotes too.
 */
const CMD_METACHARACTERS = /[&|<>^%!"]/

/** Batch extensions that can only run through `cmd.exe` on Windows. */
const BATCH_EXTENSIONS = /\.(cmd|bat)$/i

/** Hard ceiling; a model cannot ask for an unbounded command. */
const MAX_TIMEOUT_MS = 600_000

/** Characters kept in captured output per stream. */
const MAX_OUTPUT_CHARS = 64 * 1024

export function buildCommandTools(deps: CommandToolDeps): ToolDefinition[] {
  const tool = (
    descriptor: ToolDescriptor,
    domain: PermissionDomain,
    schema: z.ZodTypeAny,
    execute: (input: never, ctx: ToolContext) => Promise<ToolResult>
  ): ToolDefinition => ({
    descriptor: {
      category: 'terminal',
      risk: 'medium',
      timeoutMs: MAX_TIMEOUT_MS,
      ...descriptor,
      platforms: ['*'],
      inputSchema: describeSchema(schema)
    },
    domain,
    schema,
    // No `dependsOn`. This tool used to declare `detect_runtime`, which is a
    // false claim: it never calls that tool, it resolves the executable itself
    // through `findExecutableOnPath`. The runtime enforces declared
    // dependencies, so the fiction made `run_command` fail outright anywhere
    // the environment tools were not registered alongside it.
    execute: execute as ToolDefinition['execute']
  })

  return [
    tool(
      {
        id: 'run_command',
        label: 'Run command',
        description:
          'Run a single command in the project and return its exit code, stdout and stderr. Pass the executable in `command` and every argument separately in `args` — never a shell string. Use this to install dependencies, run a build, run tests, or start a generator.',
        dependsOn: [],
        tier: 'elevated',
        inputSchema: {}
      },
      'terminal.elevated',
      z.object({
        command: z.string().min(1).describe('Executable name resolved on PATH, e.g. "npm" or "node"'),
        args: z.array(z.string()).default([]).describe('Arguments, passed verbatim as argv'),
        cwd: z
          .string()
          .optional()
          .describe('Working directory inside the project; defaults to the project root'),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe(`Abort after this long. Defaults to 120000, capped at ${MAX_TIMEOUT_MS}.`)
      }),
      async (input: { command: string; args?: string[]; cwd?: string; timeoutMs?: number }, ctx) => {
        const roots = deps.getRoots()
        if (roots.length === 0) {
          return fail('No project open', 'Open a project before running commands.', 'unavailable')
        }

        const cwdVerdict = checkPath(input.cwd ?? (roots[0] as string), roots)
        if (!cwdVerdict.allowed) {
          return fail('Working directory rejected', cwdVerdict.reason, 'permission-denied')
        }

        const args: string[] = Array.isArray(input.args) ? input.args : []

        // The tier is re-derived from the real argv. A caller cannot label
        // `rm -rf /` as something benign by calling a different tool or by
        // renaming a field.
        const verdict = classifyCommand(input.command, args)
        if (tierRank(verdict.tier) > tierRank('elevated')) {
          return fail(
            `Refused: ${verdict.reason}`,
            `This command classifies as "${verdict.tier}"${
              verdict.trigger ? ` because of "${verdict.trigger}"` : ''
            }, which this stage may not run. Run it yourself in a terminal if you are sure.`,
            'permission-denied'
          )
        }

        const environment = deps.env.environmentFor({ projectRoot: cwdVerdict.absolute })
        const resolved = resolveExecutable(input.command, environment)

        if (resolved === null) {
          return fail(
            `"${input.command}" is not on PATH`,
            `No executable named "${input.command}" was found in the current environment. Use detect_runtime or inspect_environment to see what is available.`,
            'dependency-missing'
          )
        }

        const batch = batchKindOf(resolved)
        const isBatch = batch !== null
        if (isBatch) {
          const offender = [input.command, ...args].find((a) => CMD_METACHARACTERS.test(a))
          if (offender !== undefined) {
            return fail(
              'Argument contains a shell metacharacter',
              `"${truncate(offender, 80)}" contains one of & | < > ^ % ! ". ` +
                `${batch} is a batch file and Windows can only run it through cmd.exe, ` +
                'which would interpret those characters. Rewrite the argument without them, or use write_file to create a script and pass its path.',
              'invalid-args'
            )
          }
        }

        const label = [input.command, ...args].join(' ')
        ctx.note(`$ ${label}`, 'info')

        // A batch file is exec'd by cmd.exe; everything else runs directly.
        //
        // The resolved absolute path is used rather than the bare name, so a
        // command still runs when the child's own PATH differs from the managed
        // environment this tool resolved against. And the whole command line is
        // wrapped in an extra pair of quotes, because `/s` makes cmd strip the
        // first and last quote of the argument — without the wrapper, a line
        // like `"npm" "--version"` loses its outer pair and cmd reports
        // `"npm"' is not recognized`, for a program that is plainly installed.
        const spawnCommand: string = isBatch ? resolveComSpec() : input.command
        const spawnArgs: string[] = isBatch
          ? ['/d', '/s', '/c', `"${[resolved, ...args].map(cmdQuote).join(' ')}"`]
          : args

        const result = await runCaptured(spawnCommand, spawnArgs, {
          cwd: cwdVerdict.absolute,
          env: environment,
          timeoutMs: input.timeoutMs ?? 120_000,
          signal: ctx.signal,
          maxOutputChars: MAX_OUTPUT_CHARS,
          // Only for the cmd.exe path. Node escapes quotes C-style (`"` becomes
          // `\"`) when it builds the command line, and cmd.exe does not
          // understand that — it reports `'"C:\path\npm.cmd"' is not
          // recognized` for a program that is plainly installed. Verbatim
          // arguments hand cmd exactly the line built above.
          ...(isBatch ? { spawn: { windowsVerbatimArguments: true } } : {})
        })

        const data = {
          command: label,
          cwd: cwdVerdict.absolute,
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          cancelled: result.cancelled
        }

        if (result.cancelled) {
          return fail(`${input.command} was cancelled`, `Stopped while running: ${label}`, 'cancelled')
        }
        if (result.timedOut) {
          return fail(
            `${input.command} timed out`,
            `Aborted after ${input.timeoutMs ?? 120_000}ms. Output so far:\n${truncate(result.stdout + result.stderr, 1500)}`,
            'timeout'
          )
        }
        if (result.spawnError) {
          return fail(`${input.command} could not start`, result.spawnError, 'unavailable')
        }

        const tail = truncate(`${result.stdout}${result.stderr}`, 1500).trim()
        return {
          ok: result.code === 0,
          summary:
            result.code === 0
              ? `${input.command} exited 0` +
                (tail ? ` — ${oneLine(tail)}` : '')
              : `${input.command} exited ${result.code}`,
          ...(result.code === 0 ? {} : { error: tail || `${input.command} exited ${result.code} with no output` }),
          data,
          exitCode: result.code
        }
      }
    )
  ]
}

/**
 * Locate the executable the way a child process would.
 *
 * `spawn` resolves the bare name itself, but resolving it here first is what
 * turns "ENOENT" into "this is not installed, here is what is" — which the
 * agent can act on instead of retrying blindly.
 *
 * The Windows branch matters more than it looks. `existsSync` on Windows applies
 * `PATHEXT`, so `existsSync('…\\npm')` is **true** when only `npm.cmd` exists.
 * Handing that extensionless path back would make `spawn` fail with ENOENT
 * while the program is sitting right there — the exact "command not found"
 * report the agent cannot act on. So the real on-disk name is resolved, and the
 * extension is what decides whether this is a batch file.
 */
function resolveExecutable(command: string, environment: Record<string, string>): string | null {
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : null
  }

  const found = findExecutableOnPath(environment, command, (candidate) => existsSync(candidate))
  if (found === null) return null
  if (process.platform !== 'win32') return found

  // A caller may pass an absolute-ish path that already carries an extension.
  if (extname(found) !== '') return found

  for (const ext of PATHEXT_EXTENSIONS) {
    const withExt = `${found}${ext}`
    if (existsSync(withExt)) return withExt
  }
  return found
}

/** Extensions Windows treats as executable, in the order `PATHEXT` prefers. */
const PATHEXT_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD']

/**
 * The batch file this path is, or null.
 *
 * Only Windows needs this, and only `.cmd`/`.bat` can be exec'd through
 * `cmd.exe` — `.exe` spawns directly and must not go through a shell.
 */
function batchKindOf(resolved: string): string | null {
  if (process.platform !== 'win32') return null
  return BATCH_EXTENSIONS.test(resolved) ? resolved.split(/[\\/]/).pop() ?? resolved : null
}

function resolveComSpec(): string {
  return process.env['ComSpec'] ?? process.env['COMSPEC'] ?? 'cmd.exe'
}

/**
 * Quote one argument for a `cmd.exe /c` command line.
 *
 * Only reached for batch files, and only after the metacharacter check has
 * passed, so the remaining job is just whitespace and embedded quotes.
 */
function cmdQuote(arg: string): string {
  if (arg.length === 0) return '""'
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length} chars total)` : text
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}