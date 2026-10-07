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

import type { FileChange, GitCheckpointResult, GitDiffResult, GitStatus } from '@shared/types'
import { checkPath } from '../permissions/policy'
import { runGit } from './runner'
import type { GitStatusEntry } from '@shared/types'

export type { GitCheckpointResult, GitDiffResult, GitStatus, GitStatusEntry }

export class GitService {
  constructor(private readonly getRoots: () => string[]) {}

  private root(): string | null {
    return this.getRoots()[0] ?? null
  }

  /** Delegates to the shared runner: one implementation of "how git is run". */
  private run(args: string[], cwd: string, timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return runGit(args, cwd, timeoutMs)
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
   * Whether the open project is inside a work tree at all.
   *
   * Kept as its own call because every other method has to decide what "not a
   * repository" means, and doing that by inspecting a failed `status` parse is
   * how a wrong answer gets reported as a real one.
   */
  async isRepo(): Promise<boolean> {
    const cwd = this.root()
    if (!cwd) return false
    const inside = await this.run(['rev-parse', '--is-inside-work-tree'], cwd, 8000)
    return inside.code === 0 && inside.stdout.trim() === 'true'
  }

  /**
   * The most recent commits, newest first.
   *
   * `--format` with NUL separators rather than the default pretty format: a
   * commit subject can contain any character a human can type, including the
   * ones a line- and colon-delimited format would split on, and a parsed log
   * that silently mis-attributes a subject to the wrong sha is worse than no
   * log at all.
   */
  async log(limit = 15): Promise<GitCommitEntry[]> {
    const cwd = this.root()
    if (!cwd) return []
    const count = Math.max(1, Math.min(100, Math.floor(limit)))
    const result = await this.run(
      ['log', `--max-count=${count}`, '--no-color', '--format=%H%x00%h%x00%s%x00%an%x00%aI'],
      cwd,
      15_000
    )
    if (result.code !== 0) return []
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha, short, subject, author, date] = line.split('\u0000')
        return {
          sha: sha ?? '',
          short: short ?? '',
          subject: subject ?? '',
          author: author ?? '',
          date: date ?? ''
        }
      })
      .filter((entry) => entry.sha.length > 0)
  }

  /**
   * Create a safety checkpoint before autonomous work: stage and commit with a
   * message. Refuses to commit an empty tree.
   *
   * `paths` narrows what is staged. Without it this stages everything (`add
   * -A`), which is right for a pre-flight checkpoint and wrong for an agent
   * that edited one file and should not sweep an unrelated in-progress change
   * into its commit. Every path is validated against the workspace first, for
   * the same reason `diff` does it: a path is an argument the model chose.
   */
  async checkpoint(message?: string, paths?: string[]): Promise<GitCheckpointResult> {
    const cwd = this.root()
    if (!cwd) return { created: false, commit: null, message: '', error: 'No project open.' }

    const inside = await this.run(['rev-parse', '--is-inside-work-tree'], cwd, 8000)
    if (inside.code !== 0) return { created: false, commit: null, message: '', error: 'Not a git repository.' }

    const scoped: string[] = []
    for (const path of paths ?? []) {
      const verdict = checkPath(path, this.getRoots())
      if (!verdict.allowed) return { created: false, commit: null, message: '', error: `Path denied: ${verdict.reason}` }
      scoped.push(verdict.absolute)
    }

    // `--` ends option parsing, so a path that begins with `-` is a path.
    await this.run(scoped.length > 0 ? ['add', '--', ...scoped] : ['add', '-A'], cwd, 30_000)
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
  async commit(message: string, paths?: string[]): Promise<GitCheckpointResult> {
    return this.checkpoint(message, paths)
  }
}

/** One entry of `git log`, as parsed above. */
export interface GitCommitEntry {
  sha: string
  short: string
  subject: string
  author: string
  /** ISO 8601 author date. */
  date: string
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