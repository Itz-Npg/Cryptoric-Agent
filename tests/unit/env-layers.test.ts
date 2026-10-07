import { describe, expect, it } from 'vitest'
import {
  POSIX,
  WINDOWS,
  dedupePathEntries,
  envGet,
  findExecutableOnPath,
  pathDirectories,
  resolveEnvLayers,
  splitPathList,
  withOverrides
} from '../../src/main/services/env/layers'
import { expandWindowsVariables, parseRegEntries } from '../../src/main/services/env/manager'

describe('splitPathList', () => {
  it('splits on the platform separator and trims entries', () => {
    expect(splitPathList(' C:\\a ; C:\\b ;;C:\\c ', WINDOWS)).toEqual(['C:\\a', 'C:\\b', 'C:\\c'])
    expect(splitPathList('/a:/b::/c', POSIX)).toEqual(['/a', '/b', '/c'])
  })

  it('unwraps quoted Windows entries', () => {
    expect(splitPathList('"C:\\Program Files\\nodejs";C:\\b', WINDOWS)).toEqual([
      'C:\\Program Files\\nodejs',
      'C:\\b'
    ])
  })
})

describe('dedupePathEntries', () => {
  it('removes duplicates case-insensitively on Windows and keeps the first', () => {
    expect(dedupePathEntries(['C:\\A', 'c:\\a', 'C:\\B'], WINDOWS)).toEqual(['C:\\A', 'C:\\B'])
  })

  it('treats trailing separators as equivalent on Windows', () => {
    expect(dedupePathEntries(['C:\\A\\', 'C:\\A'], WINDOWS)).toEqual(['C:\\A\\'])
  })

  it('is case-sensitive on POSIX', () => {
    expect(dedupePathEntries(['/a', '/A'], POSIX)).toEqual(['/a', '/A'])
  })
})

describe('resolveEnvLayers', () => {
  it('lets the highest layer win for scalar variables', () => {
    const merged = resolveEnvLayers(
      { SYSTEM: { HOME: '/home/a', FOO: 'system' }, CRYPTORIC: { FOO: 'cryptoric' }, TASK: { FOO: 'task' } },
      POSIX
    )
    expect(merged.FOO).toBe('task')
    expect(merged.HOME).toBe('/home/a')
  })

  it('merges PATH with higher layers first so project tools shadow system tools', () => {
    const merged = resolveEnvLayers(
      {
        SYSTEM: { PATH: '/usr/bin:/bin' },
        CRYPTORIC: { PATH: '/opt/cryptoric/tools/bin' },
        PROJECT: { PATH: '/repo/node_modules/.bin' }
      },
      POSIX
    )
    expect(merged.PATH).toBe('/repo/node_modules/.bin:/opt/cryptoric/tools/bin:/usr/bin:/bin')
  })

  it('does not duplicate entries shared across layers', () => {
    const merged = resolveEnvLayers(
      { SYSTEM: { PATH: '/usr/bin' }, CRYPTORIC: { PATH: '/tools/bin:/usr/bin' } },
      POSIX
    )
    expect(merged.PATH).toBe('/tools/bin:/usr/bin')
  })

  it('normalises Windows PATH casing and uses the canonical key', () => {
    const merged = resolveEnvLayers({ SYSTEM: { path: 'C:\\Windows' }, USER: { Path: 'C:\\Users\\a' } }, WINDOWS)
    expect(merged.Path).toBe('C:\\Users\\a;C:\\Windows')
    expect(envGet(merged, 'PATH', WINDOWS)).toBe('C:\\Users\\a;C:\\Windows')
  })

  it('applies layers strictly in the declared order', () => {
    const merged = resolveEnvLayers(
      { TASK: { V: 'task' }, PROJECT: { V: 'project' }, CRYPTORIC: { V: 'cryptoric' }, USER: { V: 'user' }, SYSTEM: { V: 'system' } },
      POSIX,
      ['SYSTEM', 'USER', 'CRYPTORIC', 'PROJECT', 'TASK']
    )
    expect(merged.V).toBe('task')
  })
})

