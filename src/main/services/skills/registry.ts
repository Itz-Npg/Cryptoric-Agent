/**
 * Skill discovery and routing.
 *
 * Two separate concerns, deliberately kept apart:
 *
 *  - **Registry** — finds skill manifests on disk and reports them to the UI.
 *    A skill is a directory (or file) containing a `SKILL.md` with YAML
 *    frontmatter. Nothing here *executes* skill content; skills contribute text
 *    context and category metadata only. That is the security boundary: a skill
 *    cannot reach the filesystem, the network or a subprocess.
 *
 *  - **Router** — classifies the current task and selects the small set of skills
 *    worth loading. The product requirement is explicit: never dump every skill
 *    into every model request. The router returns ranked ids with a token
 *    estimate so the agent can refuse to exceed its context budget.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PermissionDomain, SkillDescriptor } from '@shared/types'

export interface SkillRoots {
  /** Shipped with the app. */
  builtin: string[]
  /** User-global skills, e.g. ~/.gemini/config/skills. */
  global: string[]
  /** Project-local skills, e.g. <project>/.cryptoric/skills. */
  project: string[]
}

export const DEFAULT_SKILL_ROOTS: SkillRoots = {
  builtin: [],
  global: [
    join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.gemini', 'config', 'skills'),
    join(process.env.HOME ?? '', '.claude', 'skills'),
    join(process.env.HOME ?? '', '.codex', 'skills')
  ],
  project: []
}

interface ParsedFrontmatter {
  data: Record<string, string>
  body: string
}

