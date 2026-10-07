/**
 * Worktree isolation.
 *
 * Two things are being claimed, and they fail in opposite directions. The first
 * is that an isolated task's work goes somewhere the developer's folder does not
 * have to absorb: the checkout is real, outside the project, on its own branch,
 * and the project folder is byte-for-byte what it was. The second is that
 * isolation that *cannot* be honoured is refused rather than downgraded — a user
 * who turned it on did so to keep their working tree out of it, and quietly
 * running in the folder anyway would produce the exact outcome the setting exists
 * to prevent.
 *
 * Everything here runs against a real repository built in a temp directory and a
 * real `git worktree`. Faking `git` would test the fake: the parts most likely to
 * be wrong are the porcelain parse, the branch/path collision handling on a second
 * task, and what git does when a directory was deleted by hand.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { BRANCH_PREFIX, WorktreeManager, slugFor } from '../../src/main/services/git/worktree'
import { runGit } from '../../src/main/services/git/runner'
import { AgentRuntime, type SessionStart } from '../../src/main/services/agent/core'
import type { Stage } from '../../src/main/services/agent/pipeline-types'
import {
  ToolRegistry,
  type ToolContext,
  type ToolDefinition
} from '../../src/main/services/tools/registry'
import { ToolRuntime } from '../../src/main/services/tools/runtime'
import { SkillRegistry } from '../../src/main/services/skills/registry'
import { ApprovalQueue, PermissionPolicy } from '../../src/main/services/permissions/policy'
import type { AgentTask, PermissionRule } from '../../src/shared/types'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cryptoric-worktree-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function manager(): WorktreeManager {
  // Under the temp root and beside the repository, never inside it: a checkout in
  // the project is the one placement that would show up in `git status`.
  return new WorktreeManager({ baseDir: join(root, 'checkouts') })
}

/** A real repository with one commit — the smallest thing a worktree can branch from. */
async function makeRepo(name = 'project'): Promise<string> {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const git = (args: string[]): Promise<unknown> => runGit(args, dir, 30_000)
  await git(['init', '-q'])
  await git(['config', 'user.email', 'test@cryptoric.local'])
  await git(['config', 'user.name', 'Cryptoric Test'])
  await git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(dir, 'README.md'), '# project\n')
  await git(['add', '-A'])
  await git(['commit', '-q', '-m', 'initial'])
  return dir
}

async function porcelain(cwd: string): Promise<string> {
  const status = await runGit(['status', '--porcelain'], cwd, 15_000)
  return status.stdout.trim()
}

async function branches(cwd: string): Promise<string> {
  return (await runGit(['branch', '--list'], cwd, 15_000)).stdout
}

/** Poll until `predicate` holds, or fail. Never a fixed sleep. */
async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

// ------------------------------------------------------------------- runGit

describe('runGit', () => {
  it('reports a timeout as a failure rather than a silent success', async () => {
    const repo = await makeRepo()
    const started = Date.now()
    // `cat-file --batch` reads stdin and cannot finish before the deadline, so a
    // killed child is deterministic here instead of a race against a fast command.
    const result = await runGit(['cat-file', '--batch'], repo, 300)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result.code).toBe(124)
    expect(result.stderr).toMatch(/did not finish/i)
  })
})

// ------------------------------------------------------------- WorktreeManager

