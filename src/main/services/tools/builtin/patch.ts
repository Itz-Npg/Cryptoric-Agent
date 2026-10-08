/**
 * Patch tools.
 *
 * `apply_patch` is Cryptoric's implementation of the Codex-style file-operation
 * format that freebuff's agent runtime uses. It fills a real gap the existing
 * tools leave open: `edit_file` replaces one exact string and `write_file`
 * replaces a whole file, but a change that touches several places across one
 * file has no honest way to be expressed. A hunk is that expression, and —
 * unlike a prose description — a hunk that does not match is an error instead
 * of a silent wrong edit.
 *
 * The format (adapted from freebuff's `apply_patch` params, rewritten for this
 * repository's registry and permission model):
 *
 *  - `create_file` — the diff is a list of `+`-prefixed lines; the file must
 *    not exist yet.
 *  - `update_file` — the diff is one or more `@@` hunks mixing context (` `),
 *    removed (`-`) and added (`+`) lines. Each hunk is located by its own
 *    context, so the agent does not need line numbers — and stale ones cannot
 *    silently corrupt a different region. A hunk that matches zero or more
 *    than one location is refused.
 *  - `delete_file` — path only.
 *
 * One call performs one operation on one file, exactly as freebuff defines it.
 * Every path goes through the same containment guard and protected-directory
 * refusal as the rest of the filesystem tools, and updates are tier `ask`, so
 * the patch capability is subject to exactly the policy an edit or a write is.
 */

import { exists } from './project'
import { PROTECTED_DIRECTORIES } from './filesystem'
import { access, mkdir, readFile, rm, writeFile, constants } from 'node:fs/promises'
import { z } from 'zod'
import type { PermissionDomain, ToolDescriptor } from '@shared/types'
import { checkPath } from '../../permissions/policy'
import { describeSchema, type ToolContext, type ToolDefinition, type ToolResult } from '../registry'

export interface PatchToolDeps {
  /** Roots the agent may touch; empty means nothing is permitted. */
  getRoots(): string[]
}

const TOOL_META: Record<
  string,
  Pick<ToolDescriptor, 'category' | 'risk'> & { timeoutMs: number; mutates: boolean }
