/**
 * Live check for the stage pipeline and the evidence gate.
 *
 * `agent-check.ts` already proves the loop drives a real model through real
 * tools. It calls `runAgentLoop` directly, though, so it never touches the
 * stages — which is where the "Task complete — no files were changed" defect
 * lived. This check exists to close exactly that gap.
 *
 * Two runs, both against a real provider with a real key:
 *
 *   1. an **implementation** request, which must produce a real file on disk and
 *      a non-empty `evidence.changedFiles`;
 *   2. a **read-only** question, which must complete *without* one — and must
 *      not be blocked for that.
 *
 * The second run is the one that matters most. An engine that demands mutation
 * from every request is as broken as one that accepts a no-op, and only a live
 * run tells you which mistake you have made.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionPolicy, ApprovalQueue } from '../../src/main/services/permissions/policy'
import { FileService } from '../../src/main/services/fs/files'
import { ToolRegistry } from '../../src/main/services/tools/registry'
import { ToolRuntime } from '../../src/main/services/tools/runtime'
import { buildFilesystemTools } from '../../src/main/services/tools/builtin/filesystem'
import { buildEnvironmentTools } from '../../src/main/services/tools/builtin/environment'
import { buildCommandTools } from '../../src/main/services/tools/builtin/command'
import { EnvironmentManager } from '../../src/main/services/env/manager'
import { ToolDetector } from '../../src/main/services/env/detect'
import { TerminalSessionManager } from '../../src/main/services/terminal/sessions'
import { ProcessSupervisor } from '../../src/main/services/proc/supervisor'
import {
  ModelGateway,
  OPENROUTER_CREDENTIAL,
  OPENROUTER_ENDPOINT,
  MODEL_BY_ID,
  type ModelConfig
} from '../../src/main/services/models/gateway'
import { parseEnv } from '../../src/main/services/models/dotenv'
import { runAgentLoop } from '../../src/main/services/agent/loop'
import { buildPipeline } from '../../src/main/services/agent/stages'
import { classifyIntent, requiresMutation, type TaskIntent } from '../../src/main/services/agent/evidence'
import type { AgentTask } from '../../src/shared/types'

let failures = 0
let passes = 0

function pass(message: string): void {
  passes += 1
  console.log(`[PASS] ${message}`)
}

function fail(message: string): void {
  failures += 1
  console.error(`[FAIL] ${message}`)
}

function env(): Record<string, string> {
  try {
    return parseEnv(readFileSync(join(process.cwd(), '.env'), 'utf8'))
  } catch {
    return {}
  }
}

const fileEnv = env()
const key = process.env['OPENROUTER_API_KEY'] ?? fileEnv['OPENROUTER_API_KEY'] ?? null

if (!key) {
  // A missing credential is a missing test input, not a passing test.
  console.log('SKIPPED: no OPENROUTER_API_KEY in the environment or .env.')
  process.exit(0)
}

const SYSTEM = [
  'You are Cryptoric Chan, the software engineering agent inside Cryptoric Agent.',
  'You have tools that read and write files in the project. Use them.',
  '',
  'Do the task with tools rather than describing how you would do it.',
  'Read before you write. Prefer one complete write over many small edits.',
  'Stop calling tools once the task is done, then answer in a sentence or two.',
  '',
  'Report only what a tool result told you. Never invent a file path.',
  'Be brief. Plain text, no markdown headings.'
].join('\n')

function makeTask(prompt: string, root: string): AgentTask {
  return {
    id: `live-${Date.now()}`,
    title: prompt.slice(0, 60),
    prompt,
    status: 'QUEUED',
    role: 'IMPLEMENTER',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectRoot: root,
    ownedPaths: [],
    changedPaths: [],
    error: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 }
  }
}

/**
 * Run one request through the real pipeline with a real gateway.
 *
 * The `model` dep is the same shape `index.ts` supplies, so what runs here is
 * the same code the app runs — not a stand-in.
 */