describe('WorktreeManager', () => {
  it('checks a task out on its own branch without touching the project folder', async () => {
    const repo = await makeRepo()
    const created = await manager().create({
      projectRoot: repo,
      taskId: '7c1f2a4e-1111',
      title: 'Fix the AUTH redirect'
    })

    expect(created.ok).toBe(true)
    if (!created.ok) return

    expect(existsSync(created.worktree.path)).toBe(true)
    expect(created.worktree.path.startsWith(repo)).toBe(false)
    expect(created.worktree.branch.startsWith(`${BRANCH_PREFIX}/`)).toBe(true)
    expect(created.worktree.branch).toContain('fix-the-auth-redirect')
    expect(await porcelain(repo)).toBe('')
    expect(await branches(repo)).toContain(created.worktree.branch)
  })

  it('keeps a file written in the checkout out of the project folder', async () => {
    const repo = await makeRepo()
    const worktrees = manager()
    const created = await worktrees.create({ projectRoot: repo, taskId: 'iso', title: 'Write a file' })
    if (!created.ok) throw new Error(created.reason)

    writeFileSync(join(created.worktree.path, 'agent.txt'), 'work\n')

    expect(existsSync(join(repo, 'agent.txt'))).toBe(false)
    // The dirty check is what `remove` consults, and it has to see the new file.
    expect(await worktrees.isDirty(created.worktree.path)).toBe(true)
    expect(await worktrees.isDirty(repo)).toBe(false)
  })

  it('refuses a folder that is not a repository, and a repository with no commits', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const notRepo = await manager().create({ projectRoot: plain, taskId: 'a', title: 'Nowhere' })
    expect(notRepo.ok).toBe(false)
    if (!notRepo.ok) expect(notRepo.reason).toMatch(/not a git repository/i)

    const empty = join(root, 'empty')
    mkdirSync(empty)
    await runGit(['init', '-q'], empty, 30_000)
    const noCommits = await manager().create({ projectRoot: empty, taskId: 'b', title: 'Nothing' })
    expect(noCommits.ok).toBe(false)
    if (!noCommits.ok) expect(noCommits.reason).toMatch(/no commits/i)
  })

  it('refuses when no project is open', async () => {
    const result = await manager().create({ projectRoot: '', taskId: 'a', title: 'Nowhere' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/no project/i)
  })

  it('gives two tasks in one project different checkouts and different branches', async () => {
    const repo = await makeRepo()
    const worktrees = manager()
    const first = await worktrees.create({ projectRoot: repo, taskId: 'one-aaaa', title: 'Same title' })
    const second = await worktrees.create({ projectRoot: repo, taskId: 'two-bbbb', title: 'Same title' })
    if (!first.ok) throw new Error(first.reason)
    if (!second.ok) throw new Error(second.reason)

    expect(first.worktree.path).not.toBe(second.worktree.path)
    expect(first.worktree.branch).not.toBe(second.worktree.branch)

    const entries = await worktrees.list(repo)
    expect(entries.filter((e) => e.main)).toHaveLength(1)
    expect(entries).toHaveLength(3)
    // `git worktree list` prints the repository's own tree first, and only that
    // one is off limits to `removeAll`.
    expect(entries[0]?.main).toBe(true)
  })

  it('refuses to remove a checkout with uncommitted work, then keeps the branch when forced', async () => {
    const repo = await makeRepo()
    const worktrees = manager()
    const created = await worktrees.create({ projectRoot: repo, taskId: 'keep', title: 'Work in progress' })
    if (!created.ok) throw new Error(created.reason)
    writeFileSync(join(created.worktree.path, 'wip.txt'), 'not committed\n')

    const refused = await worktrees.remove({ projectRoot: repo, path: created.worktree.path })
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/uncommitted/i)
    expect(existsSync(created.worktree.path)).toBe(true)

    const forced = await worktrees.remove({
      projectRoot: repo,
      path: created.worktree.path,
      force: true
    })
    expect(forced.ok).toBe(true)
    expect(existsSync(created.worktree.path)).toBe(false)
    // The directory is disposable; the branch is what makes work recoverable, so
    // removing the checkout must never be able to remove the only copy of it.
    expect(await branches(repo)).toContain(created.worktree.branch)
  })

  it('cleans up the metadata when a checkout was deleted by hand', async () => {
    const repo = await makeRepo()
    const worktrees = manager()
    const created = await worktrees.create({ projectRoot: repo, taskId: 'gone', title: 'Deleted by hand' })
    if (!created.ok) throw new Error(created.reason)
    rmSync(created.worktree.path, { recursive: true, force: true })

    const removed = await worktrees.remove({ projectRoot: repo, path: created.worktree.path })
    expect(removed.ok).toBe(true)
    expect(await worktrees.list(repo)).toHaveLength(1)
  })

  it('removes only the checkouts it created', async () => {
    const repo = await makeRepo()
    const worktrees = manager()
    const mine = await worktrees.create({ projectRoot: repo, taskId: 'mine', title: 'Ours' })
    if (!mine.ok) throw new Error(mine.reason)

    const handmade = join(root, 'checkouts', 'handmade')
    const added = await runGit(['worktree', 'add', '-b', 'handmade', handmade, 'HEAD'], repo, 60_000)
    expect(added.code).toBe(0)

    const result = await worktrees.removeAll(repo)
    expect(result.removed).toBe(1)
    expect(existsSync(mine.worktree.path)).toBe(false)
    // A checkout someone else created is not this application's to delete.
    expect(existsSync(handmade)).toBe(true)
  })

  it('derives a readable, filesystem-safe name for a task', () => {
    expect(slugFor('Fix the AUTH redirect!', 'task-1234-abcd')).toBe('fix-the-auth-redirect-task1234')
    expect(slugFor('', 'x')).toBe('task-x')
    const traversal = slugFor('../../etc/passwd', 'a')
    expect(traversal).not.toContain('/')
    expect(traversal).not.toContain('..')
    expect(slugFor('x'.repeat(200), 'a').length).toBeLessThan(64)
  })
})

