/**
 * `analyze_project` and `run_tests`, against real projects on disk.
 *
 * The environment layer is real here (`EnvironmentManager`, initialised the way
 * the app initialises it) because `run_tests` delegates to the command executor,
 * and the executor resolves its executable against that environment's PATH. A
 * stubbed environment would prove only that the tool can add two strings
 * together.
 *
 * The tests run `npm` because this repository is a Node project and npm is
 * present wherever the suite runs. They do not install anything: a `test` script
 * pointing at a one-line file is a complete npm script lifecycle, offline.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildProjectTools,
  detectTestCommand,
  readPackageManifest,
  testScriptOf,
  walkProject
} from '../../src/main/services/tools/builtin/project'
import { EnvironmentManager } from '../../src/main/services/env/manager'
import { ToolDetector } from '../../src/main/services/env/detect'
import { ToolRegistry } from '../../src/main/services/tools/registry'
import { ToolRuntime } from '../../src/main/services/tools/runtime'
import { ApprovalQueue, PermissionPolicy, DEFAULT_PERMISSION_RULES } from '../../src/main/services/permissions/policy'

const created: string[] = []
let env: EnvironmentManager

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cryptoric-project-'))
  created.push(root)
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return root
}

/**
 * A runtime over one project, with its approval queue handed back.
 *
 * The queue is returned rather than hidden inside the runtime because an
 * `ask`-or-higher tool waits on it: a test that watched a *different* queue would
 * hang until the runtime's own timeout and then report a timeout as the result.
 */
function runtimeFor(root: string): { runtime: ToolRuntime; approvals: ApprovalQueue } {
  const approvals = new ApprovalQueue()
  const registry = new ToolRegistry()
  // An empty root is how "no project is open" is expressed in both hosts, so an
  // empty string here exercises the same path rather than a special case.
  registry.registerAll(buildProjectTools({ env, getRoots: () => (root === '' ? [] : [root]) }))
  return {
    runtime: new ToolRuntime({
      registry,
      policy: new PermissionPolicy(DEFAULT_PERMISSION_RULES),
      approvals
    }),
    approvals
  }
}

async function call(
  root: string,
  toolId: string,
  args: Record<string, unknown> = {},
  grantedTier: 'safe' | 'elevated' = 'elevated'
) {
  return invokeOn(runtimeFor(root), toolId, args, grantedTier, root)
}

/**
 * Invoke a tool, answering any approval prompt.
 *
 * An `elevated` tool is refused *before* its body runs unless policy allows it
 * or a session grant exists, so a test that never answers the prompt measures
 * the runtime's timeout, not the tool.
 */
async function invokeOn(
  target: { runtime: ToolRuntime; approvals: ApprovalQueue },
  toolId: string,
  args: Record<string, unknown>,
  grantedTier: 'safe' | 'elevated',
  projectRoot: string | null
) {
  const pending = target.runtime.invoke(toolId, args, { grantedTier, projectRoot })
  const watch = setInterval(() => {
    for (const request of target.approvals.list()) target.approvals.resolve(request.id, true)
  }, 2)
  try {
    return await pending
  } finally {
    clearInterval(watch)
  }
}

/** A Node project whose `test` script passes or fails on demand. */
function nodeProject(script: string, extra: Record<string, string> = {}): string {
  return project({
    'package.json': JSON.stringify(
      { name: 'fixture-project', version: '1.0.0', main: 'src/index.ts', scripts: { test: script } },
      null,
      2
    ),
    'package-lock.json': '{}',
    'src/index.ts': 'export const answer = 42\n',
    'src/index.test.ts': "import { answer } from './index'\nexport const t = answer\n",
    'README.md': '# Fixture\n',
    '.github/workflows/ci.yml': 'name: ci\n',
    'node_modules/left-pad/index.js': 'module.exports = 1\n',
    ...extra
  })
}

beforeAll(async () => {
  env = new EnvironmentManager({
    userDataDir: mkdtempSync(join(tmpdir(), 'cryptoric-project-env-')),
    managedRoot: join(tmpdir(), 'cryptoric-project-tools'),
    scratchDir: join(tmpdir(), 'cryptoric-project-tmp'),
    platform: process.platform,
    detector: new ToolDetector()
  })
  await env.init()
}, 60_000)

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

