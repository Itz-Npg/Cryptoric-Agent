import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildFilesystemTools,
  detectEncoding,
  filterTree,
  globToMatcher,
  looksBinary,
  PROTECTED_DIRECTORIES
} from '../../src/main/services/tools/builtin/filesystem'
import { PermissionPolicy } from '../../src/main/services/permissions/policy'
import { FileService } from '../../src/main/services/fs/files'
import { ToolRuntime } from '../../src/main/services/tools/runtime'
import { ToolRegistry } from '../../src/main/services/tools/registry'
import { ApprovalQueue } from '../../src/main/services/permissions/policy'

/**
 * The filesystem tools are exercised against a real directory on a real disk.
 * Mocking the filesystem here would test the mock; containment bugs in
 * particular only appear once `resolve`, `..` and symlinked separators are real.
 */
let root = ''
let runtime: ToolRuntime
let approvals: ApprovalQueue

/**
 * Invoke a tool the way the application does.
 *
 * Anything above the safe tier pauses for approval even when policy allows it —
 * that is the existing security stance, not a bug — so the harness answers the
 * prompt instead of pretending a user is present.
 */
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
  root = mkdtempSync(join(tmpdir(), 'cryptoric-fs-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# Project\nA test project.\n')
  writeFileSync(join(root, 'src', 'index.ts'), "export const answer = 42\nconst secret = 'hunter2'\n")
  writeFileSync(join(root, 'src', 'index.test.ts'), "import { answer } from './index'\n")
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(root, '.git', 'config'), '[core]\n')

  const rules = [
    { domain: 'fs.read', default: 'allow' },
    { domain: 'fs.write', default: 'allow' },
    { domain: 'fs.delete', default: 'allow' }
  ] as const

  const registry = new ToolRegistry()
  registry.registerAll(
    buildFilesystemTools({
      files: new FileService(() => [root]),
      policy: new PermissionPolicy([...rules]),
      getRoots: () => [root]
    })
  )
  approvals = new ApprovalQueue()
  runtime = new ToolRuntime({
    registry,
    policy: new PermissionPolicy([...rules]),
    approvals
  })
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('filesystem tools', () => {
  it('declares every tool with a category, risk, timeout and platforms', () => {
    for (const tool of buildFilesystemTools({
      files: new FileService(() => [root]),
      policy: new PermissionPolicy(),
      getRoots: () => [root]
    })) {
      expect(tool.descriptor.category).toBeTruthy()
      expect(tool.descriptor.risk).toBeTruthy()
      expect(tool.descriptor.timeoutMs).toBeGreaterThan(0)
      expect(tool.descriptor.platforms).toEqual(['*'])
    }
  })

  it('reads a file with line numbers', async () => {
    const result = await call('read_file', { path: join(root, 'src', 'index.ts') })
    expect(result.ok).toBe(true)
    const data = result.data as { content: string; totalLines: number }
    expect(data.totalLines).toBe(2)
    expect(data.content).toContain('export const answer = 42')
  })

  it('refuses a path that escapes the project root', async () => {
    const result = await call('read_file', { path: join(root, '..', '..', 'etc', 'passwd') })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/escapes|deny|workspace/i)
  })

  it('writes and then reads back a file', async () => {
    const target = join(root, 'src', 'written.ts')
    const write = await call('write_file', { path: target, content: 'export const x = 1\n' })
    expect(write.ok).toBe(true)
    const read = await call('read_file', { path: target })
    expect((read.data as { content: string }).content).toContain('export const x = 1')
  })

  it('reports whether a write created or overwrote', async () => {
    const target = join(root, 'src', 'overwrite.txt')
    const first = await call('write_file', { path: target, content: 'a' })
    expect((first.data as { created: boolean }).created).toBe(true)
    const second = await call('write_file', { path: target, content: 'ab' })
    expect((second.data as { created: boolean }).created).toBe(false)
  })

  it('appends without losing existing content', async () => {
    const target = join(root, 'src', 'append.txt')
    await call('write_file', { path: target, content: 'one\n' })
    await call('append_file', { path: target, content: 'two\n' })
    const read = await call('read_file', { path: target })
    expect((read.data as { content: string }).content).toContain('one')
    expect((read.data as { content: string }).content).toContain('two')
  })

  it('edits an exact unique string', async () => {
    const target = join(root, 'src', 'edit.txt')
    await call('write_file', { path: target, content: 'alpha beta gamma\n' })
    const result = await call('edit_file', {
      path: target,
      find: 'beta',
      replace: 'delta'
    })
    expect(result.ok).toBe(true)
    const read = await call('read_file', { path: target })
    expect((read.data as { content: string }).content).toContain('alpha delta gamma')
  })

  it('refuses an ambiguous edit rather than guessing which occurrence was meant', async () => {
    const target = join(root, 'src', 'ambiguous.txt')
    await call('write_file', { path: target, content: 'dup dup\n' })
    const result = await call('edit_file', {
      path: target,
      find: 'dup',
      replace: 'once'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/appears 2 times/i)
  })

  it('replaces every occurrence when explicitly asked', async () => {
    const target = join(root, 'src', 'all.txt')
    await call('write_file', { path: target, content: 'x x x\n' })
    const result = await call('edit_file', {
      path: target,
      find: 'x',
      replace: 'y',
      all: true
    })
    expect((result.data as { occurrences: number }).occurrences).toBe(3)
  })

  it('fails clearly when the text to replace is not there', async () => {
    const result = await call('edit_file', {
      path: join(root, 'src', 'index.ts'),
      find: 'text-that-does-not-exist',
      replace: 'x'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/does not appear/i)
  })

  it('refuses to delete a vendored directory', async () => {
    for (const dir of ['node_modules', '.git']) {
      const result = await call('delete_file', {
        path: join(root, dir),
        recursive: true
      })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/managed, not authored/i)
    }
  })

  it('refuses to delete a file inside a vendored directory', async () => {
    const result = await call('delete_file', {
      path: join(root, 'node_modules', 'left-pad', 'index.js')
    })
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('permission-denied')
  })

  it('deletes an ordinary project file', async () => {
    const target = join(root, 'src', 'to-delete.txt')
    await call('write_file', { path: target, content: 'x' })
    const result = await call('delete_file', { path: target })
    expect(result.ok).toBe(true)
    const exists = await call('file_exists', { path: target })
    expect((exists.data as { kind: string }).kind).toBe('missing')
  })

  it('requires an explicit opt-in before deleting a directory', async () => {
    const result = await call('delete_file', { path: join(root, 'src') })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/recursive=true/i)
  })

  it('keeps vendored directories out of search results', async () => {
    const result = await call('search_content', { query: 'module.exports|secret' })
    const data = result.data as { matches: { path: string }[] }
    expect(data.matches.some((m) => m.path.includes('node_modules'))).toBe(false)
    expect(data.matches.some((m) => m.path.includes('.git'))).toBe(false)
    expect(data.matches.some((m) => m.path.includes('index.ts'))).toBe(true)
  })

  it('finds files by glob', async () => {
    const result = await call('search_files', { pattern: '*.test.ts' })
    const data = result.data as { files: string[] }
    expect(data.files.some((f) => f.endsWith('index.test.ts'))).toBe(true)
    expect(data.files.some((f) => f.includes('node_modules'))).toBe(false)
  })

  it('reports an invalid regular expression instead of throwing', async () => {
    const result = await call('search_content', { query: '([unclosed' })
    expect(result.ok).toBe(false)
    expect(result.failureKind).toBe('invalid-args')
  })

  it('moves a file within the project', async () => {
    const from = join(root, 'src', 'movable.txt')
    const to = join(root, 'src', 'moved.txt')
    await call('write_file', { path: from, content: 'payload' })
    const result = await call('move_file', { from, to })
    expect(result.ok).toBe(true)
    const exists = await call('file_exists', { path: to })
    expect((exists.data as { kind: string }).kind).toBe('file')
  })

  it('creates a directory including missing parents', async () => {
    const result = await call('create_directory', {
      path: join(root, 'src', 'deep', 'nested')
    })
    expect(result.ok).toBe(true)
    const exists = await call('file_exists', { path: join(root, 'src', 'deep', 'nested') })
    expect((exists.data as { kind: string }).kind).toBe('dir')
  })

  it('reports file metadata without reading the whole file', async () => {
    const result = await call('file_metadata', { path: join(root, 'src', 'index.ts') })
    expect(result.ok).toBe(true)
    const data = result.data as {
      sizeBytes: number
      isBinary: boolean
      encoding: string
      modifiedAt: string
    }
    expect(data.sizeBytes).toBeGreaterThan(0)
    expect(data.isBinary).toBe(false)
    expect(data.encoding).toBe('utf-8')
    expect(data.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('redacts a secret that leaks through a file read into the transcript', async () => {
    const result = await call('read_file', { path: join(root, 'src', 'index.ts') })
    expect(result.summary).not.toContain('hunter2')
  })
})

describe('filesystem helpers', () => {
  it('protects the directories that are never authored by hand', () => {
    for (const dir of ['.git', 'node_modules', 'dist', 'build', 'target', 'venv', '.venv']) {
      expect(PROTECTED_DIRECTORIES).toContain(dir)
    }
  })

  it('filters vendored directories out of a tree', () => {
    const filtered = filterTree([
      { name: 'src', children: [] },
      { name: 'node_modules', children: [{ name: 'left-pad' }] },
      { name: 'README.md' }
    ])
    expect(filtered.map((n) => n.name)).toEqual(['src', 'README.md'])
  })

  it('matches globs and bare substrings', () => {
    expect(globToMatcher('*.test.ts')('index.test.ts')).toBe(true)
    expect(globToMatcher('*.test.ts')('index.ts')).toBe(false)
    expect(globToMatcher('index')('src/index.ts')).toBe(true)
    expect(globToMatcher('INDEX.TS')('index.ts')).toBe(true)
  })
})

describe('content classification', () => {
  it('treats source text as text', () => {
    expect(looksBinary(Buffer.from("export const answer = 42\nconst x = 'hi'\n"))).toBe(false)
  })

  it('treats a NUL-containing blob as binary', () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x47, 0x0d]))).toBe(true)
  })

  it('treats a mostly non-printable sample as binary', () => {
    // A gzip header: control bytes throughout.
    expect(looksBinary(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x03, 0x04]))).toBe(true)
    // Mostly printable text with a stray control character is still text; the
    // heuristic looks at the share of unprintable bytes, not their presence.
    expect(looksBinary(Buffer.from('const a = 1\n\tlet b = 2\r\nreturn a + b', 'utf8'))).toBe(false)
  })

  it('treats an empty sample as text rather than guessing', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false)
  })

  it('detects a byte order mark and otherwise assumes UTF-8', () => {
    expect(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('utf-8-bom')
    expect(detectEncoding(Buffer.from([0xff, 0xfe, 0x61]))).toBe('utf-16le')
    expect(detectEncoding(Buffer.from('plain', 'utf8'))).toBe('utf-8')
  })
})