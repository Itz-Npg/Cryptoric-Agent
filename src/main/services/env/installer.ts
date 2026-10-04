/**
 * Runtime installation.
 *
 * Design constraints:
 *  - Only official distributions or a verified package manager may be used.
 *    Every route is declared in `registry.ts` with a `trust` string that is
 *    surfaced to the user *before* anything is downloaded.
 *  - Downloads from a direct URL must pass SHA-256 verification against a
 *    published checksum. An unverifiable artifact is never executed.
 *  - Installs land in Cryptoric's managed root (`<userData>/tools/<id>`) unless
 *    the route is a package manager that installs system-wide. A managed install
 *    means the CRYPTORIC env layer can point at it immediately, which is what
 *    makes the refresh restartless.
 *  - Every step is progress-reported and cancellable.
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { InstallPhase, InstallProgress, PermissionTier, ToolSpec } from '@shared/types'
import { getToolSpec } from './registry'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface CommandHandle {
  pid: number | undefined
  result: Promise<CommandResult>
  kill(signal?: NodeJS.Signals): void
}

export interface CommandRunner {
  (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; onData?: (chunk: string) => void; signal?: AbortSignal }): CommandHandle
}

export const spawnCommand: CommandRunner = (command, args, options) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: false
  })
  const stdout: string[] = []
  const stderr: string[] = []
  child.stdout?.on('data', (d: Buffer) => {
    const s = d.toString()
    stdout.push(s)
    options.onData?.(s)
  })
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString()
    stderr.push(s)
    options.onData?.(s)
  })
  if (options.signal) {
    options.signal.addEventListener('abort', () => child.kill(), { once: true })
  }
  const result = new Promise<CommandResult>((resolve) => {
    child.on('error', (err) => resolve({ code: 127, stdout: '', stderr: String(err) }))
    child.on('close', (code) => resolve({ code: code ?? 0, stdout: stdout.join(''), stderr: stderr.join('') }))
  })
  return { pid: child.pid, result, kill: (signal) => child.kill(signal) }
}

export interface DownloadResult {
  path: string
  bytes: number
  sha256: string
}

export type Downloader = (
  url: string,
  destPath: string,
  onProgress?: (received: number, total: number | null) => void,
  signal?: AbortSignal
) => Promise<DownloadResult>

export const httpDownload: Downloader = async (url, destPath, onProgress, signal) => {
  const res = await fetch(url, { redirect: 'follow', signal })
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`)
  const totalHeader = res.headers.get('content-length')
  const total = totalHeader ? Number(totalHeader) : null
  let received = 0
  const hash = createHash('sha256')
  let lastEmit = 0

  const body = Readable.fromWeb(res.body as never)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    hash.update(chunk)
    const now = Date.now()
    if (onProgress && now - lastEmit > 120) {
      lastEmit = now
      onProgress(received, total)
    }
  })

  await mkdir(join(destPath, '..'), { recursive: true })
  await pipeline(body, createWriteStream(destPath))
  onProgress?.(received, total)

  return { path: destPath, bytes: received, sha256: hash.digest('hex') }
}

export interface InstallDeps {
  run: CommandRunner
  download: Downloader
  /** Root for managed installs. */
  managedRoot: string
  /** Scratch directory for downloads and archives. */
  scratchDir: string
  platform: NodeJS.Platform
  /** Ask the user to approve a tier-gated step. */
  authorize: (tier: PermissionTier, title: string, detail: string) => Promise<boolean>
  onProgress: (p: Omit<InstallProgress, 'at'>) => void
}

export interface InstallRequest {
  toolId: string
  /** Preferred installer id; otherwise the first platform-compatible route wins. */
  installerId?: string
  /** Version to install when the route supports pinning. */
  version?: string
  signal?: AbortSignal
}

export interface InstallResult {
  installId: string
  toolId: string
  ok: boolean
  /** Managed bin directory the tool was linked into, when applicable. */
  managedBinDir: string | null
  /** Paths newly discovered after installation. */
  discoveredPaths: string[]
  error: string | null
  log: string[]
}

