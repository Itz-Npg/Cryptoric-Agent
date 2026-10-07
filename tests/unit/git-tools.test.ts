/**
 * The git tools, against a real repository on a real disk.
 *
 * Mocking git here would test the mock: the interesting behaviour is what
 * `git` actually prints — porcelain codes, a rename's second path, a diff's
 * added-line count — and every one of those is a parse this module depends on.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildGitTools } from '../../src/main/services/tools/builtin/git'
import { GitService } from '../../src/main/services/git/service'
import { ToolRegistry } from '../../src/main/services/tools/registry'
import { ToolRuntime } from '../../src/main/services/tools/runtime'
import { ApprovalQueue, PermissionPolicy, DEFAULT_PERMISSION_RULES } from '../../src/main/services/permissions/policy'

let root = ''
let plain = ''
let runtime: ToolRuntime
let approvals: ApprovalQueue

function git(args: string[], cwd = root): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** Invoke a tool the way the application does, answering any approval prompt. */
async function call(toolId: string, args: Record<string, unknown> = {}) {
  const pending = runtime.invoke(toolId, args, { grantedTier: 'destructive' })
  const watch = setInterval(() => {
    for (const request of approvals.list()) approvals.resolve(request.id, true)
  }, 2)
  try {
    return await pending
  } finally {
    clearInterval(watch)
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cryptoric-git-'))
  plain = mkdtempSync(join(tmpdir(), 'cryptoric-nogit-'))

  git(['init', '-q'])
  // Local identity and no signing: a machine with a global `commit.gpgsign` or
  // a missing user.email would otherwise make these tests fail for reasons that
  // have nothing to do with the code under test.
  git(['config', 'user.email', 'agent@example.invalid'])
  git(['config', 'user.name', 'Cryptoric Test'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['config', 'core.autocrlf', 'false'])

  writeFileSync(join(root, 'a.txt'), 'first\n')
  writeFileSync(join(root, 'b.txt'), 'second\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'chore: initial commit'])

  approvals = new ApprovalQueue()
  const registry = new ToolRegistry()
  registry.registerAll(
    buildGitTools({
      git: new GitService(() => [root]),
      getRoots: () => [root]
    })
  )
  runtime = new ToolRuntime({
    registry,
    policy: new PermissionPolicy(DEFAULT_PERMISSION_RULES),
    approvals
  })
})

afterAll(() => {
  for (const dir of [root, plain]) if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('git tools', () => {
  it('reports a clean tree on the current branch', async () => {
    const result = await call('git_status')
    expect(result.ok).toBe(true)
    const data = result.data as { isRepo: boolean; clean: boolean; branch: string | null }
    expect(data.isRepo).toBe(true)
    expect(data.clean).toBe(true)
    expect(data.branch).toBeTruthy()
    expect(result.summary).toMatch(/clean/)
  })

  it('answers "not a repository" as a fact, not as a failure', async () => {
    // A tool that errored here would push the model to retry a check that can
    // only ever answer the same way.
    const registry = new ToolRegistry()
    registry.registerAll(buildGitTools({ git: new GitService(() => [plain]), getRoots: () => [plain] }))
    const local = new ToolRuntime({ registry, policy: new PermissionPolicy(DEFAULT_PERMISSION_RULES), approvals: new ApprovalQueue() })
    const result = await local.invoke('git_status', {}, { grantedTier: 'safe' })
    expect(result.ok).toBe(true)
    expect((result.data as { isRepo: boolean }).isRepo).toBe(false)
    expect(result.summary).toMatch(/No git repository/)
  })

  it('lists a changed file with its staged and untracked counts', async () => {
    writeFileSync(join(root, 'a.txt'), 'first\nsecond line\n')
    writeFileSync(join(root, 'untracked.txt'), 'new\n')

    const result = await call('git_status')
    const data = result.data as {
      clean: boolean
      untracked: number
      entries: { path: string; staged: boolean }[]
    }
    expect(data.clean).toBe(false)
    expect(data.untracked).toBe(1)
    expect(data.entries.map((e) => e.path)).toContain('a.txt')
    expect(data.entries.find((e) => e.path === 'a.txt')?.staged).toBe(false)
  })

  it('shows the added line in a diff, with counts', async () => {
    const result = await call('git_diff')
    expect(result.ok).toBe(true)
    const data = result.data as {
      totals: { added: number; removed: number }
      files: { path: string; additions: number }[]
      raw: string
    }
    expect(data.totals.added).toBeGreaterThan(0)

    const scoped = await call('git_diff', { path: 'a.txt' })
    const scopedData = scoped.data as { files: { path: string }[]; raw: string }
    expect(scopedData.files.map((f) => f.path)).toEqual(['a.txt'])
    expect(scopedData.raw).toContain('second line')
  })

  it('refuses a diff path outside the workspace', async () => {
    const outside = resolve(root, '..', 'not-ours.txt')
    const result = await call('git_diff', { path: outside })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/denied|escapes/i)
  })

  it('returns the commit history newest first', async () => {
    const result = await call('git_log', { limit: 5 })
    expect(result.ok).toBe(true)
    const data = result.data as { commits: { sha: string; subject: string; author: string }[] }
    expect(data.commits[0]?.subject).toBe('chore: initial commit')
    expect(data.commits[0]?.author).toBe('Cryptoric Test')
    expect(data.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('commits only the paths it was given', async () => {
    writeFileSync(join(root, 'a.txt'), 'first\nsecond line\nthird\n')
    writeFileSync(join(root, 'b.txt'), 'second\nchanged\n')

    const result = await call('git_commit', { message: 'test: touch only a', paths: ['a.txt'] })
    expect(result.ok).toBe(true)
    expect(result.summary).toMatch(/test: touch only a/)

    const status = await call('git_status')
    const data = status.data as { entries: { path: string; staged: boolean }[]; clean: boolean }
    // b.txt is still modified and unstaged — the commit did not sweep it in.
    expect(data.clean).toBe(false)
    expect(data.entries.map((e) => e.path)).toContain('b.txt')
    expect(data.entries.find((e) => e.path === 'b.txt')?.staged).toBe(false)
    expect(data.entries.map((e) => e.path)).not.toContain('a.txt')

    const log = await call('git_log', { limit: 1 })
    expect((log.data as { commits: { subject: string }[] }).commits[0]?.subject).toBe('test: touch only a')
  })

  it('refuses a commit path outside the workspace', async () => {
    const result = await call('git_commit', {
      message: 'test: escape',
      paths: [resolve(root, '..', 'other.txt')]
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Path denied/i)
  })

  it('refuses to commit when there is nothing to commit', async () => {
    await call('git_commit', { message: 'test: finish b.txt' })
    const status = await call('git_status')
    expect((status.data as { clean: boolean }).clean).toBe(true)

    const result = await call('git_commit', { message: 'test: empty' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Nothing to checkpoint|working tree is clean/i)
  })

  it('refuses an empty message rather than creating a blank commit', async () => {
    writeFileSync(join(root, 'c.txt'), 'third\n')
    const result = await call('git_commit', { message: '   ' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/empty/i)
    // The change is still there — nothing was swallowed.
    const status = await call('git_status')
    expect((status.data as { entries: { path: string }[] }).entries.map((e) => e.path)).toContain('c.txt')
  })
})
