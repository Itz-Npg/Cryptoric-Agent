/**
 * Verify a downloaded Cryptoric Agent artifact against the project's public key.
 *
 * This is the script a user runs. It is deliberately a standalone answer to one
 * question — "is this file the one the project published?" — with no npm
 * install and no network access required beyond having the files already.
 *
 * Usage:
 *   node scripts/verify-release.mjs <artifact> [<artifact> ...]
 *   node scripts/verify-release.mjs --key-file <path.asc> <artifact>
 *
 * The default key is the public key committed at
 * `docs/signing/cryptoric-agent-signing-key.asc`. Comparing against that file
 * rather than trusting a key already in the user's keyring is deliberate: the
 * point is to check the artifact against a key fetched from the *repository*,
 * not against whatever happens to be installed locally.
 *
 * Exits 0 when every artifact verified, 1 otherwise, so it can gate a script.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  detectGpg,
  importPublicKey,
  verifyDetachedSignature,
  withTempGpgHome,
} from './lib/signing.mjs'

const EXPECTED_FINGERPRINT = '0A0BDF9C7A1C544D22505E4BC91B55788C7458A1'

/** Default public key, relative to this file, so it works from any cwd. */
export const DEFAULT_KEY_PATH = resolve(
  fileURLToPath(new URL('../docs/signing/cryptoric-agent-signing-key.asc', import.meta.url)),
)

/**
 * Verify one artifact.
 *
 * @param {{filePath: string, homeDir: string, passphraseFile?: string|null}} options
 * @returns {Promise<{file: string, ok: boolean, fingerprint: string|null,
 *                    signatureDate: string|null, reason: string|null}>}
 */
export async function verifyArtifact(options) {
  const status = await verifyDetachedSignature({
    homeDir: options.homeDir,
    filePath: options.filePath,
    passphraseFile: options.passphraseFile,
  })
  return {
    file: options.filePath,
    ok: status.ok,
    fingerprint: status.fingerprint,
    signatureDate: status.signatureDate,
    reason: status.reason,
  }
}

/**
 * Verify a list of artifacts against a public key.
 *
 * `expectedFingerprint` is overridable so a test can verify against its own
 * throwaway key. It is a parameter rather than a constant precisely so the
 * production path keeps the strict default.
 *
 * @param {{files: string[], keyPath?: string, expectedFingerprint?: string,
 *          log?: (line: string) => void}} options
 * @returns {Promise<{results: Awaited<ReturnType<typeof verifyArtifact>>[],
 *                    keyFingerprint: string}>}
 */
export async function verifyArtifacts(options) {
  const log = options.log ?? console.log
  const gpg = await detectGpg()
  if (!gpg.available) throw new Error(gpg.reason)

  const keyPath = resolve(options.keyPath ?? DEFAULT_KEY_PATH)
  const armoredKey = await readFile(keyPath, 'utf8')
  const expectedFingerprint = options.expectedFingerprint ?? EXPECTED_FINGERPRINT
  if (options.files.length === 0) {
    throw new Error('Pass at least one artifact path to verify.')
  }

  return withTempGpgHome(async (homeDir, passphraseFile) => {
    const key = await importPublicKey({ homeDir, armoredKey, passphraseFile })
    if (key.fingerprint !== expectedFingerprint) {
      throw new Error(
        `Key at ${keyPath} is ${key.fingerprint}, but the expected release key ` +
          `is ${expectedFingerprint}. Refusing to verify against a key this ` +
          'project did not publish.',
      )
    }
    log(`public key: ${key.fingerprint}`)
    log(`             ${key.userIds.join(', ')}`)
    log('')

    const results = []
    for (const file of options.files) {
      results.push(await verifyArtifact({ filePath: resolve(file), homeDir, passphraseFile }))
    }
    return { results, keyFingerprint: key.fingerprint }
  })
}

async function main() {
  const argv = process.argv.slice(2)
  let keyPath
  const files = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--key-file') {
      keyPath = argv[i + 1]
      i += 1
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(
        'Usage: node scripts/verify-release.mjs [--key-file <path.asc>] <artifact> [...]',
      )
      return
    } else {
      files.push(argv[i])
    }
  }

  const { results } = await verifyArtifacts({ files, keyPath })
  for (const result of results) {
    if (result.ok) {
      console.log(`GOOD  ${result.file}`)
      console.log(`      signed by ${result.fingerprint}`)
      console.log(`      signature made ${formatDate(result.signatureDate)}`)
    } else {
      console.log(`BAD   ${result.file}`)
      console.log(`      ${result.reason}`)
    }
    console.log('')
  }

  const failed = results.filter((result) => !result.ok)
  if (failed.length > 0) {
    console.log(
      `${failed.length} of ${results.length} artifact(s) FAILED verification. ` +
        'Do not run them.',
    )
    process.exitCode = 1
    return
  }
  console.log(`All ${results.length} artifact(s) verified against ${EXPECTED_FINGERPRINT}.`)
}

/**
 * Render a gpg signature timestamp (seconds since the epoch) readably.
 *
 * Falls back to the raw number rather than throwing: an unreadable date is
 * worth noting, but it is not a verification failure and must not turn a good
 * signature into a red result.
 *
 * @param {string|null} signatureDate
 * @returns {string}
 */
export function formatDate(signatureDate) {
  if (!signatureDate) return 'unknown'
  const seconds = Number(signatureDate)
  if (!Number.isFinite(seconds) || seconds <= 0) return signatureDate
  return new Date(seconds * 1000).toISOString()
}

/** @returns {boolean} true when this module is the process entry point. */
function isEntryPoint() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(`\nverify-release failed: ${error.message}`)
    process.exitCode = 1
  })
}