import { describe, expect, it } from 'vitest'
import { classifyCommand, checkPath, matchScope, PermissionPolicy, ApprovalQueue } from '../../src/main/services/permissions/policy'

describe('classifyCommand', () => {
  it('treats read-only inspection as safe', () => {
    for (const [cmd, args] of [
      ['git', ['status']],
      ['node', ['--version']],
      ['ls', ['-la']],
      ['rg', ['--files']],
      ['python3', ['--version']]
    ] as [string, string[]][]) {
      expect(classifyCommand(cmd, args).tier, `${cmd} ${args.join(' ')}`).toBe('safe')
    }
  })

  it('classifies a recursive delete at the filesystem root as destructive', () => {
    expect(classifyCommand('rm', ['-rf', '/']).tier).toBe('destructive')
  })

  it('classifies a recursive delete anywhere as elevated', () => {
    expect(classifyCommand('rm', ['-rf', 'build']).tier).toBe('destructive')
  })

  it('classifies force push as destructive and ordinary push as ask', () => {
    expect(classifyCommand('git', ['push', '--force']).tier).toBe('destructive')
    expect(classifyCommand('git', ['push', '-f', 'origin', 'main']).tier).toBe('destructive')
    expect(classifyCommand('git', ['push']).tier).toBe('ask')
  })

  it('classifies git reset --hard and git clean -f as destructive', () => {
    expect(classifyCommand('git', ['reset', '--hard']).tier).toBe('destructive')
    expect(classifyCommand('git', ['clean', '-fd']).tier).toBe('destructive')
  })

  it('classifies branch-creating git commands as ask, not safe', () => {
    expect(classifyCommand('git', ['checkout', '-b', 'feature']).tier).toBe('ask')
    expect(classifyCommand('git', ['commit', '-m', 'x']).tier).toBe('ask')
  })

  it('treats interpreters as elevated because they execute arbitrary code', () => {
    expect(classifyCommand('python3', ['-c', 'import os']).tier).toBe('elevated')
    expect(classifyCommand('node', ['-e', 'process.exit()']).tier).toBe('elevated')
  })

  it('classifies publishing to a registry as destructive', () => {
    expect(classifyCommand('npm', ['publish']).tier).toBe('destructive')
    expect(classifyCommand('yarn', ['unpublish']).tier).toBe('destructive')
  })

  it('treats a plain package install as elevated and a script-free local one as ask', () => {
    expect(classifyCommand('npm', ['install']).tier).toBe('elevated')
    expect(classifyCommand('npm', ['install', '--ignore-scripts']).tier).toBe('ask')
  })

  it('treats registry writes and privilege escalation as elevated', () => {
    expect(classifyCommand('reg', ['add', 'HKLM\\Software', '/v', 'x']).tier).toBe('elevated')
    expect(classifyCommand('sudo', ['apt', 'install', 'x']).tier).toBe('elevated')
    expect(classifyCommand('setx', ['FOO', 'bar']).tier).toBe('elevated')
  })

  it('classifies docker resource removal as destructive', () => {
    expect(classifyCommand('docker', ['system', 'prune', '-f']).tier).toBe('destructive')
    expect(classifyCommand('docker', ['rm', 'container']).tier).toBe('destructive')
  })

  it('fails closed for an unrecognised command', () => {
    const verdict = classifyCommand('some-unknown-binary', ['--flag'])
    expect(verdict.tier).toBe('ask')
    expect(verdict.reason).toMatch(/not in the known-safe set/i)
  })

  it('matches the executable by base name so a full path cannot disguise it', () => {
    expect(classifyCommand('/usr/bin/rm', ['-rf', '/']).tier).toBe('destructive')
    expect(classifyCommand('C:\\Windows\\System32\\del.exe', ['/s', 'x']).tier).toBe('destructive')
  })
})

