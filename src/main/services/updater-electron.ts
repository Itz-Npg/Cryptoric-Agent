/**
 * The real transport: `electron-updater` pointed at GitHub Releases.
 *
 * Everything policy-shaped lives in `UpdateService`. This file only knows how to
 * talk to the library and, importantly, how to say honestly when it cannot run.
 */

import { app } from 'electron'
// `electron-updater` ships CommonJS. A named ESM import type-checks and then
// throws `Named export 'autoUpdater' not found` when the bundle actually loads,
// so the default export is unpacked by hand.
import electronUpdater from 'electron-updater'
import type { UpdatePort, UpdateProgress } from './updater'

const { autoUpdater } = electronUpdater

/** Where a human reads what changed. Built from the feed, never hardcoded. */
function releasePageFor(version: string | null): string | null {
  if (!version) return null
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/v${version}`
}

const REPO_OWNER = 'Itz-Npg'
const REPO_NAME = 'Cryptoric-Agent'

export function createElectronUpdatePort(): UpdatePort {
  // The library infers the owner/repo from `publish` in electron-builder.yml.
  // `autoUpdater.setFeedURL` would override that with a hardcoded copy that
  // silently rots the day the repository is renamed, so it is set from the same
  // source of truth instead.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false

  return {
    get currentVersion(): string {
      return app.getVersion()
    },

    canCheck(): { ok: boolean; reason: string | null } {
      // The library throws `dev mode` in an unpackaged build. Catching that as
      // "no update" is how an updater ends up reporting a permanent false
      // all-clear, so it is reported as its own state.
      if (!app.isPackaged) {
        return {
          ok: false,
          reason:
            'This is a development build, so it has no update feed. Updates apply to the packaged app.'
        }
      }
      return { ok: true, reason: null }
    },

    async check() {
      const result = await autoUpdater.checkForUpdates()
      const info = result?.updateInfo
      const version = info?.version ?? null

      // `releaseNotes` arrives as an object keyed by platform from the feed.
      let notes: string | null = null
      const raw = info?.releaseNotes as unknown
      if (typeof raw === 'string' && raw.trim()) {
        notes = raw
      } else if (raw && typeof raw === 'object') {
        const bucket = raw as Record<string, string | undefined>
        const first = bucket['win32'] ?? bucket['default'] ?? bucket['linux'] ?? bucket['darwin']
        if (first && first.trim()) notes = first
      }

      return {
        version,
        releaseNotes: notes,
        releaseDate: info?.releaseDate ?? null,
        releasePageUrl: releasePageFor(version)
      }
    },

    async download(onProgress: (progress: UpdateProgress) => void) {
      // The staged version arrives on `update-downloaded`; `downloadUpdate`
      // itself only resolves with the file paths, so it is captured here rather
      // than guessed or re-fetched.
      let stagedVersion: string | null = null

      const onProgressEvent = (p: {
        percent?: number
        transferred?: number
        total?: number
        bytesPerSecond?: number
      }): void => {
        onProgress({
          percent: p.percent ?? 0,
          transferred: p.transferred ?? 0,
          total: p.total ?? 0,
          bytesPerSecond: p.bytesPerSecond ?? 0
        })
      }
      const onDownloaded = (p: { version?: string }): void => {
        stagedVersion = p?.version ?? null
      }

      autoUpdater.on('download-progress', onProgressEvent)
      autoUpdater.on('update-downloaded', onDownloaded)

      try {
        await autoUpdater.downloadUpdate()
        return { version: stagedVersion }
      } finally {
        autoUpdater.removeListener('download-progress', onProgressEvent)
        autoUpdater.removeListener('update-downloaded', onDownloaded)
      }
    },

    install(): void {
      // `quitAndInstall` ends the process, so nothing after this runs.
      autoUpdater.quitAndInstall(false, true)
    }
  }
}