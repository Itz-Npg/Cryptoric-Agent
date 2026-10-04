/**
 * Live check for `run_command`.
 *
 * `run_command` was written and registered but never driven by a real
 * subprocess, which is exactly the gap that lets a tool look finished while
 * being untested. This runs it for real: real argv, real PATH resolution, real
 * child processes, real exit codes.
 *
 * What it asserts, in order:
 *
 *  - a command that succeeds returns exit 0 and its real stdout
 *  - a command that fails returns its real non-zero exit code and stderr
 *  - a command that does not exist is `dependency-missing`, not an opaque ENOENT
 *  - `npm --version` works on Windows, which is the hard case: npm is a `.cmd`
 *    and can only be exec'd through `cmd.exe`
 *  - a destructive argv is refused by tier classification, and never runs
 *  - a batch argument containing a cmd metacharacter is refused
 *  - a cancelled task stops the child rather than orphaning it
 *
 * No model is involved: this is about the tool, not the agent.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentManager } from '../../src/main/services/env/manager'
import { ToolDetector } from '../../src/main/services/env/detect'
import { ToolRegistry } from '../../src/main/services/tools/registry'
import { ToolRuntime } from '../../src/main/services/tools/runtime'
import { buildCommandTools } from '../../src/main/services/tools/builtin/command'
import { PermissionPolicy, ApprovalQueue } from '../../src/main/services/permissions/policy'

let failures = 0
let passes = 0
const pass = (m: string) => { passes++; console.log(`[PASS] ${m}`) }
const fail = (m: string) => { failures++; console.error(`[FAIL] ${m}`) }

const workspace = mkdtempSync(join(tmpdir(), 'cryptoric-command-live-'))
const roots = [workspace]

const env = new EnvironmentManager({
  userDataDir: join(workspace, '.cryptoric'),
  managedRoot: join(workspace, '.cryptoric', 'tools'),
  scratchDir: join(workspace, '.cryptoric', 'tmp'),
  platform: process.platform,
  detector: new ToolDetector()
})
await env.init()

const policy = new PermissionPolicy([{ domain: 'terminal.elevated', default: 'allow' }])
policy.grantSession('terminal.elevated', 'allow')
const approvals = new ApprovalQueue()

const tools = new ToolRegistry()
tools.registerAll(buildCommandTools({ env, getRoots: () => roots }))
const runtime = new ToolRuntime({ registry: tools, policy, approvals })

async function run(args: Record<string, unknown>, signal?: AbortSignal) {
  return runtime.invoke('run_command', args, {
    grantedTier: 'elevated',
    signal: signal ?? new AbortController().signal,
    projectRoot: workspace,
    workspaceRoots: roots
  })
}

const data = (result: { data?: unknown }) => (result.data ?? {}) as Record<string, unknown>

try {
  console.log(`Workspace: ${workspace}\n`)

  // --- 1. a command that succeeds ------------------------------------------
  {
    const r = await run({
      command: 'node',
      args: ['-e', 'process.stdout.write("hello-from-subprocess")']
    })
    if (r.ok && data(r)['exitCode'] === 0 && String(data(r)['stdout']).includes('hello-from-subprocess')) {
      pass('node ran and returned real stdout with exit 0')
    } else {
      fail(`node failed: ok=${r.ok} ${JSON.stringify(data(r))} ${r.error ?? ''}`)
    }
  }

  // --- 2. a command that fails ------------------------------------------------
  {
    const r = await run({ command: 'node', args: ['-e', 'process.stderr.write("boom"); process.exit(3)'] })
    if (!r.ok && data(r)['exitCode'] === 3 && String(r.error ?? '').includes('boom')) {
      pass('a failing command reports its real exit code and stderr')
    } else {
      fail(`expected exit 3 with "boom", got ok=${r.ok} exit=${data(r)['exitCode']} err=${r.error ?? ''}`)
    }
  }

  // --- 3. a command that is not installed ------------------------------------
  {
    const r = await run({ command: 'definitely-not-a-real-binary-xyz', args: [] })
    if (!r.ok && r.failureKind === 'dependency-missing') {
      pass('a missing executable is dependency-missing, not an opaque ENOENT')
    } else {
      fail(`expected dependency-missing, got ok=${r.ok} kind=${r.failureKind}`)
    }
  }

  // --- 4. npm on Windows (the .cmd case) --------------------------------------
  {
    const r = await run({ command: 'npm', args: ['--version'] })
    const out = String(data(r)['stdout'] ?? '').trim()
    if (r.ok && data(r)['exitCode'] === 0 && /^\d+\.\d+\.\d+/.test(out)) {
      pass(`npm --version returned a real version through cmd.exe: ${out}`)
    } else {
      fail(`npm --version failed: ok=${r.ok} exit=${data(r)['exitCode']} out=${JSON.stringify(out)} ${r.error ?? ''}`)
    }
  }

  // --- 5. npm with a lifecycle-free script arg, proving argv survives quoting --
  {
    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify({ name: 'run-command-live-fixture', version: '1.0.0', private: true }),
      'utf8'
    )
    const r = await run({ command: 'npm', args: ['pkg', 'get', 'name'] })
    const out = String(data(r)['stdout'] ?? '')
    if (r.ok && out.includes('run-command-live-fixture')) {
      pass('a hyphenated argument survived the cmd.exe path intact')
    } else {
      fail(`argv was mangled: ok=${r.ok} out=${JSON.stringify(out)} ${r.error ?? ''}`)
    }
  }

  // --- 6. a destructive argv is refused and never runs ------------------------
  {
    // A sentinel that must survive: `rm -rf /` is refused by classification, so
    // nothing may touch the filesystem at all. Checking the *outcome* rather
    // than only the message is what proves it refused rather than merely warned.
    const sentinel = join(workspace, 'sentinel.txt')
    writeFileSync(sentinel, 'intact', 'utf8')

    const rm = await run({ command: 'rm', args: ['-rf', '/'] })
    const rmText = `${rm.summary} ${rm.error ?? ''}`.toLowerCase()
    if (!rm.ok && rmText.includes('destructive')) {
      pass('rm -rf / is refused by argv classification')
    } else {
      fail(`expected a destructive refusal, got ok=${rm.ok} ${JSON.stringify(rmText)}`)
    }

    const push = await run({ command: 'git', args: ['push', '--force'] })
    const pushText = `${push.summary} ${push.error ?? ''}`.toLowerCase()
    if (!push.ok && pushText.includes('destructive')) {
      pass('git push --force is refused by argv classification')
    } else {
      fail(`expected a force-push refusal, got ok=${push.ok} ${JSON.stringify(pushText)}`)
    }

    if (readFileSync(sentinel, 'utf8') === 'intact') {
      pass('nothing the refusals covered touched the filesystem')
    } else {
      fail('a refused command modified the filesystem')
    }
  }

  // --- 7. cmd metacharacters are refused, not quoted --------------------------
  {
    const r = await run({ command: 'npm', args: ['run', 'build & calc'] })
    const text = `${r.summary} ${r.error ?? ''}`.toLowerCase()
    if (!r.ok && text.includes('metacharacter')) {
      pass('a batch argument containing a cmd metacharacter is refused, not quoted')
    } else {
      fail(`expected a metacharacter refusal, got ok=${r.ok} ${JSON.stringify(text)}`)
    }
  }

  // --- 8. cwd outside the workspace is refused --------------------------------
  {
    const r = await run({ command: 'node', args: ['-e', 'process.stdout.write("x")'], cwd: 'C:\\Windows' })
    const text = `${r.summary} ${r.error ?? ''}`.toLowerCase()
    if (!r.ok && text.includes('escapes the allowed workspace roots')) {
      pass('a cwd outside the workspace is refused')
    } else {
      fail(`expected a cwd refusal, got ok=${r.ok} ${JSON.stringify(text)}`)
    }
  }

  // --- 9. cancellation stops the child ----------------------------------------
  {
    const controller = new AbortController()
    const promise = run(
      { command: 'node', args: ['-e', 'setTimeout(() => {}, 60000)'] },
      controller.signal
    )
    setTimeout(() => controller.abort(), 400)
    const r = await promise
    if (!r.ok && (r.failureKind === 'cancelled' || (r.error ?? '').toLowerCase().includes('cancel'))) {
      pass('cancelling the task stops the child instead of orphaning it')
    } else {
      fail(`expected cancellation, got ok=${r.ok} kind=${r.failureKind} ${r.error ?? ''}`)
    }
  }

  // --- 10. the audit trail recorded the real invocations ----------------------
  {
    const audit = runtime.auditFor('run_command', 100)
    if (audit.length >= 8 && audit.every((r) => typeof r.durationMs === 'number')) {
      pass(`${audit.length} invocations were audited through the runtime`)
    } else {
      fail(`expected >= 8 audited invocations, got ${audit.length}`)
    }
  }
} finally {
  console.log('')
  console.log(`--- ${passes} passed, ${failures} failed ---`)
  if (failures === 0) rmSync(workspace, { recursive: true, force: true })
  else console.log(`Artifacts kept for inspection: ${workspace}`)
  process.exitCode = failures === 0 ? 0 : 1
}