// ------------------------------------------------------------- AgentRuntime

/** A tool that writes into whichever root the runtime resolved for the call. */
function writeTool(writes: string[]): ToolDefinition {
  return {
    descriptor: {
      id: 'test_write',
      label: 'test write',
      description: 'writes a file into the resolved project root',
      dependsOn: [],
      tier: 'safe',
      inputSchema: {},
      mutates: true
    },
    domain: 'fs.write',
    schema: z.object({ name: z.string().min(1), text: z.string() }),
    execute: async (input: { name: string; text: string }, ctx: ToolContext) => {
      if (!ctx.projectRoot) return { ok: false, summary: 'No project root' }
      writes.push(ctx.projectRoot)
      writeFileSync(join(ctx.projectRoot, input.name), input.text)
      return { ok: true, summary: `wrote ${input.name}` }
    }
  } as ToolDefinition
}

/** One stage that records the roots it was handed and then writes one file. */
function writeStage(seen: string[]): Stage {
  return {
    role: 'IMPLEMENTER',
    name: 'write',
    maxTier: 'safe',
    run: async (ctx) => {
      seen.push(...ctx.workspaceRoots)
      const result = await ctx.call('test_write', { name: 'agent.txt', text: 'from the agent\n' })
      return { continue: false, status: 'COMPLETED', summary: result.summary }
    }
  }
}

function harness(options: {
  stage: Stage
  isolation: boolean
  writes: string[]
  notes?: string[]
  beginSession?: (task: AgentTask) => Promise<SessionStart>
}): AgentRuntime {
  const tools = new ToolRegistry()
  tools.registerAll([writeTool(options.writes)])
  const rules: PermissionRule[] = [{ domain: 'fs.write', default: 'allow' }]

  return new AgentRuntime(
    {
      tools,
      runtime: new ToolRuntime({
        registry: tools,
        policy: new PermissionPolicy(rules),
        approvals: new ApprovalQueue()
      }),
      skills: new SkillRegistry(),
      skillTokenBudget: 6000,
      maxSkillsPerTask: 4,
      getProjectRoot: () => null,
      worktrees: manager(),
      worktreeIsolation: () => options.isolation,
      ...(options.beginSession ? { beginSession: options.beginSession } : {}),
      events: {
        timeline: (entry) => options.notes?.push(entry.message),
        task: () => undefined,
        toolResult: () => undefined,
        say: () => undefined
      }
    },
    [options.stage]
  )
}

