/**
 * Release-signing primitives shared by `sign-release.mjs` and
 * `verify-release.mjs`.
 *
 * Scope, stated plainly so nobody over-reads it: this produces **detached
 * OpenPGP signatures** (`.asc`) next to each artifact. That is a provenance
 * answer — "this file is byte-for-byte the one the release pipeline produced" —
 * and it is what GPG is for.
 *
 * It is *not* an Authenticode signature, so it does not satisfy Windows
 * SmartScreen, and it is *not* an Apple signature, so it does not satisfy
 * Gatekeeper. Those need a certificate from a commercial or Foundation CA and
 * are wired separately (see `win.signtoolOptions` in `electron-builder.yml` and
 * `docs/signing/SIGNING.md`). What this module buys is that *right now*, for
 * every platform at once and at no cost, a user can prove a download is ours.
 *
 * Why detached signatures and not `dpkg-sig`: `dpkg-sig` adds a `_binary.gpgsig`
 * member by rewriting the `.deb` archive. `electron-updater`'s `DebUpdater`
 * verifies the `.deb` sha512 recorded in `latest-linux.yml`, which electron-
 * builder writes *before* any post-processing. Rewriting the archive after the
 * fact silently invalidates the updater feed. A detached `.asc` is a separate
 * file and leaves every artifact byte-identical, so the feed stays correct.
 *
 * Everything here is deliberately dependency-free and cross-platform: it shells
 * out to `gpg` and uses only `node:` builtins.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

const execFileAsync = promisify(execFile)

/** Filename used for the passphrase inside a throwaway GnuPG home. */
export const PASSPHRASE_FILENAME = 'cryptoric-passphrase.txt'

/**
 * Artifact types worth signing: things a person downloads and runs.
 *
 * Deliberately excluded are `.blockmap` and the `latest*.yml` update-feed files.
 * They are consumed by the updater, not by a human, and the updater already
 * checks their sha512 against the feed itself.
 */
export const SIGNABLE_EXTENSIONS = Object.freeze([
  '.exe',
  '.msi',
  '.msix',
  '.dmg',
  '.zip',
  '.deb',
  '.rpm',
  '.appimage',
  '.snap',
  '.flatpak',
])

/** Lowercased extension set, so `.AppImage` and `.appimage` both match. */
const SIGNABLE = new Set(SIGNABLE_EXTENSIONS)

/**
 * Is this a filename we sign?
 *
 * @param {string} name bare filename, no directory component
 * @returns {boolean}
 */
export function isSignableArtifact(name) {
  return SIGNABLE.has(extname(name).toLowerCase())
}

/**
 * Pick the signable files out of a directory listing.
 *
 * Pure on purpose: the selection rule is the part most likely to be wrong in a
 * way that silently skips an artifact, so it is testable without a filesystem.
 * Sorting makes signing and verification output deterministic, which matters
 * when a CI log is the only record of what was signed.
 *
 * @param {string[]} names
 * @returns {string[]} a new, sorted array
 */
export function selectSignableArtifacts(names) {
  return names
    .filter((name) => isSignableArtifact(name))
    .filter((name) => !name.endsWith('.asc'))
    .sort((a, b) => a.localeCompare(b))
}

/**
 * The GPG status codes that mean "this signature is not acceptable", mapped to a
 * sentence a human can act on.
 *
 * `EXPKEYSIG` and `REVKEYSIG` are listed as failures on purpose. A signature
 * made by an expired or revoked key is exactly the case where a user needs to
 * stop and think, and letting it pass as a warning is how a compromised or
 * abandoned key goes unnoticed.
 */
export const FAILURE_REASONS = Object.freeze({
  BADSIG: 'the signature does not match the file (the file was modified after signing)',
  ERRSIG: 'the signature could not be checked',
  EXPKEYSIG: 'the signing key has expired',
  REVKEYSIG: 'the signing key has been revoked',
  EXPSIG: 'the signature itself has expired',
  NO_PUBKEY: 'the signing key is not known to this keyring',
})

/**
 * Parse GPG's machine-readable `--status-fd` stream.
 *
 * Why the status stream and not gpg's human output: the human output is
 * localised and its wording changes between GnuPG releases, while
 * `[GNUPG:] <KEYWORD> <args>` is a documented, stable machine interface. Parsing
 * prose would make a verification script that breaks on a user's German locale
 * or on GnuPG 2.4.
 *
 * @param {string} stdout combined stdout/stderr from a gpg `--status-fd 1` call
 * @returns {{ok: boolean, fingerprint: string|null, signatureDate: string|null,
 *            reason: string|null, reasonCode: string|null, trust: string|null}}
 */
