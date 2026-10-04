/**
 * Command execution primitive.
 *
 * Every tool that shells out goes through here rather than calling `spawn`
 * directly. Three reasons:
 *
 *  - **Bounded.** A command that hangs cannot hang the agent: a timeout aborts
 *    it and the caller gets a failure with an exit code, not a pending promise.
 *  - **Cancellable.** The caller's signal is honoured, so stopping a task stops
 *    the command rather than orphaning it.
 *  - **Captured.** Output is bounded in size, because a runaway `npm install`
 *    that prints a megabyte must not be able to exhaust the transcript.
 *
 * `shell: false` is not negotiable: arguments are passed as an array so a path
 * containing a space or a semicolon is data, never syntax.
 */

import { spawn, type SpawnOptions } from 'node:child_process'

export interface ExecOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Hard limit; defaults to 120s. */
  timeoutMs?: number
  /** Caller cancellation. */
  signal?: AbortSignal
  /** Called for each stdout chunk, for streaming into a terminal or artifact. */
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** Cap on captured stdout/stderr, in characters. */
  maxOutputChars?: number
  /** Extra spawn options, e.g. `windowsHide`. */
  spawn?: Omit<SpawnOptions, 'cwd' | 'env' | 'shell'>
}

export interface ExecResult {
  /** Exit code; 124 when the timeout fired, 130 when cancelled, 127 on spawn failure. */
  code: number
  stdout: string
  stderr: string
  /** True when output was longer than `maxOutputChars` and was truncated. */
  truncated: boolean
  durationMs: number
  timedOut: boolean
  cancelled: boolean
  /** Set when the executable could not be spawned at all. */
  spawnError?: string
}

const DEFAULT_MAX_OUTPUT = 256 * 1024

/** Run a command to completion, capturing output under a timeout. */
export function runCaptured(
  command: string,
  args: string[],
  options: ExecOptions
): Promise<ExecResult> {
  const started = Date.now()
  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        ...options.spawn
      })
    } catch (err) {
      resolve({
        code: 127,
        stdout: '',
        stderr: '',
        truncated: false,
        durationMs: Date.now() - started,
        timedOut: false,
        cancelled: false,
        spawnError: String(err)
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let cancelled = false
    let settled = false

    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString()
      options[target === 'stdout' ? 'onStdout' : 'onStderr']?.(text)
      if (target === 'stdout') {
        if (stdout.length >= maxChars) {
          truncated = true
          return
        }
        stdout += text
        if (stdout.length > maxChars) {
          stdout = stdout.slice(0, maxChars)
          truncated = true
        }
      } else {
        if (stderr.length >= maxChars) {
          truncated = true
          return
        }
        stderr += text
        if (stderr.length > maxChars) {
          stderr = stderr.slice(0, maxChars)
          truncated = true
        }
      }
    }

    const finish = (code: number, spawnError?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
        ...(spawnError ? { spawnError } : {})
      })
    }

    const kill = (): void => {
      if (child.exitCode === null) {
        // SIGTERM first so the child can clean up; the close handler still fires.
        child.kill()
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
      // If the child ignores SIGTERM, settle anyway rather than wait forever.
      setTimeout(() => finish(124), 2000).unref?.()
    }, options.timeoutMs ?? 120_000)
    timer.unref?.()

    function onAbort(): void {
      cancelled = true
      kill()
      setTimeout(() => finish(130), 2000).unref?.()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))

    child.on('error', (err) => finish(127, String(err)))
    child.on('close', (code) => finish(code ?? (timedOut ? 124 : cancelled ? 130 : 0)))
  })
}

/** True when an exit code indicates the command was never really run. */
export function isSpawnFailure(result: ExecResult): boolean {
  return result.code === 127 || result.spawnError !== undefined
}