> = {
  apply_patch: { category: 'files', risk: 'medium', timeoutMs: 30_000, mutates: true }
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

// ---------------------------------------------------------------- patch model

/** One `@@` hunk: the lines between a `@@` marker and the next one (or EOF). */
export interface PatchHunk {
  /** Context (` `) and removed (`-`) lines, in order — the search key. */
  expected: string[]
  /** Added (`+`) lines, in order. */
  replacement: string[]
}

/**
 * Parse a Codex-style update diff into hunks.
 *
 * Leading file headers (`***`/`---`/`+++`/`diff`) are tolerated because models
 * paste whole unified diffs. Line numbers inside `@@` markers are ignored
 * deliberately: the matcher locates hunks by content, so a stale number is
 * information the tool must not trust.
 */
export function parsePatchHunks(diff: string): { ok: true; hunks: PatchHunk[] } | { ok: false; error: string } {
  const hunks: PatchHunk[] = []
  let current: PatchHunk | null = null
  let sawAnything = false

  const rawLines = diff.split('\n')
  // A diff conventionally ends with a newline, which `split` reports as a final
  // empty element. That artifact is not a blank context line; dropping it keeps
  // a diff written as `+BETA\n` matching a file whose hunk does not end in a
  // blank line. A deliberate blank context line mid-diff is unaffected.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop()

  for (const rawLine of rawLines) {
    // Strip a trailing CR so a Windows-edited patch still parses; the content
    // being patched is read with CRLF preserved separately.
    const line = rawLine.replace(/\r$/, '')
    if (/^(diff |index |--- |\+\+\+ |\*\*\* )/.test(line)) continue

    if (line.startsWith('@@')) {
      current = { expected: [], replacement: [] }
      hunks.push(current)
      sawAnything = true
      continue
    }
    if (current === null) {
      // Lines before the first `@@` in an update diff mean the model used the
      // create-file shape; that mistake must be named, not guessed around.
      if (line.startsWith('+')) {
        return { ok: false, error: 'update_file diffs must start with an @@ hunk marker; use create_file for new files.' }
      }
      if (line.length === 0 || line.startsWith('-') || line.startsWith(' ')) continue
      continue
    }

    sawAnything = sawAnything || line.length > 0
    if (line.startsWith('+')) current.replacement.push(line.slice(1))
    else if (line.startsWith('-')) current.expected.push(line.slice(1))
    else if (line.startsWith(' ')) current.expected.push(line.slice(1))
    else if (line.length === 0) current.expected.push('')
    else return { ok: false, error: `Patch line must start with ' ', '-' or '+': "${line.slice(0, 40)}"` }
  }

  if (!sawAnything) return { ok: false, error: 'The diff contains no hunk or line to apply.' }
  if (hunks.length === 0) {
    // No `@@` at all but only `+` lines was refused above; reaching here means
    // an update diff made only of `-`/context lines before any marker.
    return { ok: false, error: 'The diff has no @@ hunk marker.' }
  }
  for (const hunk of hunks) {
    if (hunk.expected.length === 0 && hunk.replacement.length === 0) {
      return { ok: false, error: 'A hunk is empty — it has no context, removed or added lines.' }
    }
  }
  return { ok: true, hunks }
}

/**
 * Apply hunks to a text body, locating each hunk by its context.
 *
 * Hunks must appear in order and each must match at exactly one location
 * relative to the end of the previous hunk's replacement. A zero-or-multi
 * match is an error naming the offending hunk, which is the difference
 * between a failed patch and a silently misplaced one.
 */
export function applyHunksToContent(content: string, hunks: PatchHunk[]): { ok: true; content: string } | { ok: false; error: string } {
  const hadTrailingNewline = content.endsWith('\n')
  const lines = (hadTrailingNewline ? content.slice(0, -1) : content).split('\n')

  let searchFrom = 0
  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index] as PatchHunk

    const positions: number[] = []
    for (let start = searchFrom; start <= lines.length; start += 1) {
      if (matchesAt(lines, start, hunk.expected)) positions.push(start)
    }
    if (positions.length === 0) {
      const label = hunk.expected[0]?.trim() || hunk.replacement[0]?.trim() || '(empty hunk)'
      return { ok: false, error: `Hunk ${index + 1} does not match the file (no line matching "${label.slice(0, 80)}"). Read the file again and regenerate the diff from its exact current content.` }
    }
    if (positions.length > 1) {
      return { ok: false, error: `Hunk ${index + 1} matches ${positions.length} places. Add more surrounding context lines to make it unambiguous.` }
    }

    const at = positions[0] as number
    lines.splice(at, hunk.expected.length, ...hunk.replacement)
    searchFrom = at + hunk.replacement.length
  }

  return { ok: true, content: lines.join('\n') + (hadTrailingNewline || lines.length > 0 ? '\n' : '') }
}

function matchesAt(lines: string[], at: number, expected: string[]): boolean {
  if (expected.length === 0) return false
  if (at + expected.length > lines.length) return false
  for (let i = 0; i < expected.length; i += 1) {
    if (lines[at + i] !== expected[i]) return false
  }
  return true
}

/** Turn a create-file diff (`+`-prefixed lines) into the new file's content. */
export function contentFromCreateDiff(diff: string): { ok: true; content: string } | { ok: false; error: string } {
  const lines: string[] = []
  for (const rawLine of diff.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (/^(diff |index |--- |\+\+\+ |\*\*\* )/.test(line) || line.startsWith('@@')) continue
    if (line.startsWith('+')) lines.push(line.slice(1))
    else if (line.startsWith('-') || line.startsWith(' ')) {
      return { ok: false, error: 'create_file diffs must contain only + lines.' }
    } else if (line.length > 0) {
      return { ok: false, error: `create_file diff line must start with '+': "${line.slice(0, 40)}"` }
    }
  }
  if (lines.length === 0) return { ok: false, error: 'The diff contains no + lines, so the file would be empty.' }
  return { ok: true, content: lines.join('\n') + '\n' }
}

/** The managed-directory refusal, worded for edits and deletes alike. */
function protectedReason(absolute: string): string | null {
  const normalized = absolute.toLowerCase().replace(/[\\/]+$/, '')
  for (const dir of PROTECTED_DIRECTORIES) {
    if (normalized.endsWith(`\\${dir}`) || normalized.endsWith(`/${dir}`) || normalized === dir) {
      return `${dir} is managed, not authored — patching it is refused`
    }
    if (normalized.includes(`\\${dir}\\`) || normalized.includes(`/${dir}/`)) {
      return `${dir} is managed, not authored — patching inside it is refused`
    }
  }
  return null
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    await access(path, constants.R_OK)
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index <= 0 ? path : path.slice(0, index)
}

// --------------------------------------------------------------- the tool

