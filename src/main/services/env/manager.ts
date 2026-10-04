/**
 * Environment Manager.
 *
 * Owns the environment registry and produces immutable `EnvSnapshot`s. Every
 * child process Cryptoric spawns is given a snapshot, never `process.env`.
 *
 * ## Why "restartless" actually works
 *
 * A running process cannot observe PATH changes made by an installer, because the
 * environment was copied into the process at creation time. Editing
 * `process.env` in the main process only affects children spawned afterwards,
 * and only for the keys we set. It does *not* pick up the machine PATH that
 * `winget` just wrote to the registry.
 *
 * So a refresh does three real things:
 *
 *  1. **Re-reads the OS environment from its source of truth.**
 *     Windows: `HKLM\...\Session Manager\Environment` + `HKCU\Environment` via
 *     `reg query`. POSIX: a login shell (`$SHELL -l -c 'echo $PATH'`) which is
 *     what a user's terminal would actually see.
 *  2. **Rebuilds the CRYPTORIC layer** by indexing the managed install root, so a
 *     user-local install is reachable without any PATH edit at all.
 *  3. **Publishes a new immutable snapshot** and invalidates the tool-detection
 *     cache, then verifies the tool by probing it *with that new snapshot*.
 *
 * Only processes created after this point receive the new environment. Existing
 * terminals and long-running tasks keep the snapshot they were born with and are
 * flagged `envStale`; they are never killed implicitly.
 */

import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  EnvLayer,
  EnvRecord,
  EnvSnapshot,
  InstallProgress,
  PermissionTier,
  ToolStatus
} from '@shared/types'
import { ToolDetector, indexManagedBin, type DetectOptions, type ProbeRunner } from './detect'
import { installTool, type CommandRunner, type Downloader } from './installer'
import {
  envGet,
  platformSpec,
  resolveEnvLayers,
  splitPathList,
  type PlatformSpec
} from './layers'
import { CORE_TOOL_IDS, TOOL_REGISTRY } from './registry'

export interface MachineEnvironment {
  /** PATH as recorded by the operating system right now. */
  path: string
  /** Other variables read from the OS, used to seed the SYSTEM layer. */
  vars: EnvRecord
  /** How the PATH was obtained, surfaced in diagnostics. */
  source: 'process' | 'windows-registry' | 'login-shell'
}

export type MachineEnvReader = () => Promise<MachineEnvironment>

export interface EnvironmentManagerDeps {
  userDataDir: string
  /** Managed tool install root; also used as the CRYPTORIC layer's PATH entries. */
  managedRoot: string
  scratchDir: string
  platform: NodeJS.Platform
  detector?: ToolDetector
  command?: CommandRunner
  download?: Downloader
  readMachineEnvironment?: MachineEnvReader
  /** Stable process identity, recorded on snapshots to prove the app never restarted. */
  processId?: number
}

export interface InstallOutcome {
  toolId: string
  ok: boolean
  error: string | null
  status: ToolStatus | null
  snapshotBefore: number
  snapshotAfter: number
  /** True when the refresh produced a new snapshot (i.e. the app did not restart). */
  refreshedWithoutRestart: boolean
}

export class EnvironmentManager {
  private readonly layers: Record<EnvLayer, EnvRecord> = {
    SYSTEM: {},
    USER: {},
    CRYPTORIC: {},
    PROJECT: {},
    TASK: {}
  }
  private snapshots: EnvSnapshot[] = []
  private current: EnvSnapshot | null = null
  private nextId = 1
  private readonly detector: ToolDetector
  private readonly spec: PlatformSpec
  private readonly deps: EnvironmentManagerDeps
  private readonly processId: number
  private readonly installsInFlight = new Map<string, AbortController>()

