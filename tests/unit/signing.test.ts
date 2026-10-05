/**
 * Tests for the release-signing scripts.
 *
 * Two layers, deliberately:
 *
 *  - Pure tests over the selection and parsing rules. These run everywhere and
 *    are where the "silently skipped an artifact" or "reported a bad signature
 *    as good" class of bug would live.
 *
 *  - A real round trip through gpg, signing an actual file and then tampering
 *    with it. A signing feature tested only against mocks proves nothing about
 *    gpg; the interesting failures (wrong keyring, path spelling the installed
 *    gpg cannot parse, a detached signature that no longer matches) only happen
 *    against the real binary. These skip when gpg is not installed rather than
 *    failing, so the suite stays runnable on a bare machine.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// @ts-expect-error - plain-JS build scripts, deliberately untyped by tsconfig
import * as signing from '../../scripts/lib/signing.mjs'
// @ts-expect-error - see above
import { signReleaseDirectory, parseDirectoryFlag } from '../../scripts/sign-release.mjs'
// @ts-expect-error - see above
import { verifyArtifacts, formatDate } from '../../scripts/verify-release.mjs'

const execFileAsync = promisify(execFile)

async function gpgAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gpg', ['--version'])
    return true
  } catch {
    return false
  }
}

const HAS_GPG = await gpgAvailable()

describe('isSignableArtifact', () => {
  it.each([
    'CryptoricAgent-0.1.4-x64-setup.exe',
    'CryptoricAgent-0.1.4-arm64.dmg',
    'cryptoric-agent_0.1.4_amd64.deb',
    'CryptoricAgent-0.1.4-linux-x86_64.AppImage',
    'CryptoricAgent-0.1.4-linux-x86_64.appimage',
  ])('signs %s', (name) => {
    expect(signing.isSignableArtifact(name)).toBe(true)
  })

  it.each([
    'latest.yml',
    'latest-linux.yml',
    'CryptoricAgent-0.1.4-x64-setup.exe.asc',
    'builder-debug.yml',
    'README.txt',
    'cryptoricagent.exe.blockmap',
  ])('does not sign %s', (name) => {
    expect(signing.isSignableArtifact(name)).toBe(false)
  })
})

describe('selectSignableArtifacts', () => {
  it('keeps only signable files, and never a signature of one', () => {
    const selected = signing.selectSignableArtifacts([
      'latest.yml',
      'app.exe',
      'app.exe.asc',
      'notes.txt',
      'pkg.deb',
    ])
    expect(selected).toEqual(['app.exe', 'pkg.deb'])
  })

  it('is sorted, so a CI log lists signatures in a stable order', () => {
    const selected = signing.selectSignableArtifacts(['z.exe', 'a.exe', 'm.deb'])
    expect(selected).toEqual(['a.exe', 'm.deb', 'z.exe'])
  })

  it('returns a new array rather than mutating the input', () => {
    const input = ['b.exe', 'a.exe']
    const selected = signing.selectSignableArtifacts(input)
    expect(input).toEqual(['b.exe', 'a.exe'])
    expect(selected).not.toBe(input)
  })
})

describe('parseGpgStatus', () => {
  it('accepts a good signature and reads the fingerprint and date', () => {
    const status = signing.parseGpgStatus(
      [
        '[GNUPG:] NEWSIG',
        '[GNUPG:] GOODSIG 0A0BDF9C7A1C544D22505E4BC91B55788C7458A1 Cryptoric',
        '[GNUPG:] VALIDSIG 0A0BDF9C7A1C544D22505E4BC91B55788C7458A1 1791228800 0 4 0',
      ].join('\n'),
    )
    expect(status.ok).toBe(true)
    expect(status.fingerprint).toBe('0A0BDF9C7A1C544D22505E4BC91B55788C7458A1')
    expect(status.signatureDate).toBe('1791228800')
    expect(status.reason).toBeNull()
  })

  it('rejects a bad signature and says the file changed', () => {
    const status = signing.parseGpgStatus(
      [
        '[GNUPG:] NEWSIG',
        '[GNUPG:] BADSIG 0A0BDF9C7A1C544D22505E4BC91B55788C7458A1',
      ].join('\n'),
    )
    expect(status.ok).toBe(false)
    expect(status.reasonCode).toBe('BADSIG')
    expect(status.reason).toMatch(/modified after signing/)
  })

  // A signature by an expired or revoked key is exactly when a user should stop
  // and think. Treating it as a warning is how an abandoned key goes unnoticed.
  it.each(['EXPKEYSIG', 'REVKEYSIG', 'EXPSIG', 'NO_PUBKEY'])(
    'rejects %s',
    (code) => {
      const status = signing.parseGpgStatus(
        `[GNUPG:] NEWSIG\n[GNUPG:] ${code} 0A0BDF9C7A1C544D22505E4BC91B55788C7458A1`,
      )
      expect(status.ok).toBe(false)
      expect(status.reasonCode).toBe(code)
      expect(status.reason).toBeTruthy()
    },
  )

  it('treats a GOODSIG contradicted by an EXPSIG as a failure', () => {
    const status = signing.parseGpgStatus(
      [
        '[GNUPG:] GOODSIG ABC 0A0BDF9C7A1C544D22505E4BC91B55788C7458A1',
        '[GNUPG:] EXPSIG ABC 1791228800',
      ].join('\n'),
    )
    expect(status.ok).toBe(false)
  })

  it('does not call empty output a success', () => {
    const status = signing.parseGpgStatus('')
    expect(status.ok).toBe(false)
    expect(status.reason).toMatch(/no signature status/)
  })

  it('ignores gpg human prose, so another locale cannot change the verdict', () => {
    const status = signing.parseGpgStatus(
      'gpg: Signature made Mon Oct  5 10:00:00 2026 BST\ngpg: BADSIG from "x"\n[GNUPG:] BADSIG 0A0BDF9C7A1C544D22505E4BC91B55788C7458A1',
    )
    expect(status.ok).toBe(false)
    expect(status.reasonCode).toBe('BADSIG')
  })
})

describe('toMsysPath', () => {
  it('rewrites a drive-letter path into the MSYS spelling', () => {
    expect(signing.toMsysPath('C:\\Users\\someone\\Temp\\x')).toBe('/c/Users/someone/Temp/x')
  })

  it('lowercases the drive letter', () => {
    expect(signing.toMsysPath('D:/data/x')).toBe('/d/data/x')
  })

  it('leaves a POSIX path alone', () => {
    expect(signing.toMsysPath('/tmp/cryptoric-sign-abc')).toBe('/tmp/cryptoric-sign-abc')
  })
})

describe('buildGpgArgs', () => {
  it('is always non-interactive, so CI cannot stall on a prompt', () => {
    const args = signing.buildGpgArgs({})
    expect(args).toContain('--batch')
    expect(args).toContain('--yes')
    expect(args).toContain('--no-tty')
  })

  it('passes the passphrase as a file, never as a readable argument', () => {
    const args = signing.buildGpgArgs({ passphraseFile: '/tmp/pw' })
    expect(args).toContain('--passphrase-file')
    expect(args).not.toContain('--passphrase')
    // A passphrase in the argument vector is visible in the process table to
    // every other user on the machine.
    expect(args.join(' ')).not.toMatch(/secretvalue/)
  })

  it('adds no passphrase machinery when there is no passphrase', () => {
    const args = signing.buildGpgArgs({})
    expect(args).not.toContain('--passphrase-file')
  })
})

describe('readSigningMaterialFromEnv', () => {
  it('reports no source when nothing is configured', () => {
    const material = signing.readSigningMaterialFromEnv({})
    expect(material.source).toBe('none')
    expect(material.armoredKey).toBeNull()
  })

  it('reads an inline key', () => {
    const material = signing.readSigningMaterialFromEnv({ CRYPTORIC_GPG_KEY: 'KEYDATA' })
    expect(material.source).toBe('CRYPTORIC_GPG_KEY')
    expect(material.armoredKey).toBe('KEYDATA')
  })

  it('records the file path, leaving armoredKey null for the caller to read', () => {
    const material = signing.readSigningMaterialFromEnv({
      CRYPTORIC_GPG_KEY_FILE: '/tmp/key.asc',
    })
    expect(material.source).toBe('CRYPTORIC_GPG_KEY_FILE')
    expect(material.armoredKey).toBeNull()
    expect(material.keyFile).toBe('/tmp/key.asc')
  })

  // Two sources for one private key is how the wrong key signs a release.
  it('refuses to accept both sources at once', () => {
    expect(() =>
      signing.readSigningMaterialFromEnv({
        CRYPTORIC_GPG_KEY: 'A',
        CRYPTORIC_GPG_KEY_FILE: 'B',
      }),
    ).toThrow(/not both/i)
  })
})

describe('parseDirectoryFlag', () => {
  it('reads --dir', () => {
    expect(parseDirectoryFlag(['--dir', 'release'])).toBe('release')
  })

  it('is undefined when absent', () => {
    expect(parseDirectoryFlag(['--other'])).toBeUndefined()
  })

  it('rejects --dir with no value', () => {
    expect(() => parseDirectoryFlag(['--dir'])).toThrow(/needs a directory/)
  })
})

describe('formatDate', () => {
  it('renders a gpg timestamp as an ISO date', () => {
    expect(formatDate('1791228800')).toBe(new Date(1791228800 * 1000).toISOString())
  })

  it('says unknown rather than printing NaN', () => {
    expect(formatDate(null)).toBe('unknown')
  })

  // A bad date is worth noting but is not a verification failure, so it must
  // never be what turns a good signature red.
  it('echoes an unparseable value instead of throwing', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date')
  })
})

describe.skipIf(!HAS_GPG)('signing round trip against real gpg', () => {
  let workDir: string
  let gpgHome: string
  let privateKeyPath: string
  let publicKeyPath: string
  let fingerprint: string

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'cryptoric-sign-test-'))
    gpgHome = join(workDir, 'home')
    privateKeyPath = join(workDir, 'private.asc')
    publicKeyPath = join(workDir, 'public.asc')

    // RSA rather than ed25519: the Git Bash MSYS build of gpg segfaults during
    // ed25519 key generation, and a test keypair nobody will ever use is still
    // not worth failing a suite over. 2048 keeps generation to about a second.
    //
    // The parameters go in a file rather than on stdin because
    // `child_process.execFile` has no `input` option at all — passing one
    // silently does nothing and gpg waits forever for input that never arrives.
    await mkdir(gpgHome, { recursive: true })
    // Ask the installed gpg which path spelling it accepts. Git Bash ships an
    // MSYS build that treats `C:\...` as relative; a native build does not.
    // Guessing wrong fails with "directory does not exist", which looks like a
    // signing fault and is not one.
    //
    // The probe gets its own directory: it starts a gpg-agent in whatever home
    // it is pointed at, and asking `--gen-key` to reuse that same home while the
    // agent is still coming up segfaults.
    const probeDir = join(workDir, 'probe')
    await mkdir(probeDir, { recursive: true })
    await signing.detectGpgPathStyle(probeDir)

    const paramsPath = join(workDir, 'keyparams')
    await writeFile(
      paramsPath,
      [
        'Key-Type: RSA',
        'Key-Length: 2048',
        'Key-Usage: sign',
        'Name-Real: Cryptoric Signing Test',
        'Name-Email: test@example.invalid',
        'Expire-Date: 0',
        '%no-protection',
        '%commit',
      ].join('\n'),
      'utf8',
    )
    await execFileAsync('gpg', [
      '--batch',
      '--yes',
      '--homedir',
      signing.toGpgPath(gpgHome),
      '--gen-key',
      signing.toGpgPath(paramsPath),
    ])

    const privateExport = await execFileAsync('gpg', [
      '--batch',
      '--yes',
      '--homedir',
      signing.toGpgPath(gpgHome),
      '--armor',
      '--export-secret-keys',
      'test@example.invalid',
    ])
    await writeFile(privateKeyPath, privateExport.stdout, 'utf8')

    const publicExport = await execFileAsync('gpg', [
      '--batch',
      '--yes',
      '--homedir',
      signing.toGpgPath(gpgHome),
      '--armor',
      '--export',
      'test@example.invalid',
    ])
    await writeFile(publicKeyPath, publicExport.stdout, 'utf8')

    const listed = await execFileAsync('gpg', [
      '--batch',
      '--yes',
      '--homedir',
      signing.toGpgPath(gpgHome),
      '--with-colons',
      '--fingerprint',
      'test@example.invalid',
    ])
    fingerprint = listed.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith('fpr:'))
      ?.split(':')[9] as string
  }, 120_000)

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true })
  })

  /** Build a directory of fake artifacts and sign it. */
  async function signFixture(name: string): Promise<string> {
    const dir = join(workDir, name)
    await mkdir(dir, { recursive: true })
    const artifact = join(dir, 'CryptoricAgent-9.9.9-x64-setup.exe')
    await writeFile(artifact, 'pretend installer bytes', 'utf8')
    // Deliberately present and deliberately not signed: the selection rule has
    // to skip it, and a test that never plants one cannot notice if it does not.
    await writeFile(join(dir, 'latest.yml'), 'version: 9.9.9\n', 'utf8')
    await signReleaseDirectory({
      directory: dir,
      env: { CRYPTORIC_GPG_KEY_FILE: privateKeyPath, CRYPTORIC_GPG_PASSPHRASE: '' },
      log: () => {},
    })
    return artifact
  }

  it('signs the installer and leaves the update feed alone', async () => {
    const dir = join(workDir, 'selects')
    const artifact = await signFixture('selects')
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(dir)).sort()).toEqual([
      'CryptoricAgent-9.9.9-x64-setup.exe',
      'CryptoricAgent-9.9.9-x64-setup.exe.asc',
      'latest.yml',
    ])
    expect(artifact).toContain('.exe')
  })

  it('verifies an untouched artifact as GOOD', async () => {
    const artifact = await signFixture('good')
    const { results } = await verifyArtifacts({
      files: [artifact],
      keyPath: publicKeyPath,
      expectedFingerprint: fingerprint,
      log: () => {},
    })
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)
    expect(results[0].fingerprint).toBe(fingerprint)
  })

  it('reports BAD after a single appended byte', async () => {
    const artifact = await signFixture('tampered')
    await appendFile(artifact, 'x', 'utf8')
    const { results } = await verifyArtifacts({
      files: [artifact],
      keyPath: publicKeyPath,
      expectedFingerprint: fingerprint,
      log: () => {},
    })
    expect(results[0].ok).toBe(false)
    expect(results[0].reason).toMatch(/modified after signing/)
  })

  it('reports BAD when the signature is missing entirely', async () => {
    const artifact = await signFixture('unsigned')
    await rm(`${artifact}.asc`)
    const { results } = await verifyArtifacts({
      files: [artifact],
      keyPath: publicKeyPath,
      expectedFingerprint: fingerprint,
      log: () => {},
    })
    expect(results[0].ok).toBe(false)
    expect(results[0].reason).toMatch(/no signature file/)
  })

  // A missing artifact is a verification failure, not a crash: it comes back as a
  // BAD result so a user checking ten downloads gets ten verdicts rather than
  // one thrown error halfway through the list.
  it('reports BAD when the artifact is missing entirely', async () => {
    const { results } = await verifyArtifacts({
      files: [join(workDir, 'never-existed.exe')],
      keyPath: publicKeyPath,
      expectedFingerprint: fingerprint,
      log: () => {},
    })
    expect(results[0].ok).toBe(false)
    expect(results[0].reason).toMatch(/no signature file/)
  })

  it('leaves the signed artifact byte-identical, so updater hashes still match', async () => {
    const artifact = await signFixture('unchanged')
    const before = await readFile(artifact, 'utf8')
    // Re-signing writes only the .asc; if signing ever rewrote the artifact, the
    // sha512 that electron-builder recorded in latest.yml would go stale.
    await signReleaseDirectory({
      directory: join(workDir, 'unchanged'),
      env: { CRYPTORIC_GPG_KEY_FILE: privateKeyPath, CRYPTORIC_GPG_PASSPHRASE: '' },
      log: () => {},
    })
    expect(await readFile(artifact, 'utf8')).toBe(before)
  })

  it('refuses to sign when no key is configured, rather than silently skipping', async () => {
    const dir = join(workDir, 'nokey')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.exe'), 'bytes', 'utf8')
    await expect(
      signReleaseDirectory({ directory: dir, env: {}, log: () => {} }),
    ).rejects.toThrow(/No signing key configured/)
  })

  it('refuses to sign an empty directory instead of reporting success', async () => {
    const dir = join(workDir, 'empty')
    await mkdir(dir, { recursive: true })
    await expect(
      signReleaseDirectory({
        directory: dir,
        env: { CRYPTORIC_GPG_KEY_FILE: privateKeyPath },
        log: () => {},
      }),
    ).rejects.toThrow(/No signable artifacts/)
  })

  it('rejects a fingerprint pin that does not match the imported key', async () => {
    const dir = join(workDir, 'wrongpin')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.exe'), 'bytes', 'utf8')
    await expect(
      signReleaseDirectory({
        directory: dir,
        env: {
          CRYPTORIC_GPG_KEY_FILE: privateKeyPath,
          CRYPTORIC_GPG_FINGERPRINT: 'DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF',
        },
        log: () => {},
      }),
    ).rejects.toThrow(/Refusing to sign with the wrong key/)
  })
})