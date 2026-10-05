/**
 * Bundle the CLI into a single file.
 *
 * Uses the esbuild that is already in the repository (it arrives with Vite), so
 * building the CLI adds no dependency and costs no extra install on a machine
 * that is already tight on disk.
 *
 * Everything is bundled, including zod. A published CLI that has to resolve its
 * dependencies at install time is a CLI that can fail to start; a single file
 * cannot.
 */

import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const outfile = resolve(here, 'dist/index.js')

const result = await build({
  entryPoints: [resolve(here, 'src/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  // ESM because the repository root is `"type": "module"` and Node 20 handles
  // it natively; CJS would need a rename on every publish.
  format: 'esm',
  target: 'node20',
  // No externals beyond Node builtins, so `npm i -g` pulls nothing at runtime.
  external: ['electron'],
  alias: {
    '@shared': resolve(repoRoot, 'src/shared')
  },
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
  metafile: true
})

const bytes = statSync(outfile).size

/**
 * Refuse to publish a CLI that imports Electron.
 *
 * The agent layer is Electron-free today, and that is a property worth
 * enforcing rather than hoping for: the moment an `import 'electron'` reaches
 * this entry point, `require('electron')` resolves to the *path string* of a
 * binary that is not installed, and the CLI fails at startup with something
 * that looks like a corrupt install.
 */
const importedElectron = Object.keys(result.metafile.inputs).some((file) =>
  /(^|[\\/])electron([\\/]|$)/.test(file)
)
if (importedElectron) {
  console.error('build failed: an Electron module reached the CLI entry point.')
  console.error('The CLI shares the agent layer with the desktop app, and that layer must stay host-agnostic.')
  process.exitCode = 1
} else {
  const kb = (bytes / 1024).toFixed(0)
  console.log(`built cli/dist/index.js (${kb} KB, ${Object.keys(result.metafile.inputs).length} modules)`)
}