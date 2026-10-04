/**
 * Live check for the APINEX provider.
 *
 * This provider needed this check more than OpenRouter did, and the reason is
 * worth recording. APINEX advertises sixteen `free/`-prefixed models, but on a
 * plain API key eleven of them answer HTTP 402 "subscription only", and two ids
 * that appear in the provider's own material do not exist at all:
 *
 *   - the Quick start snippet on apinex.bond uses `free/gpt-5.6-luna`, which
 *     returns 404 "Model not found"; the real id is `free/gpt-6-luna`
 *   - the model card renders `free/deepseek-v4-pro-0...` truncated, and the
 *     untruncated-looking guess `free/deepseek-v4-pro` is also 404; the real id
 *     is `free/deepseek-v4-pro-0813`
 *
 * So this check asserts, against the live provider and through the same
 * `ModelGateway` the app uses:
 *
 *   1. every catalogue entry that claims to be APINEX resolves to a provider
 *      and a credential slot,
 *   2. the provider lists every wire id we ship,
 *   3. every shipped wire id returns real text (not an empty 200 - reasoning
 *      models will happily return `finish: "length"` and no content),
 *   4. every shipped wire id emits a real tool call, because the agent loop
 *      depends on it,
 *   5. the ids the provider's own docs advertise wrongly stay out.
 *
 * With no key the check reports SKIPPED and exits 0: an absent credential is a
 * missing test input, not a pass and not a failure.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APINEX_CREDENTIAL,
  APINEX_ENDPOINT,
  MODEL_CATALOG,
  ModelGateway,
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
  if (process.env['APINEX_API_KEY']) return process.env['APINEX_API_KEY']
  const file = join(process.cwd(), '.env')
  if (!existsSync(file)) return null
  return parseEnv(readFileSync(file, 'utf8'))['APINEX_API_KEY'] ?? null
}

const key = resolveKey()

if (!key) {
  console.log('[SKIP] no APINEX_API_KEY — set it in .env (see .env.example) or the environment')
  console.log('0 checks run against the provider.')
  process.exit(0)
}

const apinexEntries = MODEL_CATALOG.filter((m) => m.servedBy === 'apinex')

// ------------------------------------------------------------- catalogue

if (apinexEntries.length === 0) {
  fail('no APINEX entries exist in the catalogue')
} else {
  pass(`catalogue declares ${apinexEntries.length} APINEX models`)
}

for (const entry of apinexEntries) {
  if (!entry.providerModelId) {
    fail(`${entry.id} declares no wire id, so selecting it would send an id the API never sees`)
  } else if (entry.endpoint !== APINEX_ENDPOINT) {
    fail(`${entry.id} points at ${entry.endpoint ?? '(none)'}, not ${APINEX_ENDPOINT}`)
  } else if (entry.inputPerMillion !== 0 || entry.outputPerMillion !== 0) {
    fail(`${entry.id} is priced ${entry.inputPerMillion}/${entry.outputPerMillion} but was verified free`)
  } else if (!entry.pricingSource) {
    fail(`${entry.id} declares a price with no source, which is a guess presented as a price`)
  }
}
if (failures === 0 && apinexEntries.length > 0) {
  pass('every APINEX entry has a wire id, the right endpoint, price 0, and provenance')
}

// Ids the provider's own docs get wrong. If one of these ever becomes real, the
// check should fail and prompt a catalogue update rather than silently rot.
const KNOWN_NONEXISTENT = ['free/gpt-5.6-luna', 'free/deepseek-v4-pro']

// ------------------------------------------------------------- key check

const config: ModelConfig = {
  provider: 'apinex',
  endpoint: APINEX_ENDPOINT,
  model: apinexEntries[0]?.providerModelId ?? 'free/gpt-6-luna',
  credentialKey: APINEX_CREDENTIAL,
  dailyBudgetCoins: 25
}

const gateway = new ModelGateway({
  config,
  getApiKey: (slot) => (slot === APINEX_CREDENTIAL ? key : null),
  onUsage: () => undefined
})

const described = await gateway.describeKey()
if (!described.configured) {
  fail(`the gateway found no key in the ${APINEX_CREDENTIAL} slot: ${described.error}`)
} else if (!described.ok) {
  fail(`the provider rejected the stored key: ${described.error}`)
} else {
  pass('the provider accepted the key (GET /v1/models returned 200)')
}

if (described.label === null && described.limit === null && described.usage === null) {
  pass('key report claims no balance or label, because APINEX exposes neither')
} else {
  fail(`key report invented figures APINEX does not publish: ${JSON.stringify(described)}`)
}

// ------------------------------------------------------------ model list

const available = await gateway.listAvailable()
if (!available.ok) {
  fail(`could not list models: ${available.error}`)
} else {
  const listed = new Set(available.models.map((m) => m.id))
  const missing = apinexEntries
    .map((m) => m.providerModelId ?? m.id)
    .filter((id) => !listed.has(id))
  if (missing.length > 0) {
    fail(`the provider does not list: ${missing.join(', ')}`)
  } else {
    pass(`the provider lists all ${apinexEntries.length} shipped wire ids (${available.models.length} total)`)
  }

  for (const bogus of KNOWN_NONEXISTENT) {
    if (listed.has(bogus)) {
      fail(`${bogus} now exists - update the catalogue instead of leaving the note stale`)
    } else {
      pass(`${bogus} confirmed absent, so it is correctly not in the catalogue`)
    }
  }
}

// ------------------------------------------- real completion, per model

function gatewayFor(wireId: string): ModelGateway {
  return new ModelGateway({
    config: { ...config, model: wireId },
    getApiKey: (slot) => (slot === APINEX_CREDENTIAL ? key : null),
    onUsage: () => undefined
  })
}

/**
 * Ask for real text, escalating the token budget if the model comes back empty.
 *
 * These are reasoning models, and how much they think before answering is not
 * fixed: `free/deepseek-v4-pro-0813` answered the same question in 26 output
 * tokens on one run and spent a whole 512-token budget on hidden thinking on
 * the next, returning HTTP 200 with no content. A single small-budget sample
 * would call that model broken on a coin flip.
 *
 * This is not a softened assertion. If the model cannot produce text even with
 * 4096 tokens, that is still a failure and still reported as one.
 */
