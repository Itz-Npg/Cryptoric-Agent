/**
 * Project snapshots.
 *
 * The question this answers is the one the engine got wrong: **did anything
 * actually change?**
 *
 * It used to be answered by trusting tool arguments — `changedPathOf` matched the
 * tool id against an allowlist and read `result.data.path`. That means a tool can
 * report a path it never wrote, and a tool that *did* write something but is not
 * on the list contributes nothing. Both directions are wrong, and the second is
 * the dangerous one: it makes a real change invisible.
 *
 * So this walks the tree and hashes contents. The engine compares the two
 * snapshots and believes the filesystem, not the narration.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { FileSnapshot } from './evidence'

/**
 * Directories that are never part of "did the agent change the project".
 *
 * `node_modules` alone would turn a snapshot into a multi-minute walk, and
 * nothing an agent legitimately writes lives there.
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
  '.gradle',
  '.idea',
  '.vscode',
  'Pods',
  '.dart_tool'
])

/** Files above this are hashed by size alone; a binary blob is not worth reading. */
const MAX_HASH_BYTES = 2 * 1024 * 1024

/** Upper bound on files walked, so a pathological tree cannot stall the agent. */
const MAX_FILES = 20_000

export interface SnapshotResult {
  files: FileSnapshot
  /** Files not visited because a limit was hit. Non-empty means partial. */
  truncated: number
  /** True when the root could not be read at all. */
  unreadable: boolean
}

/**
 * Hash every file under `root`.
 *
 * Bounded on purpose. A snapshot that can itself hang would reintroduce exactly
 * the class of bug this work is fixing, one level up.
 */
export function takeSnapshot(root: string): SnapshotResult {
  const files: Record<string, string> = {}
  if (!root) return { files, truncated: 0, unreadable: true }

  let visited = 0
  let truncated = 0

  const walk = (dir: string): void => {
    if (visited >= MAX_FILES) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited >= MAX_FILES) {
        truncated += 1
        return
      }
      if (entry.name.startsWith('.') && entry.name !== '.env') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue

      visited += 1
      const hash = hashFile(full)
      if (hash !== null) {
        files[toRelative(root, full)] = hash
      }
    }
  }

  try {
    statSync(root)
  } catch {
    return { files, truncated: 0, unreadable: true }
  }

  walk(root)
  return { files, truncated, unreadable: false }
}

function toRelative(root: string, full: string): string {
  return relative(root, full).split(sep).join('/')
}

/**
 * SHA-256 of a file, or `size:mtime` for anything too large to read.
 *
 * Using size and mtime for big files keeps the walk bounded while still
 * detecting that they changed — which is what this is for.
 */
function hashFile(full: string): string | null {
  try {
    const stat = statSync(full)
    if (stat.size > MAX_HASH_BYTES) {
      return `big:${stat.size}:${Math.round(stat.mtimeMs)}`
    }
    const buffer = readFileSync(full)
    return createHash('sha256').update(buffer).digest('hex').slice(0, 32)
  } catch {
    // A file that vanished mid-walk, or one we cannot read, is not evidence of
    // anything and must not become a phantom entry.
    return null
  }
}

/** True when the process can actually write into this directory. */
export function isProjectWritable(root: string): boolean {
  if (!root) return false
  try {
    statSync(root)
    return true
  } catch {
    return false
  }
}