describe('checkPath', () => {
  const roots = [process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo']

  it('allows a path inside the root', () => {
    const target = roots[0] as string
    const inner = process.platform === 'win32' ? `${target}\\src\\index.ts` : `${target}/src/index.ts`
    expect(checkPath(inner, roots).allowed).toBe(true)
  })

  it('allows the root itself', () => {
    expect(checkPath(roots[0] as string, roots).allowed).toBe(true)
  })

  it('rejects traversal that escapes the root', () => {
    const escape = process.platform === 'win32' ? `${roots[0] as string}\\..\\..\\secrets` : `${roots[0] as string}/../../secrets`
    const verdict = checkPath(escape, roots)
    expect(verdict.allowed).toBe(false)
  })

  it('rejects a sibling directory with a shared prefix', () => {
    const sibling = process.platform === 'win32' ? 'C:\\work\\repo-other\\x' : '/work/repo-other/x'
    expect(checkPath(sibling, roots).allowed).toBe(false)
  })

  it('rejects an absolute path outside every root', () => {
    expect(checkPath(process.platform === 'win32' ? 'C:\\Windows\\System32\\config' : '/etc/passwd', roots).allowed).toBe(false)
  })

  it('rejects Windows device and UNC prefixes', () => {
    expect(checkPath('\\\\?\\C:\\Windows', roots).allowed).toBe(false)
    expect(checkPath('\\\\.\\PhysicalDrive0', roots).allowed).toBe(false)
  })

  it('rejects a null byte in the path', () => {
    expect(checkPath(`${roots[0] as string}\\a\0b`, roots).allowed).toBe(false)
  })

  it('denies everything when no root is open', () => {
    expect(checkPath(roots[0] as string, []).allowed).toBe(false)
  })
})

describe('matchScope', () => {
  it('matches a single-segment wildcard', () => {
    expect(matchScope('*.ts', 'index.ts')).toBe(true)
    expect(matchScope('*.ts', 'src/index.ts')).toBe(false)
  })

  it('matches across segments with a double wildcard', () => {
    expect(matchScope('src/**', 'src/a/b/c.ts')).toBe(true)
  })

  it('matches an exact string', () => {
    expect(matchScope('/work/repo', '/work/repo')).toBe(true)
  })
})

describe('PermissionPolicy', () => {
  const ctx = { workspaceRoots: ['/work/repo'] }

  it('denies a filesystem read outside the workspace rather than asking', () => {
    const policy = new PermissionPolicy()
    const result = policy.evaluatePath('fs.read', '/etc/shadow', ctx)
    expect(result.decision).toBe('deny')
  })

  it('allows a read inside the workspace by default', () => {
    const policy = new PermissionPolicy()
    expect(policy.evaluatePath('fs.read', '/work/repo/src/a.ts', ctx).decision).toBe('allow')
  })

  it('does not let a global allow authorise an elevated command', () => {
    const policy = new PermissionPolicy([
      { domain: 'terminal.elevated', default: 'allow' },
      { domain: 'terminal.destructive', default: 'allow' }
    ])
    // Even with `allow`, an elevated command must still be confirmed.
    expect(policy.evaluateCommand('python3', ['-c', 'x'], ctx).decision).toBe('ask')
  })

  it('allows a safe command without prompting', () => {
    const policy = new PermissionPolicy()
    expect(policy.evaluateCommand('git', ['status'], ctx).decision).toBe('allow')
  })

  it('requires approval when no workspace root is open', () => {
    const policy = new PermissionPolicy()
    expect(policy.evaluateCommand('git', ['status'], { workspaceRoots: [] }).decision).toBe('ask')
  })

  it('honours a deny rule over an allow rule', () => {
    const policy = new PermissionPolicy([
      { domain: 'fs.read', default: 'allow' },
      { domain: 'fs.delete', default: 'deny' }
    ])
    expect(policy.evaluatePath('fs.delete', '/work/repo/a.txt', ctx).decision).toBe('deny')
  })

  it('remembers a session grant', () => {
    const policy = new PermissionPolicy([{ domain: 'fs.delete', default: 'ask' }])
    expect(policy.evaluatePath('fs.delete', '/work/repo/a.txt', ctx).decision).toBe('ask')
    policy.grantSession('fs.delete', 'allow')
    expect(policy.evaluatePath('fs.delete', '/work/repo/a.txt', ctx).decision).toBe('allow')
    policy.clearSessionGrants()
    expect(policy.evaluatePath('fs.delete', '/work/repo/a.txt', ctx).decision).toBe('ask')
  })
})

describe('ApprovalQueue', () => {
  it('resolves a waiter when the user decides', async () => {
    const queue = new ApprovalQueue()
    const request = queue.request({ toolId: 't', tier: 'ask', title: 'T', detail: 'd', risk: 'r' })
    const pending = queue.wait(request.id, 5000)
    expect(queue.resolve(request.id, true)).toBe(true)
    await expect(pending).resolves.toBe(true)
    expect(queue.list()).toHaveLength(0)
  })

  it('denies on timeout so a dismissed dialog cannot hang a task', async () => {
    const queue = new ApprovalQueue()
    const request = queue.request({ toolId: 't', tier: 'ask', title: 'T', detail: 'd', risk: 'r' })
    await expect(queue.wait(request.id, 30)).resolves.toBe(false)
  })

  it('denies everything outstanding on shutdown', async () => {
    const queue = new ApprovalQueue()
    const a = queue.request({ toolId: 'a', tier: 'ask', title: 'A', detail: '', risk: '' })
    const b = queue.request({ toolId: 'b', tier: 'ask', title: 'B', detail: '', risk: '' })
    const pa = queue.wait(a.id, 5000)
    const pb = queue.wait(b.id, 5000)
    queue.denyAll()
    expect(await pa).toBe(false)
    expect(await pb).toBe(false)
  })
})

describe('relative paths resolve against the workspace, not the app', () => {
  // Found by the live agent check: the model asked for "index.html" and ".",
  // and every call came back "Path escapes the allowed workspace roots",
  // because `resolve()` was anchoring to the app's own working directory
  // rather than to the open project.
  const roots = ['C:\\projects\\site']

  it('accepts a bare relative path inside the workspace', () => {
    const verdict = checkPath('index.html', roots)
    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.absolute).toBe('C:\\projects\\site\\index.html')
  })

  it('accepts the current-directory shorthand', () => {
    expect(checkPath('.', roots).allowed).toBe(true)
  })

  it('accepts a nested relative path', () => {
    const verdict = checkPath('src/app.ts', roots)
    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.absolute).toBe('C:\\projects\\site\\src\\app.ts')
  })

  it('still refuses a relative path that climbs out', () => {
    expect(checkPath('../secrets.txt', roots).allowed).toBe(false)
    expect(checkPath('a/../../b', roots).allowed).toBe(false)
  })

  it('still refuses an absolute path outside the workspace', () => {
    expect(checkPath('C:\\Windows\\System32\\config', roots).allowed).toBe(false)
  })

  it('still refuses device paths and null bytes', () => {
    expect(checkPath(String.raw`\\?\C:\x`, roots).allowed).toBe(false)
    expect(checkPath('a\0b', roots).allowed).toBe(false)
  })

  it('still refuses everything when no root is open', () => {
    expect(checkPath('index.html', []).allowed).toBe(false)
  })
})