/**
 * Parse the minimal YAML frontmatter used by skill manifests.
 *
 * A full YAML parser would accept anchors, aliases and multi-document streams —
 * none of which a skill manifest needs, and all of which complicate proving what
 * a skill actually declared. This parser accepts scalars and simple `-` lists and
 * rejects anything else, which is what makes "declared permissions" auditable.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const normalized = text.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return { data: {}, body: normalized }

  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: normalized }

  const header = normalized.slice(3, end)
  const body = normalized.slice(end + 4).replace(/^\s*\r?\n/, '')
  const data: Record<string, string> = {}
  let currentListKey: string | null = null

  for (const line of header.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const listItem = /^\s*-\s+(.*)$/.exec(line)
    if (listItem && currentListKey) {
      const existing = data[currentListKey]
      data[currentListKey] = existing ? `${existing}, ${cleanScalar(listItem[1] as string)}` : cleanScalar(listItem[1] as string)
      continue
    }
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1] as string
    const rawValue = (kv[2] ?? '').trim()
    if (rawValue === '') {
      currentListKey = key
      data[key] = ''
      continue
    }
    currentListKey = null
    data[key] = cleanScalar(rawValue)
  }

  return { data, body }
}

function cleanScalar(value: string): string {
  let v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1)
  }
  return v
}

const VALID_PERMISSIONS = new Set<PermissionDomain>([
  'fs.read', 'fs.write', 'fs.delete',
  'terminal.safe', 'terminal.elevated', 'terminal.destructive',
  'git.read', 'git.modify', 'git.destructive',
  'browser.read', 'browser.interact',
  'network.read', 'network.write',
  'env.detect', 'env.install', 'env.modify'
])

function parsePermissions(raw: string): PermissionDomain[] {
  if (!raw) return []
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s): s is PermissionDomain => VALID_PERMISSIONS.has(s as PermissionDomain))
}

/** Approximate token count; ~4 characters per token is the usual rule of thumb. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export class SkillRegistry {
  private skills = new Map<string, SkillDescriptor>()
  private bodies = new Map<string, string>()
  private disabled = new Set<string>()

  async discover(roots: SkillRoots, projectRoot?: string | null): Promise<SkillDescriptor[]> {
    this.skills.clear()
    this.bodies.clear()

    const resolved: { dir: string; scope: SkillDescriptor['scope'] }[] = []
    for (const dir of roots.builtin) resolved.push({ dir, scope: 'builtin' })
    for (const dir of roots.global) resolved.push({ dir, scope: 'global' })
    if (projectRoot) {
      resolved.push({ dir: join(projectRoot, '.cryptoric', 'skills'), scope: 'project' })
    }

    for (const { dir, scope } of resolved) {
      await this.scanRoot(dir, scope)
    }
    return this.list()
  }

  private async scanRoot(root: string, scope: SkillDescriptor['scope']): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = join(root, entry)
      const info = await stat(entryPath).catch(() => null)
      if (!info) continue

      if (info.isDirectory()) {
        const manifest = join(entryPath, 'SKILL.md')
        const loaded = await this.loadManifest(manifest, entry, entryPath, scope)
        if (loaded) continue
        // One level of nesting, so `skills/frontend/react/SKILL.md` is found.
        const nested = await readdir(entryPath).catch(() => [] as string[])
        for (const child of nested) {
          const childPath = join(entryPath, child)
          const childStat = await stat(childPath).catch(() => null)
          if (!childStat?.isDirectory()) continue
          await this.loadManifest(join(childPath, 'SKILL.md'), `${entry}/${child}`, childPath, scope)
        }
      } else if (entry.toLowerCase().endsWith('.md')) {
        await this.loadManifest(entryPath, entry.replace(/\.md$/i, ''), entryPath, scope)
      }
    }
  }

  private async loadManifest(
    path: string,
    fallbackName: string,
    dir: string,
    scope: SkillDescriptor['scope']
  ): Promise<boolean> {
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text === null) return false

    const { data, body } = parseFrontmatter(text)
    const id = (data.name || fallbackName).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    const categories = (data.categories ?? data.category ?? data.tags ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)

    const descriptor: SkillDescriptor = {
      id,
      name: data.name || fallbackName,
      description: (data.description || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      path: dir,
      scope,
      categories,
      enabled: !this.disabled.has(id) && data['disable-model-invocation'] !== 'true',
      permissions: parsePermissions(data.permissions ?? data['allowed-tools'] ?? ''),
      version: data.version ?? null
    }

    this.skills.set(id, descriptor)
    this.bodies.set(id, body)
    return true
  }

  list(): SkillDescriptor[] {
    return [...this.skills.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string): SkillDescriptor | null {
    return this.skills.get(id) ?? null
  }

  body(id: string): string | null {
    return this.bodies.get(id) ?? null
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const skill = this.skills.get(id)
    if (!skill) return false
    skill.enabled = enabled
    if (enabled) this.disabled.delete(id)
    else this.disabled.add(id)
    return true
  }

  /** Union of permissions the selected skills declare; fed into the policy. */
  declaredPermissions(ids: string[]): PermissionDomain[] {
    const set = new Set<PermissionDomain>()
    for (const id of ids) {
      for (const p of this.skills.get(id)?.permissions ?? []) set.add(p)
    }
    return [...set]
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type TaskCategory =
  | 'ui'
  | 'react'
  | 'security'
  | 'testing'
  | 'electron'
  | 'backend'
  | 'performance'
  | 'database'
  | 'devops'
  | 'release'
  | 'documentation'
  | 'general'

export interface RoutingInput {
  prompt: string
  /** Files the agent plans to touch, used as a secondary signal. */
  paths: string[]
  categories: TaskCategory[]
}

export interface RoutingDecision {
  categories: TaskCategory[]
  skillIds: string[]
  /** Rough token cost of the selected skill bodies. */
  estimatedTokens: number
  /** Skills that were considered and deliberately left out. */
  skipped: { id: string; reason: string }[]
}

/** Keyword and path signals for each category. */
const CATEGORY_SIGNALS: { category: TaskCategory; keywords: string[]; pathPattern: RegExp }[] = [
  {
    category: 'ui',
    keywords: ['ui', 'design', 'layout', 'theme', 'typography', 'color', 'spacing', 'visual', 'redesign', 'responsive'],
    pathPattern: /\.(css|scss|less)$/i
  },
  {
    category: 'react',
    keywords: ['react', 'component', 'hook', 'state', 'props', 'rerender', 'jsx', 'tsx'],
    pathPattern: /\.tsx?$/i
  },
  {
    category: 'security',
    keywords: ['security', 'vulnerability', 'xss', 'csrf', 'injection', 'auth', 'secret', 'credential', 'permission', 'sandbox', 'traversal'],
    pathPattern: /(auth|security|permission|secret)/i
  },
  {
    category: 'testing',
    keywords: ['test', 'spec', 'coverage', 'vitest', 'jest', 'playwright', 'e2e', 'assertion'],
    pathPattern: /\.(test|spec)\.[jt]sx?$/i
  },
  { category: 'electron', keywords: ['electron', 'ipc', 'contextbridge', 'preload', 'renderer', 'main process'], pathPattern: /(electron|preload|main\/)/i },
  { category: 'backend', keywords: ['api', 'server', 'endpoint', 'route', 'service', 'handler', 'request'], pathPattern: /(server|api|routes?)\//i },
  { category: 'performance', keywords: ['performance', 'slow', 'latency', 'memory', 'cpu', 'profil', 'optimi'], pathPattern: /(perf|benchmark)/i },
  { category: 'database', keywords: ['database', 'sql', 'query', 'schema', 'migration', 'postgres', 'sqlite'], pathPattern: /(db|migration|schema)\//i },
  { category: 'devops', keywords: ['ci', 'cd', 'docker', 'pipeline', 'deploy', 'workflow', 'action'], pathPattern: /(docker|\.github\/)/i },
  { category: 'release', keywords: ['release', 'version', 'changelog', 'publish', 'updater', 'tag'], pathPattern: /(release|changelog)/i },
  { category: 'documentation', keywords: ['document', 'readme', 'docstring', 'explain', 'guide'], pathPattern: /(docs?|\.md)$/i }
]

/** Classify a request into the categories whose skills are worth loading. */
export function classifyTask(input: RoutingInput): TaskCategory[] {
  const haystack = `${input.prompt} ${input.paths.join(' ')}`.toLowerCase()
  const scored = new Map<TaskCategory, number>()

  for (const category of input.categories) scored.set(category, (scored.get(category) ?? 0) + 3)

  for (const signal of CATEGORY_SIGNALS) {
    for (const keyword of signal.keywords) {
      if (haystack.includes(keyword)) {
        scored.set(signal.category, (scored.get(signal.category) ?? 0) + 2)
        break
      }
    }
    if (input.paths.some((p) => signal.pathPattern.test(p))) {
      scored.set(signal.category, (scored.get(signal.category) ?? 0) + 2)
    }
  }

  return [...scored.entries()]
    .filter(([, score]) => score >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([category]) => category)
}

export interface RouterOptions {
  /** Hard ceiling on skill context tokens; the router never exceeds it. */
  tokenBudget: number
  /** Maximum skills to select, regardless of budget. */
  maxSkills: number
}

/**
 * Select skills for a task.
 *
 * The selection is intentionally conservative: a skill is loaded only when its
 * declared categories intersect the classified task, it is enabled, and it fits
 * the budget. Everything else is reported in `skipped` with a reason, so the
 * behaviour is inspectable rather than mysterious.
 */
export function routeSkills(
  registry: SkillRegistry,
  input: RoutingInput,
  options: RouterOptions
): RoutingDecision {
  const categories = classifyTask(input)
  const categorySet = new Set(categories)
  const chosen: { id: string; tokens: number }[] = []
  const skipped: { id: string; reason: string }[] = []
  let used = 0

  const candidates = registry.list().sort((a, b) => {
    const aHit = score(a, categorySet)
    const bHit = score(b, categorySet)
    return bHit - aHit
  })

  for (const skill of candidates) {
    if (!skill.enabled) {
      skipped.push({ id: skill.id, reason: 'disabled' })
      continue
    }
    const relevance = score(skill, categorySet)
    if (relevance === 0) {
      skipped.push({ id: skill.id, reason: 'not relevant to this task' })
      continue
    }
    if (chosen.length >= options.maxSkills) {
      skipped.push({ id: skill.id, reason: 'selection limit reached' })
      continue
    }
    const body = registry.body(skill.id) ?? ''
    const tokens = estimateTokens(body)
    if (used + tokens > options.tokenBudget) {
      skipped.push({ id: skill.id, reason: `would exceed the ${options.tokenBudget}-token skill budget` })
      continue
    }
    used += tokens
    chosen.push({ id: skill.id, tokens })
  }

  return {
    categories,
    skillIds: chosen.map((c) => c.id),
    estimatedTokens: used,
    skipped
  }
}

function score(skill: SkillDescriptor, categories: Set<TaskCategory>): number {
  let points = 0
  for (const category of skill.categories) {
    if (categories.has(category as TaskCategory)) points += 3
  }
  // A skill that declares permissions for the selected categories is a strong signal.
  if (skill.permissions.length > 0 && categories.has('security')) points += 1
  if (points === 0 && skill.categories.length === 0 && categories.has('general')) points += 1
  return points
}

/** Assemble the skill context block injected into a model request. */
export function buildSkillContext(registry: SkillRegistry, skillIds: string[]): string {
  const sections: string[] = []
  for (const id of skillIds) {
    const skill = registry.get(id)
    const body = registry.body(id)
    if (!skill || body === null) continue
    const trimmed = body.trim().slice(0, 12_000)
    sections.push(`## Skill: ${skill.name}\n${skill.description ? `${skill.description}\n` : ''}\n${trimmed}`)
  }
  return sections.join('\n\n---\n\n')
}