describe('withOverrides', () => {
  it('prepends override paths instead of replacing the base path', () => {
    const base = { PATH: '/usr/bin:/bin' }
    const merged = withOverrides(base, { PATH: '/opt/tools/bin' }, POSIX)
    expect(merged.PATH).toBe('/opt/tools/bin:/usr/bin:/bin')
  })
})

describe('findExecutableOnPath', () => {
  it('walks PATH left to right and returns the highest-precedence match', () => {
    const env = { PATH: '/first:/second' }
    const exists = (p: string) => p === '/second/node'
    expect(findExecutableOnPath(env, 'node', exists, POSIX)).toBe('/second/node')
  })

  it('appends Windows executable extensions when probing', () => {
    const env = { Path: 'C:\\tools' }
    const exists = (p: string) => p === 'C:\\tools\\node.EXE'
    expect(findExecutableOnPath(env, 'node', exists, WINDOWS)).toBe('C:\\tools\\node.EXE')
  })

  it('returns null when the executable exists nowhere on PATH', () => {
    const env = { PATH: '/first:/second' }
    expect(findExecutableOnPath(env, 'node', () => false, POSIX)).toBeNull()
  })

  it('resolves an absolute path directly without consulting PATH', () => {
    const env = { PATH: '/first' }
    expect(findExecutableOnPath(env, '/opt/node', (p) => p === '/opt/node', POSIX)).toBe('/opt/node')
  })

  it('returns null when PATH is absent', () => {
    expect(findExecutableOnPath({}, 'node', () => true, POSIX)).toBeNull()
  })
})

describe('pathDirectories', () => {
  it('lists directories highest precedence first', () => {
    expect(pathDirectories({ PATH: '/a:/b' }, POSIX)).toEqual(['/a', '/b'])
    expect(pathDirectories({}, POSIX)).toEqual([])
  })
})

describe('Windows registry values', () => {
  /**
   * The persisted machine PATH is REG_EXPAND_SZ, and Windows expands the
   * %NAME% references when it composes a process environment. Reading the raw
   * string instead put a literal %SystemRoot%\system32 on the PATH of every
   * child Cryptoric spawned, and `npm test` answered
   * `ENOENT spawn %SystemRoot%\system32\cmd.exe` — for a suite that was
   * sitting right there, because npm shells out to cmd through that entry.
   */
  it('parses the value type as well as the value', () => {
    const entries = parseRegEntries(
      String.raw`HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment
    Path    REG_EXPAND_SZ    %SystemRoot%\system32;%SystemRoot%
    TEMP    REG_SZ    C:\Temp
    windir    REG_EXPAND_SZ    %SystemRoot%`
    )
    expect(entries).toEqual([
      { name: 'Path', value: String.raw`%SystemRoot%\system32;%SystemRoot%`, expandable: true },
      { name: 'TEMP', value: String.raw`C:\Temp`, expandable: false },
      { name: 'windir', value: String.raw`%SystemRoot%`, expandable: true }
    ])
  })

  it('expands references case-insensitively and leaves unknown names alone', () => {
    const vars = { SystemRoot: String.raw`C:\Windows`, SystemDrive: 'C:' }
    expect(expandWindowsVariables(String.raw`%SystemRoot%\system32;%SYSTEMROOT%`, vars)).toBe(
      String.raw`C:\Windows\system32;C:\Windows`
    )
    expect(expandWindowsVariables(String.raw`%NotASetting%\x`, vars)).toBe(String.raw`%NotASetting%\x`)
    expect(expandWindowsVariables(String.raw`C:\plain`, vars)).toBe(String.raw`C:\plain`)
  })

  it('resolves a reference to another reference, and cannot loop forever', () => {
    expect(expandWindowsVariables('%A%', { A: '%B%', B: String.raw`C:\real` })).toBe(String.raw`C:\real`)
    // A cycle terminates rather than spinning: the value stays bounded, which
    // is what matters — there is no correct expansion of a self-reference.
    expect(expandWindowsVariables('%A%', { A: '%B%', B: '%A%' })).toMatch(/^%[AB]%$/)
    expect(expandWindowsVariables('%A%', { A: '%A%' })).toBe('%A%')
  })
})
