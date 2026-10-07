/**
 * Project tools.
 *
 * Two capabilities that share one subject: the project as a whole.
 *
 * `analyze_project` answers "what am I looking at" — the question every agent
 * asks first on an unfamiliar repository and had no way to ask. The tool router
 * has advertised an `analyze_project` tool in its intent chains since it was
 * written; nothing implemented one, so those chains named a tool that did not
 * exist. This is that tool, and it is real.
 *
 * `run_tests` answers "did I break it". The agent could always shell out to
 * `npm test` through `run_command` — but only if it guessed the runner right,
 * and it had no structured result to reason over. This detects the project's own
 * runner and runs it through the *same* executor as `run_command`, so there is
 * one place where argv is classified and one place where Windows batch handling
 * lives.
 *
 * Neither tool invents a number. `analyze_project` counts files and bytes it
 * actually walked and says when it stopped early; `run_tests` reports the
 * runner's exit code and deliberately does **not** claim a test count, because
 * parsing "N passed" out of a stream is a different result shape for every
 * runner and a wrong count is worse than no count.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { PermissionDomain, ToolDescriptor } from '@shared/types'
import { IGNORED_DIRECTORIES } from './filesystem'
import { describeSchema, type ToolContext, type ToolDefinition, type ToolResult } from '../registry'
import { runCommand, type CommandToolDeps } from './command'

/** The project tools need the same two things the command executor does. */
export type ProjectToolDeps = CommandToolDeps

const TOOL_META: Record<
  string,
  Pick<ToolDescriptor, 'category' | 'risk'> & { timeoutMs: number; mutates: boolean }
> = {
  analyze_project: { category: 'files', risk: 'safe', timeoutMs: 90_000, mutates: false },
  run_tests: { category: 'test', risk: 'medium', timeoutMs: 600_000, mutates: false }
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

/** Walk limits. A monorepo is bigger than anything the model needs summarised. */
const MAX_FILES = 4000
const MAX_ENTRIES = 8000

/** Extensions mapped to the language they mean. Unknown extensions are grouped by themselves. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.swift': 'Swift',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.c': 'C',
  '.h': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.m': 'Objective-C',
  '.mm': 'Objective-C',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.ps1': 'PowerShell',
  '.sql': 'SQL',
  '.css': 'CSS',
  '.scss': 'CSS',
  '.less': 'CSS',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.dart': 'Dart',
  '.lua': 'Lua',
  '.r': 'R',
  '.scala': 'Scala',
  '.clj': 'Clojure',
  '.hs': 'Haskell',
  '.zig': 'Zig'
}

/** Files that tell the agent how the project is set up. */
const CONFIG_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  'jsconfig.json',
  'vitest.config.ts',
  'jest.config.js',
  'jest.config.ts',
  'playwright.config.ts',
  'eslint.config.js',
  '.eslintrc.json',
  '.prettierrc',
  '.editorconfig',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  'Dockerfile',
  'docker-compose.yml',
  'compose.yml',
  'Makefile',
  'justfile',
  '.env.example',
  'README.md',
  'LICENSE'
]

/** Lockfile to package manager. The first match wins. */
const MANAGER_BY_LOCKFILE: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm']
]

/** The placeholder `npm init` writes, which is not a test suite. */
const NPM_PLACEHOLDER = /no test specified/i

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])(tests?|__tests__|spec)[\\/]/i

