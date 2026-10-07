/**
 * The `.cryptoricagent/` project workspace.
 *
 * Opening a folder has to leave behind something that identifies that folder
 * forever, and the two failure modes worth guarding are the quiet ones:
 *
 *  - a **fresh id on every call**, which would silently split one project's
 *    history into a new file each time the folder is opened;
 *  - a folder that **shows up as untracked noise** in the repository the user
 *    opened, because they did not ask for a commit and would not have reviewed
 *    one.
 *
 * Plus the setting that decides whether history is written to the app folder,
 * the project folder, or both — and the mirror that has to keep two files in
 * agreement without ever duplicating a turn.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CONVERSATION_FILE,
  PROJECT_DIR_NAME,
  PROJECT_MANIFEST,
  ensureProjectWorkspace,
  readProjectId,
  resolveHistoryPaths
} from '../../src/main/services/project/workspace'
import { MirroredConversation } from '../../src/main/services/agent/mirrored-conversation'

let root: string
let appDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cryptoric-ws-'))
  appDir = mkdtempSync(join(tmpdir(), 'cryptoric-app-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(appDir, { recursive: true, force: true })
})

describe('ensureProjectWorkspace', () => {
  it('creates the folder on first open', () => {
    const result = ensureProjectWorkspace(root, 'demo')
    expect(existsSync(join(root, PROJECT_DIR_NAME))).toBe(true)
    expect(result.created).toBe(true)
    expect(result.error).toBeNull()
    expect(result.manifest.name).toBe('demo')
    expect(result.manifest.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('keeps the same id across repeated opens', () => {
    const first = ensureProjectWorkspace(root, 'demo')
    const second = ensureProjectWorkspace(root, 'demo')
    const third = ensureProjectWorkspace(root, 'demo')

    expect(second.manifest.id).toBe(first.manifest.id)
    expect(third.manifest.id).toBe(first.manifest.id)
    expect(second.created).toBe(false)
  })

  it('gives two different folders two different ids', () => {
    const other = mkdtempSync(join(tmpdir(), 'cryptoric-other-'))
    try {
      expect(ensureProjectWorkspace(root, 'a').manifest.id).not.toBe(
        ensureProjectWorkspace(other, 'b').manifest.id
      )
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('ignores itself so it never appears in the user repository', () => {
    ensureProjectWorkspace(root, 'demo')
    const ignore = readFileSync(join(root, PROJECT_DIR_NAME, '.gitignore'), 'utf8')
    // `*` is what makes git skip the whole folder, including its own manifest.
    expect(ignore).toContain('*')
  })

  it('does not modify the repository root gitignore', () => {
    const rootIgnore = join(root, '.gitignore')
    writeFileSync(rootIgnore, 'node_modules/\n', 'utf8')
    ensureProjectWorkspace(root, 'demo')
    // The user's ignore rules are theirs; editing them unasked is not acceptable.
    expect(readFileSync(rootIgnore, 'utf8')).toBe('node_modules/\n')
  })

  it('mints one new id when the manifest is corrupt, not one per call', () => {
    const dir = join(root, PROJECT_DIR_NAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, PROJECT_MANIFEST), '{ this is not json', 'utf8')

    const first = ensureProjectWorkspace(root, 'demo')
    const second = ensureProjectWorkspace(root, 'demo')
    expect(first.manifest.id).not.toBe('')
    // The repair is written once, so the next call reads it.
    expect(second.manifest.id).toBe(first.manifest.id)
  })

  it('refuses a half-written manifest rather than adopting undefined', () => {
    const dir = join(root, PROJECT_DIR_NAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, PROJECT_MANIFEST), JSON.stringify({ name: 'no id here' }), 'utf8')

    const result = ensureProjectWorkspace(root, 'demo')
    // An entry with no id is not a project; a new one is minted instead.
    expect(result.manifest.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reports an error instead of throwing when the folder cannot be made', () => {
    // A file where the folder should be: mkdir will fail.
    writeFileSync(join(root, PROJECT_DIR_NAME), 'not a directory', 'utf8')
    const result = ensureProjectWorkspace(root, 'demo')
    expect(result.error).not.toBeNull()
  })

  it('reads an existing id back without creating anything', () => {
    const created = ensureProjectWorkspace(root, 'demo')
    expect(readProjectId(root)).toBe(created.manifest.id)
  })

  it('returns null for a folder that was never opened', () => {
    expect(readProjectId(join(root, 'never-opened'))).toBeNull()
  })
})

describe('resolveHistoryPaths', () => {
  const targets = () => ({
    appDir,
    projectDir: join(root, PROJECT_DIR_NAME),
    location: 'both' as const
  })

  it('writes both copies when set to both', () => {
    const resolved = resolveHistoryPaths(targets(), 'pid-1')
    expect(resolved.writes).toHaveLength(2)
    expect(resolved.writes).toContain(join(root, PROJECT_DIR_NAME, CONVERSATION_FILE))
    // Keyed by project id, so two checkouts of one repo never collide.
    expect(resolved.writes.some((p) => p.includes('pid-1'))).toBe(true)
  })

  it('writes only the project folder when set to project', () => {
    const resolved = resolveHistoryPaths({ ...targets(), location: 'project' }, 'pid-1')
    expect(resolved.writes).toEqual([join(root, PROJECT_DIR_NAME, CONVERSATION_FILE)])
  })

  it('never resolves a relative path when no project is open', () => {
    // `join('', 'conversation.json')` is `conversation.json`, which resolves
    // against the process's working directory. The app passes `projectDir: ''`
    // until a project is opened, so that path dropped a stray transcript in
    // whatever directory the app was launched from — and read it back as the
    // user's conversation on the next boot.
    for (const location of ['both', 'project', 'app'] as const) {
      const resolved = resolveHistoryPaths({ appDir, projectDir: '', location }, 'no-project')
      for (const path of [...resolved.reads, ...resolved.writes]) {
        expect(isAbsolute(path), `${location}: ${path} is not absolute`).toBe(true)
        expect(path).not.toBe(CONVERSATION_FILE)
      }
      // With nowhere project-local to write, the app copy is the only honest
      // destination: the alternative is losing the session.
      expect(resolved.writes).toEqual([join(appDir, 'conversations', 'no-project.json')])
    }
  })

  it('writes only the app folder when set to app', () => {
    const resolved = resolveHistoryPaths({ ...targets(), location: 'app' }, 'pid-1')
    expect(resolved.writes).toHaveLength(1)
    expect(resolved.writes[0]).toContain(appDir)
    expect(resolved.writes[0]).not.toContain(PROJECT_DIR_NAME)
  })

  it('prefers the project copy on read, with the app copy as fallback', () => {
    const resolved = resolveHistoryPaths(targets(), 'pid-1')
    expect(resolved.reads[0]).toBe(join(root, PROJECT_DIR_NAME, CONVERSATION_FILE))
    expect(resolved.reads[1]).toContain(appDir)
  })
})

describe('MirroredConversation', () => {
  it('writes the same turn to every target', async () => {
    const projectFile = join(root, PROJECT_DIR_NAME, CONVERSATION_FILE)
    mkdirSync(join(root, PROJECT_DIR_NAME), { recursive: true })
    const appFile = join(appDir, 'conversations', 'pid-1.json')
    mkdirSync(join(appDir, 'conversations'), { recursive: true })

    const conversation = new MirroredConversation([projectFile, appFile])
    conversation.setProject(root)
    conversation.appendUser('first')
    // Writes are queued, so nothing is on disk until this resolves.
    await conversation.flush()

    const turns = (p: string): string[] =>
      Object.values(JSON.parse(readFileSync(p, 'utf8')).scopes as Record<string, { turns: { text: string }[] }>)
        .flatMap((s) => s.turns)
        .map((t) => t.text)

    expect(turns(projectFile)).toEqual(['first'])
    expect(turns(appFile)).toEqual(['first'])
  })

  it('never duplicates a turn that lives in both copies', () => {
    const a = join(appDir, 'a.json')
    const b = join(appDir, 'b.json')
    const conversation = new MirroredConversation([a, b])
    conversation.setProject(root)
    conversation.appendUser('only once')
    conversation.appendAssistant('and only once more')

    // Mirroring must not read both files and concatenate them.
    expect(conversation.all().map((t) => t.text)).toEqual(['only once', 'and only once more'])
  })

  it('reads from whichever copy actually has history', async () => {
    const empty = join(appDir, 'empty.json')
    const filled = join(appDir, 'filled.json')

    const seed = new MirroredConversation([filled])
    seed.setProject(root)
    seed.appendUser('from the surviving copy')
    await seed.flush()

    // The project folder was wiped; the app copy is all that is left.
    const restored = new MirroredConversation([empty, filled])
    restored.setProject(root)
    expect(restored.all().map((t) => t.text)).toEqual(['from the surviving copy'])
  })
})