export function parseGpgStatus(stdout) {
  const result = {
    ok: false,
    fingerprint: null,
    signatureDate: null,
    reason: null,
    reasonCode: null,
    trust: null,
  }
  let sawGood = false
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('[GNUPG:] ')) continue
    const fields = line.slice('[GNUPG]: '.length).split(/\s+/)
    const keyword = fields[0]
    if (keyword === 'GOODSIG') {
      sawGood = true
      result.fingerprint = fields[1] ?? null
    } else if (keyword === 'VALIDSIG') {
      // VALIDSIG carries the primary-key fingerprint and the signature date,
      // and it is the authoritative source for both. GOODSIG only has the
      // signing subkey's long id.
      //
      // Field order is: VALIDSIG <fpr> <sig_creation_date> <sig-timestamp>
      // <expire-timestamp> <sig-version> ... The signature date is field 2.
      result.fingerprint = fields[1] ?? result.fingerprint
      result.signatureDate = fields[2] ?? null
    } else if (keyword === 'TRUST_UNDEFINED' || keyword === 'TRUST_NEVER') {
      result.trust = keyword
    } else if (Object.prototype.hasOwnProperty.call(FAILURE_REASONS, keyword)) {
      result.reasonCode = keyword
      result.reason = FAILURE_REASONS[keyword]
    }
  }
  // A good signature only counts if nothing else contradicted it.
  result.ok = sawGood && result.reasonCode === null
  if (!result.ok && result.reasonCode === null && !sawGood) {
    result.reason = 'gpg produced no signature status at all'
  }
  return result
}

/**
 * Windows exposes at least two incompatible `gpg` builds. Git Bash ships an MSYS
 * build that treats `C:\Users\...` as a *relative* path and resolves it against
 * the current directory, so it wants `/c/Users/...`. A native GnuPG for Windows
 * build wants `C:\Users\...`. Guessing wrong fails every call with
 * "directory does not exist", which reads like a signing problem and is not one.
 *
 * @param {string} absolutePath
 * @returns {string} the MSYS/POSIX spelling of a Windows path
 */