async function runPipeline(prompt: string, root: string): Promise<{ task: AgentTask; statuses: string[] }> {
  const policy = new PermissionPolicy()
  const approvals = new ApprovalQueue()
  const tools = new ToolRegistry()
  const files = new FileService(() => [root])

  // The full tool surface, as `index.ts` registers it. The first version of
  // this harness registered only the filesystem tools and the pipeline died at
  // `analyze` with "Unknown tool: inspect_environment" — which is exactly the
  // kind of thing only a live run tells you.
  const env = new EnvironmentManager({
    userDataDir: join(root, '.cryptoric'),
    managedRoot: join(root, '.cryptoric', 'tools'),
    scratchDir: join(root, '.cryptoric', 'tmp'),
    platform: process.platform,
    detector: new ToolDetector()
  })
  await env.init()

  tools.registerAll(
    buildEnvironmentTools({
      env,
      terminals: new TerminalSessionManager(env, {
        onChange: () => undefined,
        onOutput: () => undefined,
        onExit: () => undefined
      }),
      processes: new ProcessSupervisor(env, {
        onChange: () => undefined,
        onOutput: () => undefined
      }),
      authorize: async () => true
    })
  )
  tools.registerAll(buildFilesystemTools({ files, policy, getRoots: () => [root] }))
  tools.registerAll(buildCommandTools({ env, getRoots: () => [root] }))

  const runtime = new ToolRuntime({ registry: tools, policy, approvals })

  const approve = setInterval(() => {
    for (const request of approvals.list()) {
      const definition = tools.get(request.toolId)
      if (definition) policy.grantSession(definition.domain, 'allow')
      approvals.resolve(request.id, true)
    }
  }, 25)
  approve.unref?.()

  const config: ModelConfig = {
    provider: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    model: MODEL_BY_ID.get('space-bunny-alpha')?.providerModelId ?? 'stealth/space-bunny-alpha',
    credentialKey: OPENROUTER_CREDENTIAL,
    dailyBudgetCoins: 25
  }

  const gateway = new ModelGateway({
    config,
    getApiKey: () => key,
    onUsage: (usage, cost) => {
      console.log(`      usage: ${usage.inputTokens} in / ${usage.outputTokens} out, $${cost.toFixed(6)}`)
    },
    attemptTimeoutMs: 90_000
  })

  const task = makeTask(prompt, root)
  const statuses: string[] = []

  const project = {
    root,
    name: 'live',
    kind: 'node',
    manifests: [],
    requiredTools: [],
    packageManager: null,
    scripts: {},
    devServerPort: null,
    isGitRepo: false,
    detectedAt: new Date().toISOString()
  }

  const stages = buildPipeline({
    tools: { call: async () => ({ ok: true, summary: 'unused' }) },
    getProject: () => project as never,
    probeRuntime: async () => ({ state: 'present', version: 'n/a', detail: '' }),
    model: async (ctx, phase) => {
      // Match `runModelPhase` in `index.ts` exactly: `plan` is a plain
      // completion with **no tools**, so the model cannot write files during
      // planning. The first version of this harness handed it the tool registry
      // for both phases, and the model duly wrote `landing.html` during `plan` —
      // which made the implement stage's own snapshot see no change and the run
      // report BLOCKED. A harness that lies to the engine tests nothing.
      if (phase === 'plan') {
        const planned = await gateway.complete({
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: ctx.task.prompt }
          ],
          maxTokens: 700,
          signal: ctx.signal
        })
        return {
          ok: planned.ok,
          text: planned.text.trim() || 'No plan produced.',
          error: planned.error,
          tools: [],
          toolCalls: 0,
          failedToolCalls: 0,
          modelCalls: 1
        }
      }

      const outcome = await runAgentLoop(
        {
          complete: (request) => gateway.complete(request),
          listTools: () => tools.list(),
          invoke: async (toolId, args) => {
            const parsed = tools.parse(toolId, args)
            if (!parsed.ok) {
              return { ok: false, summary: 'Invalid arguments', error: parsed.error, failureKind: 'invalid-args' }
            }
            const result = await runtime.invoke(toolId, parsed.value, {
              grantedTier: 'elevated',
              signal: ctx.signal,
              projectRoot: root,
              workspaceRoots: [root]
            })
            return result
          },
          note: (message) => console.log(`      · ${message}`),
          record: () => undefined
        },
        {
          systemPrompt: SYSTEM,
          history: [],
          prompt: ctx.task.prompt,
          signal: ctx.signal
        }
      )
      return {
        ok: outcome.ok,
        text: outcome.text,
        error: outcome.error,
        tools: outcome.called,
        toolCalls: outcome.toolRecords.length,
        failedToolCalls: outcome.toolRecords.filter((r) => r.status !== 'COMPLETED').length,
        modelCalls: outcome.calls.length
      }
    }
  })

  try {
    for (const stage of stages) {
      statuses.push(stage.name)
      const outcome = await stage.run({
        task,
        signal: new AbortController().signal,
        maxTier: stage.maxTier,
        note: (message, status) => console.log(`      [${stage.name}] ${message} ${status ?? ''}`),
        call: async (toolId, args) => {
          const parsed = tools.parse(toolId, args)
          if (!parsed.ok) {
            return { ok: false, summary: 'Invalid arguments', error: parsed.error, failureKind: 'invalid-args' }
          }
          return runtime.invoke(toolId, parsed.value, {
            grantedTier: 'elevated',
            signal: new AbortController().signal,
            projectRoot: root,
            workspaceRoots: [root]
          })
        },
        workspaceRoots: [root],
        skillContext: '',
        selectedSkills: []
      })
      if (!outcome.continue) {
        task.status = (outcome.status === 'PARTIAL' ? 'BLOCKED' : outcome.status) ?? 'COMPLETED'
        console.log(`      → ${stage.name} ended: ${outcome.status ?? 'COMPLETED'}`)
        console.log(`        ${String(outcome.summary).split('\n')[0]}`)
        break
      }
    }
  } finally {
    clearInterval(approve)
  }

  return { task, statuses }
}

