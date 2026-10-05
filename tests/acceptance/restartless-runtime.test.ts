/**
 * CRITICAL ACCEPTANCE TEST — restartless runtime installation.
 *
 * Proves the mechanism required by the product spec: a runtime that is missing
 * from the environment can be installed and become usable **inside the running
 * application process**, with no application restart.
 *
 * What is real in this test:
 *   - the Environment Manager, its layer resolution, PATH merging, managed-root
 *     indexing, detection cache invalidation and verification probe;
 *   - `installTool`'s winget route, including the manifest publisher check;
 *   - a real `node.exe` binary is copied into the managed root and executed;
 *   - a real child process is spawned with the refreshed snapshot and its
 *     output is read back.
 *
 * What is stubbed, and why:
 *   - the `winget` executable itself (the copy of `node.exe` stands in for what a
 *     real winget install would place on disk);
 *   - the OS environment reader (the registry is replaced with a PATH that
 *     provably excludes Node, so the "missing" precondition is deterministic).
 *
 * Neither stub touches the mechanism under test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EnvironmentManager, type MachineEnvironment } from '../../src/main/services/env/manager'
import type { CommandRunner } from '../../src/main/services/env/installer'
import { POSIX, WINDOWS } from '../../src/main/services/env/layers'

const execFileAsync = promisify(execFile)
const IS_WINDOWS = process.platform === 'win32'
const SPEC = IS_WINDOWS ? WINDOWS : POSIX

/** PATH that provably cannot contain Node, so the precondition is deterministic. */
const BLIND_PATH = IS_WINDOWS ? 'C:\\Windows\\System32' : '/nonexistent-cryptoric-baseline'

let root: string
let managedRoot: string
let scratchDir: string
const originalPath = process.env[SPEC.canonicalPathKey]

/**
 * Windows-only, because the capability is.
 *
 * This suite exercises `installTool`'s **winget** route — the manifest lookup,
 * the publisher verification, and the copy of a real `node.exe` standing in for
 * what winget would place on disk. `winget` is the only installation route in
 * `src/main/services/env/installer.ts`: every installer id is `-winget`, and
 * there is no apt or brew path. On Linux and macOS the product therefore
 * correctly answers "No supported installation route", and there is nothing
 * here to assert.
 *
 * So it is skipped off Windows rather than made to pass. Asserting a Linux
 * install that does not exist, or loosening the assertions, would be worse than
 * saying plainly that the platform is unsupported — see `audit.md`, NOT
 * IMPLEMENTED: runtime installation is Windows-only.
 */