export function buildPatchTools(deps: PatchToolDeps): ToolDefinition[] {
  const guard = (target: string): { ok: true; absolute: string } | { ok: false; error: string } => {
    const verdict = checkPath(target, deps.getRoots())
    if (!verdict.allowed) return { ok: false, error: verdict.reason }
    return { ok: true, absolute: verdict.absolute }
  }

  const schema = z.object({
    operation: z.object({
      type: z.enum(['create_file', 'update_file', 'delete_file']).describe('The file operation to perform.'),
      path: z.string().min(1).describe('Path relative to the project root.'),
      diff: z
        .string()
        .optional()
        .describe(
          'For create_file: lines prefixed with +. For update_file: one or more @@ hunks mixing context (space), removed (-) and added (+) lines. Not needed for delete_file.'
        )
    })
  })

  return [
    {
      descriptor: {
        id: 'apply_patch',
        label: 'Apply patch',
        description:
          'Apply one file operation in Codex-style patch format. create_file builds a new file from + lines; update_file rewrites an existing file by matching @@ hunks (context and - lines) against its exact current content and replacing them with the + lines; delete_file removes the file. A hunk that matches zero or several places is refused, so a wrong patch fails loudly instead of editing the wrong lines. Use it when one change touches several places in a file; use edit_file for a single small replacement.',
        dependsOn: ['read_file'],
        tier: 'ask',
        platforms: ['*'],
        ...TOOL_META.apply_patch,
        inputSchema: describeSchema(schema)
      },
      domain: 'fs.write' as PermissionDomain,
      schema,
      execute: async (
        input: {
          operation: { type: 'create_file' | 'update_file' | 'delete_file'; path: string; diff?: string }
        },
        _ctx: ToolContext
      ): Promise<ToolResult> => {
        const { type, path, diff } = input.operation

        const checked = guard(path)
        if (!checked.ok) return fail('Path rejected', checked.error, 'permission-denied')
        const absolute = checked.absolute

        const reason = protectedReason(absolute)
        if (reason) return fail('Refused', reason, 'permission-denied')

        const present = await readIfPresent(absolute)
        const fileExists = (await exists(absolute)) || present !== null

        if (type === 'delete_file') {
          if (!fileExists) {
            return fail('File not found', `${path} does not exist.`, 'failed')
          }
          try {
            await rm(absolute, { recursive: false, force: false })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (/is a directory|EPERM|EISDIR/i.test(message)) {
              return fail('Refusing to delete a directory', `${path} is a directory; use delete_file (the filesystem tool) with recursive=true instead.`, 'invalid-args')
            }
            return fail('Delete failed', message, 'failed')
          }
          return ok(`Deleted ${path}`, { path, action: 'delete' })
        }

        if (type === 'create_file') {
          if (fileExists) {
            return fail('File already exists', `${path} already exists; use update_file to change it.`, 'invalid-args')
          }
          if (diff === undefined || diff.trim().length === 0) {
            return fail('No diff given', 'create_file needs a diff of + lines.', 'invalid-args')
          }
          const built = contentFromCreateDiff(diff)
          if (!built.ok) return fail('Invalid create diff', built.error, 'invalid-args')
          await mkdir(dirnameOf(absolute), { recursive: true })
          await writeFile(absolute, built.content, 'utf8')
          return ok(`Created ${path} (${built.content.split('\n').length - 1} lines)`, {
            path,
            action: 'add',
            bytes: Buffer.byteLength(built.content)
          })
        }

        // update_file
        if (!fileExists) {
          return fail('File not found', `${path} does not exist; use create_file for new files.`, 'failed')
        }
        if (diff === undefined || diff.trim().length === 0) {
          return fail('No diff given', 'update_file needs an @@ hunk.', 'invalid-args')
        }
        const parsed = parsePatchHunks(diff)
        if (!parsed.ok) return fail('Invalid patch', parsed.error, 'invalid-args')
        const applied = applyHunksToContent(present ?? '', parsed.hunks)
        if (!applied.ok) return fail('Patch does not apply', applied.error, 'invalid-args')
        await writeFile(absolute, applied.content, 'utf8')
        const added = parsed.hunks.reduce((n, h) => n + h.replacement.length, 0)
        const removed = parsed.hunks.reduce((n, h) => n + h.expected.length, 0)
        return ok(`Patched ${path} (+${added} −${removed} across ${parsed.hunks.length} hunk(s))`, {
          path,
          action: 'update',
          hunks: parsed.hunks.length,
          added,
          removed,
          bytes: Buffer.byteLength(applied.content)
        })
      }
    }
  ]
}
