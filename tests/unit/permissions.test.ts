import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  ApprovalQueue,
  SESSION_GRANT_TTL_MS,
  checkPath,
  classifyCommand,
  matchScope,
  PermissionPolicy
} from '../../src/main/services/permissions/policy'

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

describe('checkPath symlink containment', () => {
  // The lexical check proves what the *text* of the path says. These tests
  // prove the second check: the kernel follows links regardless of text, so a
  // link inside the workspace pointing outside it must be denied.
  //
  // Symlink creation needs privilege on Windows (Developer Mode), so every
  // case below creates its link defensively and skips when the OS refuses.
  const outside = mkdtempSync(join(tmpdir(), 'cryptoric-outside-'))
  const root = mkdtempSync(join(tmpdir(), 'cryptoric-root-'))

  const makeLink = (target: string, link: string, kind: 'file' | 'dir' = 'file'): boolean => {
    try {
      // On Windows a directory junction needs no privilege, while a file
      // symlink needs Developer Mode (EPERM otherwise) — so directory escape
      // is exercised everywhere and file escape where the OS allows it.
      if (process.platform === 'win32' && kind === 'dir') {
        symlinkSync(target, link, 'junction')
      } else {
        symlinkSync(target, link)
      }
      return true
    } catch {
      return false // Windows without symlink privilege: EPERM
    }
  }

  it('denies a file symlink whose target escapes the root', () => {
    const secret = join(outside, 'secret.txt')
    writeFileSync(secret, 'top secret', 'utf8')
    if (!makeLink(secret, join(root, 'innocent.txt'))) return // skipped: no symlink privilege

    expect(checkPath(join(root, 'innocent.txt'), [root]).allowed).toBe(false)
  })

  it('denies a directory symlink whose target escapes the root', () => {
    if (!makeLink(outside, join(root, 'vendor'), 'dir')) return

    const verdict = checkPath(join(root, 'vendor', 'secret.txt'), [root])
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toMatch(/symlink/i)
  })

  it('denies a dangling symlink that would create outside the root', () => {
    // The write target does not exist yet, so realpath alone throws ENOENT;
    // containment must be judged on where the link points.
    if (!makeLink(join(outside, 'new-file.txt'), join(root, 'future.txt'))) return

    expect(checkPath(join(root, 'future.txt'), [root]).allowed).toBe(false)
  })

  it('allows a symlink that stays inside the root', () => {
    mkdirSync(join(root, 'real'), { recursive: true })
    writeFileSync(join(root, 'real', 'a.txt'), 'ok', 'utf8')
    if (!makeLink(join(root, 'real'), join(root, 'alias'), 'dir')) return

    expect(checkPath(join(root, 'alias', 'a.txt'), [root]).allowed).toBe(true)
  })

  it('allows a path that does not exist yet inside the root', () => {
    // write_file to a brand-new file: no realpath available, but no link
    // either — the missing tail re-attaches to the resolved ancestor.
    const verdict = checkPath(join(root, 'brand-new', 'file.txt'), [root])
    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.absolute).toBe(join(root, 'brand-new', 'file.txt'))
  })

  it('does not leak the temp directories it created', () => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    expect(true).toBe(true)
  })
})

describe('session grant scope, tier and expiry', () => {
  it('expires a grant after its TTL', () => {
    let clock = 1_000_000
    const policy = new PermissionPolicy([{ domain: 'fs.write', default: 'ask' }], {
      now: () => clock
    })
    policy.grantSession('fs.write', 'allow')
    expect(policy.hasSessionGrant('fs.write')).toBe(true)

    clock += SESSION_GRANT_TTL_MS + 1
    expect(policy.hasSessionGrant('fs.write')).toBe(false)
    expect(policy.evaluateDomain('fs.write')).toBe('ask')
  })

  it('honours a custom TTL when one is given', () => {
    let clock = 0
    const policy = new PermissionPolicy([], { now: () => clock })
    policy.grantSession('terminal.elevated', 'allow', { ttlMs: 60_000 })
    clock = 59_999
    expect(policy.hasSessionGrant('terminal.elevated')).toBe(true)
    clock = 60_000
    expect(policy.hasSessionGrant('terminal.elevated')).toBe(false)
  })

  it('caps a grant at the tier the user approved', () => {
    const policy = new PermissionPolicy([])
    // The dialog showed an `ask`-tier tool; the grant must not cover an
    // elevated tool that shares the domain.
    policy.grantSession('terminal.elevated', 'allow', { maxTier: 'ask' })
    expect(policy.hasSessionGrant('terminal.elevated', 'safe')).toBe(true)
    expect(policy.hasSessionGrant('terminal.elevated', 'ask')).toBe(true)
    expect(policy.hasSessionGrant('terminal.elevated', 'elevated')).toBe(false)
    expect(policy.hasSessionGrant('terminal.elevated', 'destructive')).toBe(false)
  })

  it('defaults to an unrestricted tier for harness callers', () => {
    const policy = new PermissionPolicy([])
    policy.grantSession('terminal.elevated', 'allow')
    expect(policy.hasSessionGrant('terminal.elevated', 'destructive')).toBe(true)
  })

  it('still cannot lift a configured deny', () => {
    const policy = new PermissionPolicy([{ domain: 'fs.delete', default: 'deny' }])
    policy.grantSession('fs.delete', 'allow')
    expect(policy.evaluateDomain('fs.delete')).toBe('deny')
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
  // Built from the platform rather than hardcoded.
  //
  // These used to read `C:\projects\site`. On POSIX a backslash is an ordinary
  // filename character, so that string is a *relative* path there — `resolve()`
  // anchored it to the app's own working directory and all three assertions
  // below failed on Linux while passing on Windows. The suite now runs in CI on
  // three operating systems, so a literal Windows path is a portability bug.
  const workspace = resolve(sep, 'projects', 'site')
  const roots = [workspace]

  it('accepts a bare relative path inside the workspace', () => {
    const verdict = checkPath('index.html', roots)
    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.absolute).toBe(join(workspace, 'index.html'))
  })

  it('accepts the current-directory shorthand', () => {
    expect(checkPath('.', roots).allowed).toBe(true)
  })

  it('accepts a nested relative path', () => {
    const verdict = checkPath('src/app.ts', roots)
    expect(verdict.allowed).toBe(true)
    if (verdict.allowed) expect(verdict.absolute).toBe(join(workspace, 'src', 'app.ts'))
  })

  it('still refuses a relative path that climbs out', () => {
    expect(checkPath('../secrets.txt', roots).allowed).toBe(false)
    expect(checkPath('a/../../b', roots).allowed).toBe(false)
  })

  it('still refuses an absolute path outside the workspace', () => {
    expect(checkPath(resolve(sep, 'Windows', 'System32', 'config'), roots).allowed).toBe(false)
  })

  it('still refuses device paths and null bytes', () => {
    expect(checkPath(String.raw`\\?\C:\x`, roots).allowed).toBe(false)
    expect(checkPath('a\0b', roots).allowed).toBe(false)
  })

  it('still refuses everything when no root is open', () => {
    expect(checkPath('index.html', []).allowed).toBe(false)
  })
})