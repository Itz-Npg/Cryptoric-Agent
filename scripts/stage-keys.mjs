/**
 * Stage provider keys into the build output, for personal builds only.
 *
 * What this does: copies the repo-root `.env` (gitignored, never committed)
 * into `out/cryptoric-keys.env`, so `electron-builder` bundles it into the
 * packaged app. At runtime the main process reads that file out of the asar and
 * the key lands in the OS-encrypted credential store like any other.
 *
 * **This is for builds you run yourself.** The key is then readable in the
 * binary by anyone who has a copy — see `readEnvFile` in
 * `src/main/services/models/dotenv.ts`. That is an accepted trade for personal
 * use and an unacceptable one for a distributed build.
 *
 * Why a build step and not a hardcoded constant: the key must never enter the
 * source tree, and this repository is public. A value committed once is public
 * forever, so the only thing that ever leaves the machine is the *artifact*.
 *
 * Why the filename is not `.env`: electron-builder's `out` glob does not match
 * dotfiles, so a `.env` placed in `out/` could be silently dropped from the
 * package.
 *
 * CI never runs this. `.github/workflows/release.yml` calls `electron-builder`
 * directly rather than `npm run dist`, so published builds contain no key.
 *
 * Runs after `electron-vite build`, which recreates `out/` from scratch.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, '.env')
const outDir = join(root, 'out')
const target = join(outDir, 'cryptoric-keys.env')

if (!existsSync(source)) {
  console.warn('[stage-keys] no .env at the repo root — packaging without provider keys.')
  console.warn('[stage-keys] the build will run, and hosted models will ask for a key in Settings.')
  process.exit(0)
}

// `electron-vite build` clears out/; if this is ever reordered the target would
// silently vanish rather than ship. Refuse instead.
if (!existsSync(outDir)) {
  console.error('[stage-keys] out/ does not exist. Run this AFTER the vite build, not before.')
  process.exit(1)
}

const bytes = statSync(source).size
mkdirSync(outDir, { recursive: true })
copyFileSync(source, target)

console.log(`[stage-keys] staged ${bytes} bytes -> out/cryptoric-keys.env`)
console.warn('[stage-keys] this build now contains your key in plaintext. Do not distribute it.')