describe('AgentRuntime with worktree isolation', () => {
  it('runs the task inside the checkout and leaves the project folder untouched', async () => {
    const repo = await makeRepo('isolated')
    const seen: string[] = []
    const writes: string[] = []
    const runtime = harness({ stage: writeStage(seen), isolation: true, writes })

    const task = runtime.submit({
      title: 'Write a file',
      prompt: 'write agent.txt',
      role: 'IMPLEMENTER',
      projectRoot: repo
    })

    await until(() => task.status === 'COMPLETED', 'task to complete')

    // Both the stage's context and the tool's own context resolved to the
    // checkout: one answer to "where does this task write".
    expect(seen).toHaveLength(1)
    const checkout = seen[0]
    if (!checkout) throw new Error('the stage was never given a workspace root')
    expect(checkout.startsWith(repo)).toBe(false)
    expect(writes).toEqual([checkout])
    expect(existsSync(join(checkout, 'agent.txt'))).toBe(true)
    expect(existsSync(join(repo, 'agent.txt'))).toBe(false)
    expect(await porcelain(repo)).toBe('')

    expect(task.worktree?.path).toBe(checkout)
    expect(task.worktree?.branch.startsWith(`${BRANCH_PREFIX}/`)).toBe(true)
    expect(runtime.worktreeOf(task.id)?.path).toBe(checkout)
  })

  it('runs in the project folder when isolation is off', async () => {
    const repo = await makeRepo('plain-run')
    const seen: string[] = []
    const runtime = harness({ stage: writeStage(seen), isolation: false, writes: [] })

    const task = runtime.submit({
      title: 'Write a file',
      prompt: 'write agent.txt',
      role: 'IMPLEMENTER',
      projectRoot: repo
    })

    await until(() => task.status === 'COMPLETED', 'task to complete')

    expect(seen).toEqual([repo])
    expect(existsSync(join(repo, 'agent.txt'))).toBe(true)
    expect(task.worktree ?? null).toBeNull()
    expect(runtime.worktreeOf(task.id)).toBeNull()
  })

  it('blocks a task it cannot isolate, before any session is bought', async () => {
    const plain = join(root, 'not-a-repo')
    mkdirSync(plain)
    const seen: string[] = []
    const notes: string[] = []
    let sessionsAsked = 0
    const runtime = harness({
      stage: writeStage(seen),
      isolation: true,
      writes: [],
      notes,
      beginSession: async () => {
        sessionsAsked += 1
        return { ok: false, error: 'should never be reached' }
      }
    })

    const task = runtime.submit({
      title: 'Write a file',
      prompt: 'write agent.txt',
      role: 'IMPLEMENTER',
      projectRoot: plain
    })

    await until(() => task.status === 'BLOCKED', 'task to be blocked')

    expect(task.error).toMatch(/not a git repository/i)
    expect(notes.some((n) => /not a git repository/i.test(n))).toBe(true)
    // Refusing is not the same as failing after spending: nothing ran, and no
    // coins were bought for it.
    expect(sessionsAsked).toBe(0)
    expect(seen).toEqual([])
    expect(existsSync(join(plain, 'agent.txt'))).toBe(false)
  })

  it('reuses the same checkout when a task is resumed', async () => {
    const repo = await makeRepo('resumed')
    const seen: string[] = []
    const writes: string[] = []
    const runtime = harness({ stage: writeStage(seen), isolation: true, writes })

    const task = runtime.submit({
      title: 'Write a file',
      prompt: 'write agent.txt',
      role: 'IMPLEMENTER',
      projectRoot: repo
    })
    await until(() => task.status === 'COMPLETED', 'first run to complete')

    // `resume` only accepts a paused task; a second checkout here would strand the
    // first one's work on a branch nobody is looking at.
    task.status = 'PAUSED'
    runtime.resume(task.id)
    await until(() => seen.length === 2, 'second run to reach the stage')

    const entries = await manager().list(repo)
    expect(entries).toHaveLength(2)
    expect(writes).toEqual([seen[0], seen[0]])
  })
})
