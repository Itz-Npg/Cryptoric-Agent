/**
 * Worktree isolation.
 *
 * Two tasks in one folder already serialise, which stops them overwriting each
 * other while they run. That is a guarantee about *time*, and it leaves two
 * problems open: a task still writes into the developer's working tree — over
 * their uncommitted work, and into the same files they are editing — and once it
 * has finished there is no record of what it changed that can be reviewed apart
 * from everything else in flight.
 *
 * One `git worktree` per task answers both. The task gets a real checkout at a
 * commit, on its own branch, outside the project folder; every tool call it
 * makes resolves inside that checkout because the task's roots point at it; and
 * when the task ends the branch carries its work — reviewable, mergeable,
 * discardable — while the project folder was never touched.
 *
 * Three honest limits, stated here rather than discovered later:
 *
 *  - **The checkout starts at HEAD.** Uncommitted changes in the working tree
 *    are not carried over. That is the point of isolation, and it is why this is
 *    a setting rather than the default: a task meant to continue work in
 *    progress would not see it.
 *  - **It needs a repository with at least one commit.** There is nothing to
 *    branch from otherwise, and there is no honest way to fake one.
 *  - **The worktree is kept after the task ends.** Deleting it would delete the
 *    work; pruning is the developer's decision, so `remove` refuses a checkout
 *    with uncommitted changes unless it is forced.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runGit } from './runner'

export interface WorktreeHandle {
  /** Absolute path of the isolated checkout. */
  path: string
  /** Branch the task's work lands on. */
  branch: string
  /** The project the checkout was branched from. */
  projectRoot: string
}

export interface WorktreeManagerDeps {
  /**
   * Directory checkouts are created under.
   *
   * Deliberately not inside the project: a checkout in the repository would show
   * up in the developer's `git status`, and the first promise of this feature is
   * that the project folder is untouched.
   */
  baseDir: string
}

export interface WorktreeEntry {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  /** True for the repository's own working tree. */
  main: boolean
}

export type CreateResult = { ok: true; worktree: WorktreeHandle } | { ok: false; reason: string }

/** Branch prefix, so `git branch` groups the agent's checkouts together. */
export const BRANCH_PREFIX = 'cryptoric'

export class WorktreeManager {
  constructor(private readonly deps: WorktreeManagerDeps) {}

  /**
   * Check the project out at HEAD, on a new branch, for one task.
   *
   * The path and the branch are both derived from the task id, so two tasks in
   * one project can never be handed the same checkout, and a re-run of the same
   * task cannot silently reuse a directory that already contains work.
   */
  async create(input: { projectRoot: string; taskId: string; title?: string }): Promise<CreateResult> {
    const repo = input.projectRoot?.trim()
    if (!repo) return { ok: false, reason: 'No project is open, so there is nothing to check out.' }

    const inside = await runGit(['rev-parse', '--is-inside-work-tree'], repo, 8000)
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return { ok: false, reason: 'The open project is not a git repository, so it has no worktrees.' }
    }

    // An unborn HEAD (a repository with no commits) cannot be branched from.
    const head = await runGit(['rev-parse', '--verify', 'HEAD'], repo, 8000)
    if (head.code !== 0) {
      return { ok: false, reason: 'The repository has no commits yet, so there is no commit to branch from.' }
    }

    const slug = slugFor(input.title ?? '', input.taskId)
    const branch = await this.freeBranch(repo, `${BRANCH_PREFIX}/${slug}`)
    const path = this.freePath(slug)

    mkdirSync(dirname(path), { recursive: true })
    const added = await runGit(['worktree', 'add', '-b', branch, path, 'HEAD'], repo, 120_000)
    if (added.code !== 0) {
      // A failed `add` can still register the worktree and leave a half-written
      // directory behind. Keeping either would make a broken checkout
      // indistinguishable from a finished one to the next `list`, so nothing is
      // left behind on the way to reporting the failure.
      await runGit(['worktree', 'remove', '--force', path], repo, 30_000)
      await this.prune(repo)
      rmSync(path, { recursive: true, force: true })
      return { ok: false, reason: added.stderr.trim() || `git worktree add exited ${added.code}` }
    }