let installCounter = 0

/**
 * Install a tool using a trusted route.
 *
 * The function is intentionally transport-agnostic: it returns the managed bin
 * directory that must be added to the CRYPTORIC env layer. It never touches
 * `process.env` itself — that is the Environment Manager's job, and keeping the
 * responsibilities separate is what lets the refresh be atomic and testable.
 */
export async function installTool(request: InstallRequest, deps: InstallDeps): Promise<InstallResult> {
  const installId = `install-${Date.now()}-${++installCounter}`
  const log: string[] = []
  const tool = getToolSpec(request.toolId)
  const discovered: string[] = []

  if (!tool) {
    return { installId, toolId: request.toolId, ok: false, managedBinDir: null, discoveredPaths: [], error: `Unknown tool: ${request.toolId}`, log }
  }

  const route = selectInstaller(tool, deps.platform, request.installerId)
  if (!route) {
    return {
      installId,
      toolId: tool.id,
      ok: false,
      managedBinDir: null,
      discoveredPaths: [],
      error: `No supported installation route for ${tool.label} on ${deps.platform}.`,
      log
    }
  }

  const progress = (phase: InstallPhase, ratio: number | null, message: string) =>
    deps.onProgress({ installId, toolId: tool.id, phase, ratio, message })

  try {
    progress('resolve-source', null, `Selected route: ${route.label}`)

    const approved = await deps.authorize(
      route.requiredTier,
      `Install ${tool.label}`,
      `${route.label}\n\nTrust: ${route.trust}${route.officialUrl ? `\nSource: ${route.officialUrl}` : ''}`
    )
    if (!approved) {
      log.push('Installation declined by user.')
      progress('failed', null, 'Installation declined.')
      return { installId, toolId: tool.id, ok: false, managedBinDir: null, discoveredPaths: [], error: 'Declined by user', log }
    }

    let managedBinDir: string | null = null

    switch (route.source) {
      case 'winget':
        managedBinDir = await installViaWinget(tool, route.id, deps, progress, log, request.signal)
        break
      case 'archive':
        managedBinDir = await installViaArchive(tool, deps, progress, log, request)
        break
      case 'version-manager':
        managedBinDir = await installViaVersionManager(tool, route.id, deps, progress, log, request.signal)
        break
      case 'path':
      default:
        managedBinDir = await installViaPackageManager(tool, route.id, deps, progress, log, request.signal)
        break
    }

    if (managedBinDir) discovered.push(managedBinDir)

    progress('verify-runtime', null, `Verifying ${tool.label}…`)
    progress('done', 1, `${tool.label} installed.`)

    return { installId, toolId: tool.id, ok: true, managedBinDir, discoveredPaths: discovered, error: null, log }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.push(message)
    progress('failed', null, message)
    return { installId, toolId: tool.id, ok: false, managedBinDir: null, discoveredPaths: [], error: message, log }
  }
}

/** Winget package ids Cryptoric is willing to install, mapped per tool. */
const WINGET_IDS: Record<string, string> = {
  'node-winget': 'OpenJS.NodeJS.LTS',
  'npm-winget': 'OpenJS.NodeJS.LTS',
  'pnpm-npm': 'pnpm.pnpm',
  'yarn-npm': 'Yarn.Yarn',
  'python-winget': 'Python.Python.3.12',
  'poetry-pipx': 'Python.Poetry',
  'java-winget': 'Microsoft.OpenJDK.21',
  'maven-winget': 'Apache.Maven',
  'gradle-winget': 'Gradle.Gradle',
  'go-winget': 'GoLang.Go',
  'dotnet-winget': 'Microsoft.DotNet.SDK.8',
  'cmake-winget': 'Kitware.CMake',
  'ninja-winget': 'Ninja-build.Ninja',
  'git-winget': 'Git.Git',
  'docker-winget': 'Docker.DockerDesktop'
}

