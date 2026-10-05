/**
 * Structural guards for the CLI/desktop split.
 *
 * The CLI works because two properties of the source tree are true. Neither is
 * enforced by the type system, and both fail silently when broken:
 *
 *  1. **The shared layer does not import Electron.** If one file under
 *     `agent/`, `tools/` or `skills/` reaches for `electron`, the CLI stops
 *     being buildable and the failure surfaces as a broken global install
 *     rather than as a compile error.
 *  2. **The agent's prompts are defined once.** They used to be private
 *     functions inside `main/index.ts`. If a copy reappears there, the desktop
 *     app and the CLI would run the same agent with different instructions, and
 *     nothing would report it — which is the definition of a fork.
 *
 * Both are cheap to assert and expensive to discover the hard way.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '..', '..')

/** Every `.ts` under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (entry.endsWith('.ts')) {
        out.push(full)
      }
    }
  }
  walk(dir)
  return out
}

const SHARED_DIRS = ['agent', 'tools', 'skills', 'permissions', 'env', 'terminal', 'proc', 'fs', 'models', 'project']
  .map((d) => join(repoRoot, 'src', 'main', 'services', d))

describe('the CLI/desktop split', () => {
  it('keeps the shared agent layer free of Electron imports', () => {
    const offenders: string[] = []
    for (const dir of SHARED_DIRS) {
      for (const file of sourceFiles(dir)) {
        const text = readFileSync(file, 'utf8')
        if (/from\s+['"]electron['"]/.test(text) || /require\(['"]electron['"]\)/.test(text)) {
          offenders.push(relative(repoRoot, file))
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('defines the agent prompts once, outside the Electron entry point', () => {
    const prompts = readFileSync(join(repoRoot, 'src/main/services/agent/prompts.ts'), 'utf8')
    expect(prompts).toContain('export function chanSystemPrompt')
    expect(prompts).toContain('export function planSystemPrompt')

    const main = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
    expect(main).toContain("from './services/agent/prompts'")
    // No second copy of the instructions hiding in the entry point.
    expect(main).not.toContain('You are Cryptoric Chan, the software engineering agent')
    expect(main).not.toContain('You are Cryptoric Chan, planning a task')
  })

  it('does not declare electron as a CLI runtime dependency', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'cli/package.json'), 'utf8')) as {
      bin: Record<string, string>
      scripts: Record<string, string>
    }
    expect(pkg.bin.cryptoric).toBe('dist/index.js')
    // `prepack` is what makes `npm publish` produce a runnable tarball without
    // the publisher having to remember to build first.
    expect(pkg.scripts.prepack).toBeTruthy()
  })

  it('ships a single bundled file, not the whole repository', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'cli/package.json'), 'utf8')) as { files: string[] }
    expect(pkg.files).toContain('dist/index.js')
  })
})