/**
 * Git service.
 *
 * Thin, argv-only wrapper around the `git` binary. Two rules hold throughout:
 *
 *  1. Every invocation uses `spawn` with an argv array and `shell: false`, so a
 *     branch name or commit message can never be interpreted as shell syntax.
 *  2. Destructive operations (`push`, `reset --hard`, `clean`, force) are not
 *     exposed at all in this build. Cryptoric can checkpoint and commit, but it
 *     will not rewrite history or publish without an explicit future feature.
 */

import { spawn } from 'node:child_process'
import type { FileChange, GitCheckpointResult, GitDiffResult, GitStatus } from '@shared/types'
import { checkPath } from '../permissions/policy'
import type { GitStatusEntry } from '@shared/types'

export type { GitCheckpointResult, GitDiffResult, GitStatus, GitStatusEntry }

export class GitService {
  constructor(private readonly getRoots: () => string[]) {}

  private root(): string | null {
    return this.getRoots()[0] ?? null
  }

  private run(args: string[], cwd: string, timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn('git', args, { cwd, shell: false, windowsHide: true })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill(), timeoutMs)
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
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 0, stdout, stderr })
      })
    })
  }

  async status(): Promise<GitStatus> {
    const cwd = this.root()
    if (!cwd) return emptyStatus()

    const inside = await this.run(['rev-parse', '--is-inside-work-tree'], cwd, 8000)
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return emptyStatus()

    const [branchRes, porcelain, upstreamRes] = await Promise.all([
      this.run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd),
      this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd, 8000)
    ])

    const branch = branchRes.code === 0 ? branchRes.stdout.trim() : null
    const upstream = upstreamRes.code === 0 ? upstreamRes.stdout.trim() : null

    let ahead = 0
    let behind = 0
    if (upstream) {
      const counts = await this.run(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], cwd, 8000)
      const parts = counts.stdout.trim().split(/\s+/)
      ahead = Number(parts[0] ?? 0)
      behind = Number(parts[1] ?? 0)
    }

    const entries = parsePorcelainZ(porcelain.stdout)

    return {
      isRepo: true,
      branch,
      upstream,
      ahead,
      behind,
      entries,
      clean: entries.length === 0
    }
  }

  /** Unified diff of the working tree (or of one path, validated to the workspace). */
  async diff(path?: string): Promise<GitDiffResult> {
    const cwd = this.root()
    if (!cwd) return { files: [], raw: '' }

    let target = '.'
    if (path) {
      const verdict = checkPath(path, this.getRoots())
      if (!verdict.allowed) throw new Error(`Path denied: ${verdict.reason}`)
      target = path
    }

    const result = await this.run(['diff', '--no-color', '--unified=3', '--', target], cwd, 25_000)
    const raw = result.stdout
    return { files: parseUnifiedDiff(raw), raw }
  }

  /**
   * Create a safety checkpoint before autonomous work: stage everything and
   * commit with a machine-authored message. Refuses to commit an empty tree.
   */
  async checkpoint(message?: string): Promise<GitCheckpointResult> {
    const cwd = this.root()
    if (!cwd) return { created: false, commit: null, message: '', error: 'No project open.' }

    const inside = await this.run(['rev-parse', '--is-inside-work-tree'], cwd, 8000)
    if (inside.code !== 0) return { created: false, commit: null, message: '', error: 'Not a git repository.' }

    await this.run(['add', '-A'], cwd, 30_000)
    const staged = await this.run(['diff', '--cached', '--name-only'], cwd, 15_000)
    if (!staged.stdout.trim()) {
      return { created: false, commit: null, message: '', error: 'Nothing to checkpoint — the working tree is clean.' }
    }

    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const body = message?.trim() || `chore: cryptoric checkpoint ${stamp}`
    // `--cleanup=strip` plus a fixed message means a message can never be
    // interpreted as an option or a shell fragment.
    const commit = await this.run(['commit', '--no-verify', '--cleanup=strip', '-m', body], cwd, 30_000)
    if (commit.code !== 0) {
      return { created: false, commit: null, message: body, error: commit.stderr.trim() || 'git commit failed' }
    }
    const sha = await this.run(['rev-parse', '--short', 'HEAD'], cwd, 8000)
    return { created: true, commit: sha.stdout.trim() || null, message: body, error: null }
  }

  /** Alias of `checkpoint` kept for the command palette's "Commit" entry point. */
  async commit(message: string): Promise<GitCheckpointResult> {
    return this.checkpoint(message)
  }
}

function emptyStatus(): GitStatus {
  return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, entries: [], clean: true }
}

/**
 * Parse `git status --porcelain -z`.
 *
 * Rename entries are `R  new\0old\0`, so the original path must be consumed or
 * the following entry is misattributed.
 */
export function parsePorcelainZ(raw: string): GitStatusEntry[] {
  const parts = raw.split('\0').filter((p) => p.length > 0)
  const entries: GitStatusEntry[] = []

  for (let i = 0; i < parts.length; i++) {
    const record = parts[i] as string
    if (record.length < 4) continue
    const index = record[0] as string
    const worktree = record[1] as string
    const file = record.slice(3)
    const staged = index !== ' ' && index !== '?'
    if (index === 'R' || index === 'C') {
      i += 1 // consume the original path of a rename/copy pair
    }
    entries.push({ path: file, index, worktree, staged })
  }
  return entries
}

/** Split a unified diff into per-file changes with line counts. */
export function parseUnifiedDiff(raw: string): FileChange[] {
  if (!raw.trim()) return []
  const files: FileChange[] = []
  const chunks = raw.split(/^diff --git /m).filter((c) => c.trim().length > 0)

  for (const chunk of chunks) {
    const headerMatch = /^a\/(.+?) b\/(.+)$/m.exec(chunk.split('\n')[0] ?? '')
    const path = headerMatch?.[2] ?? 'unknown'
    const lines = chunk.split('\n')
    let additions = 0
    let deletions = 0
    let binary = false
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
      else if (line.startsWith('Binary files')) binary = true
    }
    const status = /new file mode/.test(chunk)
      ? 'A'
      : /deleted file mode/.test(chunk)
        ? 'D'
        : /rename from/.test(chunk)
          ? 'R'
          : 'M'
    files.push({ path, status, additions, deletions, binary, patch: binary ? '' : chunk })
  }
  return files
}