    return { ok: true, worktree: { path, branch, projectRoot: repo } }
  }

  /** Every checkout git knows about for this repository, the main one included. */
  async list(projectRoot: string): Promise<WorktreeEntry[]> {
    const repo = projectRoot?.trim()
    if (!repo) return []
    const listed = await runGit(['worktree', 'list', '--porcelain'], repo, 15_000)
    if (listed.code !== 0) return []

    const entries: WorktreeEntry[] = []
    let current: WorktreeEntry | null = null
    for (const raw of listed.stdout.split('\n')) {
      const line = raw.trimEnd()
      if (line.startsWith('worktree ')) {
        if (current) entries.push(current)
        current = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, main: false }
        continue
      }
      if (!current) continue
      if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line === 'detached') current.detached = true
      else if (line === 'bare') current.main = false
    }
    if (current) entries.push(current)

    // `git worktree list` prints the repository's own working tree first.
    return entries.map((entry, index) => ({ ...entry, main: index === 0 }))
  }

  /**
   * Does this checkout have work that a removal would destroy?
   *
   * Asked before removing rather than after, because `git worktree remove`
   * without `--force` deletes the directory and *then* reports that it refused.
   */
  async isDirty(path: string): Promise<boolean> {
    if (!existsSync(path)) return false
    const status = await runGit(['status', '--porcelain'], path, 15_000)
    return status.stdout.trim().length > 0
  }

  /**
   * Remove a checkout. Refuses to destroy uncommitted work unless forced.
   *
   * The branch is left in place either way: it is what makes the work
   * recoverable, so removing the directory must never be able to remove the
   * only copy of a change.
   */
  async remove(input: {
    projectRoot: string
    path: string
    force?: boolean
  }): Promise<{ ok: boolean; error: string | null }> {
    const repo = input.projectRoot?.trim()
    if (!repo) return { ok: false, error: 'No project is open.' }

    if (!input.force && (await this.isDirty(input.path))) {
      return {
        ok: false,
        error: `${input.path} has uncommitted changes. Commit them, or pass force to discard them.`
      }
    }

    const args = ['worktree', 'remove', ...(input.force ? ['--force'] : []), input.path]
    const removed = await runGit(args, repo, 30_000)
    if (removed.code !== 0) {
      // A directory deleted by hand is the common case here, and git reports it
      // as a failure with a message that reads like a bug. Clean the metadata
      // instead of returning a failure the caller can do nothing with.
      await this.prune(repo)
      if (!existsSync(input.path)) return { ok: true, error: null }
      return { ok: false, error: removed.stderr.trim() || `git worktree remove exited ${removed.code}` }
    }

    // The directory is gone at this point; a leftover empty parent is noise.
    try {
      rmSync(dirname(input.path), { recursive: false, force: false })
    } catch {
      // Not empty because another checkout lives there. That is the normal case.
    }
    return { ok: true, error: null }
  }

  /** Drop metadata for checkouts whose directories no longer exist. */
  async prune(projectRoot: string): Promise<void> {
    const repo = projectRoot?.trim()
    if (!repo) return
    await runGit(['worktree', 'prune'], repo, 30_000)
  }

  /** Remove every checkout this application created for a project. */
  async removeAll(projectRoot: string, options: { force?: boolean } = {}): Promise<{ removed: number; kept: number }> {
    const entries = await this.list(projectRoot)
    let removed = 0
    let kept = 0
    for (const entry of entries) {
      if (entry.main) continue
      if (!entry.branch?.startsWith(`${BRANCH_PREFIX}/`)) continue
      const result = await this.remove({ projectRoot, path: entry.path, force: options.force })
      if (result.ok) removed += 1
      else kept += 1
    }
    return { removed, kept }
  }

  /** A branch name that is free, derived from the task. */
  private async freeBranch(repo: string, base: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
      const exists = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], repo, 8000)
      if (exists.code !== 0) return candidate
    }
    // Falling back to a timestamp keeps this total: the alternative is returning
    // a name that is already taken and letting `git worktree add` fail.
    return `${base}-${Date.now().toString(36)}`
  }

  /** A directory under `baseDir` that is not already in use. */
  private freePath(slug: string): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = join(this.deps.baseDir, attempt === 0 ? slug : `${slug}-${attempt + 1}`)
      if (!existsSync(candidate)) return candidate
    }
    return join(this.deps.baseDir, `${slug}-${Date.now().toString(36)}`)
  }
}

/**
 * A directory/branch-safe name for a task.
 *
 * The task id is always included, so two tasks with the same title get different
 * checkouts; the title is only there to make the branch readable in
 * `git branch`. Unusable characters collapse to `-` rather than being stripped,
 * because `fix-auth-redirect` reads better than `fixauthredirect`.
 */
export function slugFor(title: string, taskId: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  const short = taskId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'task'
  return cleaned.length > 0 ? `${cleaned}-${short}` : `task-${short}`
}
