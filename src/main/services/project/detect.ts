/**
 * Project detection.
 *
 * Opening a folder must immediately answer three questions without the user
 * explaining anything: what kind of project is this, which runtimes does it
 * need, and which package manager did its author actually choose.
 *
 * The package manager is inferred from **lockfiles**, never guessed: a project
 * with `pnpm-lock.yaml` gets pnpm even if npm also happens to be installed.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { EnvironmentGap, ProjectKind, ProjectManifest, ProjectProfile } from '@shared/types'

interface DetectorRule {
  file: string
  kind: ProjectKind
  requires: string[]
  read?: (text: string) => { constraint?: string | null; scripts?: Record<string, string> }
}

/** Shape of the `engines` field we read out of a package.json. */
interface PackageJsonLike {
  engines?: { node?: string }
  scripts?: Record<string, string>
}

/** Ordered: the first matching primary manifest decides the project kind. */
const RULES: DetectorRule[] = [
  {
    file: 'package.json',
    kind: 'node',
    requires: ['node'],
    read: (text) => {
      const pkg = safeJson(text) as PackageJsonLike | null
      if (!pkg) return {}
      const engines = pkg.engines?.node ?? null
      const scripts = pkg.scripts ?? {}
      return {
        constraint: engines ? stripRangeOperator(engines) : null,
        scripts: mapNodeScripts(scripts)
      }
    }
  },
  { file: 'Cargo.toml', kind: 'rust', requires: ['rust', 'cargo'] },
  { file: 'pyproject.toml', kind: 'python', requires: ['python'] },
  { file: 'requirements.txt', kind: 'python', requires: ['python', 'pip'] },
  { file: 'go.mod', kind: 'go', requires: ['go'] },
  { file: 'pom.xml', kind: 'jvm-maven', requires: ['java', 'maven'] },
  { file: 'build.gradle', kind: 'jvm-gradle', requires: ['java', 'gradle'] },
  { file: 'build.gradle.kts', kind: 'jvm-gradle', requires: ['java', 'gradle'] },
  { file: 'CMakeLists.txt', kind: 'native-cmake', requires: ['cmake'] },
  { file: 'Gemfile', kind: 'ruby', requires: [] },
  { file: 'composer.json', kind: 'php', requires: [] }
]

/** Lockfile -> package manager. First match wins; order encodes precedence. */
const LOCKFILES: { file: string; manager: string }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
  { file: 'uv.lock', manager: 'uv' },
  { file: 'poetry.lock', manager: 'poetry' },
  { file: 'Pipfile.lock', manager: 'pipenv' },
  { file: 'Cargo.lock', manager: 'cargo' },
  { file: 'go.sum', manager: 'go' },
  { file: 'Gemfile.lock', manager: 'bundler' },
  { file: 'composer.lock', manager: 'composer' }
]

/** Java/Kotlin/.NET project files are discovered by glob, not by a fixed name. */
const GLOB_RULES: { pattern: RegExp; kind: ProjectKind; requires: string[] }[] = [
  { pattern: /\.csproj$/i, kind: 'dotnet', requires: ['dotnet'] },
  { pattern: /\.fsproj$/i, kind: 'dotnet', requires: ['dotnet'] },
  { pattern: /\.sln$/i, kind: 'dotnet', requires: ['dotnet'] }
]

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function stripRangeOperator(engine: string): string {
  const first = engine.split('||')[0]?.trim() ?? engine
  return first.replace(/^[\^~>=<\s]+/, '')
}

/** Map npm script names onto purpose keys the agent and UI understand. */
function mapNodeScripts(scripts: Record<string, string>): Record<string, string> {
  const purpose: Record<string, string> = {}
  const map: Record<string, string> = {
    dev: 'dev',
    start: 'start',
    serve: 'serve',
    build: 'build',
    test: 'test',
    lint: 'lint',
    watch: 'watch',
    preview: 'preview'
  }
  for (const [name, command] of Object.entries(scripts)) {
    const key = map[name]
    if (key && !purpose[key]) purpose[key] = command
  }
  return purpose
}

const DEV_PORT_PATTERNS = [
  /--port[= ](\d{2,5})/i,
  /-p[= ](\d{2,5})\b/,
  /(?:^|\s)-l[= ](\d{2,5})\b/,
  /--listen[= ](\d{2,5})/i,
  /PORT=(\d{2,5})/,
  /localhost:(\d{2,5})/i
]

/** Best-effort dev-server port discovery from the dev/start script. */
export function inferDevPort(scripts: Record<string, string>): number | null {
  for (const key of ['dev', 'start', 'serve']) {
    const command = scripts[key]
    if (!command) continue
    for (const pattern of DEV_PORT_PATTERNS) {
      const m = pattern.exec(command)
      const value = m?.[1]
      if (value) {
        const port = Number(value)
        if (port > 0 && port < 65536) return port
      }
    }
  }
  // Framework defaults, only when the framework is recognisable.
  const all = Object.values(scripts).join(' ')
  if (/\bvite\b/.test(all)) return 5173
  if (/\bnext\b/.test(all)) return 3000
  if (/\bnuxt\b/.test(all)) return 3000
  if (/\bng serve\b/.test(all)) return 4200
  if (/\bcreate-react-app\b|\breact-scripts\b/.test(all)) return 3000
  if (/\bsvelte-kit\b|\bvite\b/.test(all)) return 5173
  return null
}

