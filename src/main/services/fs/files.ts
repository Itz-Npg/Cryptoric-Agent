/**
 * Filesystem service.
 *
 * Every path is resolved and checked against the open project's roots before any
 * read or write. The service never trusts a caller-supplied path — that is the
 * single most common traversal vector in a desktop agent.
 */

import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { FileContents, FileNode, FileSearchHit, FileWriteResult } from '@shared/types'
import { checkPath } from '../permissions/policy'

export type { FileNode }

/** Directories that are noise in a project tree and slow to walk. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'release', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '__pycache__', '.venv', 'venv',
  'target', '.gradle', '.idea', '.vscode-test', 'vendor', '.pytest_cache'
])

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.7z', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.mp4', '.mp3'
])

export class FileService {
  constructor(private readonly getRoots: () => string[]) {}

  private requirePath(target: string): string {
    const verdict = checkPath(target, this.getRoots())
    if (!verdict.allowed) throw new Error(`Path denied: ${verdict.reason}`)
    return verdict.absolute
  }

  async tree(root?: string, depth = 2): Promise<FileNode[]> {
    const base = root ? this.requirePath(root) : (this.getRoots()[0] ?? process.cwd())
    return this.walk(base, depth)
  }

  private async walk(dir: string, depth: number): Promise<FileNode[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }

    const nodes: FileNode[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
      const abs = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        nodes.push({
          name: entry.name,
          path: abs,
          kind: 'dir',
          size: 0,
          children: depth > 1 ? await this.walk(abs, depth - 1) : []
        })
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(abs).catch(() => null)
      nodes.push({ name: entry.name, path: abs, kind: 'file', size: info?.size ?? 0 })
    }

    // Directories first, then alphabetical — stable and scannable.
    return nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  async read(target: string): Promise<FileContents> {
    const abs = this.requirePath(target)
    const ext = extname(abs).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) {
      throw new Error(`${ext} is a binary file and cannot be opened in the editor.`)
    }
    const info = await stat(abs)
    if (info.size > 5_000_000) throw new Error('File is larger than the 5 MB edit limit.')
    const content = await readFile(abs, 'utf8')
    return { path: abs, content, binary: false }
  }

  async write(target: string, content: string): Promise<FileWriteResult> {
    const abs = this.requirePath(target)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return { path: abs, bytes: Buffer.byteLength(content, 'utf8') }
  }

  /** Substring / fuzzy filename search across the workspace, bounded. */
  async search(query: string, limit = 100): Promise<FileSearchHit[]> {
    const q = query.toLowerCase()
    const results: { path: string; name: string; matches: number }[] = []
    for (const root of this.getRoots()) {
      await this.searchDir(root, q, results, limit)
    }
    return results.sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name)).slice(0, limit)
  }

  private async searchDir(
    dir: string,
    q: string,
    out: { path: string; name: string; matches: number }[],
    limit: number
  ): Promise<void> {
    if (out.length >= limit) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      if (entry.name.startsWith('.')) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await this.searchDir(abs, q, out, limit)
      } else if (entry.isFile()) {
        const name = entry.name.toLowerCase()
        if (name.includes(q)) {
          out.push({ path: abs, name: entry.name, matches: name === q ? 100 : 1 })
          continue
        }
        if (BINARY_EXTENSIONS.has(extname(abs).toLowerCase())) continue
        const text = await readFile(abs, 'utf8').catch(() => null)
        if (!text || text.length > 2_000_000) continue
        const matches = countOccurrences(text.toLowerCase(), q)
        if (matches > 0) out.push({ path: abs, name: entry.name, matches })
      }
    }
  }

  /** Relative POSIX-style path, for display and diffs. */
  display(root: string, target: string): string {
    return relative(root, target).split(sep).join('/')
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
    if (count > 999) break
  }
  return count
}

function extname(p: string): string {
  const base = basename(p)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot)
}