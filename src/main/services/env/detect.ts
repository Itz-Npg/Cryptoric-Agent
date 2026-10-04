/**
 * Tool detection.
 *
 * Detection resolves an executable through the *current* environment snapshot's
 * PATH — the same lookup a child process would perform — and then runs the
 * tool's version probe. Results are cached per (snapshot id, executable) and the
 * cache is explicitly invalidated on refresh, because a stale executable cache is
 * exactly how "restartless" runtime installation silently fails.
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { EnvRecord, ToolSourceKind, ToolSpec, ToolStatus } from '@shared/types'
import { findExecutableOnPath, platformSpec } from './layers'
import { getToolSpec } from './registry'
import { satisfiesConstraint } from './semver'

const PROBE_TIMEOUT_MS = 8_000

export interface ProbeRunner {
  (command: string, args: string[], env: EnvRecord, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>
}

export const defaultProbeRunner: ProbeRunner = (command, args, env, cwd) =>
  new Promise((resolve) => {
    let settled = false
    const child = execFile(
      command,
      args,
      { env, cwd, timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (settled) return
        settled = true
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? Number((error as NodeJS.ErrnoException & { code: unknown }).code)
            : error
              ? 1
              : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
    child.on('error', () => {
      if (settled) return
      settled = true
      resolve({ code: 127, stdout: '', stderr: 'probe failed to spawn' })
    })
  })

interface CacheEntry {
  path: string | null
  at: number
  snapshotId: number
}

export interface DetectOptions {
  snapshotId: number
  env: EnvRecord
  runner?: ProbeRunner
  /** Managed install directories (CRYPTORIC layer) that must be searched. */
  managedDirs?: string[]
  /** Restrict the probe to these tool ids. */
  only?: string[]
}

export class ToolDetector {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly runner: ProbeRunner
  private readonly spec = platformSpec()
  private readonly fsExists: (p: string) => boolean

  constructor(
    runner: ProbeRunner = defaultProbeRunner,
    fsExists: (p: string) => boolean = existsSync
  ) {
    this.runner = runner
    this.fsExists = fsExists
  }

  /** Drop cached resolutions. Mandatory after an install or an env refresh. */
  invalidate(toolIds?: string[]): void {
    if (!toolIds) {
      this.cache.clear()
      return
    }
    for (const id of toolIds) {
      for (const key of [...this.cache.keys()]) {
        if (key.startsWith(`${id}::`)) this.cache.delete(key)
      }
    }
  }

  /** Remove every entry that predates the given snapshot. */
  invalidateStale(snapshotId: number): void {
    for (const [key, entry] of [...this.cache.entries()]) {
      if (entry.snapshotId !== snapshotId) this.cache.delete(key)
    }
  }

  /** Resolve an executable path only (no version probe). Cheap and cacheable. */
  resolveExecutable(toolId: string, env: EnvRecord, snapshotId: number): { path: string | null; managed: boolean } {
    const tool = getToolSpec(toolId)
    if (!tool) return { path: null, managed: false }
    const key = `${toolId}::${snapshotId}`

    const hit = this.cache.get(key)
    if (hit) {
      // Re-validate: a file could have been removed since the cache was written.
      if (hit.path && !this.fsExists(hit.path)) this.cache.delete(key)
      else return { path: hit.path, managed: isManagedPath(hit.path) }
    }

    let found: string | null = null
    let managed = false
    for (const exe of tool.executables) {
      const resolved = findExecutableOnPath(env, exe, this.fsExists, this.spec)
      if (resolved) {
        found = resolved
        managed = isManagedPath(resolved)
        break
      }
    }

    this.cache.set(key, { path: found, at: Date.now(), snapshotId })
    return { path: found, managed }
  }

