/**
 * Git tools.
 *
 * The agent ships files, and until now it had no way to see what it changed or
 * to record it. Git was reachable from the status panel through IPC, which is a
 * UI affordance, not a capability: a task could rewrite six files and had no
 * `status`, no `diff` and no way to leave a checkpoint behind. That is the gap
 * this module closes.
 *
 * Everything here is a thin wrapper over `GitService`, which is where the real
 * rules live:
 *
 *  - **argv only, `shell: false`.** A branch name or commit message can never be
 *    interpreted as shell syntax, so a message containing `;` is a message.
 *  - **No history rewriting, ever.** `push`, `reset --hard`, `clean` and force
 *    are not exposed at any level, so a prompt-injected model cannot reach them
 *    by asking for a tool.
 *  - **Destructive git is not a tool.** `git.modify` is the highest domain this
 *    module declares.
 *
 * Two decisions are worth stating because the alternative looks reasonable:
 *
 *  1. A read that finds no repository is `ok: true`. "There is no git repository
 *     here" is a fact the tool successfully observed, not a failed operation —
 *     reporting it as an error would push the model toward retrying a check that
 *     can only ever answer the same way.
 *  2. A commit only ever stages what it was told to. The pre-flight checkpoint
 *     that stages everything is the existing `add -A` path and it stays behind
 *     `paths` being absent, because an agent that edited one file should not
 *     sweep an unrelated work-in-progress into its commit.
 */

import { z } from 'zod'
import type { PermissionDomain, ToolDescriptor } from '@shared/types'
import type { GitCommitEntry, GitService } from '../../git/service'
import { describeSchema, type ToolContext, type ToolDefinition, type ToolResult } from '../registry'

/**
 * The slice of `GitService` these tools use.
 *
 * Structural rather than nominal so the module depends on four methods instead
 * of the whole service, and so a test can hand in a double without reshaping
 * anything that ships.
 */
export interface GitToolPort {
  isRepo(): Promise<boolean>
  status(): Promise<Awaited<ReturnType<GitService['status']>>>
  diff(path?: string): Promise<Awaited<ReturnType<GitService['diff']>>>
  log(limit?: number): Promise<GitCommitEntry[]>
  checkpoint(message?: string, paths?: string[]): Promise<Awaited<ReturnType<GitService['checkpoint']>>>
}

export interface GitToolDeps {
  git: GitToolPort
  /** Roots a diff path may name. Empty means no path may be named. */
  getRoots(): string[]
}

const TOOL_META: Record<
  string,
  Pick<ToolDescriptor, 'category' | 'risk'> & { timeoutMs: number; mutates: boolean }
> = {
  git_status: { category: 'git', risk: 'safe', timeoutMs: 30_000, mutates: false },
  git_diff: { category: 'git', risk: 'safe', timeoutMs: 60_000, mutates: false },
  git_log: { category: 'git', risk: 'safe', timeoutMs: 30_000, mutates: false },
  git_commit: { category: 'git', risk: 'medium', timeoutMs: 90_000, mutates: true }
}

const ok = (summary: string, data?: unknown): ToolResult => ({
  ok: true,
  summary,
  ...(data !== undefined ? { data } : {})
})

const fail = (
  summary: string,
  error: string,
  failureKind?: ToolResult['failureKind']
): ToolResult => ({ ok: false, summary, error, ...(failureKind ? { failureKind } : {}) })

/** Characters of a diff handed back to the model. */
const MAX_DIFF_CHARS = 24_000

/** A commit message is short. Anything longer is a paste, and is refused. */
const MAX_MESSAGE_CHARS = 2_000

