/**
 * Sign every release artifact with the project's OpenPGP release key.
 *
 * What this produces, for each installer in `release/`:
 *
 *   CryptoricAgent-0.1.4-x64-setup.exe
 *   CryptoricAgent-0.1.4-x64-setup.exe.asc   <- detached armored signature
 *
 * Why a detached signature rather than an in-place signature: the artifact stays
 * byte-identical, so the sha512 that electron-builder recorded in `latest.yml`
 * / `latest-linux.yml` before this script ran still matches. That matters
 * because `electron-updater` verifies it. `dpkg-sig`, which embeds a
 * `_binary.gpgsig` inside the `.deb`, rewrites the archive and would break the
 * updater feed — see `docs/signing/SIGNING.md` for the full reasoning.
 *
 * This does NOT produce a Windows Authenticode or an Apple signature. Those need
 * a certificate from a CA and are configured separately; a `.asc` beside the
 * `.exe` does not make SmartScreen stop warning. The honest summary is that this
 * gives users a way to verify provenance today, and the CI job in
 * `.github/workflows/release.yml` is where Authenticode attaches once SignPath
 * Foundation approval lands.
 *
 * Required environment:
 *   CRYPTORIC_GPG_KEY        armored private key, or
 *   CRYPTORIC_GPG_KEY_FILE   path to a file holding it
 * Optional:
 *   CRYPTORIC_GPG_PASSPHRASE passphrase for that key (empty if it has none)
 *   CRYPTORIC_GPG_FINGERPRINT  pin signing to one key when the keyring has several
 *   CRYPTORIC_SIGN_DIR       directory to sign (default `release`)
 *
 * Exits non-zero if anything was expected but not signed. A release that
 * silently skips signing because an environment variable was misspelled is the
 * failure mode this is written to prevent.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  detectGpg,
  importSigningKey,
  listReleaseArtifacts,
  readSigningMaterialFromEnv,
  signFile,
  withTempGpgHome,
} from './lib/signing.mjs'

/**
 * Sign every signable artifact in `directory`.
 *
 * Separated from the CLI so tests can drive it without spawning a process.
 *
 * @param {{directory?: string, env?: Record<string,string|undefined>,
 *          log?: (line: string) => void}} [options]
 * @returns {Promise<{signed: Array<{file: string, signatureFile: string}>,
 *                    fingerprint: string, userIds: string[], skipped: boolean}>}
 */
export async function signReleaseDirectory(options = {}) {
  const log = options.log ?? console.log
  const env = options.env ?? process.env
  const directory = resolve(options.directory ?? env.CRYPTORIC_SIGN_DIR ?? 'release')

  const gpg = await detectGpg()
  if (!gpg.available) {
    throw new Error(gpg.reason)
  }
  log(`gpg: ${gpg.version}`)

  const material = readSigningMaterialFromEnv(env)
  if (material.source === 'none') {
    throw new Error(
      'No signing key configured. Set CRYPTORIC_GPG_KEY (armored private key) ' +
        'or CRYPTORIC_GPG_KEY_FILE (path to it). Refusing to publish unsigned ' +
        'artifacts while appearing to sign them.',
    )
  }

  const armoredKey =
    material.armoredKey ?? (await readFile(material.keyFile, 'utf8'))

  const artifacts = await listReleaseArtifacts(directory)
  if (artifacts.length === 0) {
    throw new Error(
      `No signable artifacts in ${directory}. ` +
        'An empty signing run means the packaging step produced nothing, and ' +
        'publishing that as a successful release would be a lie.',
    )
  }
  log(`found ${artifacts.length} artifact(s) in ${directory}`)

  return withTempGpgHome(
    async (homeDir, passphraseFile) => {
      const key = await importSigningKey({ homeDir, armoredKey, passphraseFile })
    const fingerprint = material.fingerprint ?? key.fingerprint
    if (material.fingerprint && material.fingerprint !== key.fingerprint) {
      throw new Error(
        `CRYPTORIC_GPG_FINGERPRINT is ${material.fingerprint} but the imported ` +
          `key is ${key.fingerprint}. Refusing to sign with the wrong key.`,
      )
    }
    log(`signing key: ${key.fingerprint}  ${key.userIds.join(', ')}`)

    const signed = []
      for (const filePath of artifacts) {
        const result = await signFile({
          homeDir,
          filePath,
          fingerprint,
          passphraseFile,
        })
        signed.push({ file: result.file, signatureFile: result.signatureFile })
        log(`  signed ${result.file}`)
      }
      return { signed, fingerprint, userIds: key.userIds, skipped: false }
    },
    { passphrase: material.passphrase },
  )
}

/**
 * Parse `--dir <path>` out of argv.
 *
 * A flag rather than only an env var because signing an ad-hoc directory is the
 * common local case, and forcing an environment variable for it is friction
 * that gets worked around by not signing at all.
 *
 * @param {string[]} argv
 * @returns {string|undefined}
 */
export function parseDirectoryFlag(argv) {
  const index = argv.indexOf('--dir')
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value) throw new Error('--dir needs a directory path.')
  return value
}

async function main() {
  const log = (line) => console.log(line)
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'Usage: node scripts/sign-release.mjs [--dir <release directory>]\n' +
        '  CRYPTORIC_GPG_KEY | CRYPTORIC_GPG_KEY_FILE   armored private key\n' +
        '  CRYPTORIC_GPG_PASSPHRASE                     key passphrase, if any\n' +
        '  CRYPTORIC_GPG_FINGERPRINT                    pin signing to one key',
    )
    return
  }
  const result = await signReleaseDirectory({ directory: parseDirectoryFlag(argv), log })
  log('')
  log(`Signed ${result.signed.length} artifact(s) with ${result.fingerprint}.`)
  log('Publish the .asc files next to the artifacts they sign.')
}

/** @returns {boolean} true when this module is the process entry point. */
function isEntryPoint() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isEntryPoint()) {
  // `process.exitCode`, not `process.exit()`: on Windows a hard exit truncates
  // buffered stdout, which here would swallow the list of what was signed — the
  // one record a release has that it really was signed.
  main().catch((error) => {
    console.error(`\nsign-release failed: ${error.message}`)
    process.exitCode = 1
  })
}