// Declared outside the `try` so the `finally` can actually reach it. Scoping it
// inside would have compiled to a cleanup that silently does nothing.
const scratchRoots: string[] = []

try {
  console.log('=== LIVE PIPELINE CHECK — real provider, real tools, real stages ===\n')

  // ---------------------------------------------------------------- run 1
  console.log('--- Run 1: an implementation request ---')
  const implRoot = mkdtempSync(join(tmpdir(), 'cryptoric-pipe-impl-'))
  scratchRoots.push(implRoot)
  writeFileSync(join(implRoot, 'README.md'), '# scratch\n', 'utf8')

  console.log(`Workspace: ${implRoot}`)
  console.log('Prompt: "Create a file named landing.html containing a heading"\n')

  const impl = await runPipeline('Create a file named landing.html containing a heading', implRoot)
  const implIntent = classifyIntent(impl.task.prompt) as TaskIntent

  console.log('')
  if (requiresMutation(implIntent)) {
    pass(`classified as ${implIntent}, which requires a change`)
  } else {
    fail(`classified as ${implIntent}, but the prompt asks for a file to be created`)
  }

  if (existsSync(join(implRoot, 'landing.html'))) {
    pass('landing.html exists on disk after the run')
  } else {
    fail('landing.html does NOT exist — the pipeline completed without writing it')
  }

  const changed = impl.task.evidence?.changedFiles ?? []
  if (changed.length > 0) {
    pass(`evidence.changedFiles is non-empty: ${changed.join(', ')}`)
  } else {
    fail('evidence.changedFiles is empty despite an implementation request')
  }

  if (impl.task.status === 'COMPLETED' && changed.length > 0) {
    pass('COMPLETED, and backed by observed change')
  } else {
    fail(`status is ${impl.task.status} with ${changed.length} changed file(s) — COMPLETED must be earned`)
  }

  if (impl.task.changedPaths.length > 0) {
    pass(`changedPaths populated: ${impl.task.changedPaths.join(', ')}`)
  } else {
    fail('changedPaths is empty even though a file was written')
  }

  // ---------------------------------------------------------------- run 2
  console.log('\n--- Run 2: a read-only question (must not be blocked) ---')
  const readRoot = mkdtempSync(join(tmpdir(), 'cryptoric-pipe-read-'))
  scratchRoots.push(readRoot)
  writeFileSync(join(readRoot, 'index.js'), 'export const answer = 42\n', 'utf8')

  console.log(`Workspace: ${readRoot}`)
  console.log('Prompt: "What does index.js export?"\n')

  const read = await runPipeline('What does index.js export?', readRoot)
  const readIntent = classifyIntent(read.task.prompt) as TaskIntent

  console.log('')
  if (!requiresMutation(readIntent)) {
    pass(`classified as ${readIntent}, which does not require a change`)
  } else {
    fail(`classified as ${readIntent} — a question must not demand edits`)
  }

  if (read.task.status === 'BLOCKED') {
    fail('a read-only question was BLOCKED — the engine is demanding mutation from everything')
  } else {
    pass(`read-only request finished as ${read.task.status}, not BLOCKED`)
  }

  if ((read.task.evidence?.changedFiles ?? []).length === 0) {
    pass('read-only request changed nothing, as it should')
  } else {
    fail('a read-only request modified the workspace')
  }
} finally {
  // Remove the scratch workspaces for real. Leaving temp directories behind
  // after a check is the kind of untidiness that eventually hides something.
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true })
  console.log(`\nCleaned up ${scratchRoots.length} scratch workspace(s).`)
}

console.log(`\n--- ${passes} passed, ${failures} failed ---`)
// `process.exitCode` rather than `process.exit()`, which truncates stdout on
// Windows and would swallow the report above.
process.exitCode = failures > 0 ? 1 : 0