async function askForText(wireId: string, maxTokens: number): Promise<ReturnType<ModelGateway['complete']> extends Promise<infer T> ? T : never> {
  return gatewayFor(wireId).complete({
    messages: [{ role: 'user', content: 'What is 17 * 23? Reply with just the number.' }],
    temperature: 0,
    maxTokens
  })
}

const TEXT_BUDGETS = [512, 4096]

for (const entry of apinexEntries) {
  const wireId = entry.providerModelId ?? entry.id

  let answered = false
  let lastNote = ''
  for (const budget of TEXT_BUDGETS) {
    const result = await askForText(wireId, budget)
    if (!result.ok) {
      lastNote = `no completion: ${result.error}`
      continue
    }
    if (result.text.trim().length === 0) {
      lastNote = `empty content at ${budget} tokens (${result.usage.outputTokens} reasoning)`
      continue
    }
    const escalated = budget === TEXT_BUDGETS[0] ? '' : ` after needing ${budget} tokens`
    pass(`${wireId} answered ${JSON.stringify(result.text.trim().slice(0, 40))}${escalated}`)
    answered = true
    break
  }

  if (!answered) {
    fail(`${wireId} produced no text - ${lastNote}`)
  }
}

// ------------------------------------------------ real tool call, per model

for (const entry of apinexEntries) {
  const wireId = entry.providerModelId ?? entry.id

  let called = false
  let lastNote = ''
  for (const budget of TEXT_BUDGETS) {
    const result = await gatewayFor(wireId).complete({
      messages: [
        { role: 'user', content: 'Create a file named hello.txt containing the word hi. Use the tool.' }
      ],
      temperature: 0,
      maxTokens: budget,
      tools: [
        {
          type: 'function',
          function: {
            name: 'write_file',
            description: 'Write text to a file in the project.',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content']
            }
          }
        }
      ]
    })

    if (!result.ok) {
      lastNote = `refused: ${result.error}`
      continue
    }
    if (result.toolCalls.length === 0) {
      lastNote = `ignored the tool schema at ${budget} tokens`
      continue
    }
    const call = result.toolCalls[0]
    if (call?.malformed) {
      lastNote = 'emitted a tool call with unparseable arguments'
      continue
    }
    const escalated = budget === TEXT_BUDGETS[0] ? '' : ` after needing ${budget} tokens`
    pass(
      `${wireId} emitted a real tool call: ${call?.name}(${JSON.stringify(call?.arguments).slice(0, 60)})${escalated}`
    )
    called = true
    break
  }

  if (!called) {
    fail(`${wireId} made no usable tool call - ${lastNote}`)
  }
}

// -------------------------------------------------------------- accounting

{
  // A BYOK key must never be metered against the daily coin allowance.
  const budget = gateway.budget()
  if (budget.metered) {
    fail('a BYOK key is installed but the gateway is still metering the daily allowance')
  } else {
    pass(`BYOK is not metered - used ${budget.usedCoins}/${budget.budgetCoins} coins`)
  }
}

console.log(`\n${passes} passed, ${failures} failed against the live APINEX provider.`)
process.exit(failures === 0 ? 0 : 1)
