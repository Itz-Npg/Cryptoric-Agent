/**
 * Live check for the agent loop.
 *
 * This is the check the product needed and did not have. The complaint was
 * "I sent a big prompt for making the website and it told me it did this and
 * stopped". Everything below is therefore a claim about *files on disk*, not
 * about what the model said it did:
 *
 *   1. the model is asked for a website,
 *   2. it requests a tool,
 *   3. that tool is the real `write_file` from the real registry, running under
 *      the real `ToolRuntime`,
 *   4. the file exists afterwards, with the content the model sent.
 *
 * A mocked model would prove nothing here, so there is none: the provider is
 * real, the key is the real key, and a run where the model does not call a
 * tool is reported as a failure rather than smoothed over.
 *
 * The key comes from the environment or a gitignored `.env`. With no key the
 * check reports SKIPPED and exits 0 — a missing credential is a missing test
 * input, not a passing test.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionPolicy, ApprovalQueue, DEFAULT_PERMISSION_RULES } from '../../src/main/services/permissions/policy'
import { FileService } from '../../src/main/services/fs/files'
import { ToolRegistry } from '../../src/main/services/tools/registry'
import { ToolRuntime } from '../../src/main/services/tools/runtime'
import { buildFilesystemTools } from '../../src/main/services/tools/builtin/filesystem'
import {
  ModelGateway,
  OPENROUTER_CREDENTIAL,
  OPENROUTER_ENDPOINT,
  APINEX_CREDENTIAL,
  APINEX_ENDPOINT,
  MODEL_BY_ID,
  type ModelConfig
} from '../../src/main/services/models/gateway'
import { parseEnv } from '../../src/main/services/models/dotenv'
import { runAgentLoop } from '../../src/main/services/agent/loop'
import { ConversationStore, deriveTitle } from '../../src/main/services/agent/conversation'
import type { ToolResult } from '../../src/main/services/tools/registry'
import type { ConversationTurn } from '../../src/shared/types'

let failures = 0
let passes = 0

function pass(message: string): void {
  passes++
  console.log(`[PASS] ${message}`)
}

function fail(message: string): void {
  failures++
  console.error(`[FAIL] ${message}`)
}

/**
 * Which provider to drive the loop with.
 *
 * Defaults to OpenRouter. `node agent-check.mjs apinex` runs the identical
 * loop against an APINEX model, because "the gateway can call it" and "the
 * agent loop can drive it end to end" are different claims. The provider is an
 * argument rather than an environment variable because npm runs scripts under
 * cmd.exe on Windows, where `VAR=value cmd` does not work.
 */
const PROVIDERS = {
  openrouter: {
    keyEnv: 'OPENROUTER_API_KEY',
    catalogId: 'space-bunny-alpha',
    endpoint: OPENROUTER_ENDPOINT,
    credential: OPENROUTER_CREDENTIAL
  },
  apinex: {
    keyEnv: 'APINEX_API_KEY',
    // The strongest of the five verified free models, and the one the
    // provider's own docs get wrong about the name of.
    catalogId: 'apinex-gpt-6-luna',
    endpoint: APINEX_ENDPOINT,
    credential: APINEX_CREDENTIAL
  },
  laguna: {
    keyEnv: 'OPENROUTER_API_KEY',
    catalogId: 'laguna-s-2.1-free',
    endpoint: OPENROUTER_ENDPOINT,
    credential: OPENROUTER_CREDENTIAL
  },
  ling: {
    keyEnv: 'OPENROUTER_API_KEY',
    // Burst rate-limited upstream, so this run also exercises the retry.
    catalogId: 'ling-3.1-flash',
    endpoint: OPENROUTER_ENDPOINT,
    credential: OPENROUTER_CREDENTIAL
  },
  'laguna-xs': {
    keyEnv: 'OPENROUTER_API_KEY',
    // A reasoning model that was rejected upstream in error on a 429 reading.
    // It emits hundreds of reasoning tokens before any text, which is the
    // strongest existing check that the loop tolerates an empty turn.
    catalogId: 'laguna-xs-2.1-free',
    endpoint: OPENROUTER_ENDPOINT,
    credential: OPENROUTER_CREDENTIAL
  }
} as const

const requested = process.argv[2] ?? process.env['CRYPTORIC_CHECK_PROVIDER'] ?? 'openrouter'
const providerName = requested as keyof typeof PROVIDERS
const provider = PROVIDERS[providerName]
if (!provider) {
  console.log(`[SKIP] unknown provider "${requested}"; use ${Object.keys(PROVIDERS).join(' or ')}`)
  process.exit(0)
}

