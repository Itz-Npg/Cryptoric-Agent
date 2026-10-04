/**
 * Bundle a live check for execution inside Electron.
 *
 * `electron-vite build` produces the application, not a library, so the live
 * checks are bundled here instead with esbuild — the same tool Vite uses, with
 * one addition: a plugin that understands Vite's `?raw` imports so the
 * injected page bridge bundles as the string it is.
 *
 * Usage: node scripts/build-live-check.mjs <entry.ts> <outfile.mjs>
 */

import { build } from 'esbuild'
import { resolve } from 'node:path'

const [, , entry, outfile] = process.argv
if (!entry || !outfile) {
  console.error('usage: node scripts/build-live-check.mjs <entry.ts> <outfile.mjs>')
  process.exit(2)
}

/** Resolve `*.js?raw` to a text module, the way Vite does. */
const rawImports = {
  name: 'raw-imports',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text'
    }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => {
      const { readFile } = await import('node:fs/promises')
      const contents = await readFile(args.path, 'utf8')
      return { contents: `export default ${JSON.stringify(contents)}`, loader: 'js' }
    })
  }
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Electron resolves these at runtime; bundling them would break the bridge
  // between the main process and the page.
  external: ['electron'],
  alias: { '@shared': resolve('src/shared') },
  plugins: [rawImports],
  logLevel: 'warning',
  sourcemap: 'inline'
})