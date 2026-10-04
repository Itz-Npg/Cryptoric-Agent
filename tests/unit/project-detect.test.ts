import { describe, expect, it } from 'vitest'
import { computeGaps, detectProject, inferDevPort } from '../../src/main/services/project/detect'

/** In-memory filesystem so detection can be tested without touching disk. */
function fsFixture(files: Record<string, string>) {
  return {
    readText: async (path: string): Promise<string | null> => {
      const key = Object.keys(files).find((f) => f.endsWith(path.replace(/\\/g, '/')) || path.endsWith(f))
      return key ? (files[key] as string) : null
    },
    listDir: async (root: string): Promise<string[]> => {
      const prefix = root.replace(/\\/g, '/').replace(/\/+$/, '')
      const names = new Set<string>()
      for (const file of Object.keys(files)) {
        let rel = file.replace(/\\/g, '/').replace(/^\/+/, '')
        if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length + 1)
        if (!rel || rel.startsWith('..')) continue
        names.add(rel.split('/')[0] as string)
      }
      // readdir order is unspecified; sort so the fixture is deterministic.
      return [...names].sort()
    },
    isGitRepo: async () => false
  }
}

describe('detectProject', () => {
  it('detects a Node project and its package manager from the lockfile', async () => {
    const profile = await detectProject('/repo', {
      readText: async (p) => (p.endsWith('package.json') ? '{"engines":{"node":">=18"},"scripts":{"dev":"vite","build":"tsc"}}' : null),
      listDir: async () => ['package.json', 'pnpm-lock.yaml', 'src'],
      isGitRepo: async () => true
    })

    expect(profile.kind).toBe('node')
    expect(profile.packageManager).toBe('pnpm')
    expect(profile.requiredTools).toContain('node')
    expect(profile.scripts.dev).toBe('vite')
    expect(profile.scripts.build).toBe('tsc')
    expect(profile.isGitRepo).toBe(true)
  })

  it('prefers pnpm over npm when both lockfiles exist', async () => {
    const profile = await detectProject('/repo', {
      readText: async () => '{}',
      listDir: async () => ['package.json', 'package-lock.json', 'pnpm-lock.yaml']
    })
    expect(profile.packageManager).toBe('pnpm')
  })

  it('prefers yarn over npm', async () => {
    const profile = await detectProject('/repo', {
      readText: async () => '{}',
      listDir: async () => ['package.json', 'yarn.lock', 'package-lock.json']
    })
    expect(profile.packageManager).toBe('yarn')
  })

  it('normalises an engines range to a minimum', async () => {
    const profile = await detectProject('/repo', {
      readText: async (p) => (p.endsWith('package.json') ? '{"engines":{"node":"^18.17 || >=20"}}' : null),
      listDir: async () => ['package.json']
    })
    const manifest = profile.manifests.find((m) => m.file === 'package.json')
    expect(manifest?.constraint).toBe('18.17')
  })

  it('detects a Rust project and requires cargo', async () => {
    const profile = await detectProject('/repo', {
      readText: async () => null,
      listDir: async () => ['Cargo.toml', 'src']
    })
    expect(profile.kind).toBe('rust')
    expect(profile.requiredTools).toEqual(expect.arrayContaining(['rust', 'cargo']))
    expect(profile.packageManager).toBe('cargo')
  })

  it('detects a Python project and defaults the package manager to pip', async () => {
    const profile = await detectProject('/repo', {
      readText: async (p) => (p.endsWith('pyproject.toml') ? '[project]\nname="x"' : null),
      listDir: async () => ['pyproject.toml']
    })
    expect(profile.kind).toBe('python')
    expect(profile.packageManager).toBe('pip')
  })

  it('uses uv when a uv.lock is present', async () => {
    const profile = await detectProject('/repo', {
      readText: async () => null,
      listDir: async () => ['pyproject.toml', 'uv.lock']
    })
    expect(profile.packageManager).toBe('uv')
  })

  it('classifies a mixed repository as mixed and unions the requirements', async () => {
    const profile = await detectProject('/repo', {
      readText: async (p) => (p.endsWith('pyproject.toml') ? 'x' : null),
      listDir: async () => ['pyproject.toml', 'Cargo.toml', 'package.json']
    })
    expect(profile.kind).toBe('mixed')
    expect(profile.requiredTools).toEqual(expect.arrayContaining(['node', 'python', 'rust']))
  })

  it('detects a .NET project by glob', async () => {
    const profile = await detectProject('/repo', {
      readText: async () => null,
      listDir: async () => ['App.csproj', 'Program.cs']
    })
    expect(profile.kind).toBe('dotnet')
    expect(profile.requiredTools).toContain('dotnet')
  })

  it('returns unknown for an empty directory instead of throwing', async () => {
    const profile = await detectProject('/empty', { readText: async () => null, listDir: async () => [] })
    expect(profile.kind).toBe('unknown')
    expect(profile.requiredTools).toEqual([])
    expect(profile.packageManager).toBeNull()
  })

  it('survives a malformed package.json', async () => {
    const profile = await detectProject('/repo', {
      readText: async (p) => (p.endsWith('package.json') ? '{ not json' : null),
      listDir: async () => ['package.json']
    })
    expect(profile.kind).toBe('node')
    expect(profile.scripts).toEqual({})
  })
})