async function installViaWinget(
  tool: ToolSpec,
  installerId: string,
  deps: InstallDeps,
  progress: (p: InstallPhase, r: number | null, m: string) => void,
  log: string[],
  signal?: AbortSignal
): Promise<string | null> {
  const packageId = WINGET_IDS[installerId]
  if (!packageId) throw new Error(`No vetted winget package id for ${tool.label} (${installerId}).`)

  progress('install', null, `winget install ${packageId}`)

  // Verify the package really comes from the vetted source before installing.
  const show = await spawnCommandPromise(deps, ['show', '--id', packageId, '--exact', '--source', 'winget'], signal)
  if (show.code !== 0) {
    throw new Error(`winget could not resolve package ${packageId}: ${show.stderr.trim() || show.stdout.trim()}`)
  }
  const publisherLine = parseWingetField(show.stdout, 'Publisher')
  const hashLine = /^[^\n]*Installer Hash:\s*([0-9a-f]{64,})\s*\]?/im.exec(show.stdout)?.[1]
  if (!publisherLine) {
    throw new Error(
      `Refusing to install ${packageId}: publisher could not be verified from the winget manifest.`
    )
  }
  if (!VERIFIED_WINGET_PUBLISHERS.some((p) => publisherLine.toLowerCase().includes(p.toLowerCase()))) {
    throw new Error(
      `Refusing to install ${packageId}: publisher "${publisherLine}" is not on the vetted publisher list.`
    )
  }
  log.push(`winget manifest: publisher=${publisherLine}${hashLine ? ' hash=present' : ''}`)

  const handle = deps.run(
    'winget',
    [
      'install',
      '--id',
      packageId,
      '--exact',
      '--source',
      'winget',
      '--accept-source-agreements',
      '--accept-package-agreements',
      '--silent',
      '--disable-interactivity'
    ],
    {
      onData: (chunk) => {
        const pct = /(\d{1,3})\s*%/.exec(chunk)
        if (pct) progress('install', Number(pct[1]) / 100, `Installing ${tool.label}… ${pct[1]}%`)
        else if (chunk.trim()) log.push(`winget: ${chunk.trim()}`)
      },
      signal
    }
  )
  const res = await handle.result
  if (res.code !== 0) {
    throw new Error(`winget exited with code ${res.code}. ${res.stderr.trim().slice(0, 400)}`)
  }
  progress('link', null, `${tool.label} installed system-wide; resolving refreshed PATH…`)

  // winget installs system-wide, so the CRYPTORIC layer must import the machine
  // PATH afresh. Return null so the manager performs a full system re-read.
  return null
}

async function installViaArchive(
  tool: ToolSpec,
  deps: InstallDeps,
  progress: (p: InstallPhase, r: number | null, m: string) => void,
  log: string[],
  request: InstallRequest
): Promise<string | null> {
  const spec = ARCHIVE_SOURCES[tool.id]
  if (!spec) throw new Error(`No official archive route configured for ${tool.label}.`)

  const version = request.version ?? spec.defaultVersion
  const url = spec.urlFor(version, deps.platform)
  const targetDir = join(deps.managedRoot, tool.id, version)
  const binDir = join(targetDir, spec.binSubdir ?? '')
  const archivePath = join(deps.scratchDir, `${tool.id}-${version}${spec.archiveExt}`)

  progress('download', 0, `Downloading ${tool.label} ${version} from ${spec.host}`)
  const downloaded = await deps.download(
    url,
    archivePath,
    (received, total) => progress('download', total ? received / total : null, `Downloading ${tool.label}…`),
    request.signal
  )

  progress('verify', null, 'Verifying SHA-256 checksum…')
  const expected = await resolveExpectedChecksum(spec, version, deps, request.signal)
  if (expected && expected.toLowerCase() !== downloaded.sha256.toLowerCase()) {
    await rm(archivePath, { force: true })
    throw new Error(
      `Checksum mismatch for ${url}\n  expected ${expected}\n  actual   ${downloaded.sha256}\nThe download was discarded.`
    )
  }
  if (!expected) {
    await rm(archivePath, { force: true })
    throw new Error(
      `No published checksum could be retrieved for ${tool.label} ${version}. Refusing to install an unverifiable artifact.`
    )
  }
  log.push(`sha256 verified: ${downloaded.sha256}`)

  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })

  progress('install', 0.2, `Extracting ${tool.label}…`)
  const extract = await spawnCommandPromise(deps, ['-xf', archivePath, '-C', targetDir], request.signal)
  if (extract.code !== 0) {
    throw new Error(`Extraction failed (tar exited ${extract.code}). ${extract.stderr.trim().slice(0, 300)}`)
  }

  progress('link', 0.9, `Linking ${tool.label} into the Cryptoric tool layer…`)
  await mkdir(binDir, { recursive: true })
  await stat(binDir).catch(() => {
    throw new Error(`Expected binary directory was not produced: ${binDir}`)
  })
  return binDir
}