const keyEnv: string = provider.keyEnv

function resolveKey(): string | null {
  if (process.env[keyEnv]) return process.env[keyEnv]
  const file = join(process.cwd(), '.env')
  if (!existsSync(file)) return null
  return parseEnv(readFileSync(file, 'utf8'))[keyEnv] ?? null
}

const key = resolveKey()

if (!key) {
  console.log(`[SKIP] no ${keyEnv} — set it in .env (see .env.example) or the environment`)
  console.log('0 checks run against the provider.')
  process.exit(0)
}

const workspace = mkdtempSync(join(tmpdir(), 'cryptoric-agent-live-'))
const conversation = new ConversationStore(join(workspace, 'conversation.json'))

const roots = [workspace]
const files = new FileService(() => roots)
const policy = new PermissionPolicy(DEFAULT_PERMISSION_RULES)
// Stand in for the developer clicking "Allow for this session". The grant is
// real and goes through the same policy object the app uses; what is simulated
// is only the click, because there is no human here.
policy.grantSession('fs.write', 'allow')
policy.grantSession('fs.read', 'allow')

const approvals = new ApprovalQueue()
const tools = new ToolRegistry()

/**
 * Stand in for the developer clicking "Allow for this session".
 *
 * Without this the run does not fail — it *hangs*, because `write_file` is
 * declared at the `ask` tier and waits on an approval nobody answers. Node then
 * exits 13 on an unsettled top-level await with no error message, which is a
 * miserable thing to debug and was exactly what this harness hit first.
 *
 * The grant is real and goes through the same `PermissionPolicy` the app uses.
 * Only the click is simulated, because there is no human here.
 */
const approvalPump = setInterval(() => {
  for (const request of approvals.list()) {
    const definition = tools.get(request.toolId)
    if (definition) policy.grantSession(definition.domain, 'allow')
    approvals.resolve(request.id, true)
    console.log(`      [approve] ${request.toolId} — allowed for this session`)
  }
}, 25)
tools.registerAll(buildFilesystemTools({ files, policy, getRoots: () => roots }))
const runtime = new ToolRuntime({ registry: tools, policy, approvals })

const gatewayConfig: ModelConfig = {
  // `laguna` and `ling` are OpenRouter reached through a different catalogue
  // entry, not a different provider kind.
  provider: providerName === 'apinex' ? 'apinex' : 'openrouter',
  endpoint: provider.endpoint,
  model: MODEL_BY_ID.get(provider.catalogId)?.providerModelId ?? provider.catalogId,
  credentialKey: provider.credential,
  dailyBudgetCoins: 25
}

const gateway = new ModelGateway({
  config: gatewayConfig,
  getApiKey: () => key,
  onUsage: (usage, cost) => {
    console.log(
      `      usage: ${usage.inputTokens} in / ${usage.outputTokens} out, $${cost.toFixed(6)}`
    )
  }
})

console.log(`provider: ${providerName} (${gatewayConfig.model} at ${provider.endpoint})`)

const recorded: ConversationTurn[] = []
const invoked: string[] = []