export function buildProjectTools(deps: ProjectToolDeps): ToolDefinition[] {
  const tool = (
    descriptor: ToolDescriptor,
    domain: PermissionDomain,
    schema: z.ZodTypeAny,
    execute: (input: never, ctx: ToolContext) => Promise<ToolResult>
  ): ToolDefinition => ({
    descriptor: {
      platforms: ['*'],
      ...TOOL_META[descriptor.id],
      ...descriptor,
      inputSchema: describeSchema(schema)
    },
    domain,
    schema,
    execute: execute as ToolDefinition['execute']
  })

  return [
    tool(
      {
        id: 'analyze_project',
        label: 'Analyze project',
        description:
          'Summarise the open project: languages by file count and bytes, package manager, package scripts, entry points, test files, CI config and which config files exist. Read-only. Run this first on a repository you have not seen, so you edit the stack that is actually there.',
        dependsOn: [],
        tier: 'safe',
        inputSchema: {}
      },
      'fs.read',
      z.object({
        maxFiles: z
          .number()
          .int()
          .min(50)
          .max(MAX_FILES)
          .optional()
          .describe(`Stop after walking this many files. Defaults to ${MAX_FILES}.`)
      }),
      async (input: { maxFiles?: number }) => {
        const roots = deps.getRoots()
        const root = roots[0]
        if (!root) {
          return fail('No project open', 'Open a project before analyzing it.', 'unavailable')
        }

        const walk = await walkProject(root, input.maxFiles ?? MAX_FILES)
        const manifest = await readPackageManifest(root)
        const config = await existingConfigFiles(root)
        const packageManager = await detectPackageManager(root)
        const ci = await detectCi(root)

        const languages = Object.entries(walk.byLanguage)
          .map(([language, counts]) => ({
            language,
            files: counts.files,
            bytes: counts.bytes,
            share: walk.files === 0 ? 0 : Math.round((counts.files / walk.files) * 1000) / 10
          }))
          .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language))

        const testFiles = walk.paths.filter((p) => TEST_FILE.test(p))

        const summary =
          `${walk.files} file(s), ${formatBytes(walk.bytes)}` +
          (languages.length > 0 ? ` · mostly ${languages[0]?.language}` : '') +
          (packageManager ? ` · ${packageManager}` : '') +
          ` · ${testFiles.length} test file(s)` +
          (walk.truncated ? ' · walk stopped early' : '')

        return ok(summary, {
          root,
          files: walk.files,
          bytes: walk.bytes,
          directories: walk.directories,
          truncated: walk.truncated,
          languages,
          packageManager,
          name: manifest?.name ?? null,
          scripts: manifest ? Object.keys(manifest.scripts ?? {}) : [],
          testScript: testScriptOf(manifest),
          entryPoints: manifestEntries(manifest),
          testFiles: testFiles.slice(0, 40),
          testFileCount: testFiles.length,
          ci,
          config
        })
      }
    ),

    tool(
      {
        id: 'run_tests',
        label: 'Run tests',
        description:
          'Detect the project\'s own test runner (npm/pnpm/yarn/bun script, cargo test, go test or pytest), run it, and report the exit code with its output. Read-only with respect to files — it runs the suite the project already defines. It does not invent a pass count: `passed` means the runner exited 0. If your project has several test scripts, pass `script`.',
        dependsOn: ['analyze_project'],
        tier: 'elevated',
        inputSchema: {}
      },
      'terminal.elevated',
      z.object({
        script: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe('A script name from package.json, e.g. "test:unit". Must already exist; it cannot be a command.'),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(600_000)
          .optional()
          .describe('Abort after this long. Defaults to 300000.')
      }),
      async (input: { script?: string; timeoutMs?: number }, ctx) => {
        const root = deps.getRoots()[0]
        if (!root) {
          return fail('No project open', 'Open a project before running its tests.', 'unavailable')
        }

        const detection = await detectTestCommand(root, input.script)
        if (!detection.ok) {
          return fail('No test runner found', detection.error, 'unavailable')
        }

        const { manager, argv, label, manifest } = detection
        ctx.note(`Running ${label}…`, 'info')

        // Delegated, not re-implemented: the tier check, the PATH resolution and
        // the Windows batch handling are the executor's job, and a second copy
        // of them here would be a second set of rules to get wrong.
        const result = await runCommand(
          deps,
          { command: argv[0] as string, args: argv.slice(1), cwd: root, timeoutMs: input.timeoutMs ?? 300_000 },
          ctx
        )

        const data = result.data as
          | { exitCode?: number; stdout?: string; stderr?: string; durationMs?: number; truncated?: boolean }
          | undefined
        const exitCode = data?.exitCode ?? null
        const passed = result.ok && exitCode === 0

        return {
          ...result,
          summary: passed
            ? `${label} passed (exit 0${data?.durationMs !== undefined ? `, ${Math.round(data.durationMs / 1000)}s` : ''})`
            : `${label} did not pass (exit ${exitCode ?? 'unknown'})`,
          data: {
            runner: manifest ? `${manager} script` : manager,
            command: label,
            passed,
            exitCode,
            durationMs: data?.durationMs ?? null,
            outputTruncated: data?.truncated ?? false,
            stdout: data?.stdout ?? '',
            stderr: data?.stderr ?? '',
            ...(passed ? {} : { error: result.error ?? 'the runner exited non-zero' })
          },
          ...(passed ? {} : { error: result.error ?? `${label} exited ${exitCode ?? 'unknown'}` })
        }
      }
    )
  ]
}