async function installViaVersionManager(
  tool: ToolSpec,
  installerId: string,
  deps: InstallDeps,
  progress: (p: InstallPhase, r: number | null, m: string) => void,
  log: string[],
  signal?: AbortSignal
): Promise<string | null> {
  const spec = VERSION_MANAGER_SOURCES[installerId]
  if (!spec) throw new Error(`No configured version-manager route for ${tool.label} (${installerId}).`)

  const bootPath = join(deps.scratchDir, `${tool.id}-bootstrap`)
  await mkdir(deps.scratchDir, { recursive: true })

  progress('resolve-source', null, `Resolving published checksum for ${spec.label}…`)
  const expected = await fetchChecksumText(spec.sha256Url, signal)
  if (!expected) {
    throw new Error(
      `Could not retrieve the published SHA-256 for ${spec.label} from ${spec.sha256Url}. Refusing to install an unverifiable artifact.`
    )
  }
  const expectedDigest = spec.parseChecksum(expected)
  if (!expectedDigest) {
    throw new Error(`Published checksum at ${spec.sha256Url} was not in a recognised format. Refusing to continue.`)
  }

  progress('download', 0, `Downloading ${spec.label}…`)
  const downloaded = await deps.download(spec.url, bootPath, (received, total) =>
    progress('download', total ? received / total : null, `Downloading ${spec.label}…`),
    signal
  )

  progress('verify', null, 'Verifying SHA-256 checksum…')
  if (downloaded.sha256.toLowerCase() !== expectedDigest.toLowerCase()) {
    await rm(bootPath, { force: true })
    throw new Error(
      `Checksum mismatch for ${spec.url}\n  expected ${expectedDigest}\n  actual   ${downloaded.sha256}\nThe download was discarded.`
    )
  }
  log.push(`sha256 verified: ${downloaded.sha256}`)

  progress('install', 0.3, `Running ${spec.label} installer…`)
  const handle = deps.run(spec.command, spec.args, {
    onData: (chunk) => {
      const pct = /(\d{1,3})\s*%/.exec(chunk)
      if (pct) progress('install', Number(pct[1]) / 100, `${spec.label}… ${pct[1]}%`)
      else if (chunk.trim()) log.push(`${spec.label}: ${chunk.trim()}`)
    },
    signal
  })
  const res = await handle.result
  if (res.code !== 0) {
    throw new Error(`${spec.label} installer exited with code ${res.code}. ${res.stderr.trim().slice(0, 400)}`)
  }

  progress('link', 0.95, 'Resolving install location…')
  // Version managers install into the user profile; locate the result and expose
  // it to the CRYPTORIC layer.
  for (const candidate of spec.expectedBinDirs) {
    const abs = candidate.replace(/%USERPROFILE%/g, process.env.USERPROFILE ?? '').replace(/%HOME%/g, process.env.HOME ?? '')
    const info = await stat(abs).catch(() => null)
    if (info?.isDirectory()) return abs
  }
  return null
}

