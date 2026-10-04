/**
 * Process supervisor and port manager.
 *
 * Tracks dev servers, watchers, test runs and agent subprocesses. Every process
 * records the environment snapshot it was spawned with, so a process started
 * before a runtime install is flagged `envStale` rather than being silently
 * killed. Restarting is an explicit user action.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import type { ProcessInfo } from '@shared/types'
import type { EnvironmentManager } from '../env/manager'

const LOG_TAIL_CHARS = 8_000

export interface SupervisorEvents {
  onChange(process: ProcessInfo): void
  onOutput(processId: string, chunk: string, stream: 'stdout' | 'stderr'): void
}

export interface StartProcessOptions {
  label: string
  command: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
  /** Expected port, used to confirm a dev server actually came up. */
  expectedPort?: number | null
}

interface Record_ {
  info: ProcessInfo
  child: ReturnType<typeof spawn>
  log: string[]
  logChars: number
  env: NodeJS.ProcessEnv
  abort: AbortController
}

let counter = 0

export class ProcessSupervisor {
  private readonly processes = new Map<string, Record_>()
  private readonly events: SupervisorEvents

  constructor(
    private readonly env: EnvironmentManager,
    events: SupervisorEvents
  ) {
    this.events = events
  }

  list(): ProcessInfo[] {
    return [...this.processes.values()].map((r) => this.describe(r))
  }

  get(id: string): ProcessInfo | null {
    const r = this.processes.get(id)
    return r ? this.describe(r) : null
  }

  logs(id: string): string {
    return this.processes.get(id)?.log.join('') ?? ''
  }

  start(options: StartProcessOptions): ProcessInfo {
    const id = `proc-${Date.now()}-${++counter}`
    const snapshot = this.env.getSnapshot()
    const env = options.env
      ? options.env
      : this.env.environmentFor({ projectRoot: options.cwd })

    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: env as NodeJS.ProcessEnv,
      // Never a shell string: argv is passed through verbatim.
      shell: false,
      windowsHide: true
    })

    const info: ProcessInfo = {
      id,
      label: options.label,
      command: [options.command, ...(options.args ?? [])].join(' '),
      cwd: options.cwd,
      pid: child.pid ?? null,
      status: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      port: options.expectedPort ?? null,
      logTail: '',
      envSnapshotId: snapshot.id,
      envStale: false
    }

    const record: Record_ = {
      info,
      child,
      log: [],
      logChars: 0,
      env,
      abort: new AbortController()
    }

    const onChunk = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString()
      record.log.push(text)
      record.logChars += text.length
      while (record.logChars > LOG_TAIL_CHARS && record.log.length > 1) {
        record.logChars -= record.log.shift()?.length ?? 0
      }
      this.events.onOutput(id, text, stream)
    }

    child.stdout?.on('data', onChunk('stdout'))
    child.stderr?.on('data', onChunk('stderr'))

    child.on('error', (err) => {
      record.log.push(`\n[cryptoric] failed to start: ${err.message}\n`)
      record.info.status = 'failed'
      record.info.endedAt = new Date().toISOString()
      this.events.onChange(this.describe(record))
    })

    child.on('close', (code) => {
      record.info.exitCode = code
      record.info.endedAt = new Date().toISOString()
      record.info.status =
        record.info.status === 'stopped' ? 'stopped' : code === 0 ? 'exited' : 'failed'
      this.events.onChange(this.describe(record))
    })

    this.processes.set(id, record)
    this.events.onChange(this.describe(record))
    return this.describe(record)
  }

  stop(id: string): boolean {
    const r = this.processes.get(id)
    if (!r) return false
    if (r.child.exitCode === null) {
      r.info.status = 'stopped'
      r.child.kill()
      // Give the process a moment, then force it so a hung watcher cannot linger.
      setTimeout(() => {
        if (this.processes.get(id)?.child.exitCode === null) r.child.kill('SIGKILL')
      }, 2000).unref?.()
    }
    this.events.onChange(this.describe(r))
    return true
  }

  /**
   * Restart a process. This is the *only* supported way to hand a long-running
   * child the refreshed environment, and it is always user-initiated.
   */
  restart(id: string): ProcessInfo | null {
    const r = this.processes.get(id)
    if (!r) return null
    const { label, command, cwd } = r.info
    const args = command.split(' ').slice(1)
    this.stop(id)
    return this.start({ label, command: args.length > 0 ? (args[0] as string) : command, args, cwd })
  }

  remove(id: string): boolean {
    const r = this.processes.get(id)
    if (!r) return false
    if (r.child.exitCode === null) r.child.kill()
    return this.processes.delete(id)
  }

  stopAll(): void {
    for (const id of [...this.processes.keys()]) this.stop(id)
  }

  /** Recompute staleness against the current snapshot. */
  markStale(currentSnapshotId: number): void {
    for (const r of this.processes.values()) {
      const stale = r.info.envSnapshotId !== currentSnapshotId && r.child.exitCode === null
      if (stale !== r.info.envStale) {
        r.info.envStale = stale
        this.events.onChange(this.describe(r))
      }
    }
  }

  private describe(r: Record_): ProcessInfo {
    return {
      ...r.info,
      logTail: r.log.join('').slice(-LOG_TAIL_CHARS),
      envStale: r.info.envSnapshotId !== this.env.getSnapshot().id && r.child.exitCode === null
    }
  }
}

/** Is a TCP port free to bind on loopback? */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

export interface PortResolution {
  port: number
  /** True when the originally requested port was already usable. */
  usedRequested: boolean
  free: boolean
}

/** Find a free port at or above `start`, bounded so the scan cannot run away. */
export async function findFreePort(start: number, end = start + 200, host = '127.0.0.1'): Promise<PortResolution | null> {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port, host)) return { port, usedRequested: port === start, free: true }
  }
  return null
}

/** Scan a range for listening sockets. Used by the port inspector. */
export async function scanPorts(from: number, to: number): Promise<number[]> {
  const found: number[] = []
  for (let port = from; port <= to; port++) {
    if (!(await isPortFree(port))) found.push(port)
  }
  return found
}