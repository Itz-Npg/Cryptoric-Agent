/**
 * Update policy.
 *
 * These tests are about the states the service is allowed to report, because an
 * updater's failure mode is not a crash — it is a confident, wrong all-clear.
 * The port is faked so the policy is testable without a network, a packaged
 * build, or a GitHub release.
 */

import { describe, expect, it } from 'vitest'
import { UpdateService, type UpdatePort, type UpdateProgress } from '../../src/main/services/updater'

interface FakeOptions {
  supported?: boolean
  reason?: string | null
  found?: { version: string | null; releaseNotes?: string | null; releaseDate?: string | null }
  failCheck?: Error
  failDownload?: Error
}

function fakePort(options: FakeOptions = {}) {
  const calls = { check: 0, download: 0, install: 0, progress: [] as UpdateProgress[] }
  const port: UpdatePort = {
    currentVersion: '0.1.0',
    canCheck: () =>
      options.supported === false
        ? { ok: false, reason: options.reason ?? 'development build' }
        : { ok: true, reason: null },
    check: async () => {
      calls.check += 1
      if (options.failCheck) throw options.failCheck
      const found = options.found ?? { version: null }
      return {
        version: found.version,
        releaseNotes: found.releaseNotes ?? null,
        releaseDate: found.releaseDate ?? null,
        releasePageUrl: found.version ? `https://example.invalid/v${found.version}` : null
      }
    },
    download: async (onProgress) => {
      calls.download += 1
      onProgress({ percent: 50, transferred: 50, total: 100, bytesPerSecond: 10 })
      onProgress({ percent: 100, transferred: 100, total: 100, bytesPerSecond: 10 })
      calls.progress.push({ percent: 100, transferred: 100, total: 100, bytesPerSecond: 10 })
      if (options.failDownload) throw options.failDownload
      return { version: options.found?.version ?? null }
    },
    install: () => {
      calls.install += 1
    }
  }
  return { port, calls }
}

describe('update service', () => {
  it('reports a build that cannot check as unsupported, never as up to date', async () => {
    const { port } = fakePort({ supported: false, reason: 'This is a development build.' })
    const service = new UpdateService({ port, checkIntervalMs: 0 })

    const status = await service.check()

    // The important part: not `not-available`. A dev build that says "you are on
    // the latest version" is a permanent false all-clear.
    expect(status.state).toBe('unsupported')
    expect(status.unavailableReason).toBe('This is a development build.')
    expect(status.error).toBeNull()
    expect(status.availableVersion).toBeNull()
  })

  it('reports the found version rather than downloading it', async () => {
    const { port, calls } = fakePort({ found: { version: '9.9.9' } })
    const service = new UpdateService({ port, checkIntervalMs: 0 })

    const status = await service.check()

    expect(status.state).toBe('available')
    expect(status.availableVersion).toBe('9.9.9')
    expect(status.currentVersion).toBe('0.1.0')
    // The whole point of the two-call design: finding an update must not start a
    // download behind the user's back.
    expect(calls.download).toBe(0)
  })

  it('refuses to download when there is nothing to download', async () => {
    const { port, calls } = fakePort({ found: { version: null } })
    const service = new UpdateService({ port, checkIntervalMs: 0 })

    await service.check()
    const status = await service.download()

    expect(calls.download).toBe(0)
    expect(status.error).toMatch(/no update to download/i)
  })

  it('downloads only after the user asks, and reports progress', async () => {
    const { port, calls } = fakePort({ found: { version: '9.9.9' } })
    const seen: UpdateStatusDtoLite[] = []
    const service = new UpdateService({
      port,
      checkIntervalMs: 0,
      notify: (s) => seen.push({ state: s.state, percent: s.progress?.percent ?? null })
    })

    await service.check()
    const status = await service.download()

    expect(calls.download).toBe(1)
    expect(status.state).toBe('downloaded')
    expect(status.availableVersion).toBe('9.9.9')
    expect(seen.some((s) => s.state === 'downloading')).toBe(true)
    expect(seen.some((s) => s.percent === 50)).toBe(true)
  })

  it('surfaces a failed check as an error with the real reason', async () => {
    const { port } = fakePort({ failCheck: new Error('ETIMEDOUT') })
    const service = new UpdateService({ port, checkIntervalMs: 0 })

    const status = await service.check()

    // Explicitly not `not-available`: "could not ask" and "nothing newer" are
    // different facts and must never collapse into one green state.
    expect(status.state).toBe('error')
    expect(status.error).toBe('ETIMEDOUT')
  })

  it('surfaces a failed download without claiming it is ready', async () => {
    const { port } = fakePort({ found: { version: '9.9.9' }, failDownload: new Error('disk full') })
    const service = new UpdateService({ port, checkIntervalMs: 0 })

    await service.check()
    const status = await service.download()

    expect(status.state).toBe('error')
    expect(status.error).toBe('disk full')
    expect(status.progress).toBeNull()
  })

  it('installs only what has actually been downloaded', async () => {
    const { port, calls } = fakePort({ found: { version: '9.9.9' } })
    const service = new UpdateService({ port, checkIntervalMs: 0 })

    const premature = service.install()
    expect(calls.install).toBe(0)
    expect(premature.error).toMatch(/nothing has been downloaded/i)

    await service.check()
    await service.download()
    service.install()

    expect(calls.install).toBe(1)
  })

  it('does not re-check inside the interval, and shares one request', async () => {
    const { port, calls } = fakePort({ found: { version: null } })
    let clock = 1000
    const service = new UpdateService({ port, checkIntervalMs: 60_000, now: () => clock })

    await service.check()
    await service.check()
    expect(calls.check).toBe(1)

    clock += 60_001
    await service.check()
    expect(calls.check).toBe(2)
  })

  it('shares a single in-flight check between concurrent callers', async () => {
    const { port, calls } = fakePort({ found: { version: null } })
    const service = new UpdateService({ port, checkIntervalMs: 0 })

    await Promise.all([service.check(), service.check(), service.check()])

    // Three callers, one request: two extra requests against GitHub buy nothing.
    expect(calls.check).toBe(1)
  })

  it('never reports an update as available without a version', async () => {
    const { port } = fakePort({ found: { version: null } })
    const service = new UpdateService({ port, checkIntervalMs: 0 })

    const status = await service.check()

    expect(status.state).toBe('not-available')
    expect(status.availableVersion).toBeNull()
  })

  it('does not download when the build cannot check at all', async () => {
    const { port, calls } = fakePort({ supported: false })
    const service = new UpdateService({ port, checkIntervalMs: 0 })

    await service.check()
    const status = await service.download()

    expect(calls.download).toBe(0)
    expect(status.state).toBe('unsupported')
  })

  it('reports the release page so a human can read the notes', async () => {
    const { port } = fakePort({ found: { version: '2.0.0', releaseNotes: 'Fixed things' } })
    const service = new UpdateService({ port, checkIntervalMs: 0 })

    const status = await service.check()

    expect(status.releasePageUrl).toContain('2.0.0')
    expect(status.releaseNotes).toBe('Fixed things')
  })
})

interface UpdateStatusDtoLite {
  state: string
  percent: number | null
}