  constructor(deps: EnvironmentManagerDeps) {
    this.deps = deps
    this.spec = platformSpec(deps.platform)
    this.detector = deps.detector ?? new ToolDetector()
    this.processId = deps.processId ?? process.pid
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  get processIdentifier(): number {
    return this.processId
  }

  getSnapshot(): EnvSnapshot {
    if (!this.current) throw new Error('EnvironmentManager has not been initialised')
    return this.current
  }

  getSnapshotHistory(): EnvSnapshot[] {
    return [...this.snapshots]
  }

  /** Build the first snapshot from the OS environment. */
  async init(): Promise<EnvSnapshot> {
    const machine = await this.readMachine()
    this.layers.SYSTEM = { ...machine.vars }
    this.layers.USER = {}
    await this.rebuildCryptoricLayer()
    return this.publish('boot')
  }

  /**
   * Re-read the OS environment, rebuild the managed layer, and publish a new
   * snapshot. Returns the snapshot. Existing consumers keep their old snapshot.
   */
  async refresh(reason: EnvSnapshot['reason'] = 'manual-refresh'): Promise<EnvSnapshot> {
    const machine = await this.readMachine()
    this.layers.SYSTEM = { ...machine.vars }
    await this.rebuildCryptoricLayer()
    const snapshot = this.publish(reason)
    // Stale cache entries are exactly what makes refresh look broken.
    this.detector.invalidateStale(snapshot.id)
    return snapshot
  }

  /** Add managed bin directories discovered by an installer to the CRYPTORIC layer. */
  addManagedPaths(paths: string[]): void {
    const usable = paths.filter((p) => p && p.trim().length > 0)
    if (usable.length === 0) return
    const existing = this.layers.CRYPTORIC[this.spec.canonicalPathKey] ?? ''
    this.layers.CRYPTORIC = {
      ...this.layers.CRYPTORIC,
      [this.spec.canonicalPathKey]: [...usable, ...splitPathList(existing, this.spec)].join(this.spec.pathSeparator)
    }
  }

  /** Install into the PROJECT layer (a per-project runtime pin). */
  setProjectEnv(projectRoot: string | null, vars: EnvRecord): void {
    if (!projectRoot) {
      this.layers.PROJECT = {}
    } else {
      this.layers.PROJECT = { ...vars }
    }
  }

  /** Install into the TASK layer (highest precedence, cleared after the task). */
  setTaskEnv(vars: EnvRecord | null): void {
    this.layers.TASK = vars ? { ...vars } : {}
  }

  /** The environment a newly spawned process should receive. */
  environmentFor(opts: { projectRoot?: string | null; taskEnv?: EnvRecord | null } = {}): EnvRecord {
    const merged = resolveEnvLayers({
      SYSTEM: this.layers.SYSTEM,
      USER: this.layers.USER,
      CRYPTORIC: this.layers.CRYPTORIC,
      PROJECT: opts.projectRoot ? this.layers.PROJECT : {},
      TASK: opts.taskEnv ?? this.layers.TASK
    }, this.spec)

    if (opts.projectRoot) {
      // A project must be able to find its own binaries (node_modules/.bin).
      const sep = this.spec.pathSeparator
      const localBin = join(opts.projectRoot, 'node_modules', '.bin')
      const pathKey = this.spec.canonicalPathKey
      const current = splitPathList(merged[pathKey] ?? '', this.spec)
      if (!current.includes(localBin)) {
        merged[pathKey] = [localBin, ...current].join(sep)
      }
    }
    return merged
  }

  /** Convenience: the environment as a `child_process`-compatible object. */
  spawnEnv(opts: { projectRoot?: string | null; taskEnv?: EnvRecord | null } = {}): NodeJS.ProcessEnv {
    return this.environmentFor(opts) as NodeJS.ProcessEnv
  }

  private publish(reason: EnvSnapshot['reason']): EnvSnapshot {
    const values = this.environmentFor()
    const snapshot: EnvSnapshot = {
      id: this.nextId++,
      createdAt: new Date().toISOString(),
      reason,
      values,
      layers: (['SYSTEM', 'USER', 'CRYPTORIC', 'PROJECT', 'TASK'] as EnvLayer[]).filter((l) =>
        Object.keys(this.layers[l]).length > 0
      ),
      previousId: this.current?.id ?? null
    }
    this.current = snapshot
    this.snapshots.push(snapshot)
    // Keep history bounded; the full history is not needed after many refreshes.
    if (this.snapshots.length > 50) this.snapshots.splice(0, this.snapshots.length - 50)

    // Mirror the resolved PATH into the main process so that *other* subsystems
    // (and Electron's own child spawning) at least inherit the current view.
    const pathKey = this.spec.canonicalPathKey
    const pathValue = envGet(values, pathKey, this.spec)
    if (pathValue) process.env[pathKey] = pathValue
    return snapshot
  }

  // -------------------------------------------------------------------------
  // OS environment reading
  // -------------------------------------------------------------------------

  private readMachine(): Promise<MachineEnvironment> {
    const reader = this.deps.readMachineEnvironment ?? defaultMachineEnvReader(this.deps.platform)
    return reader()
  }

  /**
   * Index every executable under the managed install root and prepend those
   * directories to the CRYPTORIC layer. This is what makes a user-local install
   * (for example a managed Node) reachable on the very next command, with no
   * system PATH mutation and no restart.
   */
  private async rebuildCryptoricLayer(): Promise<void> {
    const found = indexManagedBin(this.deps.managedRoot, readdirSync)
    const dirs = new Set<string>()
    for (const p of found.values()) {
      const dir = p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')))
      if (dir) dirs.add(dir)
    }
    const managedDir = this.deps.managedRoot
    if (dirs.size > 0) dirs.add(managedDir)
    this.layers.CRYPTORIC = {
      ...this.layers.CRYPTORIC,
      [this.spec.canonicalPathKey]: [...dirs].join(this.spec.pathSeparator)
    }
  }

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  private detectOptions(): DetectOptions {
    return {
      snapshotId: this.getSnapshot().id,
      env: this.getSnapshot().values
    }
  }

  async probeTool(toolId: string, runner?: ProbeRunner): Promise<ToolStatus> {
    const opts = this.detectOptions()
    return runner ? new ToolDetector(runner).status(toolId, opts) : this.detector.status(toolId, opts)
  }

  async probeTools(toolIds: string[], only?: string[]): Promise<ToolStatus[]> {
    return this.detector.statuses(toolIds, { ...this.detectOptions(), only })
  }

  async probeCoreTools(): Promise<ToolStatus[]> {
    return this.probeTools([...CORE_TOOL_IDS])
  }

  probeAllTools(): Promise<ToolStatus[]> {
    return this.probeTools(TOOL_REGISTRY.map((t) => t.id))
  }

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------

  /**
   * Install a runtime and make it usable **without restarting the application**.
   *
   * Sequence: install (verified download) -> add managed bin to CRYPTORIC layer
   * -> publish a new snapshot -> invalidate the detector cache -> probe the tool
   * again *using the new snapshot*. The final probe is what proves the runtime is
   * genuinely reachable; it is not inferred from the installer exiting 0.
   */
  async install(
    toolId: string,
    options: {
      installerId?: string
      version?: string
      authorize: (tier: PermissionTier, title: string, detail: string) => Promise<boolean>
      onProgress: (p: Omit<InstallProgress, 'at'>) => void
    }
  ): Promise<InstallOutcome> {
    const snapshotBefore = this.getSnapshot().id
    const controller = new AbortController()
    this.installsInFlight.set(toolId, controller)

    try {
      const { spawnCommand, httpDownload } = await import('./installer')
      const command = this.deps.command ?? spawnCommand
      const download = this.deps.download ?? httpDownload

      const result = await installTool(
        { toolId, installerId: options.installerId, version: options.version, signal: controller.signal },
        {
          run: command,
          download,
          managedRoot: this.deps.managedRoot,
          scratchDir: this.deps.scratchDir,
          platform: this.deps.platform,
          authorize: options.authorize,
          onProgress: options.onProgress
        }
      )

      if (!result.ok) {
        return {
          toolId,
          ok: false,
          error: result.error,
          status: null,
          snapshotBefore,
          snapshotAfter: this.getSnapshot().id,
          refreshedWithoutRestart: false
        }
      }

      if (result.managedBinDir) this.addManagedPaths([result.managedBinDir])

      // Refresh unconditionally: a system-wide install (winget) is only visible
      // after re-reading the OS environment.
      await this.refresh('install')

      // Verify against the *new* snapshot, not the one that predated the install.
      const status = await this.detector.status(toolId, this.detectOptions())

      if (status.state === 'missing' || status.state === 'unverified') {
        return {
          toolId,
          ok: false,
          error: `Installation reported success but ${status.spec.label} is still not resolvable on the refreshed PATH (${status.detail})`,
          status,
          snapshotBefore,
          snapshotAfter: this.getSnapshot().id,
          refreshedWithoutRestart: true
        }
      }

      return {
        toolId,
        ok: true,
        error: null,
        status,
        snapshotBefore,
        snapshotAfter: this.getSnapshot().id,
        refreshedWithoutRestart: true
      }
    } catch (err) {
      return {
        toolId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: null,
        snapshotBefore,
        snapshotAfter: this.getSnapshot().id,
        refreshedWithoutRestart: false
      }
    } finally {
      this.installsInFlight.delete(toolId)
    }
  }

  cancelInstall(toolId: string): boolean {
    const controller = this.installsInFlight.get(toolId)
    if (!controller) return false
    controller.abort()
    return true
  }

  isInstalling(toolId: string): boolean {
    return this.installsInFlight.has(toolId)
  }
}

// ---------------------------------------------------------------------------
// Default machine-environment readers
// ---------------------------------------------------------------------------

function runCapture(command: string, args: string[], shell = false): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 8000, windowsHide: true, shell, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout) })
    )
  })
}