describe('analyze_project', () => {
  it('summarises a Node project without counting dependencies', async () => {
    const root = nodeProject('node -e "process.exit(0)"')
    const result = await call(root, 'analyze_project', {}, 'safe')
    expect(result.ok).toBe(true)

    const data = result.data as {
      root: string
      files: number
      languages: { language: string; files: number; share: number }[]
      packageManager: string | null
      name: string | null
      scripts: string[]
      entryPoints: string[]
      testFileCount: number
      testFiles: string[]
      ci: string[]
      config: string[]
      truncated: boolean
    }
    expect(data.root).toBe(root)
    expect(data.name).toBe('fixture-project')
    expect(data.packageManager).toBe('npm')
    expect(data.scripts).toContain('test')
    expect(data.entryPoints).toContain('src/index.ts')
    expect(data.testFileCount).toBe(1)
    expect(data.testFiles).toContain('src/index.test.ts')
    expect(data.ci).toContain('github-actions')
    expect(data.config).toContain('package.json')
    expect(data.truncated).toBe(false)

    // `node_modules` must not be walked: a project reported as mostly
    // dependencies is worse than no report.
    const languageNames = data.languages.map((l) => l.language)
    expect(languageNames).toContain('TypeScript')
    expect(data.files).toBeLessThan(10)
  })

  it('reads the package manager from the lockfile, not from the manifest', async () => {
    const root = project({ 'package.json': '{"name":"p"}', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
    const result = await call(root, 'analyze_project', {}, 'safe')
    expect((result.data as { packageManager: string | null }).packageManager).toBe('pnpm')
  })

  it('answers for a project that is not a Node project at all', async () => {
    const root = project({ 'Cargo.toml': '[package]\nname = "x"\n', 'src/main.rs': 'fn main() {}\n' })
    const result = await call(root, 'analyze_project', {}, 'safe')
    expect(result.ok).toBe(true)
    const data = result.data as { languages: { language: string }[]; packageManager: string | null }
    expect(data.languages.map((l) => l.language)).toContain('Rust')
    expect(data.packageManager).toBeNull()
  })

  it('refuses to analyse when no project is open', async () => {
    const result = await call('', 'analyze_project', {}, 'safe')
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/No project open/)
    expect(result.error).toMatch(/Open a project before analyzing/)
  })
})

describe('walkProject', () => {
  it('reports truncation rather than presenting a partial count as the total', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 12; i++) files[`f${i}.ts`] = 'export const x = 1\n'
    const root = project(files)
    const walk = await walkProject(root, 5)
    expect(walk.truncated).toBe(true)
    expect(walk.files).toBe(5)
  })
})

describe('test-runner detection', () => {
  it('prefers a declared script and maps it to the right manager', async () => {
    const root = nodeProject('node -e "process.exit(0)"')
    const detected = await detectTestCommand(root)
    expect(detected.ok).toBe(true)
    if (!detected.ok) return
    expect(detected.argv).toEqual(['npm', 'test'])
  })

  it('refuses the placeholder npm init writes', async () => {
    const root = project({
      'package.json': JSON.stringify({
        name: 'placeholder',
        scripts: { test: 'echo "Error: no test specified" && exit 1' }
      })
    })
    expect(testScriptOf(await readPackageManifest(root))).toBeNull()
    const detected = await detectTestCommand(root)
    expect(detected.ok).toBe(false)
    if (detected.ok) return
    expect(detected.error).toMatch(/No test runner was detected/)
  })

  it('detects cargo, go and pytest from their own files', async () => {
    const cargo = await detectTestCommand(project({ 'Cargo.toml': '[package]\n' }))
    expect(cargo.ok && cargo.argv).toEqual(['cargo', 'test'])

    const go = await detectTestCommand(project({ 'go.mod': 'module x\n' }))
    expect(go.ok && go.argv).toEqual(['go', 'test', './...'])

    const py = await detectTestCommand(project({ 'pyproject.toml': '[project]\nname = "x"\n' }))
    expect(py.ok && py.argv.slice(1)).toEqual(['-m', 'pytest'])
  })
})

describe('run_tests', () => {
  it('runs the project suite and reports a pass from the exit code', async () => {
    const root = nodeProject('node ok.mjs', { 'ok.mjs': 'console.log("1 passed")\n' })
    const result = await call(root, 'run_tests')

    expect(result.ok).toBe(true)
    const data = result.data as { passed: boolean; exitCode: number; runner: string; stdout: string }
    expect(data.passed).toBe(true)
    expect(data.exitCode).toBe(0)
    expect(data.runner).toMatch(/npm/)
    expect(data.stdout).toContain('1 passed')
    expect(result.summary).toMatch(/passed/)
  }, 120_000)

  it('reports a failing suite as a failure with the runner exit code', async () => {
    const root = nodeProject('node bad.mjs', {
      'bad.mjs': 'console.error("AssertionError: expected 2")\nprocess.exit(3)\n'
    })
    const result = await call(root, 'run_tests')

    expect(result.ok).toBe(false)
    const data = result.data as { passed: boolean; exitCode: number; stderr: string }
    expect(data.passed).toBe(false)
    expect(data.exitCode).toBe(3)
    expect(data.stderr).toContain('AssertionError')
    expect(result.summary).toMatch(/did not pass/)
  }, 120_000)

  it('runs a named script when one is given, and refuses an unknown name', async () => {
    const root = project({
      'package.json': JSON.stringify({
        name: 'multi',
        scripts: { test: 'node -e "process.exit(0)"', 'test:unit': 'node unit.mjs' }
      }),
      'unit.mjs': 'console.log("unit suite ran")\n'
    })

    const named = await call(root, 'run_tests', { script: 'test:unit' })
    expect(named.ok).toBe(true)
    expect((named.data as { stdout: string }).stdout).toContain('unit suite ran')
    expect((named.data as { command: string }).command).toBe('npm run test:unit')

    const unknown = await call(root, 'run_tests', { script: 'test:everything' })
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toMatch(/declares no script named "test:everything"/)

    // The argument is a script name, never a command: a script named like one
    // cannot execute anything the manifest did not already declare.
    const injected = await call(root, 'run_tests', { script: 'test; rm -rf /' })
    expect(injected.ok).toBe(false)
    expect(injected.error).toMatch(/declares no script named/)
  }, 120_000)

  it('says there is no runner rather than inventing a command', async () => {
    const root = project({ 'README.md': '# nothing here\n' })
    const result = await call(root, 'run_tests')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/No test runner was detected/)
  })

  it('refuses to run tests when no project is open', async () => {
    const result = await call('', 'run_tests')
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/No project open/)
    expect(result.error).toMatch(/Open a project before running its tests/)
  })
})