  /** Full status probe for one tool. */
  async status(toolId: string, options: DetectOptions): Promise<ToolStatus> {
    const tool = getToolSpec(toolId)
    if (!tool) throw new Error(`Unknown tool: ${toolId}`)

    const now = new Date().toISOString()
    const { path } = this.resolveExecutable(toolId, options.env, options.snapshotId)

    if (!path) {
      return {
        spec: tool,
        state: 'missing',
        path: null,
        version: null,
        layer: null,
        source: 'unknown',
        lastVerifiedAt: now,
        constraint: tool.requiredRange ?? null,
        detail: `${tool.label} was not found on PATH in this environment.`
      }
    }

    const version = await this.probeVersion(tool, path, options.env)
    const managed = isManagedPath(path)
    const source: ToolSourceKind = managed ? 'path' : 'path'

    if (!version) {
      return {
        spec: tool,
        state: 'unverified',
        path,
        version: null,
        layer: null,
        source,
        lastVerifiedAt: now,
        constraint: tool.requiredRange ?? null,
        detail: `${tool.label} was found at ${path} but did not report a readable version.`
      }
    }

    const ok = satisfiesConstraint(version, tool.requiredRange)
    return {
      spec: tool,
      state: ok ? 'present' : 'mismatched',
      path,
      version,
      layer: null,
      source,
      lastVerifiedAt: now,
      constraint: tool.requiredRange ?? null,
      detail: ok
        ? `${tool.label} ${version} at ${path}`
        : `${tool.label} ${version} does not satisfy ${tool.requiredRange as string}.`
    }
  }

  /** Probe several tools concurrently, preserving input order. */
  async statuses(toolIds: string[], options: DetectOptions): Promise<ToolStatus[]> {
    const targets = options.only
      ? toolIds.filter((id) => options.only?.includes(id))
      : toolIds
    return Promise.all(
      targets.map((id) => this.status(id, options).catch((err: unknown) => errorStatus(id, err)))
    )
  }

  private async probeVersion(tool: ToolSpec, exePath: string, env: EnvRecord): Promise<string | null> {
    if (tool.versionArgs.length === 0) {
      // Tools with no version flag (e.g. MSVC `cl`) report presence only.
      return pathExists(this.fsExists, exePath) ? 'present' : null
    }
    const { stdout, stderr, code } = await this.runner(exePath, tool.versionArgs, env)
    if (code !== 0 && !stdout && !stderr) return null
    const text = `${stdout}\n${stderr}`
    const match = new RegExp(tool.versionPattern).exec(text)
    if (!match) {
      const loose = /(\d+\.\d+(?:\.\d+)?)/.exec(text)
      return loose?.[1] ?? null
    }
    const groups = match.slice(1).filter((g): g is string => g !== undefined && g !== '')
    if (groups.length === 0) return null
    return isJavaVersion(tool.id) && groups.length > 1 ? groups.join('.') : (groups[0] ?? null)
  }
}

function isJavaVersion(toolId: string): boolean {
  return toolId === 'java'
}

function pathExists(fsExists: (p: string) => boolean, p: string): boolean {
  try {
    if (!fsExists(p)) return false
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function errorStatus(toolId: string, err: unknown): ToolStatus {
  const tool = getToolSpec(toolId)
  return {
    spec: tool ?? {
      id: toolId,
      label: toolId,
      executables: [toolId],
      versionArgs: ['--version'],
      versionPattern: '(\\d+\\.\\d+\\.\\d+)',
      category: 'native',
      installers: []
    },
    state: 'failed',
    path: null,
    version: null,
    layer: null,
    source: 'unknown',
    lastVerifiedAt: new Date().toISOString(),
    constraint: null,
    detail: err instanceof Error ? err.message : String(err)
  }
}

const MANAGED_ROOTS = ['cryptoric-tools', '.cryptoric', 'AppData\\Local\\CryptoricAgent']

/** True when a resolved path lives inside Cryptoric's own managed install root. */
export function isManagedPath(p: string | null): boolean {
  if (!p) return false
  const lower = p.toLowerCase().replace(/\\/g, '/')
  return MANAGED_ROOTS.some((root) => lower.includes(root.toLowerCase().replace(/\\/g, '/')))
}

/**
 * Walk a managed install root and yield `name -> absolute path` for every file on
 * disk that is executable. Used after an install so the CRYPTORIC layer can be
 * rebuilt without depending on the OS PATH having been mutated.
 */
export function indexManagedBin(root: string, readdirSync: typeof import('node:fs').readdirSync): Map<string, string> {
  const found = new Map<string, string>()
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const abs = isAbsolute(entry.name) ? entry.name : join(root, entry.name)
    if (entry.isDirectory()) {
      for (const [name, p] of indexManagedBin(abs, readdirSync)) {
        if (!found.has(name)) found.set(name, p)
      }
    } else {
      const base = entry.name.replace(/\.(exe|cmd|bat|com)$/i, '')
      if (!found.has(base)) found.set(base, abs)
    }
  }
  return found
}