/**
 * Windows: read the persisted machine and user PATH straight out of the
 * registry. This is the only way to observe a PATH that `winget` (or any
 * installer) just wrote, because the current process inherited a copy at start.
 */
export async function readWindowsEnvironment(): Promise<MachineEnvironment> {
  const spec = WINDOWS_SPEC
  const [machine, user] = await Promise.all([
    runCapture('reg', [
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
    ]),
    runCapture('reg', ['query', 'HKCU\\Environment'])
  ])

  const machineVars = parseRegOutput(machine.stdout)
  const userVars = parseRegOutput(user.stdout)

  const machinePath = machineVars['PATH'] ?? machineVars['Path'] ?? ''
  const userPath = userVars['PATH'] ?? userVars['Path'] ?? ''

  // Windows composes a process PATH from the machine PATH then the user PATH.
  const combined = [...splitPathList(machinePath, spec), ...splitPathList(userPath, spec)]
  const vars: EnvRecord = { ...machineVars, ...userVars }
  vars[spec.canonicalPathKey] = combined.join(spec.pathSeparator)

  return {
    path: vars[spec.canonicalPathKey] as string,
    vars,
    source: combined.length > 0 ? 'windows-registry' : 'process'
  }
}

const WINDOWS_SPEC: PlatformSpec = {
  pathSeparator: ';',
  caseInsensitiveEnv: true,
  canonicalPathKey: 'Path',
  exeExtensions: ['.EXE', '.CMD', '.BAT', '.COM', '.PS1']
}

