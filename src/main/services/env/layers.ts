/**
 * Layered environment resolution.
 *
 * Cryptoric resolves process environments from five layers, lowest precedence
 * first:
 *
 *     SYSTEM -> USER -> CRYPTORIC -> PROJECT -> TASK
 *
 * The highest layer that defines a variable wins, except for `PATH`-family
 * variables which are *merged* (higher layers are prepended) so that a
 * project-local toolchain shadows a system one without hiding it.
 *
 * This module is pure and platform-parameterised so it can be unit tested
 * without touching the real machine.
 */

import { ENV_LAYERS, type EnvLayer, type EnvRecord } from '@shared/types'

export interface PlatformSpec {
  /** `;` on Windows, `:` elsewhere. */
  pathSeparator: string
  /** Windows environment variable names are case-insensitive. */
  caseInsensitiveEnv: boolean
  /** `path` on Windows, `PATH` on POSIX. */
  canonicalPathKey: string
  /** Executable extension search, e.g. `.EXE`. */
  exeExtensions: string[]
}

export const WINDOWS: PlatformSpec = {
  pathSeparator: ';',
  caseInsensitiveEnv: true,
  canonicalPathKey: 'Path',
  exeExtensions: ['.EXE', '.CMD', '.BAT', '.COM', '.PS1']
}

export const POSIX: PlatformSpec = {
  pathSeparator: ':',
  caseInsensitiveEnv: false,
  canonicalPathKey: 'PATH',
  exeExtensions: ['']
}

export function platformSpec(platform: NodeJS.Platform = process.platform): PlatformSpec {
  return platform === 'win32' ? WINDOWS : POSIX
}

function keyOf(name: string, spec: PlatformSpec): string {
  return spec.caseInsensitiveEnv ? name.toUpperCase() : name
}

/**
 * Split a `PATH`-style value into trimmed, non-empty entries.
 * Quoted segments are unwrapped because Windows PATH entries are frequently quoted.
 */
export function splitPathList(value: string, spec: PlatformSpec): string[] {
  return value
    .split(spec.pathSeparator)
    .map((entry) => unquote(entry.trim()))
    .filter((entry) => entry.length > 0)
}

function unquote(entry: string): string {
  if (entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')) {
    return entry.slice(1, -1)
  }
  return entry
}

/**
 * Deduplicate path entries case-insensitively on Windows, preserving the first
 * occurrence (which is the highest-precedence one, since higher layers are
 * prepended first).
 */
export function dedupePathEntries(entries: string[], spec: PlatformSpec): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of entries) {
    const norm = spec.caseInsensitiveEnv ? entry.toLowerCase() : entry
    const key = norm.replace(/[\\/]+$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

const PATH_LIKE = new Set(['PATH', 'PATHEXT', 'MANPATH', 'NODE_PATH', 'PYTHONPATH', 'GOPATH', 'CLASSPATH'])

export function isPathLike(key: string): boolean {
  return PATH_LIKE.has(key.toUpperCase())
}

/**
 * Resolve the effective environment from a set of layers.
 *
 * @param layers     Map of layer -> variables defined by that layer.
 * @param spec       Platform semantics. Defaults to the host platform.
 * @param order      Precedence order, lowest first.
 */
export function resolveEnvLayers(
  layers: Partial<Record<EnvLayer, EnvRecord>>,
  spec: PlatformSpec = platformSpec(),
  order: readonly EnvLayer[] = ENV_LAYERS
): EnvRecord {
  const out: Record<string, string> = {}

  for (const layer of order) {
    const vars = layers[layer]
    if (!vars) continue
    for (const [rawKey, rawValue] of Object.entries(vars)) {
      if (rawValue === undefined || rawValue === null) continue
      const value = String(rawValue)
      const key = keyOf(rawKey, spec)
      if (key === keyOf(spec.canonicalPathKey, spec)) {
        // PATH-like: merge, higher precedence layers first.
        const incoming = splitPathList(value, spec)
        const existing = out[key] ? splitPathList(out[key] as string, spec) : []
        out[key] = dedupePathEntries([...incoming, ...existing], spec).join(spec.pathSeparator)
      } else {
        out[key] = value
      }
    }
  }

  // Emit the canonical PATH key casing plus any aliases the layers provided.
  const canonical = keyOf(spec.canonicalPathKey, spec)
  const pathValue = out[canonical]
  const result: EnvRecord = {}
  for (const [k, v] of Object.entries(out)) {
    if (k === canonical) continue
    result[k] = v
  }
  if (pathValue !== undefined) result[spec.canonicalPathKey] = pathValue

  return result
}

/** Return a copy of `env` with `overrides` applied (PATH-like keys are merged). */
export function withOverrides(
  env: EnvRecord,
  overrides: EnvRecord,
  spec: PlatformSpec = platformSpec()
): EnvRecord {
  return resolveEnvLayers(
    { SYSTEM: env, CRYPTORIC: overrides } as Partial<Record<EnvLayer, EnvRecord>>,
    spec,
    ['SYSTEM', 'USER', 'CRYPTORIC', 'PROJECT', 'TASK']
  )
}

/** Case-insensitive lookup appropriate for the platform. */
export function envGet(env: EnvRecord, name: string, spec: PlatformSpec = platformSpec()): string | undefined {
  const wanted = keyOf(name, spec)
  for (const [k, v] of Object.entries(env)) {
    if (keyOf(k, spec) === wanted) return v
  }
  return undefined
}

/**
 * Find `executable` on the snapshot's PATH.
 *
 * Returns the absolute path of the first match walking PATH left to right, which
 * is exactly what a child process spawned with this environment would resolve.
 */
export function findExecutableOnPath(
  env: EnvRecord,
  executable: string,
  exists: (candidate: string) => boolean,
  spec: PlatformSpec = platformSpec()
): string | null {
  const pathValue = envGet(env, spec.canonicalPathKey, spec)
  if (!pathValue) return null

  // An absolute or explicitly relative invocation bypasses PATH lookup entirely.
  if (executable.includes('/') || executable.includes('\\')) {
    const abs = isAbsoluteLike(executable) ? executable : joinLike('.', executable)
    return exists(abs) ? abs : null
  }

  const extensions =
    executable.includes('.') || spec.exeExtensions.every((e) => e === '')
      ? ['']
      : ['', ...spec.exeExtensions]

  for (const dir of splitPathList(pathValue, spec)) {
    for (const ext of extensions) {
      const candidate = joinLike(dir, executable + ext)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

function isAbsoluteLike(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
}

function joinLike(dir: string, name: string): string {
  if (dir === '') return name
  const sep = dir.includes('\\') || /^[a-zA-Z]:/.test(dir) ? '\\' : '/'
  return dir.endsWith('\\') || dir.endsWith('/') ? `${dir}${name}` : `${dir}${sep}${name}`
}

/** Every directory on PATH, highest precedence first. */
export function pathDirectories(env: EnvRecord, spec: PlatformSpec = platformSpec()): string[] {
  const value = envGet(env, spec.canonicalPathKey, spec)
  return value ? splitPathList(value, spec) : []
}