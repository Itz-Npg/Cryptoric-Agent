/**
 * The one way this process runs `git`.
 *
 * Two rules, and they are the reason this is a module rather than a private
 * method: every invocation passes an argv array with `shell: false`, so a branch
 * name or commit message can never be interpreted as shell syntax, and every
 * invocation is bounded, so a git that hangs on a lockfile or a network
 * filesystem cannot hang a task.
 *
 * `GitService` and `WorktreeManager` both need this, and a second copy of it
 * would be a second set of rules to get wrong — the same argument that keeps
 * `run_tests` delegating to `runCommand`.
 */

import { spawn } from 'node:child_process'

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

export function runGit(args: string[], cwd: string, timeoutMs = 20_000): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: String(err) })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      // A killed child reports `code: null`, and reading that as 0 turns a
      // timeout into success — the one outcome a caller cannot recover from,
      // because a half-written `git worktree add` would then look finished. 124
      // is what `timeout(1)` uses for the same reason.
      if (timedOut) {
        resolve({
          code: 124,
          stdout,
          stderr: `${stderr}git ${args[0] ?? ''} did not finish within ${timeoutMs}ms and was killed.`.trim()
        })
        return
      }
      // Any other signal-terminated run is a failure too, not an exit 0.
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr })
    })
  })
}