/** The same path the app uses: `AgentRuntime.invoke`, i.e. through the runtime. */
async function invoke(toolId: string, args: Record<string, unknown>): Promise<ToolResult> {
  invoked.push(toolId)
  const parsed = tools.parse(toolId, args)
  if (!parsed.ok) {
    return { ok: false, summary: 'Invalid arguments', error: parsed.error, failureKind: 'invalid-args' }
  }
  const result = await runtime.invoke(toolId, parsed.value, {
    grantedTier: 'elevated',
    signal: new AbortController().signal,
    projectRoot: workspace,
    workspaceRoots: roots
  })
  return result
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

try {
  console.log(`Workspace: ${workspace}`)
  console.log('Prompt: "Build a single-page website at index.html ..."')
  console.log('')

  // A crash inside the loop must produce a stack trace, not a silent exit
  // code. `process.on` is registered before anything can throw.
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaught exception:', err && err.stack ? err.stack : String(err))
  })
  process.on('unhandledRejection', (err) => {
    console.error('[FATAL] unhandled rejection:', err && (err as Error).stack ? (err as Error).stack : String(err))
  })

  const outcome = await runAgentLoop(
    {
      complete: (request) => gateway.complete(request),
      listTools: () => tools.list(),
      invoke,
      note: (message) => console.log(`      · ${message}`),
      record: (role, text, tool, ok) =>
        recorded.push({ id: `t${recorded.length}`, at: '', role, text, tool, ok })
    },
    {
      systemPrompt: SYSTEM,
      history: conversation.contextMessages(),
      prompt:
        'Build a single-page website in this project. Create index.html containing a full HTML5 document with a <title>, a <h1> heading, and at least one <p> paragraph. That single file is the whole deliverable — do not create any others.',
      signal: AbortSignal.timeout(180_000)
    }
  )

  console.log('')
  console.log(`Steps: ${outcome.steps}  tool calls: ${outcome.toolCalls}  -> ${invoked.join(', ') || '(none)'}`)
  console.log(`Reply: ${outcome.text.slice(0, 400)}`)
  console.log('')

  // --- the claims that matter ---------------------------------------------

  if (invoked.length > 0) {
    pass(`The model called a tool: ${invoked.join(', ')}`)
  } else {
    fail('The model never called a tool. It narrated instead of acting.')
  }

  const indexPath = join(workspace, 'index.html')
  if (existsSync(indexPath)) {
    pass('index.html exists on disk after the run')
  } else {
    fail('index.html does NOT exist. The agent did not create the file.')
  }

  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, 'utf8')
    const size = statSync(indexPath).size
    if (size > 0) {
      pass(`index.html is ${size} bytes`)
    } else {
      fail('index.html is empty.')
    }
    if (/<title>/i.test(html)) pass('index.html contains a <title>')
    else fail('index.html has no <title>')
    if (/<h1[\s>]/i.test(html)) pass('index.html contains an <h1>')
    else fail('index.html has no <h1>')
    if (/<p[\s>]/i.test(html)) pass('index.html contains a <p>')
    else fail('index.html has no <p>')
  }

  // Exactly one file: the prompt asked for one, and a model that ignored that
  // is a model worth knowing about.
  const extras = ['package.json', 'style.css', 'script.js', 'app.js', 'README.md'].filter((name) =>
    existsSync(join(workspace, name))
  )
  if (extras.length === 0) {
    pass('No extra files were created beyond what was asked for')
  } else {
    fail(`Created files that were not asked for: ${extras.join(', ')}`)
  }

  // --- the transcript -------------------------------------------------------

  const toolTurns = recorded.filter((t) => t.role === 'tool')
  const assistantTurns = recorded.filter((t) => t.role === 'assistant')
  if (toolTurns.length > 0) pass(`${toolTurns.length} tool result(s) recorded in the transcript`)
  else fail('No tool results were recorded in the transcript')
  if (assistantTurns.length > 0) pass('Chan produced a spoken reply')
  else fail('Chan produced no reply')

  if (outcome.ok) pass('The loop reported success')
  else fail(`The loop reported failure: ${outcome.error}`)

  // --- persistence ----------------------------------------------------------

  conversation.appendUser('what did you just do?')
  conversation.appendAssistant('I created index.html.')
  await conversation.flush()
  const reopened = new ConversationStore(join(workspace, 'conversation.json'))
  if (reopened.all().length >= 2) {
    pass(`Conversation survived a reload (${reopened.all().length} turns)`)
  } else {
    fail('Conversation did not survive a reload.')
  }

  const ctx = reopened.contextMessages()
  if (ctx.length > 0 && !ctx.some((m) => (m as { role: string }).role === 'tool')) {
    pass('Model context contains no orphan tool messages')
  } else {
    fail('Model context contains an orphan tool message.')
  }

  // --- title derivation -----------------------------------------------------

  const title = deriveTitle(
    'id="qv7k3r" ================================================\n\nBuild me a portfolio website'
  )
  if (title === 'Build me a portfolio website') {
    pass(`Pasted-prompt title is clean: "${title}"`)
  } else {
    fail(`Pasted-prompt title was not cleaned: "${title}"`)
  }
} catch (err) {
  fail(`The run threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
} finally {
  clearInterval(approvalPump)
  console.log('')
  console.log(`--- ${passes} passed, ${failures} failed ---`)
  // The workspace is removed only on a clean run, and the message says which
  // happened. Announcing "kept" after deleting it would be a small lie in the
  // one place someone goes to look at what the agent actually produced.
  if (failures === 0) {
    rmSync(workspace, { recursive: true, force: true })
    console.log('Clean run: the scratch workspace was removed.')
  } else {
    console.log(`Artifacts kept for inspection: ${workspace}`)
  }
  // `process.exitCode` rather than `process.exit()`: exit() truncates buffered
  // stdout on Windows when it is redirected to a file, which silently eats the
  // last few lines of a failing run.
  process.exitCode = failures === 0 ? 0 : 1
}