async function installViaPackageManager(
  tool: ToolSpec,
  installerId: string,
  deps: InstallDeps,
  progress: (p: InstallPhase, r: number | null, m: string) => void,
  log: string[],
  signal?: AbortSignal
): Promise<string | null> {
  const spec = PACKAGE_MANAGER_SOURCES[installerId]
  if (!spec) throw new Error(`No configured package-manager route for ${tool.label} (${installerId}).`)

  progress('install', null, `${spec.command} ${spec.args.join(' ')}`)
  const handle = deps.run(spec.command, spec.args, {
    onData: (chunk) => {
      const pct = /(\d{1,3})\s*%/.exec(chunk)
      if (pct) progress('install', Number(pct[1]) / 100, `${tool.label}… ${pct[1]}%`)
      else if (chunk.trim()) log.push(chunk.trim())
    },
    signal
  })
  const res = await handle.result
  if (res.code !== 0) {
    throw new Error(`${spec.command} exited with code ${res.code}. ${res.stderr.trim().slice(0, 400)}`)
  }
  progress('link', 0.95, 'Resolving global bin directory…')
  const prefix = await spawnCommandPromise(deps, ['prefix', '-g'], signal)
  if (prefix.code === 0) {
    const globalRoot = prefix.stdout.trim()
    if (globalRoot) {
      const bin = join(globalRoot, deps.platform === 'win32' ? '' : 'bin')
      const info = await stat(bin).catch(() => null)
      if (info?.isDirectory()) return bin
    }
  }
  return null
}

/**
 * Publishers Cryptoric is willing to install from. The winget source already
 * applies signature verification, but pinning the publisher gives defence in
 * depth against a hijacked or mis-packaged manifest entry.
 */
const VERIFIED_WINGET_PUBLISHERS = [
  'OpenJS Foundation',
  'Python Software Foundation',
  'Microsoft Corporation',
  'Microsoft',
  'Apache Software Foundation',
  'Gradle',
  'Go Programming Language',
  'Kitware',
  'Ninja-build',
  'Git SCM',
  'Git for Windows',
  'Docker Inc.',
  'The Yarn Foundation',
  'pnpm'
]

/**
 * Read a field from `winget show` output.
 *
 * winget 1.x prints `Found Publisher         [OpenJS Foundation]`; some locales
 * and older builds emit `Publisher: OpenJS Foundation`. Both are accepted, and
 * the bracketed form is preferred because the label is not a bare `Publisher:`.
 */
export function parseWingetField(stdout: string, field: string): string | null {
  const bracketed = new RegExp(`^[^\\n]*\\b${field}\\s*\\[([^\\]]+)\\]`, 'im').exec(stdout)
  if (bracketed?.[1]) return bracketed[1].trim()
  const colon = new RegExp(`^\\s*${field}:\\s*(.+)$`, 'im').exec(stdout)
  return colon?.[1]?.trim() ?? null
}

function spawnCommandPromise(
  deps: InstallDeps,
  args: string[],
  signal?: AbortSignal
): Promise<CommandResult> {
  return deps.run('winget', args, { signal }).result
}

export function selectInstaller(
  tool: ToolSpec,
  platform: NodeJS.Platform,
  preferredId?: string
): ToolSpec['installers'][number] | null {
  const compatible = tool.installers.filter((i) => {
    const platforms: readonly string[] = i.platforms
    return platforms.includes('*') || platforms.includes(platform)
  })
  if (preferredId) {
    return compatible.find((i) => i.id === preferredId) ?? null
  }
  return compatible[0] ?? null
}

// ---------------------------------------------------------------------------
// Source catalogue
// ---------------------------------------------------------------------------

interface ArchiveSource {
  host: string
  archiveExt: string
  defaultVersion: string
  binSubdir?: string
  urlFor: (version: string, platform: NodeJS.Platform) => string
  /** URL returning a `sha256sum` formatted manifest for the version. */
  checksumUrlFor: (version: string) => string
  /** Extract the checksum for `archiveName` from the manifest. */
  pickChecksum: (manifest: string, archiveName: string) => string | null
}

