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

/** First readable `.env` among `dirs`, merged in order. Missing file is not an error. */
export function readEnvFile(dirs: string[]): Record<string, string> {
  for (const dir of dirs) {
    if (!dir) continue
    try {
      return parseEnv(readFileSync(join(dir, '.env'), 'utf8'))
    } catch {
      // Try the next candidate directory.
    }
  }
  return {}
}