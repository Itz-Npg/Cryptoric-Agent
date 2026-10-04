import { describe, expect, it } from 'vitest'
import {
  buildSkillContext,
  classifyTask,
  estimateTokens,
  parseFrontmatter,
  routeSkills,
  SkillRegistry
} from '../../src/main/services/skills/registry'
import { subsequence } from '../../src/renderer/src/palette/CommandPalette'

describe('parseFrontmatter', () => {
  it('parses scalars', () => {
    const { data, body } = parseFrontmatter('---\nname: demo\nversion: "1.2"\n---\nbody text\n')
    expect(data.name).toBe('demo')
    expect(data.version).toBe('1.2')
    expect(body.trim()).toBe('body text')
  })

  it('parses simple list items into a comma-separated value', () => {
    const { data } = parseFrontmatter('---\nname: demo\ncategories:\n  - ui\n  - react\n---\n')
    expect(data.categories).toBe('ui, react')
  })

  it('unwraps quoted scalars', () => {
    const { data } = parseFrontmatter('---\ndescription: "a: description: with colons"\n---\n')
    expect(data.description).toBe('a: description: with colons')
  })

  it('returns an empty map when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('no frontmatter here')
    expect(data).toEqual({})
    expect(body).toBe('no frontmatter here')
  })

  it('tolerates an unterminated frontmatter block', () => {
    const { data } = parseFrontmatter('---\nname: broken\nstill going')
    expect(data.name).toBe('broken')
  })
})

describe('estimateTokens', () => {
  it('approximates four characters per token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('classifyTask', () => {
  it('classifies a UI request', () => {
    expect(classifyTask({ prompt: 'redesign the settings page layout and spacing', paths: [], categories: [] })).toContain('ui')
  })

  it('classifies a security request', () => {
    expect(classifyTask({ prompt: 'audit this for xss and path traversal in the auth handler', paths: [], categories: [] })).toContain('security')
  })

  it('classifies by file extension', () => {
    expect(classifyTask({ prompt: 'improve this', paths: ['src/App.tsx'], categories: [] })).toContain('react')
  })

  it('classifies testing from a spec path', () => {
    expect(classifyTask({ prompt: 'improve this', paths: ['tests/foo.test.ts'], categories: [] })).toContain('testing')
  })

  it('returns nothing for an unclassifiable request', () => {
    expect(classifyTask({ prompt: 'hello', paths: [], categories: [] })).toEqual([])
  })

  it('honours an explicit category from the caller', () => {
    expect(classifyTask({ prompt: 'hello', paths: [], categories: ['performance'] })).toContain('performance')
  })
})

describe('routeSkills', () => {
  /** Build a registry whose manifests are injected directly, avoiding disk. */
  function fakeRegistry(entries: { id: string; categories: string[]; body: string; enabled?: boolean }[]) {
    const registry = new SkillRegistry()
    for (const entry of entries) {
      const descriptor = {
        id: entry.id,
        name: entry.id,
        description: `${entry.id} skill`,
        path: `/skills/${entry.id}`,
        scope: 'global' as const,
        categories: entry.categories,
        enabled: entry.enabled ?? true,
        permissions: [],
        version: null
      }
      // The registry keeps bodies in a private map; expose it for the test.
      ;(registry as unknown as { skills: Map<string, unknown>; bodies: Map<string, string> }).skills.set(
        entry.id,
        descriptor
      )
      ;(registry as unknown as { skills: Map<string, unknown>; bodies: Map<string, string> }).bodies.set(
        entry.id,
        entry.body
      )
    }
    return registry
  }

  it('loads only skills whose categories match the task', () => {
    const registry = fakeRegistry([
      { id: 'ui', categories: ['ui'], body: 'ui guidance' },
      { id: 'security', categories: ['security'], body: 'security guidance' },
      { id: 'database', categories: ['database'], body: 'db guidance' }
    ])
    const decision = routeSkills(registry, { prompt: 'fix the layout spacing', paths: [], categories: [] }, {
      tokenBudget: 10_000,
      maxSkills: 4
    })
    expect(decision.skillIds).toEqual(['ui'])
    expect(decision.skipped.find((s) => s.id === 'database')?.reason).toMatch(/not relevant/i)
  })

  it('never loads every skill into one request', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      id: `skill-${i}`,
      categories: ['ui', 'security', 'testing', 'backend', 'database'],
      body: 'x'
    }))
    const registry = fakeRegistry(entries)
    const decision = routeSkills(registry, { prompt: 'ui security testing backend database', paths: [], categories: [] }, {
      tokenBudget: 100_000,
      maxSkills: 3
    })
    expect(decision.skillIds).toHaveLength(3)
    expect(decision.skipped.filter((s) => s.reason === 'selection limit reached').length).toBe(37)
  })

  it('respects the token budget and reports why a skill was skipped', () => {
    const registry = fakeRegistry([
      { id: 'big', categories: ['ui'], body: 'x'.repeat(400) }, // ~100 tokens
      { id: 'small', categories: ['ui'], body: 'y'.repeat(40) } // ~10 tokens
    ])
    const decision = routeSkills(registry, { prompt: 'ui work', paths: [], categories: [] }, {
      tokenBudget: 20,
      maxSkills: 4
    })
    expect(decision.skillIds).toEqual(['small'])
    expect(decision.skipped.find((s) => s.id === 'big')?.reason).toMatch(/token budget/i)
  })

  it('skips disabled skills', () => {
    const registry = fakeRegistry([{ id: 'off', categories: ['ui'], body: 'x', enabled: false }])
    const decision = routeSkills(registry, { prompt: 'ui', paths: [], categories: [] }, {
      tokenBudget: 10_000,
      maxSkills: 4
    })
    expect(decision.skillIds).toEqual([])
    expect(decision.skipped[0]?.reason).toBe('disabled')
  })

  it('reports an estimated token cost for the selection', () => {
    const registry = fakeRegistry([{ id: 'a', categories: ['ui'], body: 'x'.repeat(400) }])
    const decision = routeSkills(registry, { prompt: 'ui', paths: [], categories: [] }, {
      tokenBudget: 10_000,
      maxSkills: 4
    })
    expect(decision.estimatedTokens).toBe(100)
  })

  it('builds a context block from the selected skills only', () => {
    const registry = fakeRegistry([
      { id: 'ui', categories: ['ui'], body: 'UI RULES' },
      { id: 'db', categories: ['database'], body: 'DB RULES' }
    ])
    const context = buildSkillContext(registry, ['ui'])
    expect(context).toContain('UI RULES')
    expect(context).not.toContain('DB RULES')
  })

  it('ignores a missing skill id without throwing', () => {
    const registry = fakeRegistry([])
    expect(buildSkillContext(registry, ['nope'])).toBe('')
  })
})

describe('command palette fuzzy match', () => {
  it('matches a subsequence regardless of spacing', () => {
    expect(subsequence('Refresh environment', 'renv')).toBe(true)
    expect(subsequence('Refresh environment', 'zzz')).toBe(false)
  })

  it('matches an exact prefix', () => {
    expect(subsequence('Open project', 'open')).toBe(true)
  })
})