// ---------------------------------------------------------------- detection

export interface PackageManifest {
  name?: string
  scripts?: Record<string, string>
  main?: string
  bin?: string | Record<string, string>
  workspaces?: unknown
}

/** Read and parse `package.json`, or null when there is not a usable one. */
export async function readPackageManifest(root: string): Promise<PackageManifest | null> {
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as PackageManifest
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    // A missing or malformed manifest is not an error: most projects are not
    // Node projects, and this tool has to answer for those too.
    return null
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The package manager the project's lockfile names. */
export async function detectPackageManager(root: string): Promise<string | null> {
  for (const [file, manager] of MANAGER_BY_LOCKFILE) {
    if (await exists(join(root, file))) return manager
  }
  return (await exists(join(root, 'package.json'))) ? 'npm' : null
}

/** The test script worth running, or null when the manifest has only the placeholder. */
export function testScriptOf(manifest: PackageManifest | null): string | null {
  const scripts = manifest?.scripts ?? {}
  for (const candidate of ['test', 'test:unit', 'test:ci']) {
    const value = scripts[candidate]
    if (typeof value === 'string' && value.trim().length > 0 && !NPM_PLACEHOLDER.test(value)) {
      return candidate
    }
  }
  return null
}

export type TestDetection =
  | { ok: true; manager: string; argv: string[]; label: string; manifest: boolean }
  | { ok: false; error: string }

/**
 * Work out how this project runs its tests.
 *
 * Ordered by how specific the signal is: a declared script beats a framework
 * file, and a framework file beats a guess. When nothing matches, the refusal
 * names what was checked so the agent can tell the developer what to add rather
 * than trying commands one at a time.
 */
export async function detectTestCommand(root: string, script?: string): Promise<TestDetection> {
  const manifest = await readPackageManifest(root)
  const scripts = manifest?.scripts ?? {}
  const manager = (await detectPackageManager(root)) ?? 'npm'

  if (script !== undefined) {
    const declared = scripts[script]
    if (typeof declared !== 'string' || declared.trim().length === 0) {
      return {
        ok: false,
        error: `package.json declares no script named "${script}". Declared scripts: ${
          Object.keys(scripts).join(', ') || '(none)'
        }. This argument is a script name, not a command.`
      }
    }
    return {
      ok: true,
      manager,
      argv: [manager, 'run', script],
      label: `${manager} run ${script}`,
      manifest: true
    }
  }

  const chosen = testScriptOf(manifest)
  if (chosen !== null) {
    // `npm test` and `npm run test` are the same thing; the shorter form is what
    // a developer would type, and it is the one that prints the familiar output.
    const argv = chosen === 'test' ? [manager, 'test'] : [manager, 'run', chosen]
    return { ok: true, manager, argv, label: argv.join(' '), manifest: true }
  }

  if (await exists(join(root, 'Cargo.toml'))) {
    return { ok: true, manager: 'cargo', argv: ['cargo', 'test'], label: 'cargo test', manifest: false }
  }
  if (await exists(join(root, 'go.mod'))) {
    return { ok: true, manager: 'go', argv: ['go', 'test', './...'], label: 'go test ./...', manifest: false }
  }
  if (
    (await exists(join(root, 'pyproject.toml'))) ||
    (await exists(join(root, 'pytest.ini'))) ||
    (await exists(join(root, 'tox.ini')))
  ) {
    // `python3` is the name that exists on Linux and macOS; Windows installs it
    // as `python`. Guessing wrong is not silent: the executor answers with
    // "not on PATH" and names what it looked for, and the agent can fall back
    // to run_command.
    const python = process.platform === 'win32' ? 'python' : 'python3'
    return { ok: true, manager: 'pytest', argv: [python, '-m', 'pytest'], label: `${python} -m pytest`, manifest: false }
  }

  return {
    ok: false,
    error:
      'No test runner was detected. Checked: a non-placeholder `test` script in package.json, Cargo.toml, go.mod, ' +
      'pyproject.toml, pytest.ini and tox.ini. Ask the developer how this project runs its tests, or run the ' +
      'command directly with run_command.'
  }
}

/** Entry points a reader would start from. */
export function manifestEntries(manifest: PackageManifest | null): string[] {
  const out: string[] = []
  if (typeof manifest?.main === 'string') out.push(manifest.main)
  if (typeof manifest?.bin === 'string') out.push(manifest.bin)
  else if (manifest?.bin && typeof manifest.bin === 'object') out.push(...Object.values(manifest.bin))
  return [...new Set(out)].filter((p) => p.length > 0)
}

async function detectCi(root: string): Promise<string[]> {
  const found: string[] = []
  for (const [path, label] of [
    ['.github/workflows', 'github-actions'],
    ['.gitlab-ci.yml', 'gitlab-ci'],
    ['azure-pipelines.yml', 'azure-pipelines'],
    ['Jenkinsfile', 'jenkins'],
    ['.circleci/config.yml', 'circleci']
  ] as [string, string][]) {
    if (await exists(join(root, path))) found.push(label)
  }
  return found
}

async function existingConfigFiles(root: string): Promise<string[]> {
  const found: string[] = []
  for (const file of CONFIG_FILES) {
    if (await exists(join(root, file))) found.push(file)
  }
  return found
}

export interface ProjectWalk {
  files: number
  directories: number
  bytes: number
  /** Walk stopped at a ceiling, so the totals are a floor, not a total. */
  truncated: boolean
  paths: string[]
  byLanguage: Record<string, { files: number; bytes: number }>
}

/**
 * Walk the project once, counting files, bytes and languages.
 *
 * Bounded on both entries and files. A walk that hits a ceiling reports
 * `truncated: true` rather than presenting a partial count as the whole
 * project — the difference matters when the model decides "this is a small
 * JavaScript repo" from a number that stopped at a limit.
 */
export async function walkProject(root: string, maxFiles = MAX_FILES, maxEntries = MAX_ENTRIES): Promise<ProjectWalk> {
  const byLanguage: Record<string, { files: number; bytes: number }> = {}
  const paths: string[] = []
  let files = 0
  let directories = 0
  let bytes = 0
  let entries = 0
  let truncated = false

  const visit = async (dir: string): Promise<void> => {
    if (truncated) return
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of dirents) {
      entries += 1
      if (entries > maxEntries || files >= maxFiles) {
        truncated = true
        return
      }
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        directories += 1
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) continue

      const info = await stat(absolute).catch(() => null)
      if (!info) continue
      files += 1
      bytes += info.size

      const rel = relative(root, absolute).split(sep).join('/')
      paths.push(rel)

      const dot = entry.name.lastIndexOf('.')
      const extension = dot <= 0 ? '' : entry.name.slice(dot).toLowerCase()
      const language = LANGUAGE_BY_EXTENSION[extension] ?? (extension === '' ? 'other' : extension)
      const bucket = (byLanguage[language] ??= { files: 0, bytes: 0 })
      bucket.files += 1
      bucket.bytes += info.size
    }
  }

  await visit(root)
  return { files, directories, bytes, truncated, paths, byLanguage }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