describe('inferDevPort', () => {
  it('reads an explicit port from a dev script', () => {
    expect(inferDevPort({ dev: 'next dev --port 4000' })).toBe(4000)
    expect(inferDevPort({ dev: 'vite --port=5175' })).toBe(5175)
    expect(inferDevPort({ start: 'serve -l 8080' })).toBe(8080)
  })

  it('falls back to framework defaults', () => {
    expect(inferDevPort({ dev: 'vite' })).toBe(5173)
    expect(inferDevPort({ dev: 'next dev' })).toBe(3000)
    expect(inferDevPort({ dev: 'ng serve' })).toBe(4200)
  })

  it('returns null when nothing suggests a port', () => {
    expect(inferDevPort({ build: 'tsc' })).toBeNull()
  })
})

describe('computeGaps', () => {
  const profile = {
    root: '/repo',
    name: 'repo',
    kind: 'node' as const,
    manifests: [{ file: 'package.json', kind: 'node' as const, requires: ['node'], packageManager: null, constraint: null }],
    requiredTools: ['node', 'rust'],
    packageManager: 'npm',
    scripts: {},
    devServerPort: null,
    isGitRepo: false,
    detectedAt: ''
  }

  it('reports a missing runtime and names the manifest that requires it', () => {
    const gaps = computeGaps(profile, [
      { spec: { id: 'node', label: 'Node.js', installers: [{ id: 'node-winget', requiredTier: 'elevated' }] }, state: 'missing', constraint: null, detail: '' },
      { spec: { id: 'rust', label: 'Rust', installers: [{ id: 'rustup-rs', requiredTier: 'ask' }] }, state: 'missing', constraint: null, detail: '' }
    ])
    expect(gaps.map((g) => g.toolId).sort()).toEqual(['node', 'rust'])
    expect(gaps[0]?.requiredBy).toEqual(['package.json'])
    expect(gaps[0]?.kind).toBe('missing')
  })

  it('reports a mismatched runtime separately from a missing one', () => {
    const gaps = computeGaps(profile, [
      { spec: { id: 'node', label: 'Node.js', installers: [] }, state: 'mismatched', constraint: '>=20', detail: 'Node 18 does not satisfy >=20' },
      { spec: { id: 'rust', label: 'Rust', installers: [] }, state: 'present', constraint: null, detail: '' }
    ])
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.kind).toBe('mismatched')
    expect(gaps[0]?.detail).toMatch(/does not satisfy/)
  })

  it('returns no gaps when every required runtime is present', () => {
    const gaps = computeGaps(profile, [
      { spec: { id: 'node', label: 'Node.js', installers: [] }, state: 'present', constraint: null, detail: '' },
      { spec: { id: 'rust', label: 'Rust', installers: [] }, state: 'present', constraint: null, detail: '' }
    ])
    expect(gaps).toEqual([])
  })
})

describe('fsFixture helper', () => {
  it('lists top-level entries for a nested tree', async () => {
    const f = fsFixture({ 'src/index.ts': '', 'src/util.ts': '', 'README.md': '' })
    await expect(f.listDir('/repo')).resolves.toEqual(['README.md', 'src'])
  })
})