describe.skipIf(!IS_WINDOWS)('restartless runtime installation', () => {
  let manager: EnvironmentManager
  let initialPid: number
  let installRunnerCalls: string[] = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cryptoric-acceptance-'))
    managedRoot = join(root, 'tools', 'cryptoric-tools')
    scratchDir = join(root, 'scratch')
    mkdirSync(managedRoot, { recursive: true })
    mkdirSync(scratchDir, { recursive: true })

    /** A "machine environment" that genuinely lacks Node. */
    const readMachine = async (): Promise<MachineEnvironment> => ({
      path: BLIND_PATH,
      vars: { [SPEC.canonicalPathKey]: BLIND_PATH, HOME: root, TEMP: root },
      source: 'process'
    })

    /**
     * Stands in for `winget`. `winget show` returns a manifest with a publisher
     * (the code under test must refuse without one); `winget install` copies the
     * real node binary into the managed root, exactly as a system install would
     * place an executable on disk.
     */
    const installRunner: CommandRunner = (command, args) => {
      installRunnerCalls.push(`${command} ${args.slice(0, 2).join(' ')}`)
      let out = ''
      let code = 0

      if (args[0] === 'show') {
        out = [
          'Found Publisher         [OpenJS Foundation]',
          'Publisher Url           [https://openjsf.org/]',
          'Publisher Support Url   [https://github.com/openjs-foundation]',
          'Installer Hash          [' + 'a'.repeat(64) + ']'
        ].join('\n')
      } else if (args[0] === 'install') {
        const binDir = join(managedRoot, 'node', 'bin')
        mkdirSync(binDir, { recursive: true })
        copyFileSync(process.execPath, join(binDir, IS_WINDOWS ? 'node.exe' : 'node'))
        if (!IS_WINDOWS) chmodSync(join(binDir, 'node'), 0o755)
        out = 'Successfully installed'
      }

      return {
        pid: undefined,
        result: Promise.resolve({ code, stdout: out, stderr: '' }),
        kill: () => undefined
      }
    }

    manager = new EnvironmentManager({
      userDataDir: root,
      managedRoot,
      scratchDir,
      platform: process.platform,
      readMachineEnvironment: readMachine,
      command: installRunner,
      processId: process.pid
    })

    await manager.init()
    initialPid = manager.processIdentifier
  })

  afterAll(() => {
    if (originalPath !== undefined) process.env[SPEC.canonicalPathKey] = originalPath
    rmSync(root, { recursive: true, force: true })
  })

  it('reports Node as missing from the initial environment', async () => {
    const status = await manager.probeTool('node')
    expect(status.state).toBe('missing')
    expect(status.path).toBeNull()
    // Guard against a false pass: the real Node must genuinely be unreachable.
    expect(status.detail).toMatch(/not found on PATH/i)
  })

  it('installs the runtime and makes it usable without restarting the process', async () => {
    const outcome = await manager.install('node', {
      authorize: async () => true,
      onProgress: () => undefined
    })

    expect(outcome.error).toBeNull()
    expect(outcome.ok).toBe(true)
    expect(outcome.refreshedWithoutRestart).toBe(true)

    // 1. A new snapshot was published rather than reusing the pre-install one.
    expect(outcome.snapshotAfter).toBeGreaterThan(outcome.snapshotBefore)
    expect(manager.getSnapshot().previousId).toBe(outcome.snapshotBefore)

    // 2. The application process is the same process throughout.
    expect(manager.processIdentifier).toBe(initialPid)
    expect(manager.processIdentifier).toBe(process.pid)

    // 3. The tool is verified against the *new* snapshot, not inferred.
    expect(outcome.status?.state).toBe('present')
    expect(outcome.status?.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(outcome.status?.path).toContain('cryptoric-tools')

    // 4. The manifest publisher check actually ran.
    expect(installRunnerCalls.some((c) => c.includes('show'))).toBe(true)
    expect(installRunnerCalls.some((c) => c.includes('install'))).toBe(true)
  })

  it('runs the newly installed runtime in a real child process on the refreshed environment', async () => {
    const env = manager.spawnEnv()
    const nodePath = env[SPEC.canonicalPathKey] ?? ''
    expect(nodePath).toContain('cryptoric-tools')

    // Spawn a brand new process using only the refreshed snapshot.
    const { stdout } = await execFileAsync(process.execPath, ['-e', 'process.stdout.write(process.env.CRYPTRIC_PROBE ?? "unset")'], {
      env: { ...env, CRYPTRIC_PROBE: 'refreshed-env-reached-child' },
      timeout: 15_000
    })
    expect(stdout).toBe('refreshed-env-reached-child')

    // And the runtime itself runs from the managed location.
    const status = await manager.probeTool('node')
    expect(status.state).toBe('present')
    const { stdout: versionOut } = await execFileAsync(status.path as string, ['--version'], {
      env,
      timeout: 15_000
    })
    // `node --version` prints `v20.20.2`; the detector normalises to `20.20.2`.
expect(versionOut.trim().replace(/^v/, '')).toBe(status.version)
  })

  it('keeps previously issued snapshots intact so existing terminals are not disturbed', async () => {
    const history = manager.getSnapshotHistory()
    const first = history[0]
    const last = history[history.length - 1]
    expect(first?.id).not.toBe(last?.id)
    // The pre-install snapshot must still hold the stale PATH it was born with.
    expect(first?.values[SPEC.canonicalPathKey]).toBe(BLIND_PATH)
    expect(last?.values[SPEC.canonicalPathKey]).toContain('cryptoric-tools')
  })

  it('reports failure honestly when an install cannot be verified', async () => {
    const failing = new EnvironmentManager({
      userDataDir: root,
      managedRoot: join(root, 'empty-tools'),
      scratchDir,
      platform: process.platform,
      readMachineEnvironment: async () => ({
        path: BLIND_PATH,
        vars: { [SPEC.canonicalPathKey]: BLIND_PATH },
        source: 'process'
      }),
      command: () => ({ pid: undefined, result: Promise.resolve({ code: 1, stdout: '', stderr: 'boom' }), kill: () => undefined }),
      processId: process.pid
    })
    await failing.init()

    const outcome = await failing.install('git', {
      authorize: async () => true,
      onProgress: () => undefined
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBeTruthy()
  })

  it('refuses to install when the user declines', async () => {
    const declining = new EnvironmentManager({
      userDataDir: root,
      managedRoot: join(root, 'empty-tools-2'),
      scratchDir,
      platform: process.platform,
      readMachineEnvironment: async () => ({
        path: BLIND_PATH,
        vars: { [SPEC.canonicalPathKey]: BLIND_PATH },
        source: 'process'
      }),
      command: () => ({ pid: undefined, result: Promise.resolve({ code: 0, stdout: '', stderr: '' }), kill: () => undefined }),
      processId: process.pid
    })
    await declining.init()

    const outcome = await declining.install('git', {
      authorize: async () => false,
      onProgress: () => undefined
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/declined/i)
  })
})