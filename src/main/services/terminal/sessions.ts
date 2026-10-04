/**
 * Terminal session manager.
 *
 * Every session freezes the environment it was born with. That is deliberate: a
 * developer who has an interactive shell open mid-install expects it to keep
 * behaving consistently, not to silently change PATH underneath them. Sessions
 * are therefore *marked* `envStale` when a newer snapshot exists, and refreshing
 * means spawning a **new** session with the new snapshot — never mutating a live
 * one. The application itself never restarts.
 *
 * Transport note: sessions use a real child shell process with streamed stdio.
 * A PTY (node-pty) is deliberately *not* used, because it requires a native
 * prebuild per platform and would make the build non-reproducible. The
 * consequence is stated honestly in the UI: full-screen TUI programs (vim, less
 * without -F) need the integrated browser or an external terminal.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { platform } from 'node:process'
import type { EnvRecord, TerminalSessionInfo, TerminalStatus } from '@shared/types'
import type { EnvironmentManager } from '../env/manager'

export interface TerminalEvents {
  onOutput(sessionId: string, chunk: string, stream: 'stdout' | 'stderr'): void
  onExit(sessionId: string, exitCode: number | null): void
  onChange(): void
}

export interface CreateSessionOptions {
  cwd: string
  label?: string
  /** Override the environment; defaults to the manager's current resolution. */
  env?: EnvRecord
  taskEnv?: EnvRecord | null
}

interface SessionRecord {
  info: TerminalSessionInfo
  child: ChildProcessWithoutNullStreams
  /** Frozen copy of the environment this session runs with. */
  env: EnvRecord
  /** Output ring buffer, capped so a runaway process cannot exhaust memory. */
  buffer: string[]
  bufferChars: number
}

const BUFFER_LIMIT = 200_000

/** Resolve the platform's interactive shell. */
export function defaultShell(): { command: string; args: string[] } {
  if (platform === 'win32') {
    const comspec = process.env.ComSpec || 'powershell.exe'
    if (/powershell/i.test(comspec)) {
      return { command: comspec, args: ['-NoLogo', '-NoExit', '-Command', '$PSVersionTable.PSVersion.ToString()'] }
    }
    return { command: comspec || 'cmd.exe', args: ['/K'] }
  }
  return { command: process.env.SHELL || '/bin/bash', args: ['-i'] }
}

let counter = 0

export class TerminalSessionManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly events: TerminalEvents

  constructor(
    private readonly env: EnvironmentManager,
    events: TerminalEvents
  ) {
    this.events = events
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((s) => this.describe(s))
  }

  get(id: string): TerminalSessionInfo | null {
    const s = this.sessions.get(id)
    return s ? this.describe(s) : null
  }

  /** Full output captured so far, for "copy logs" and agent inspection. */
  read(id: string): string {
    return this.sessions.get(id)?.buffer.join('') ?? ''
  }

  create(options: CreateSessionOptions): TerminalSessionInfo {
    const id = `term-${Date.now()}-${++counter}`
    const snapshot = this.env.getSnapshot()
    const env = options.env
      ? options.env
      : this.env.environmentFor({ projectRoot: options.cwd, taskEnv: options.taskEnv })

    const shell = defaultShell()
    const child = spawn(shell.command, shell.args, {
      cwd: options.cwd,
      env: env as NodeJS.ProcessEnv,
      windowsHide: true,
      // Never run through a shell string: shell injection would be trivial.
      shell: false
    })

    const info: TerminalSessionInfo = {
      id,
      cwd: options.cwd,
      shell: shell.command,
      pid: child.pid ?? null,
      status: 'starting',
      envSnapshotId: snapshot.id,
      createdAt: new Date().toISOString(),
      envStale: false,
      exitCode: null,
      label: options.label ?? `shell ${counter}`
    }

    const record: SessionRecord = { info, child, env, buffer: [], bufferChars: 0 }

    const onChunk = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString()
      record.buffer.push(text)
      record.bufferChars += text.length
      while (record.bufferChars > BUFFER_LIMIT && record.buffer.length > 1) {
        const dropped = record.buffer.shift()
        record.bufferChars -= dropped?.length ?? 0
      }
      this.events.onOutput(id, text, stream)
      this.events.onChange()
    }

    child.stdout.on('data', onChunk('stdout'))
    child.stderr.on('data', onChunk('stderr'))

    child.on('error', (err) => {
      record.info.status = 'error'
      record.info.exitCode = null
      this.events.onOutput(id, `\r\n[cryptoric] shell failed to start: ${err.message}\r\n`, 'stderr')
      this.events.onChange()
    })

    child.on('close', (code) => {
      record.info.status = 'exited'
      record.info.exitCode = code
      this.events.onExit(id, code)
      this.events.onChange()
    })

    record.info.status = 'ready'
    this.sessions.set(id, record)
    this.events.onChange()
    return this.describe(record)
  }

  /** Send raw input to the session's stdin. */
  write(id: string, data: string): boolean {
    const s = this.sessions.get(id)
    if (!s || s.info.status === 'exited' || s.info.status === 'error') return false
    return s.child.stdin.write(data)
  }

  /**
   * Create a replacement session for an existing one, using the current
   * environment. The old session is preserved unless `closeOld` is set.
   */
  refresh(id: string, opts: { closeOld?: boolean } = {}): TerminalSessionInfo | null {
    const old = this.sessions.get(id)
    if (!old) return null
    const replacement = this.create({ cwd: old.info.cwd, label: `${old.info.label} (refreshed)` })
    if (opts.closeOld) this.close(id)
    return replacement
  }

  close(id: string): boolean {
    const s = this.sessions.get(id)
    if (!s) return false
    if (s.info.status !== 'exited' && s.info.status !== 'error') {
      s.child.kill()
    }
    this.sessions.delete(id)
    this.events.onChange()
    return true
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  /** Mark sessions whose snapshot predates the current one. Called after refresh. */
  markStale(currentSnapshotId: number): void {
    let changed = false
    for (const s of this.sessions.values()) {
      const stale = s.info.envSnapshotId !== currentSnapshotId && s.info.status !== 'exited'
      if (stale !== s.info.envStale) {
        s.info.envStale = stale
        changed = true
      }
    }
    if (changed) this.events.onChange()
  }

  private describe(s: SessionRecord): TerminalSessionInfo {
    const status: TerminalStatus =
      s.child.exitCode !== null ? 'exited' : s.info.status === 'error' ? 'error' : 'ready'
    return { ...s.info, status }
  }
}