/**
 * Filesystem tools.
 *
 * The agent's most-used capability, and the one with the sharpest edges: a
 * wrong path here destroys work. Three rules keep that contained, and all three
 * live in this module rather than in each tool body:
 *
 *  1. **Containment** — every path is resolved and checked against the open
 *     project's roots before it is touched. `checkPath` rejects traversal,
 *     sibling-prefix tricks, Windows device paths and null bytes.
 *  2. **Protection** — directories that are generated or vendored are refused
 *     for destructive operations outright. `node_modules` is not the user's
 *     code; deleting it is never what "clean up" meant.
 *  3. **Ignore** — listings and searches honour `.gitignore` and a small set of
 *     built-in noise directories, so a search returns the project rather than
 *     its dependencies.
 *
 * Reads are cheap and safe, so they run under a lower tier than writes; the
 * split means a read-heavy task never trips an approval prompt.
 */

import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { PermissionDomain, ToolDescriptor } from '@shared/types'
import { checkPath, type PermissionPolicy } from '../../permissions/policy'
import type { FileService } from '../../fs/files'
import type { ToolContext, ToolDefinition, ToolResult } from '../registry'
import { describeSchema } from '../registry'

export interface FilesystemToolDeps {
  files: FileService
  policy: PermissionPolicy
  /** Roots the agent may touch; empty means nothing is permitted. */
  getRoots(): string[]
}

const ok = (summary: string, data?: unknown): ToolResult => ({
  ok: true,
  summary,
  ...(data !== undefined ? { data } : {})
})

const fail = (summary: string, error: string, failureKind?: ToolResult['failureKind']): ToolResult => ({
  ok: false,
  summary,
  error,
  ...(failureKind ? { failureKind } : {})
})

/**
 * Directories that are never the user's authored work.
 *
 * Refused for deletion outright — silently wiping a dependency tree or a build
 * cache in response to "remove the unused files" is the kind of failure an
 * agent must not be able to cause.
 */
export const PROTECTED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'venv',
  '.venv',
  '__pycache__',
  '.next',
  '.nuxt',
  'vendor'
]

/**
 * Directories skipped when listing or searching, to keep results readable.
 *
 * Exported because the project tools walk the same tree and must skip exactly
 * the same set. Two lists would drift, and the symptom of drift is an
 * `analyze_project` that reports a project as 90% dependencies.
 */
export const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '.cache'
])

const TOOL_META: Record<
  string,
  Pick<ToolDescriptor, 'category' | 'risk'> & { timeoutMs: number; mutates: boolean }
> = {
  read_file: { category: 'files', risk: 'safe', timeoutMs: 30_000, mutates: false },
  write_file: { category: 'files', risk: 'medium', timeoutMs: 30_000, mutates: true },
  append_file: { category: 'files', risk: 'medium', timeoutMs: 30_000, mutates: true },
  edit_file: { category: 'files', risk: 'medium', timeoutMs: 30_000, mutates: true },
  list_directory: { category: 'files', risk: 'safe', timeoutMs: 60_000, mutates: false },
  create_directory: { category: 'files', risk: 'low', timeoutMs: 30_000, mutates: true },
  delete_file: { category: 'files', risk: 'high', timeoutMs: 30_000, mutates: true },
  move_file: { category: 'files', risk: 'medium', timeoutMs: 30_000, mutates: true },
  file_exists: { category: 'files', risk: 'safe', timeoutMs: 30_000, mutates: false },
  file_metadata: { category: 'files', risk: 'safe', timeoutMs: 30_000, mutates: false },
  search_content: { category: 'code', risk: 'safe', timeoutMs: 120_000, mutates: false },
  search_files: { category: 'files', risk: 'safe', timeoutMs: 120_000, mutates: false }
}