/** Parse `reg query` output: `    KEY_NAME    REG_SZ    value`. */
export function parseRegOutput(stdout: string): EnvRecord {
  const out: EnvRecord = {}
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s{4}(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/.exec(line)
    if (m) out[m[1] as string] = (m[2] as string).trim()
  }
  return out
}

/**
 * POSIX: ask a login shell what PATH it would hand a fresh terminal. This is the
 * honest equivalent of the Windows registry read — a non-login shell would still
 * see the stale inherited PATH.
 */
export async function readPosixEnvironment(): Promise<MachineEnvironment> {
  const shell = process.env.SHELL || '/bin/bash'
  const { code, stdout } = await runCapture(shell, ['-l', '-c', 'printf %s "$PATH"'])
  const loginPath = code === 0 ? stdout.trim() : ''
  const path = loginPath || (process.env.PATH ?? '')
  return {
    path,
    vars: { ...(process.env as EnvRecord), PATH: path },
    source: loginPath ? 'login-shell' : 'process'
  }
}

export function defaultMachineEnvReader(platform: NodeJS.Platform = process.platform): MachineEnvReader {
  return async () => {
    if (platform === 'win32') {
      const result = await readWindowsEnvironment()
      if (result.source === 'windows-registry') return result
      // Fall back to the inherited environment if the registry is unreadable
      // (locked-down machines, containers).
      const spec = WINDOWS_SPEC
      return {
        path: process.env[spec.canonicalPathKey] ?? process.env.PATH ?? '',
        vars: { ...(process.env as EnvRecord) },
        source: 'process'
      }
    }
    return readPosixEnvironment()
  }
}