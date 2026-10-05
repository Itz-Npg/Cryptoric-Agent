/**
 * The per-project workspace: `.cryptoricagent/`.
 *
 * Opening a folder creates `<root>/.cryptoricagent/` and gives that project a
 * stable id, so the same folder is the same project to the agent across
 * restarts, machines and the CLI. Everything about a project that outlives a
 * session lives here.
 *
 * Two decisions worth stating, because both were deliberate:
 *
 *  - **The folder ignores itself.** It writes its own `.gitignore` containing
 *    `*` rather than appending to the project's root `.gitignore`. The user
 *    opened a folder to work on it; quietly editing their repo's ignore rules
 *    is a change they did not ask for and did not review. The folder is
 *    self-contained, so it is invisible to `git status` and still removable.
 *  - **The id is never regenerated.** If `project.json` is unreadable the id is
 *    a *new* one, not a random one each call — a caller that ran twice would
 *    otherwise get two different ids for the same folder and create two
 *    histories.
 *
 * Electron-free on purpose: the CLI creates the same folder, so the two
 * surfaces cannot disagree about where a project's state lives.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const PROJECT_DIR_NAME = '.cryptoricagent'
export const PROJECT_MANIFEST = 'project.json'
export const CONVERSATION_FILE = 'conversation.json'

/** Bumped when the on-disk layout changes incompatibly. */
export const WORKSPACE_SCHEMA_VERSION = 1

export type HistoryLocation = 'app' | 'project' | 'both'

export interface ProjectManifest {
  /** Stable for the lifetime of the folder. */
  id: string
  name: string
  createdAt: string
  schemaVersion: number
}

export interface WorkspaceResult {
  root: string
  dir: string
  manifest: ProjectManifest
  /** True when this call created the folder. */
  created: boolean
  /** Set when the folder could not be created and the caller must say so. */
  error: string | null
}

const SELF_IGNORE = `# Managed by Cryptoric Agent.\n#\n# This folder holds per-project agent state: the project id and chat\n# history. It is ignored by git so it never shows up as untracked noise in\n# the repository you opened.\n#\n# Delete the folder to remove this project's agent history.\n*\n`

/**
 * Create `.cryptoricagent/` in `root` if it is missing, and read or mint the
 * project id.
 *
 * Never throws: a project on a read-only mount is a real situation, and the
 * honest response is an `error` the caller can surface, not a crash on open.
 */
export function ensureProjectWorkspace(root: string, projectName?: string): WorkspaceResult {
  const dir = join(root, PROJECT_DIR_NAME)
  const manifestPath = join(dir, PROJECT_MANIFEST)

  let created = false
  let error: string | null = null

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      created = true
    }
    // Written every time: if the folder already exists but this file does not,
    // the folder was created by something else and still needs the ignore rule.
    const ignorePath = join(dir, '.gitignore')
    if (!existsSync(ignorePath)) writeFileSync(ignorePath, SELF_IGNORE, 'utf8')
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : String(e)
  }

  const existing = error === null ? readManifest(manifestPath) : null
  if (existing) {
    return { root, dir, manifest: existing, created, error: null }
  }

  const manifest: ProjectManifest = {
    id: randomUUID(),
    name: projectName ?? root.split(/[\\/]/).pop() ?? root,
    createdAt: new Date().toISOString(),
    schemaVersion: WORKSPACE_SCHEMA_VERSION
  }

  if (error === null) {
    try {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  return { root, dir, manifest, created, error }
}

function readManifest(path: string): ProjectManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectManifest>
    // Every field is validated. A half-written or hand-edited manifest must not
    // become a project with `id: undefined`, which would silently merge two
    // unrelated projects' histories into one file name.
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null
    if (typeof parsed.name !== 'string') return null
    if (typeof parsed.createdAt !== 'string') return null
    return {
      id: parsed.id,
      name: parsed.name,
      createdAt: parsed.createdAt,
      schemaVersion:
        typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : WORKSPACE_SCHEMA_VERSION
    }
  } catch {
    return null
  }
}

/** The project id, or null when the folder does not exist yet. */
export function readProjectId(root: string): string | null {
  return readManifest(join(root, PROJECT_DIR_NAME, PROJECT_MANIFEST))?.id ?? null
}

export interface HistoryTargets {
  /** Absolute path of the app's own data directory. */
  appDir: string
  /** Absolute path of `<root>/.cryptoricagent`. */
  projectDir: string
  /** What the user chose in settings. */
  location: HistoryLocation
}

export interface ResolvedHistory {
  /** Where reads come from, in priority order. First match wins. */
  reads: string[]
  /** Every file that must be written, so the copies cannot drift. */
  writes: string[]
}

export function resolveHistoryPaths(targets: HistoryTargets, projectId: string): ResolvedHistory {
  // Keyed by project id rather than by root: two checkouts of the same repo are
  // different projects and must not share a transcript.
  const appFile = join(targets.appDir, 'conversations', `${projectId}.json`)
  const projectFile = join(targets.projectDir, CONVERSATION_FILE)

  if (targets.location === 'project') {
    return { reads: [projectFile], writes: [projectFile] }
  }
  if (targets.location === 'app') {
    return { reads: [appFile], writes: [appFile] }
  }

  // Both: the project folder is the readable copy when it exists, because that
  // is the one that travels with the folder; the app copy is the fallback for a
  // project whose folder was deleted or is unwritable.
  return { reads: [projectFile, appFile], writes: [projectFile, appFile] }
}