export function buildFilesystemTools(deps: FilesystemToolDeps): ToolDefinition[] {
  const { files, policy } = deps

  const tool = (
    descriptor: ToolDescriptor,
    domain: PermissionDomain,
    schema: z.ZodTypeAny,
    execute: (input: never, ctx: ToolContext) => Promise<ToolResult>,
    dependsOn?: string[]
  ): ToolDefinition => ({
    descriptor: {
      ...TOOL_META[descriptor.id],
      ...descriptor,
      platforms: descriptor.platforms ?? ['*'],
      inputSchema: describeSchema(schema)
    },
    domain,
    schema,
    dependsOn,
    execute: execute as ToolDefinition['execute']
  })

  /**
   * Resolve a path for use, or explain why it cannot be used.
   *
   * Every tool funnels through this so containment is checked in exactly one
   * place. A tool that forgot to call it would be a containment bug, which is
   * why the guard is a function rather than a convention.
   */
  const guard = (target: string): { ok: true; absolute: string } | { ok: false; error: string } => {
    const roots = deps.getRoots()
    const verdict = checkPath(target, roots)
    if (!verdict.allowed) return { ok: false, error: verdict.reason }
    return { ok: true, absolute: verdict.absolute }
  }

  /** True when the path sits inside a directory the agent may never destroy. */
  const protectedReason = (absolute: string): string | null => {
    const normalized = absolute.toLowerCase().replace(/[\\/]+$/, '')
    for (const dir of PROTECTED_DIRECTORIES) {
      if (normalized.endsWith(`\\${dir}`) || normalized.endsWith(`/${dir}`) || normalized === dir) {
        return `${dir} is managed, not authored — deleting it is refused`
      }
      if (normalized.includes(`\\${dir}\\`) || normalized.includes(`/${dir}/`)) {
        return `${dir} is managed, not authored — deleting inside it is refused`
      }
    }
    return null
  }

  return [
    // ------------------------------------------------------------- reading
    tool(
      {
        id: 'read_file',
        label: 'Read file',
        description:
          'Read a UTF-8 text file from the open project and return its contents with line numbers.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'fs.read',
      z.object({
        path: z.string().min(1),
        startLine: z.number().int().min(1).optional(),
        maxLines: z.number().int().min(1).max(2000).optional()
      }),
      async (input: { path: string; startLine?: number; maxLines?: number }) => {
        const checked = guard(input.path)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')

        const contents = await files.read(checked.absolute)
        if (contents.binary) {
          return fail(
            `${basename(contents.path)} is binary`,
            'This file is binary; read it with a tool that understands its format instead.',
            'failed'
          )
        }
        // A trailing newline terminates the last line rather than starting an empty
        // one, so line numbers match what an editor shows.
        const normalised = contents.content.endsWith('\n')
          ? contents.content.slice(0, -1)
          : contents.content
        const allLines = normalised.length === 0 ? [] : normalised.split('\n')
        const from = (input.startLine ?? 1) - 1
        const slice = allLines.slice(from, input.maxLines ? from + input.maxLines : undefined)
        const numbered = slice
          .map((line, i) => `${String(from + i + 1).padStart(5, ' ')}  ${line}`)
          .join('\n')
        return ok(`Read ${contents.path} (${allLines.length} lines)`, {
          path: contents.path,
          totalLines: allLines.length,
          content: numbered,
          truncated: slice.length < allLines.length
        })
      }
    ),

    tool(
      {
        id: 'list_directory',
        label: 'List directory',
        description:
          'List a directory in the project, skipping vendored and generated directories so the result is the project rather than its dependencies.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'fs.read',
      z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(5).optional() }),
      async (input: { path?: string; depth?: number }) => {
        const target = input.path ?? deps.getRoots()[0]
        if (!target) return fail('No project open', 'Open a project to list its files.', 'unavailable')
        const checked = guard(target)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')

        const root = input.path ? checked.absolute : (deps.getRoots()[0] as string)
        const entries = await files.tree(root, input.depth ?? 1)
        const shown = filterTree(entries)
        return ok(`Listed ${shown.length} entries under ${root}`, { root, entries: shown })
      }
    ),

    tool(
      {
        id: 'file_exists',
        label: 'File exists',
        description: 'Report whether a path exists inside the project, and what kind of entry it is.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'fs.read',
      z.object({ path: z.string().min(1) }),
      async (input: { path: string }) => {
        const checked = guard(input.path)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')
        try {
          const info = await stat(checked.absolute)
          return ok(`${checked.absolute} exists`, {
            path: checked.absolute,
            kind: info.isDirectory() ? 'dir' : 'file',
            size: info.size,
            modifiedAt: info.mtime.toISOString()
          })
        } catch {
          return ok(`${checked.absolute} does not exist`, { path: checked.absolute, kind: 'missing' })
        }
      }
    ),

    tool(
      {
        id: 'file_metadata',
        label: 'File metadata',
        description:
          'Return size, timestamps, type and whether a file looks binary, reading only a small prefix rather than the whole file.',
        dependsOn: ['file_exists'],
        tier: 'safe',
        inputSchema: {}
      },
      'fs.read',
      z.object({ path: z.string().min(1) }),
      async (input: { path: string }) => {
        const checked = guard(input.path)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')
        try {
          const info = await stat(checked.absolute)
          const isDirectory = info.isDirectory()
          // A prefix is enough to classify binary content; reading a whole
          // multi-gigabyte artefact to answer "is this binary" is not.
          const probe = isDirectory
            ? Buffer.alloc(0)
            : await readPrefix(checked.absolute, BINARY_PROBE_BYTES)
          return ok(`${basename(checked.absolute)}: ${info.size} bytes`, {
            path: checked.absolute,
            extension: extname(checked.absolute),
            sizeBytes: info.size,
            createdAt: info.birthtime.toISOString(),
            modifiedAt: info.mtime.toISOString(),
            isDirectory,
            isBinary: isDirectory ? false : looksBinary(probe),
            /** Only meaningful for text files; used to choose a decoder. */
            encoding: isDirectory ? null : detectEncoding(probe)
          })
        } catch (err) {
          return fail(
            'Could not stat file',
            err instanceof Error ? err.message : String(err),
            'failed'
          )
        }
      }
    ),

    // ------------------------------------------------------------- writing
    tool(
      {
        id: 'write_file',
        label: 'Write file',
        description:
          'Create or overwrite a text file, creating parent directories as needed. Overwrites are reported so the agent can diff what it replaced.',
        dependsOn: ['read_file'],
        tier: 'ask',
        inputSchema: {}
      },
      'fs.write',
      z.object({ path: z.string().min(1), content: z.string() }),
      async (input: { path: string; content: string }) => {
        const checked = guard(input.path)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')

        const existing = await readTextIfPresent(checked.absolute)
        await mkdir(dirnameOf(checked.absolute), { recursive: true })
        await writeFile(checked.absolute, input.content, 'utf8')
        return ok(
          existing === null
            ? `Created ${checked.absolute} (${input.content.length} chars)`
            : `Overwrote ${checked.absolute} (${existing.length} → ${input.content.length} chars)`,
          { path: checked.absolute, created: existing === null, bytes: Buffer.byteLength(input.content) }
        )
      }
    ),

    tool(
      {
        id: 'append_file',
        label: 'Append to file',
        description: 'Append text to an existing file, creating it when absent.',
        dependsOn: ['write_file'],
        tier: 'ask',
        inputSchema: {}
      },
      'fs.write',
      z.object({ path: z.string().min(1), content: z.string() }),
      async (input: { path: string; content: string }) => {
        const checked = guard(input.path)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')
        const existing = (await readTextIfPresent(checked.absolute)) ?? ''
        await mkdir(dirnameOf(checked.absolute), { recursive: true })
        await writeFile(checked.absolute, existing + input.content, 'utf8')
        return ok(`Appended ${input.content.length} chars to ${checked.absolute}`, {
          path: checked.absolute,
          totalLength: existing.length + input.content.length
        })
      }
    ),

    tool(
      {
        id: 'edit_file',
        label: 'Edit file',
        description:
          'Replace an exact, unique string in a file. Refuses when the text appears more than once, so the agent cannot silently edit the wrong occurrence.',
        dependsOn: ['read_file'],
        tier: 'ask',
        inputSchema: {}
      },
      'fs.write',
      z.object({
        path: z.string().min(1),
        find: z.string().min(1),
        replace: z.string(),
        all: z.boolean().optional().describe('Replace every occurrence instead of requiring uniqueness')
      }),
      async (input: { path: string; find: string; replace: string; all?: boolean }) => {
        const checked = guard(input.path)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')
        const content = await readTextIfPresent(checked.absolute)
        if (content === null) {
          return fail('File not found', `${checked.absolute} does not exist.`, 'failed')
        }

        const occurrences = countOccurrences(content, input.find)
        if (occurrences === 0) {
          return fail(
            'Text not found',
            `The exact text to replace does not appear in ${basename(checked.absolute)}. Read the file first and copy the text exactly.`,
            'failed'
          )
        }
        if (occurrences > 1 && !input.all) {
          return fail(
            'Ambiguous edit',
            `The text appears ${occurrences} times. Include more surrounding context, or pass all=true to replace every occurrence.`,
            'invalid-args'
          )
        }

        const updated =
          occurrences === 1
            ? content.replace(input.find, () => input.replace)
            : content.split(input.find).join(input.replace)
        await writeFile(checked.absolute, updated, 'utf8')
        return ok(
          `Replaced ${input.all ? occurrences : 1} occurrence(s) in ${basename(checked.absolute)}`,
          { path: checked.absolute, occurrences, bytes: Buffer.byteLength(updated) }
        )
      }
    ),

    tool(
      {
        id: 'create_directory',
        label: 'Create directory',
        description: 'Create a directory, including any missing parents.',
        dependsOn: [],
        tier: 'ask',
        inputSchema: {}
      },
      'fs.write',
      z.object({ path: z.string().min(1) }),
      async (input: { path: string }) => {
        const checked = guard(input.path)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')
        await mkdir(checked.absolute, { recursive: true })
        return ok(`Created ${checked.absolute}`, { path: checked.absolute })
      }
    ),

    tool(
      {
        id: 'move_file',
        label: 'Move file',
        description: 'Move or rename a file within the project.',
        dependsOn: ['file_exists'],
        tier: 'ask',
        inputSchema: {}
      },
      'fs.write',
      z.object({ from: z.string().min(1), to: z.string().min(1) }),
      async (input: { from: string; to: string }) => {
        const source = guard(input.from)
        if (!source.ok) return fail('Path rejected', source.error, 'permission-denied')
        const destination = guard(input.to)
        if (!destination.ok) return fail('Path rejected', destination.error, 'permission-denied')

        await mkdir(dirnameOf(destination.absolute), { recursive: true })
        await rename(source.absolute, destination.absolute)
        return ok(`Moved ${basename(source.absolute)} → ${destination.absolute}`, {
          from: source.absolute,
          to: destination.absolute
        })
      }
    ),

    tool(
      {
        id: 'delete_file',
        label: 'Delete file',
        description:
          'Delete a file or directory inside the project. Refuses vendored and generated directories such as node_modules, .git and dist.',
        dependsOn: ['file_exists'],
        tier: 'elevated',
        inputSchema: {}
      },
      'fs.delete',
      z.object({ path: z.string().min(1), recursive: z.boolean().optional() }),
      async (input: { path: string; recursive?: boolean }) => {
        const checked = guard(input.path)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')

        const guardReason = protectedReason(checked.absolute)
        if (guardReason) {
          return fail('Refused', guardReason, 'permission-denied')
        }

        const decision = policy.evaluatePath('fs.delete', checked.absolute, {
          workspaceRoots: deps.getRoots()
        })
        if (decision.decision === 'deny') {
          return fail('Denied by policy', decision.reason, 'permission-denied')
        }

        const info = await stat(checked.absolute).catch(() => null)
        if (!info) return fail('Not found', `${checked.absolute} does not exist.`, 'failed')
        if (info.isDirectory() && !input.recursive) {
          return fail(
            'Refusing to delete a directory',
            `${basename(checked.absolute)} is a directory. Pass recursive=true to delete it and its contents.`,
            'invalid-args'
          )
        }

        await rm(checked.absolute, { recursive: input.recursive === true, force: false })
        // `deleted: true` is what lets the runtime report this as a deletion
        // rather than as an ambiguous "this path was involved". Without it the
        // engine cannot tell a delete from a read.
        return ok(`Deleted ${checked.absolute}`, {
          path: checked.absolute,
          deleted: true,
          wasDirectory: info.isDirectory()
        })
      }
    ),

    // ------------------------------------------------------------ searching
    tool(
      {
        id: 'search_content',
        label: 'Search file contents',
        description:
          'Regex search across project files, skipping vendored and generated directories. Returns matching lines with file and line number.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'fs.read',
      z.object({
        query: z.string().min(1).describe('Regular expression'),
        path: z.string().optional().describe('Subtree to search; defaults to the project root'),
        caseSensitive: z.boolean().optional(),
        maxMatches: z.number().int().min(1).max(500).optional()
      }),
      async (input: {
        query: string
        path?: string
        caseSensitive?: boolean
        maxMatches?: number
      }) => {
        const root = input.path ?? deps.getRoots()[0]
        if (!root) return fail('No project open', 'Open a project to search it.', 'unavailable')
        const checked = guard(root)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')

        let pattern: RegExp
        try {
          pattern = new RegExp(input.query, input.caseSensitive ? 'g' : 'gi')
        } catch (err) {
          return fail(
            'Invalid regular expression',
            err instanceof Error ? err.message : String(err),
            'invalid-args'
          )
        }

        const limit = input.maxMatches ?? 100
        const matches: { path: string; line: number; text: string }[] = []
        let filesScanned = 0

        for await (const file of walkTextFiles(checked.absolute)) {
          if (matches.length >= limit) break
          filesScanned += 1
          const content = await readTextIfPresent(file)
          if (content === null) continue
          const lines = content.split('\n')
          for (let i = 0; i < lines.length && matches.length < limit; i += 1) {
            pattern.lastIndex = 0
            if (pattern.test(lines[i] as string)) {
              matches.push({
                path: file,
                line: i + 1,
                text: (lines[i] as string).trim().slice(0, 240)
              })
            }
          }
        }

        return ok(
          `${matches.length} match(es) for /${input.query}/ across ${filesScanned} file(s)`,
          { query: input.query, filesScanned, matches, truncated: matches.length >= limit }
        )
      }
    ),

    tool(
      {
        id: 'search_files',
        label: 'Find files by name',
        description: 'Find files under the project whose name matches a glob-like pattern.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'fs.read',
      z.object({
        pattern: z.string().min(1).describe('Case-insensitive substring or glob, e.g. *test*'),
        path: z.string().optional()
      }),
      async (input: { pattern: string; path?: string }) => {
        const root = input.path ?? deps.getRoots()[0]
        if (!root) return fail('No project open', 'Open a project to search it.', 'unavailable')
        const checked = guard(root)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')

        const matcher = globToMatcher(input.pattern)
        const found: string[] = []
        for await (const file of walkTextFiles(checked.absolute)) {
          if (matcher(basename(file))) {
            found.push(file)
            if (found.length >= 200) break
          }
        }
        return ok(`${found.length} file(s) matching ${input.pattern}`, { pattern: input.pattern, files: found })
      }
    )
  ]
}

// ---------------------------------------------------------------- helpers

/** Bytes sampled when classifying a file's content. */
const BINARY_PROBE_BYTES = 8192

/** Read the first `bytes` of a file without loading the rest. */
async function readPrefix(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Heuristic binary detection: a NUL byte, or a high share of bytes that are
 * not printable and not common whitespace, means the agent should not try to
 * read this as source.
 */
export function looksBinary(sample: Buffer): boolean {
  if (sample.length === 0) return false
  if (sample.includes(0)) return true
  let suspicious = 0
  for (const byte of sample) {
    const printable =
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127)
    if (!printable) suspicious += 1
  }
  return suspicious / sample.length > 0.3
}

/** BOM sniffing for the encodings that declare one; otherwise UTF-8. */
export function detectEncoding(sample: Buffer): string {
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return 'utf-8-bom'
  }
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return 'utf-16le'
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return 'utf-16be'
  return 'utf-8'
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index <= 0 ? path : path.slice(0, index)
}

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    await access(path, constants.R_OK)
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** Drop vendored and generated directories from a tree listing. */
export function filterTree<T extends { name: string; children?: T[] }>(nodes: T[]): T[] {
  return nodes
    .filter((node) => !IGNORED_DIRECTORIES.has(node.name))
    .map((node) => (node.children ? { ...node, children: filterTree(node.children) } : node))
}

/** Walk readable text files, skipping ignored directories. */
export async function* walkTextFiles(root: string, maxDepth = 12): AsyncGenerator<string> {
  async function* walk(dir: string, depth: number): AsyncGenerator<string> {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        yield* walk(full, depth + 1)
      } else if (entry.isFile()) {
        yield full
      }
    }
  }
  yield* walk(root, 0)
}

/** Convert `*`/`?` globs, or a bare substring, into a matcher over a base name. */
export function globToMatcher(pattern: string): (name: string) => boolean {
  const lowered = pattern.toLowerCase()
  if (!lowered.includes('*') && !lowered.includes('?')) {
    return (name) => name.toLowerCase().includes(lowered)
  }
  const source = lowered
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  const re = new RegExp(`^${source}$`)
  return (name) => re.test(name.toLowerCase())
}

export { relative, resolve, sep }