export function toMsysPath(absolutePath) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolutePath)
  if (!match) return absolutePath
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`
}

/** Cached answer from {@link detectGpgPathStyle}; `null` means "not probed yet". */
let cachedPathStyle = null

/**
 * Work out which path spelling this machine's `gpg` accepts, once, by trying it.
 *
 * Both candidates name a directory that really exists — Node created it, using
 * Windows paths it understands — so the only thing being tested is whether gpg
 * can *parse* the string. Whichever form lets `--list-secret-keys` succeed is
 * the form used for every later argument.
 *
 * @param {string} [existingDir] a directory that exists, used as the probe subject
 * @returns {Promise<'msys'|'native'>}
 */
export async function detectGpgPathStyle(existingDir) {
  if (cachedPathStyle) return cachedPathStyle
  if (process.platform !== 'win32') {
    cachedPathStyle = 'native'
    return cachedPathStyle
  }
  const probeDir = existingDir ?? (await mkdtemp(join(tmpdir(), 'cryptoric-gpgprobe-')))
  for (const style of ['native', 'msys']) {
    const candidate = style === 'native' ? probeDir : toMsysPath(probeDir)
    try {
      await execFileAsync('gpg', ['--batch', '--yes', '--no-tty', '--homedir', candidate, '--list-secret-keys'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      cachedPathStyle = style
      return cachedPathStyle
    } catch {
      // Wrong spelling for this build; try the next one.
    }
  }
  throw new Error(
    'gpg is installed but rejected both Windows and MSYS path forms for its ' +
      '--homedir directory. Cannot continue without knowing how it wants paths.',
  )
}

/**
 * Render an absolute path the way the local `gpg` expects it.
 *
 * @param {string} absolutePath
 * @returns {string}
 */
export function toGpgPath(absolutePath, style = cachedPathStyle) {
  if (process.platform !== 'win32') return absolutePath
  return style === 'msys' ? toMsysPath(absolutePath) : absolutePath
}

/** Reset the memoised probe. Exposed for tests. */
export function resetGpgPathStyleCache() {
  cachedPathStyle = null
}

/**
 * Build the argument vector for `gpg`.
 *
 * `--batch --yes --no-tty` keeps it non-interactive: a signing step in CI that
 * stops to ask a human is a signing step that hangs a release.
 *
 * The passphrase goes through `--passphrase-file`, never `--passphrase-fd 0`.
 * `child_process.execFile` cannot write to the child's stdin, so an fd-based
 * passphrase silently leaves gpg blocked forever waiting for input nobody will
 * send — which is exactly how this first worked. A file inside the throwaway
 * GnuPG home is also deleted with the home.
 *
 * @param {{homeDir?: string, passphraseFile?: string, statusFd?: boolean}} options
 * @returns {string[]}
 */
export function buildGpgArgs(options = {}) {
  const args = ['--batch', '--yes', '--no-tty']
  if (options.homeDir) args.push('--homedir', toGpgPath(options.homeDir))
  if (options.statusFd) args.push('--status-fd', '1')
  if (options.passphraseFile) {
    args.push(
      '--pinentry-mode',
      'loopback',
      '--passphrase-file',
      toGpgPath(options.passphraseFile),
    )
  }
  return args
}

/**
 * Run gpg.
 *
 * @param {string[]} args
 * @param {{homeDir?: string, passphraseFile?: string, statusFd?: boolean,
 *          env?: Record<string,string>, maxBuffer?: number}} [options]
 * @returns {Promise<{stdout: string, stderr: string}>}
 * @throws the underlying error, with `.stdout`/`.stderr` attached, on non-zero exit
 */
export async function runGpg(args, options = {}) {
  const gpgArgs = [...buildGpgArgs(options), ...args]
  const env = { ...process.env, ...(options.env ?? {}) }
  if (options.homeDir) env.GNUPGHOME = options.homeDir
  try {
    const { stdout, stderr } = await execFileAsync('gpg', gpgArgs, {
      encoding: 'utf8',
      // A release feeds the wrapper a ~180 MB .dmg or .deb; the default 1 MB
      // Node cap would abort on a legitimate signature with ENOBUFS, which
      // reads like a signing failure rather than a limit.
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      env,
    })
    return { stdout, stderr }
  } catch (error) {
    error.stdout = error.stdout ?? ''
    error.stderr = error.stderr ?? error.message
    throw error
  }
}

/**
 * Is gpg usable at all?
 *
 * @returns {Promise<{available: boolean, version: string|null, reason?: string}>}
 */
export async function detectGpg() {
  try {
    const { stdout, stderr } = await execFileAsync('gpg', ['--version'], {
      encoding: 'utf8',
    })
    const version = `${stdout}${stderr}`.split(/\r?\n/).find((line) => /^gpg \(/.test(line))
    return { available: true, version: version ? version.trim() : 'unknown' }
  } catch (error) {
    return {
      available: false,
      version: null,
      reason: 'gpg is not on PATH. Install GnuPG 2.2 or newer and try again.',
    }
  }
}

/**
 * Create a private, throwaway GnuPG home.
 *
 * Why not the user's real `~/.gnupg`: signing must not be able to touch, list
 * or trust the user's personal keys, and CI has no user home at all. A
 * throwaway directory keeps the blast radius at exactly one directory that the
 * caller deletes afterwards.
 *
 * @param {{prefix?: string}} [options]
 * @returns {Promise<string>} the directory path — the caller owns removal
 */
export async function createTempGpgHome(options = {}) {
  const base = options.prefix ?? tmpdir()
  await mkdir(base, { recursive: true })
  const homeDir = await mkdtemp(join(base, 'cryptoric-sign-'))
  // GnuPG refuses to use a home directory that other users can read. Windows
  // has no equivalent bits to set, and gpg does not enforce it there, so this
  // is a no-op on win32 rather than an error.
  if (process.platform !== 'win32') await chmod(homeDir, 0o700)
  return homeDir
}

/**
 * Run a callback with a temporary GnuPG home, then delete it.
 *
 * The `finally` is the whole point: a signing failure must not leave a private
 * key on disk in a temp directory.
 *
 * @template T
 * @param {(homeDir: string) => Promise<T>} callback
 * @param {{prefix?: string}} [options]
 * @returns {Promise<T>}
 */
export async function withTempGpgHome(callback, options = {}) {
  const homeDir = await createTempGpgHome(options)
  try {
    // Probe using the real home directory so the answer is about the gpg that is
    // actually installed here, not about some throwaway guess.
    await detectGpgPathStyle(homeDir)
    return await callback(homeDir, await writePassphraseFile(homeDir, options.passphrase))
  } finally {
    await rm(homeDir, { recursive: true, force: true })
  }
}

/**
 * Write the passphrase into a throwaway GnuPG home and return its path.
 *
 * Lives inside the home directory on purpose: `withTempGpgHome` deletes the
 * whole directory afterwards, so the secret does not outlive the signing run the
 * way a fixed path like `~/.cryptoric-passphrase` would.
 *
 * @param {string} homeDir
 * @param {string|undefined} passphrase
 * @returns {Promise<string|null>} null when there is no passphrase to write
 */
export async function writePassphraseFile(homeDir, passphrase) {
  if (!passphrase) return null
  const path = join(homeDir, PASSPHRASE_FILENAME)
  await writeFile(path, passphrase, { encoding: 'utf8', mode: 0o600 })
  return path
}

/**
 * Import an ASCII-armoured key into a keyring and report its fingerprint.
 *
 * @param {{homeDir: string, armoredKey: string, passphraseFile?: string|null}} options
 * @returns {Promise<{fingerprint: string, keyId: string, userIds: string[]}>}
 * @throws if the key does not parse or no secret key was imported
 */
export async function importSigningKey(options) {
  await importKeyMaterial(options)
  return describeKeys(options.homeDir, { secret: true })
}

/**
 * Import an ASCII-armoured **public** key and report its fingerprint.
 *
 * Separate from {@link importSigningKey} because asking for the secret half of
 * a key that was never imported finds nothing, and the resulting "no secret key"
 * error reads as a corrupt download rather than as the expected situation of a
 * verifier that only ever holds a public key.
 *
 * @param {{homeDir: string, armoredKey: string, passphraseFile?: string|null}} options
 * @returns {Promise<{fingerprint: string, keyId: string, userIds: string[]}>}
 */
export async function importPublicKey(options) {
  await importKeyMaterial(options)
  return describeKeys(options.homeDir, { secret: false })
}

/**
 * Write key bytes into a keyring's home and import them.
 *
 * A file rather than stdin because `child_process.execFile` cannot write to the
 * child's stdin at all; see {@link buildGpgArgs}.
 *
 * @param {{homeDir: string, armoredKey: string, passphraseFile?: string|null}} options
 * @returns {Promise<void>}
 */
async function importKeyMaterial(options) {
  const keyPath = join(options.homeDir, 'import.asc')
  await writeFile(keyPath, options.armoredKey, 'utf8')
  await runGpg(['--import', toGpgPath(keyPath)], {
    homeDir: options.homeDir,
    passphraseFile: options.passphraseFile,
  })
}

/**
 * List the keys in a keyring.
 *
 * Parses the `--with-colons` machine format rather than the default listing,
 * for the same reason `parseGpgStatus` does: field positions are fixed, human
 * output is not.
 *
 * `secret` selects `--list-secret-keys` over `--list-keys`. Verifying a download
 * only ever has the *public* key, so asking for secret keys there finds nothing
 * and would report a perfectly good key as missing.
 *
 * @param {string} homeDir
 * @param {{secret?: boolean}} [options]
 * @returns {Promise<{fingerprint: string, keyId: string, userIds: string[]}>}
 */
export async function describeKeys(homeDir, options = {}) {
  const secret = options.secret ?? true
  const { stdout } = await runGpg(['--with-colons', secret ? '--list-secret-keys' : '--list-keys'], {
    homeDir,
    statusFd: false,
  })
  const userIds = []
  let keyId = null
  let fingerprint = null
  let inKeyBlock = false
  for (const rawLine of stdout.split(/\r?\n/)) {
    const fields = rawLine.split(':')
    // `sec` and `pub` open a key block. Accepting only `sec` made
    // `--list-keys` parse as an empty keyring, which is how verifying a
    // perfectly good public key reported "no public key found".
    if (fields[0] === 'sec' || fields[0] === 'pub') {
      inKeyBlock = true
      keyId = fields[4] ?? keyId
    } else if (fields[0] === 'fpr' && inKeyBlock && !fingerprint) {
      fingerprint = fields[9] ?? null
    } else if (fields[0] === 'uid' && inKeyBlock && fields[9]) {
      userIds.push(fields[9])
    }
  }
  if (!fingerprint) {
    throw new Error(
      secret
        ? 'No secret key was found after importing CRYPTORIC_GPG_KEY. ' +
          'The value must be a private key, not a public key.'
        : 'No public key was found after importing the key file.',
    )
  }
  return { fingerprint, keyId, userIds }
}

/**
 * Sign one file, producing an ASCII-armoured detached signature beside it.
 *
 * @param {{homeDir: string, filePath: string, fingerprint?: string,
 *          passphraseFile?: string|null}} options
 * @returns {Promise<{file: string, signatureFile: string, fingerprint: string}>}
 */
export async function signFile(options) {
  const signatureFile = `${options.filePath}.asc`
  const args = []
  if (options.fingerprint) args.push('--local-user', options.fingerprint)
  args.push(
    '--armor',
    '--detach-sign',
    '--output',
    toGpgPath(signatureFile),
    toGpgPath(options.filePath),
  )
  await runGpg(args, {
    homeDir: options.homeDir,
    passphraseFile: options.passphraseFile,
  })
  return { file: options.filePath, signatureFile, fingerprint: options.fingerprint ?? '' }
}

/**
 * Verify a detached signature against a file.
 *
 * @param {{homeDir: string, filePath: string, signatureFile?: string,
 *          passphraseFile?: string|null}} options
 * @returns {Promise<ReturnType<typeof parseGpgStatus>>}
 */
export async function verifyDetachedSignature(options) {
  const signatureFile = options.signatureFile ?? `${options.filePath}.asc`
  if (!existsSync(signatureFile)) {
    return {
      ok: false,
      fingerprint: null,
      signatureDate: null,
      reason: `no signature file at ${signatureFile}`,
      reasonCode: 'NOSIG',
      trust: null,
    }
  }
  // gpg resolves a relative signature path against its own cwd, so both paths
  // have to be spelled for this platform before they are handed over.
  try {
    const { stdout, stderr } = await runGpg(
      ['--verify', toGpgPath(signatureFile), toGpgPath(options.filePath)],
      { homeDir: options.homeDir, passphraseFile: options.passphraseFile, statusFd: true },
    )
    return parseGpgStatus(`${stdout}\n${stderr}`)
  } catch (error) {
    // A bad signature is an expected outcome of verification, not a crash of the
    // verification script, so it comes back as a parsed result.
    return parseGpgStatus(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)
  }
}

/**
 * Read the signing material a release run expects from the environment.
 *
 * Failing here with a precise message matters: a release that silently skips
 * signing because an environment variable was misspelled publishes unsigned
 * artifacts that look signed in the job log.
 *
 * `armoredKey` is null in the file case on purpose: the caller reads that file
 * itself. The signal that a key is configured at all is `source`, not
 * `armoredKey` — checking the wrong one makes the file path unreachable.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{armoredKey: string|null, keyFile: string|null, passphrase: string,
 *            fingerprint: string|null, source: 'none'|'CRYPTORIC_GPG_KEY'|'CRYPTORIC_GPG_KEY_FILE'}}
 */
export function readSigningMaterialFromEnv(env = process.env) {
  const inline = env.CRYPTORIC_GPG_KEY
  const file = env.CRYPTORIC_GPG_KEY_FILE
  if (inline && file) {
    throw new Error(
      'Set either CRYPTORIC_GPG_KEY or CRYPTORIC_GPG_KEY_FILE, not both. ' +
        'Two sources for one private key is how the wrong key signs a release.',
    )
  }
  if (!inline && !file) {
    return {
      armoredKey: null,
      keyFile: null,
      passphrase: env.CRYPTORIC_GPG_PASSPHRASE ?? '',
      fingerprint: env.CRYPTORIC_GPG_FINGERPRINT ?? null,
      source: 'none',
    }
  }
  return {
    armoredKey: inline ?? null,
    keyFile: inline ? null : file,
    passphrase: env.CRYPTORIC_GPG_PASSPHRASE ?? '',
    fingerprint: env.CRYPTORIC_GPG_FINGERPRINT ?? null,
    source: inline ? 'CRYPTORIC_GPG_KEY' : 'CRYPTORIC_GPG_KEY_FILE',
  }
}

/**
 * List the signable artifacts in a release directory.
 *
 * @param {string} directory
 * @returns {Promise<string[]>} absolute paths, sorted
 */
export async function listReleaseArtifacts(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return selectSignableArtifacts(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  ).map((name) => join(directory, name))
}