export function buildGitTools(deps: GitToolDeps): ToolDefinition[] {
  const tool = (
    descriptor: ToolDescriptor,
    domain: PermissionDomain,
    schema: z.ZodTypeAny,
    execute: (input: never, ctx: ToolContext) => Promise<ToolResult>
  ): ToolDefinition => ({
    descriptor: {
      platforms: ['*'],
      ...TOOL_META[descriptor.id],
      ...descriptor,
      inputSchema: describeSchema(schema)
    },
    domain,
    schema,
    execute: execute as ToolDefinition['execute']
  })

  return [
    tool(
      {
        id: 'git_status',
        label: 'Git status',
        description:
          'Report the repository state: current branch, upstream, commits ahead and behind, and every changed path with its index/worktree codes. Read-only. Use it before committing, and after a write to see what actually changed on disk.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'git.read',
      z.object({}),
      async () => {
        const status = await deps.git.status()
        if (!status.isRepo) {
          return ok('No git repository at the project root; nothing to report.', {
            isRepo: false,
            branch: null,
            clean: true,
            entries: []
          })
        }
        const staged = status.entries.filter((e) => e.staged).length
        const untracked = status.entries.filter((e) => e.index === '?' && e.worktree === '?').length
        const tracked = status.entries.length - untracked
        const tracking =
          status.upstream === null
            ? 'no upstream'
            : `${status.upstream} (+${status.ahead}/-${status.behind})`
        const summary = status.clean
          ? `On ${status.branch ?? 'detached HEAD'}, clean (${tracking})`
          : `On ${status.branch ?? 'detached HEAD'}, ${tracked} changed (${staged} staged)${untracked > 0 ? `, ${untracked} untracked` : ''} (${tracking})`
        return ok(summary, {
          isRepo: true,
          branch: status.branch,
          upstream: status.upstream,
          ahead: status.ahead,
          behind: status.behind,
          clean: status.clean,
          staged,
          untracked,
          entries: status.entries.map((e) => ({
            path: e.path,
            index: e.index,
            worktree: e.worktree,
            staged: e.staged
          }))
        })
      }
    ),

    tool(
      {
        id: 'git_diff',
        label: 'Git diff',
        description:
          'Return the unified diff of uncommitted changes, per file with added and removed line counts, plus the raw patch. Pass `path` to narrow it to one file. Read-only. Use it to check your own edit before reporting it, or to review a change you were asked about.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'git.read',
      z.object({
        path: z.string().optional().describe('File or directory inside the project; defaults to the whole tree'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(120_000)
          .optional()
          .describe(`Cap on the raw patch text. Defaults to ${MAX_DIFF_CHARS}.`)
      }),
      async (input: { path?: string; maxChars?: number }) => {
        const isRepo = await deps.git.isRepo()
        if (!isRepo) {
          return ok('No git repository at the project root; there is no diff to show.', {
            isRepo: false,
            files: [],
            raw: ''
          })
        }

        let diff
        try {
          diff = await deps.git.diff(input.path)
        } catch (err) {
          // `GitService.diff` throws for a path outside the workspace. That is a
          // refusal the model can act on, so it is reported as a tool failure
          // with the reason intact rather than swallowed into an empty diff.
          return fail('Diff refused', err instanceof Error ? err.message : String(err), 'permission-denied')
        }

        const cap = input.maxChars ?? MAX_DIFF_CHARS
        const truncated = diff.raw.length > cap
        const raw = truncated ? `${diff.raw.slice(0, cap)}\n… (truncated; ${diff.raw.length} chars total)` : diff.raw

        if (diff.files.length === 0) {
          return ok('No uncommitted changes.', { isRepo: true, files: [], raw: '' })
        }

        const totals = diff.files.reduce(
          (acc, f) => ({ added: acc.added + f.additions, removed: acc.removed + f.deletions }),
          { added: 0, removed: 0 }
        )
        return ok(
          `${diff.files.length} file(s) changed, +${totals.added}/-${totals.removed}${truncated ? ' (patch truncated)' : ''}`,
          {
            isRepo: true,
            totals,
            truncated,
            files: diff.files.map((f) => ({
              path: f.path,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              binary: f.binary
            })),
            raw
          }
        )
      }
    ),

    tool(
      {
        id: 'git_log',
        label: 'Git log',
        description:
          'List the most recent commits, newest first, with sha, subject, author and date. Read-only. Use it to learn the conventions already in the repository before you add to them.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'git.read',
      z.object({
        limit: z.number().int().min(1).max(100).optional().describe('How many commits to return. Defaults to 15.')
      }),
      async (input: { limit?: number }) => {
        const isRepo = await deps.git.isRepo()
        if (!isRepo) {
          return ok('No git repository at the project root; there is no history to show.', {
            isRepo: false,
            commits: []
          })
        }
        const limit = input.limit ?? 15
        const commits = await deps.git.log(limit)
        if (commits.length === 0) {
          return ok('The repository has no commits yet.', { isRepo: true, commits: [] })
        }
        return ok(
          `${commits.length} commit(s) — newest: ${commits[0]?.short ?? ''} ${commits[0]?.subject ?? ''}`,
          { isRepo: true, commits }
        )
      }
    ),

    tool(
      {
        id: 'git_commit',
        label: 'Commit changes',
        description:
          'Stage and commit. Pass `paths` to commit only the files you changed; omit it to stage every change in the tree. Refuses an empty commit. This modifies the repository and is the one git tool that needs approval — the message you pass is the message recorded, so write it as a real commit subject.',
        dependsOn: ['git_status'],
        tier: 'ask',
        inputSchema: {}
      },
      'git.modify',
      z.object({
        message: z.string().min(1).max(MAX_MESSAGE_CHARS).describe('Commit subject, e.g. "fix: handle empty manifest"'),
        paths: z
          .array(z.string())
          .max(200)
          .optional()
          .describe('Paths to stage. Omit to commit every change currently in the working tree.')
      }),
      async (input: { message: string; paths?: string[] }, ctx) => {
        if (!(await deps.git.isRepo())) {
          return fail(
            'Not a git repository',
            'The open project is not a git repository, so there is nothing to commit. Use `git init` in a terminal first if the developer wants one.',
            'unavailable'
          )
        }

        const message = input.message.trim()
        if (message.length === 0) {
          return fail('Commit refused', 'The commit message was empty after trimming.', 'invalid-args')
        }

        ctx.note(`git commit — ${message.split('\n')[0]}`, 'info')
        const result = await deps.git.checkpoint(message, input.paths)
        if (!result.created) {
          return {
            ok: false,
            summary: 'Nothing was committed',
            error: result.error ?? 'git commit did not create a commit.',
            data: { created: false, message: result.message }
          }
        }
        ctx.note(`commit ${result.commit ?? ''}`, 'ok')
        return ok(`Committed ${result.commit ?? '(unknown sha)'} — ${message.split('\n')[0]}`, {
          created: true,
          commit: result.commit,
          message: result.message,
          scoped: input.paths !== undefined
        })
      }
    )
  ]
}
