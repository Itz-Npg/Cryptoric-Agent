/**
 * Minimal `.env` reader.
 *
 * Exists for one reason: a hosted model needs a key, the key must not be in
 * source, and Electron does not load `.env` files for the main process. So the
 * main process reads the local file once at boot and moves the value into the
 * OS-encrypted credential store, which is the only place a key is ever read
 * from afterwards.
 *
 * Deliberately not a `.env` library:
 *  - no variable expansion (`$FOO`) — a key must not be able to pull in other
 *    values or accidentally interpolate;
 *  - no `export` handling, no quotes unescaping beyond stripping one matched
 *    pair, no multi-line values;
 *  - parse failures are skipped, never thrown, because a malformed line must
 *    not stop the app from booting.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = LINE.exec(line)
    if (!m) continue
    const key = m[1]
    let value = m[2] ?? ''
    // Strip one matched pair of surrounding quotes; an unbalanced quote stays
    // verbatim rather than eating the rest of the line.
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1)
    }
    // An inline comment is only honoured after a quoted value, where it cannot
    // be part of the value itself.
    if (!raw.includes('"') && !raw.includes("'")) {
      const hash = value.indexOf(' #')
      if (hash !== -1) value = value.slice(0, hash).trimEnd()
    }
    if (key && value) out[key] = value
  }
  return out
}

/**
 * Filenames a key file can have, in priority order.
 *
 * `.env` is the developer's file. `cryptoric-keys.env` is what
 * `scripts/stage-keys.mjs` writes into `out/` so a personal build carries the
 * key — it is not a dotfile because electron-builder's `out` glob does not match
 * dotfiles, so a `.env` placed there could be silently dropped from the package.
 */
const ENV_FILENAMES = ['.env', 'cryptoric-keys.env']

/**
 * First readable key file among `dirs`, merged in order. Missing file is not an
 * error.
 *
 * The app path is searched first, which is what lets a packaged build find the
 * staged file inside the asar — Electron resolves `fs` reads inside an asar
 * transparently, so no extraction step is needed.
 */
export function readEnvFile(dirs: string[]): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of ENV_FILENAMES) {
      try {
        Object.assign(merged, parseEnv(readFileSync(join(dir, name), 'utf8')))
        break
      } catch {
        // Try the next filename, then the next directory.
      }
    }
  }
  return merged
}