/**
 * Persistence.
 *
 * Two stores with deliberately different security properties:
 *
 *  - `JsonStore` — settings, sessions, projects, tasks. Plaintext on disk in the
 *    app's userData directory, written atomically (temp file + rename) so a
 *    crash mid-write cannot corrupt state. Nothing secret goes here.
 *  - `CredentialStore` — API keys and tokens, encrypted with the OS keychain via
 *    Electron's `safeStorage`. If the OS offers no encryption backend the store
 *    refuses to persist rather than writing plaintext to disk.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface Persisted<T> {
  version: number
  updatedAt: string
  data: T
}

const SCHEMA_VERSION = 1

export class JsonStore<T extends object> {
  private cache: T | null = null

  constructor(
    private readonly filePath: string,
    private readonly defaults: T
  ) {}

  async load(): Promise<T> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Persisted<T>
      this.cache = { ...this.defaults, ...parsed.data }
    } catch {
      // Missing or corrupt state falls back to defaults rather than crashing.
      this.cache = { ...this.defaults }
    }
    return this.cache
  }

  get(): T {
    return this.cache ?? { ...this.defaults }
  }

  async set(patch: Partial<T>): Promise<T> {
    const next = { ...this.get(), ...patch }
    this.cache = next
    await this.persist(next)
    return next
  }

  private async persist(data: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const payload: Persisted<T> = {
      version: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      data
    }
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.filePath)
  }

  async clear(): Promise<void> {
    this.cache = { ...this.defaults }
    await unlink(this.filePath).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Minimal contract so the store can be unit tested without Electron. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(cipherText: Buffer): string
}

export class CredentialStore {
  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageLike
  ) {}

  /**
   * Persist a secret. Returns false when the OS has no encryption backend —
   * the caller must then keep the secret in memory only and tell the user.
   */
  async set(key: string, value: string): Promise<boolean> {
    if (!this.safeStorage.isEncryptionAvailable()) return false
    const all = this.readAll()
    all[key] = this.safeStorage.encryptString(value).toString('base64')
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify({ version: SCHEMA_VERSION, secrets: all }), {
      encoding: 'utf8',
      mode: 0o600
    })
    return true
  }

  get(key: string): string | null {
    if (!this.safeStorage.isEncryptionAvailable()) return null
    const encoded = this.readAll()[key]
    if (!encoded) return null
    try {
      return this.safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch {
      return null
    }
  }

  has(key: string): boolean {
    return key in this.readAll()
  }

  async delete(key: string): Promise<void> {
    const all = this.readAll()
    delete all[key]
    await writeFile(this.filePath, JSON.stringify({ version: SCHEMA_VERSION, secrets: all }), {
      encoding: 'utf8',
      mode: 0o600
    })
  }

  /** Key names only — values are never enumerated for logging or export. */
  keys(): string[] {
    return Object.keys(this.readAll())
  }

  private readAll(): Record<string, string> {
    try {
      // Synchronous read is intentional: this runs on the hot path of every
      // credential lookup and the file is a few hundred bytes.
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as { secrets?: Record<string, string> }
      return parsed.secrets ?? {}
    } catch {
      return {}
    }
  }
}

export interface AppState {
  recentProjects: { root: string; name: string; openedAt: string }[]
  lastProjectRoot: string | null
  layout: Record<string, unknown>
  updateChannel: 'stable' | 'beta' | 'nightly'
  theme: 'graphite' | 'bone'
  density: 'compact' | 'default' | 'relaxed'
  motion: 'full' | 'reduced'
  modelProvider: 'none' | 'ollama' | 'openai-compatible' | 'openrouter'
  modelEndpoint: string
  modelName: string
  /**
   * Display ceiling in USD. The daily allowance is 25 coins and one coin is one
   * cent, so the shipped default is 0.25. The server is authoritative once
   * accounts exist; this is the local ceiling used before that.
   */
  dailyBudgetUsd: number
  permissionOverrides: Record<string, string>
  onboardingComplete: boolean
}

export const DEFAULT_STATE: AppState = {
  recentProjects: [],
  lastProjectRoot: null,
  layout: {},
  updateChannel: 'stable',
  theme: 'graphite',
  density: 'default',
  motion: 'full',
  modelProvider: 'none',
  modelEndpoint: 'http://127.0.0.1:11434/v1',
  modelName: 'qwen2.5-coder:14b',
  dailyBudgetUsd: 0.25,
  permissionOverrides: {},
  onboardingComplete: false
}

export function createStore(userDataDir: string): JsonStore<AppState> {
  return new JsonStore<AppState>(join(userDataDir, 'state.json'), DEFAULT_STATE)
}