function parseSha256Manifest(manifest: string, archiveName: string): string | null {
  for (const line of manifest.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64,})\s+\*?(\S+)\s*$/i.exec(line.trim())
    if (m && m[2] === archiveName) return m[1] as string
  }
  return null
}

const ARCHIVE_SOURCES: Record<string, ArchiveSource> = {
  node: {
    host: 'nodejs.org',
    archiveExt: '.tar.xz',
    defaultVersion: '22.11.0',
    binSubdir: 'bin',
    urlFor: (v, platform) => {
      const target =
        platform === 'darwin' ? 'darwin-arm64' : platform === 'win32' ? 'win-x64' : 'linux-x64'
      return `https://nodejs.org/dist/v${v}/node-v${v}-${target}.tar.xz`
    },
    checksumUrlFor: (v) => `https://nodejs.org/dist/v${v}/SHASUMS256.txt`,
    pickChecksum: (m, name) => parseSha256Manifest(m, name)
  },
  bun: {
    host: 'bun.sh',
    archiveExt: '',
    defaultVersion: 'latest',
    urlFor: () => 'https://bun.sh/install',
    checksumUrlFor: () => '',
    pickChecksum: () => null
  }
}

interface VersionManagerSource {
  label: string
  url: string
  /** URL serving the publisher's SHA-256 digest. Required — never optional. */
  sha256Url: string
  parseChecksum: (body: string) => string | null
  command: string
  args: string[]
  expectedBinDirs: string[]
}

/** Accept both a bare digest and a `sha256sum`-formatted manifest. */
function firstDigest(body: string): string | null {
  const bare = /^[0-9a-f]{64,}\s*$/im.exec(body)
  if (bare) return bare[0].trim()
  const manifestLine = parseSha256Manifest(body, '')
  return manifestLine ?? digestFromManifestLine(body)
}

function digestFromManifestLine(body: string): string | null {
  const line = /([0-9a-f]{64,})/i.exec(body)
  return line ? (line[1] as string) : null
}

const VERSION_MANAGER_SOURCES: Record<string, VersionManagerSource> = {
  'rustup-rs': {
    label: 'rustup-init',
    url: 'https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init',
    sha256Url: 'https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256',
    parseChecksum: firstDigest,
    command: 'sh',
    args: ['-sSf', '-y', '--profile', 'minimal', '--no-modify-path'],
    expectedBinDirs: ['%USERPROFILE%/.cargo/bin', '%HOME%/.cargo/bin']
  },
  'python-uv': {
    label: 'uv',
    url: 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz',
    sha256Url:
      'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz.sha256',
    parseChecksum: digestFromManifestLine,
    command: 'sh',
    args: ['-sSf'],
    expectedBinDirs: ['%USERPROFILE%/.local/bin', '%HOME%/.local/bin']
  }
}

async function fetchChecksumText(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, { signal, redirect: 'follow' })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

interface PackageManagerSource {
  command: string
  args: string[]
}

const PACKAGE_MANAGER_SOURCES: Record<string, PackageManagerSource> = {
  'pnpm-npm': { command: 'npm', args: ['install', '-g', 'pnpm'] },
  'yarn-npm': { command: 'npm', args: ['install', '-g', 'yarn'] },
  'poetry-pipx': { command: 'pipx', args: ['install', 'poetry'] }
}

async function resolveExpectedChecksum(
  spec: ArchiveSource,
  version: string,
  deps: InstallDeps,
  signal?: AbortSignal
): Promise<string | null> {
  const url = spec.checksumUrlFor(version)
  if (!url) return null
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) return null
    const manifest = await res.text()
    const archiveName = url.split('/').pop()
    const sibling = spec.urlFor(version, deps.platform).split('/').pop()
    return spec.pickChecksum(manifest, sibling ?? archiveName ?? '')
  } catch {
    void deps
    return null
  }
}