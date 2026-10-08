import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyHunksToContent,
  buildPatchTools,
  contentFromCreateDiff,
  parsePatchHunks
} from '../../src/main/services/tools/builtin/patch'
import { PermissionPolicy, ApprovalQueue } from '../../src/main/services/permissions/policy'
import { ToolRegistry } from '../../src/main/services/tools/registry'
import { ToolRuntime } from '../../src/main/services/tools/runtime'

/**
 * The pure patch functions are tested directly, because every failure mode
 * worth having — ambiguous hunks, stale context, mixed formats — is a pure
 * property of (diff, content) and needs no disk. The tool itself is exercised
 * through a real directory the same way the filesystem tools are.
 */
let root = ''
let runtime: ToolRuntime
let approvals: ApprovalQueue

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
  root = mkdtempSync(join(tmpdir(), 'cryptoric-patch-'))
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'fib.py'), 'def fib(n):\n    if n <= 1:\n        return n\n    return fib(n-1) + fib(n-2)\n')
  writeFileSync(join(root, 'notes.txt'), 'alpha\nbeta\ngamma\n')
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')

  const rules = [
    { domain: 'fs.read', default: 'allow' },
    { domain: 'fs.write', default: 'allow' },
    { domain: 'fs.delete', default: 'allow' }
  ] as const

  const registry = new ToolRegistry()
  registry.registerAll(buildPatchTools({ getRoots: () => [root] }))
  approvals = new ApprovalQueue()
  runtime = new ToolRuntime({
    registry,
    policy: new PermissionPolicy([...rules]),
    approvals
  })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('parsePatchHunks', () => {
  it('splits hunks on @@ markers and ignores stale line numbers', () => {
    const parsed = parsePatchHunks('@@ -1,3 +1,3 @@\n-def fib(n):\n+def fibonacci(n):\n def fib(n):')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.hunks).toHaveLength(1)
    expect(parsed.hunks[0]?.expected).toEqual(['def fib(n):', 'def fib(n):'])
    expect(parsed.hunks[0]?.replacement).toEqual(['def fibonacci(n):'])
  })

  it('rejects a create-file style diff given to the update parser', () => {
    const parsed = parsePatchHunks('+just added\n')
    expect(parsed.ok).toBe(false)
  })

  it('rejects lines with no prefix marker', () => {
    const parsed = parsePatchHunks('@@\njust text\n')
    expect(parsed.ok).toBe(false)
  })
})

describe('applyHunksToContent', () => {
  it('replaces the matched region and keeps the rest', () => {
    const parsed = parsePatchHunks('@@\n-def fib(n):\n+def fibonacci(n):')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const applied = applyHunksToContent('def fib(n):\n    return n\n', parsed.hunks)
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.content).toBe('def fibonacci(n):\n    return n\n')
  })

  it('applies multiple hunks in order', () => {
    const parsed = parsePatchHunks('@@\n-alpha\n+ALPHA\n@@\n-gamma\n+GAMMA')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const applied = applyHunksToContent('alpha\nbeta\ngamma\n', parsed.hunks)
    if (!applied.ok) throw new Error(applied.error)
    expect(applied.content).toBe('ALPHA\nbeta\nGAMMA\n')
  })

  it('refuses a hunk whose context no longer matches', () => {
    const parsed = parsePatchHunks('@@\n-const gone = true\n+const here = true')
    if (!parsed.ok) throw new Error('parse failed')
    const applied = applyHunksToContent('const other = 1\n', parsed.hunks)
    expect(applied.ok).toBe(false)
  })

  it('refuses an ambiguous hunk instead of editing the wrong place', () => {
    const parsed = parsePatchHunks('@@\n-same\n+other')
    if (!parsed.ok) throw new Error('parse failed')
    const applied = applyHunksToContent('same\nmiddle\nsame\n', parsed.hunks)
    expect(applied.ok).toBe(false)
  })
})

describe('contentFromCreateDiff', () => {
  it('builds content from + lines', () => {
    const built = contentFromCreateDiff('@@\n+Hello world\n+second line')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.content).toBe('Hello world\nsecond line\n')
  })

  it('rejects - and context lines', () => {
    expect(contentFromCreateDiff('+keep\n-remove\n').ok).toBe(false)
  })
})

describe('apply_patch tool', () => {
  it('creates a new file from + lines', async () => {
    const result = await call('apply_patch', {
      operation: { type: 'create_file', path: 'created.txt', diff: '+first\n+second\n' }
    })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(root, 'created.txt'), 'utf8')).toBe('first\nsecond\n')
  })

  it('refuses to create over an existing file', async () => {
    const result = await call('apply_patch', {
      operation: { type: 'create_file', path: 'notes.txt', diff: '+x\n' }
    })
    expect(result.ok).toBe(false)
  })

  it('updates an existing file by hunk context', async () => {
    const result = await call('apply_patch', {
      operation: {
        type: 'update_file',
        path: 'notes.txt',
        diff: '@@\n-beta\n+BETA\n'
      }
    })
    expect(result.ok).toBe(true)
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n')
  })

  it('deletes a file by path', async () => {
    const result = await call('apply_patch', {
      operation: { type: 'delete_file', path: 'created.txt' }
    })
    expect(result.ok).toBe(true)
    expect(() => readFileSync(join(root, 'created.txt'), 'utf8')).toThrow()
  })

  it('refuses to patch inside managed directories', async () => {
    const result = await call('apply_patch', {
      operation: {
        type: 'update_file',
        path: 'node_modules/dep/index.js',
        diff: '@@\n-module.exports = 1\n-module.exports = 2\n'
      }
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('node_modules')
  })
})
