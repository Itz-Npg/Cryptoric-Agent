/**
 * Live check for the hosted model path.
 *
 * Unit tests prove the gateway decides correctly; this proves the thing
 * actually talks to the provider. Everything here goes through the same
 * `ModelGateway` the app uses — no mocked fetch, no stubbed response, no
 * "connection successful" banner.
 *
 * The key is read from the environment (or a local, gitignored `.env`). With no
 * key the check reports SKIPPED and exits 0: an absent credential is a missing
 * test input, not a passing test and not a failing one.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MODEL_BY_ID,
  MODEL_CATALOG,
  ModelGateway,
  OPENROUTER_CREDENTIAL,
  OPENROUTER_ENDPOINT,
  type ModelConfig
} from '../../src/main/services/models/gateway'
import { parseEnv } from '../../src/main/services/models/dotenv'

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

/** The key the app would read at boot, resolved the same way it resolves it. */
function resolveKey(): string | null {
  if (process.env['OPENROUTER_API_KEY']) return process.env['OPENROUTER_API_KEY']
  const file = join(process.cwd(), '.env')
  if (!existsSync(file)) return null
  return parseEnv(readFileSync(file, 'utf8'))['OPENROUTER_API_KEY'] ?? null
}

const key = resolveKey()

if (!key) {
  console.log('[SKIP] no OPENROUTER_API_KEY — set it in .env (see .env.example) or the environment')
  console.log('0 checks run against the provider.')
  process.exit(0)
}

const config: ModelConfig = {
  provider: 'openrouter',
  endpoint: OPENROUTER_ENDPOINT,
  model: MODEL_BY_ID.get('space-bunny-alpha')?.providerModelId ?? 'stealth/space-bunny-alpha',
  credentialKey: OPENROUTER_CREDENTIAL,
  dailyBudgetCoins: 25
}

const gateway = new ModelGateway({
  config,
  getApiKey: (slot) => (slot === OPENROUTER_CREDENTIAL ? key : null),
  onUsage: () => undefined
})

// ---------------------------------------------------------------- catalogue

const declared = MODEL_BY_ID.get('space-bunny-alpha')
if (!declared) {
  fail('Space Bunny Alpha is missing from the catalogue')
} else if (!declared.providerModelId || !declared.servedBy) {
  fail('Space Bunny Alpha declares no provider, so selecting it would not reach anything')
} else {
  pass(`catalogue entry is wired to ${declared.providerModelId} via ${declared.servedBy}`)
}

// Every other OpenRouter entry we ship, verified the same way. A catalogue is
// only worth anything if each row works, and these ids came from the provider's
// catalogue rather than from a guess, so they still have to answer.
const otherOpenRouter = MODEL_CATALOG.filter((m) => m.servedBy === 'openrouter' && m.id !== 'space-bunny-alpha')

// ------------------------------------------------------------- key check

const described = await gateway.describeKey()
if (!described.configured) {
  fail(`the gateway found no key in the ${OPENROUTER_CREDENTIAL} slot: ${described.error}`)
} else if (!described.ok) {
  fail(`the provider rejected the stored key: ${described.error}`)
} else {
  const parts = [`label=${described.label ?? 'unnamed'}`]
  if (described.isFreeTier !== null) parts.push(`freeTier=${described.isFreeTier}`)
  if (described.limit !== null) parts.push(`limit=${described.limit}`)
  if (described.limitRemaining !== null) parts.push(`remaining=${described.limitRemaining}`)
  pass(`the provider accepted the key (${parts.join(', ')})`)
}

// ------------------------------------------------------------ model list

const available = await gateway.listAvailable()
if (!available.ok) {
  fail(`could not list models: ${available.error}`)
} else if (!available.models.some((m) => m.id === config.model)) {
  fail(`the provider does not offer ${config.model} (${available.models.length} models listed)`)
} else {
  pass(`the provider lists ${config.model} among ${available.models.length} models`)
}

// ------------------------------------------------------- real completion

const result = await gateway.complete({
  messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  temperature: 0,
  maxTokens: 24
})

if (!result.ok) {
  fail(`a real completion failed: ${result.error}`)
} else if (result.text.trim().toLowerCase() !== 'pong') {
  fail(`the model answered ${JSON.stringify(result.text.slice(0, 80))} instead of "pong"`)
} else {
  pass(`a real completion returned "${result.text.trim()}" from ${result.model}`)
}

if (result.usage.inputTokens > 0 && result.usage.outputTokens > 0) {
  pass(`usage came back from the provider — ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`)
} else {
  fail(`the provider reported no token usage (${JSON.stringify(result.usage)})`)
}

// ------------------------------------------ every shipped OpenRouter entry

for (const model of otherOpenRouter) {
  const wireId = model.providerModelId ?? model.id
  const listed = available.ok && available.models.some((m) => m.id === wireId)
  if (!listed) {
    fail(`the provider does not offer ${wireId}`)
    continue
  }

  const entryGateway = new ModelGateway({
    config: { ...config, model: wireId },
    getApiKey: (slot) => (slot === OPENROUTER_CREDENTIAL ? key : null),
    onUsage: () => undefined
  })

  let answered = false
  let lastNote = ''
  // `inclusionai/ling-3.1-flash` is burst rate-limited upstream, so a single
  // small sample is not evidence about the model. Escalate before judging it.
  for (const budget of [512, 4096]) {
    const result = await entryGateway.complete({
      messages: [{ role: 'user', content: 'What is 17 * 23? Reply with just the number.' }],
      temperature: 0,
      maxTokens: budget
    })
    if (!result.ok) {
      lastNote = result.error ?? 'no completion'
      continue
    }
    if (result.text.trim().length === 0) {
      lastNote = `empty content at ${budget} tokens`
      continue
    }
    const cost = result.usage.estimatedCostUsd
    if (cost !== 0) {
      fail(`${wireId} is catalogued as free but a completion cost $${cost}`)
    } else {
      pass(`${wireId} answered ${JSON.stringify(result.text.trim().slice(0, 30))} at cost $0`)
    }
    answered = true
    break
  }
  if (!answered) {
    fail(`${wireId} produced no text - ${lastNote}`)
  }
}

// -------------------------------------------------------------- accounting

const budget = gateway.budget()
if (budget.metered) {
  fail('a BYOK key is installed but the gateway is still metering the daily allowance')
} else {
  pass(`BYOK is not metered — used ${budget.usedCoins}/${budget.budgetCoins} coins, modelled spend $${budget.spendUsd}`)
}

console.log(`\n${passes} passed, ${failures} failed against the live provider.`)
process.exit(failures === 0 ? 0 : 1)