export interface DetectOptions {
  /** Injected for tests. */
  readText?: (path: string) => Promise<string | null>
  listDir?: (path: string) => Promise<string[]>
  isGitRepo?: (root: string) => Promise<boolean>
}

async function existsText(path: string, opts: DetectOptions): Promise<string | null> {
  if (opts.readText) return opts.readText(path)
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function listEntries(dir: string, opts: DetectOptions): Promise<string[]> {
  if (opts.listDir) return opts.listDir(dir)
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/** Inspect a project root and produce a profile. Never throws for an empty folder. */
export async function detectProject(root: string, opts: DetectOptions = {}): Promise<ProjectProfile> {
  const entries = await listEntries(root, opts)
  const manifests: ProjectManifest[] = []
  const scripts: Record<string, string> = {}
  const requiredTools = new Set<string>()
  const kinds = new Set<ProjectKind>()

  for (const rule of RULES) {
    const text = await existsText(join(root, rule.file), opts)
    // A manifest that is listed but unreadable still declares a requirement —
    // failing to read `Cargo.toml` must not hide the fact that cargo is needed.
    if (text === null && !entries.includes(rule.file)) continue
    const parsed = rule.read ? rule.read(text ?? '') : {}
    manifests.push({
      file: rule.file,
      kind: rule.kind,
      requires: rule.requires,
      packageManager: null,
      constraint: parsed.constraint ?? null
    })
    kinds.add(rule.kind)
    for (const tool of rule.requires) requiredTools.add(tool)
    for (const [purpose, command] of Object.entries(parsed.scripts ?? {})) {
      if (!scripts[purpose]) scripts[purpose] = command
    }
  }

  for (const glob of GLOB_RULES) {
    const hit = entries.find((e) => glob.pattern.test(e))
    if (!hit) continue
    kinds.add(glob.kind)
    manifests.push({ file: hit, kind: glob.kind, requires: glob.requires, packageManager: null, constraint: null })
    for (const tool of glob.requires) requiredTools.add(tool)
  }

  // Lockfile-driven package manager selection.
  let packageManager: string | null = null
  for (const lock of LOCKFILES) {
    if (!entries.includes(lock.file)) continue
    packageManager = lock.manager
    const existing = manifests.find((m) => m.file === lock.file)
    if (existing) existing.packageManager = lock.manager
    else manifests.push({ file: lock.file, kind: kinds.values().next().value ?? 'unknown', requires: [], packageManager: lock.manager, constraint: null })
    break
  }

  // A Python or Rust project without a lockfile still needs a package manager.
  if (!packageManager && kinds.has('python')) packageManager = 'pip'
  if (!packageManager && kinds.has('rust')) packageManager = 'cargo'

  const kind: ProjectKind =
    kinds.size === 0 ? 'unknown' : kinds.size === 1 ? [...kinds][0]! : 'mixed'

  const isGit = opts.isGitRepo ? await opts.isGitRepo(root) : await defaultIsGitRepo(root)

  return {
    root,
    name: basename(root) || root,
    kind,
    manifests: manifests.sort((a, b) => a.file.localeCompare(b.file)),
    requiredTools: [...requiredTools],
    packageManager,
    scripts,
    devServerPort: inferDevPort(scripts),
    isGitRepo: isGit,
    detectedAt: new Date().toISOString()
  }
}

async function defaultIsGitRepo(root: string): Promise<boolean> {
  try {
    const info = await stat(join(root, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

/**
 * Compare a profile's requirements against probed tool statuses and produce the
 * plan the UI renders and the agent acts on.
 */
export function computeGaps(
  profile: ProjectProfile,
  statuses: { spec: { id: string; label: string; installers: { id: string; requiredTier: string }[] }; state: string; constraint: string | null; detail: string }[]
): EnvironmentGap[] {
  const byId = new Map(statuses.map((s) => [s.spec.id, s]))
  const gaps: EnvironmentGap[] = []

  for (const toolId of profile.requiredTools) {
    const status = byId.get(toolId)
    const requiredBy = profile.manifests.filter((m) => m.requires.includes(toolId)).map((m) => m.file)
    const spec = status?.spec
    const installers = spec?.installers ?? []

    if (!status || status.state === 'missing') {
      gaps.push({
        toolId,
        label: spec?.label ?? toolId,
        kind: 'missing',
        requiredBy,
        constraint: status?.constraint ?? null,
        installerIds: installers.map((i) => i.id),
        requiredTier: installers[0]?.requiredTier ?? 'ask',
        detail: `${spec?.label ?? toolId} is required by this project but is not available in the current environment.`
      })
      continue
    }

    if (status.state === 'mismatched') {
      gaps.push({
        toolId,
        label: spec?.label ?? toolId,
        kind: 'mismatched',
        requiredBy,
        constraint: status.constraint,
        installerIds: installers.map((i) => i.id),
        requiredTier: installers[0]?.requiredTier ?? 'ask',
        detail: status.detail
      })
    }
  }

  return gaps
}