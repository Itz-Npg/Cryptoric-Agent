/**
 * Model gateway.
 *
 * A single OpenAI-compatible client. That covers the cases that actually matter
 * for a local-first agent: Ollama, LM Studio, llama.cpp servers, vLLM, and any
 * hosted OpenAI-compatible API the user points at with their own key.
 *
 * Three rules, because an agent that silently spends money is not a product:
 *
 *  1. **No request without an explicit model.** The active selection is resolved
 *     before every call and reported back to the UI.
 *  2. **Budget is enforced, not advisory.** `checkBudget` refuses a call that
 *     would cross the configured ceiling, and the refusal is surfaced to the user
 *     rather than swallowed.
 *  3. **Cost is an estimate from a declared price table.** Unknown models report
 *     `null` cost rather than a fabricated number.
 *
 * Keys are read from the encrypted credential store; they are never written to
 * the plain state file or sent anywhere except the configured endpoint.
 */

import type { UsageRecord } from '@shared/types'

export type ProviderKind = 'none' | 'ollama' | 'openai-compatible' | 'openrouter' | 'apinex'

export interface ModelDescriptor {
  id: string
  label: string
  provider: string
  /** `local` models cost nothing; `hosted` models are metered. */
  kind: 'local' | 'hosted'
  /** USD per 1M input tokens, or null when unpriced. */
  inputPerMillion: number | null
  outputPerMillion: number | null
  contextWindow: number | null
  /**
   * Identifier sent on the wire. Most models are addressed by their own id;
   * hosted catalogues namespace them (`stealth/space-bunny-alpha`), so that
   * value lives here instead of being guessed.
   */
  providerModelId?: string
  /** Provider that actually serves this model. Selecting it configures the gateway. */
  servedBy?: ProviderKind
  /** Base URL, including the version prefix, when it differs from the configured one. */
  endpoint?: string
  /**
   * Where the declared prices came from. A price without provenance is a guess,
   * and a guess presented as a price is how an agent silently overspends.
   */
  pricingSource?: string
  /** ISO date the prices were read from that source. */
  pricingFetchedAt?: string
}

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1'

/** Credential-store slot for the user's own OpenRouter key (BYOK). */
export const OPENROUTER_CREDENTIAL = 'openrouter-api-key'

/** APINEX base URL, version prefix included. OpenAI-compatible on the wire. */
export const APINEX_ENDPOINT = 'https://api.apinex.bond/v1'

/** Credential-store slot for the user's own APINEX key (BYOK). */
export const APINEX_CREDENTIAL = 'apinex-api-key'

/**
 * Which credential slot belongs to which provider.
 *
 * The slot has to move with the provider: sending a previous provider's key to
 * a new endpoint would leak it. Providers absent from this map use the generic
 * `model-api-key` slot when they need one at all.
 */
export const PROVIDER_CREDENTIAL_SLOTS: Partial<Record<ProviderKind, string>> = {
  openrouter: OPENROUTER_CREDENTIAL,
  apinex: APINEX_CREDENTIAL
}

/**
 * Catalogue. Local models are discovered at runtime from the endpoint; this
 * list is what the UI offers when no endpoint is reachable, and what provides
 * pricing for hosted models.
 *
 * Declared after the endpoint constants above because entries reference them:
 * a `const` read before its declaration throws at import time.
 */
export const MODEL_CATALOG: ModelDescriptor[] = [
  {
    id: 'local-default',
    label: 'Local model',
    provider: 'Ollama / LM Studio',
    kind: 'local',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: null
  },
  {
    id: 'space-bunny-alpha',
    label: 'Space Bunny Alpha',
    provider: 'OpenRouter',
    kind: 'hosted',
    // OpenRouter reports prompt "0" and completion "0" for this model, i.e. the
    // provider serves it at no charge. That is a declared price, not an absence
    // of one, so it prices as 0 rather than as unknown. Verified against
    // GET https://openrouter.ai/api/v1/models on 2026-10-04.
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 1_000_000,
    providerModelId: 'stealth/space-bunny-alpha',
    servedBy: 'openrouter',
    endpoint: 'https://openrouter.ai/api/v1',
    pricingSource: 'openrouter.ai /api/v1/models',
    pricingFetchedAt: '2026-10-04'
  },
  {
    id: 'apodex-1.1-mini-free',
    label: 'Apodex 1.1 Mini (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 262_144,
    providerModelId: 'apodex/apodex-1.1-mini:free',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion and tool call',
    pricingFetchedAt: '2026-10-05'
  },
  {
    id: 'ling-3.0-flash-sante-free',
    label: 'Ling 3.0 Flash Sante (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 262_144,
    providerModelId: 'inclusionai/ling-3.0-flash-sante:free',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion and tool call',
    pricingFetchedAt: '2026-10-05'
  },
  {
    id: 'qwen3.8-27b-free',
    label: 'Qwen 3.8 27B (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 262_144,
    providerModelId: 'qwen/qwen3.8-27b:free',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion and tool call',
    pricingFetchedAt: '2026-10-05'
  },
  {
    id: 'dots-3-note-preview-free',
    label: 'Dots3 Note Preview (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 512_000,
    providerModelId: 'dots-studio/dots-3-note-preview:free',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion and tool call',
    pricingFetchedAt: '2026-10-05'
  },
  {
    id: 'lfm-2.5-2.6b-free',
    label: 'LFM 2.5 2.6B (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 65_536,
    providerModelId: 'liquid/lfm-2.5-2.6b:free',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion and tool call',
    pricingFetchedAt: '2026-10-05'
  },
  {
    id: 'nemotron-3.5-lightning-free',
    label: 'Nemotron 3.5 Lightning (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 1_000_000,
    providerModelId: 'nvidia/nemotron-3.5-lightning:free',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion and tool call',
    pricingFetchedAt: '2026-10-05'
  },
  {
    id: 'north-mini-code-free',
    label: 'North Mini Code (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 256_000,
    providerModelId: 'cohere/north-mini-code:free',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion and tool call',
    pricingFetchedAt: '2026-10-05'
  },
  {
    id: 'nemotron-3-ultra-free',
    label: 'Nemotron 3 Ultra (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 1_000_000,
    providerModelId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion and tool call',
    pricingFetchedAt: '2026-10-05'
  },
  {
    id: 'nemotron-3-super-free',
    label: 'Nemotron 3 Super (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 262_144,
    providerModelId: 'nvidia/nemotron-3-super-120b-a12b:free',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion and tool call',
    pricingFetchedAt: '2026-10-05'
  },
  {
    id: 'nemotron-3-nano-omni-free',
    label: 'Nemotron 3 Nano Omni (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 256_000,
    // A reasoning model: it returns HTTP 200 with no text when the token budget
    // is small, so the gateway's escalation is what makes it usable at all.
    providerModelId: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion and tool call',
    pricingFetchedAt: '2026-10-05'
  },
  {
    id: 'laguna-s-2.1-free',
    label: 'Laguna S 2.1 (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    // OpenRouter reports prompt "0" and completion "0", and a real completion
    // came back with usage.cost 0 on 2026-10-04.
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 262_144,
    providerModelId: 'poolside/laguna-s-2.1:free',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion',
    pricingFetchedAt: '2026-10-04'
  },
  {
    id: 'ling-3.1-flash',
    label: 'Ling 3.1 Flash (free)',
    provider: 'OpenRouter',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: 262_144,
    // Not suffixed `:free`, but OpenRouter prices it 0/0 and a real completion
    // came back with usage.cost 0. It is burst rate-limited upstream: four
    // consecutive calls returned HTTP 429 "temporarily rate-limited" and a
    // fifth, 30s later, succeeded. The gateway retries those rather than
    // dropping the run, which is what makes this entry usable.
    providerModelId: 'inclusionai/ling-3.1-flash',
    servedBy: 'openrouter',
    endpoint: OPENROUTER_ENDPOINT,
    pricingSource: 'openrouter.ai /api/v1/models + live completion',
    pricingFetchedAt: '2026-10-04'
  },
  {
    id: 'apinex-gpt-6-luna',
    label: 'GPT 6 Luna (APINEX, free)',
    provider: 'APINEX',
    kind: 'hosted',
    // Price 0 is measured, not assumed: on a plain API key these five returned
    // real completions while eleven other `free/`-prefixed ids answered HTTP 402
    // "subscription only". Verified 2026-10-04.
    inputPerMillion: 0,
    outputPerMillion: 0,
    // The provider's model cards claim a 1M window, but GET /v1/models returns
    // no context_length and there is no other API to check against, so this
    // stays null rather than repeating an unverifiable number as fact.
    contextWindow: null,
    providerModelId: 'free/gpt-6-luna',
    servedBy: 'apinex',
    endpoint: APINEX_ENDPOINT,
    pricingSource: 'apinex.bond/v1/models + live completion',
    pricingFetchedAt: '2026-10-04'
  },
  {
    id: 'apinex-glm-5.3-flash',
    label: 'GLM 5.3 Flash (APINEX, free)',
    provider: 'APINEX',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: null,
    providerModelId: 'free/glm-5.3-flash',
    servedBy: 'apinex',
    endpoint: APINEX_ENDPOINT,
    pricingSource: 'apinex.bond/v1/models + live completion',
    pricingFetchedAt: '2026-10-04'
  },
  {
    id: 'apinex-deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash (APINEX, free)',
    provider: 'APINEX',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: null,
    providerModelId: 'free/deepseek-v4.1-flash',
    servedBy: 'apinex',
    endpoint: APINEX_ENDPOINT,
    pricingSource: 'apinex.bond/v1/models + live completion',
    pricingFetchedAt: '2026-10-04'
  },
  {
    id: 'apinex-deepseek-v4-pro',
    label: 'DeepSeek V4 Pro (APINEX, free)',
    provider: 'APINEX',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: null,
    // The real id carries a date suffix. The bare `free/deepseek-v4-pro` that
    // the provider's own model card shows in truncated form answers HTTP 404
    // "Model not found", so shipping the card's text verbatim would have put a
    // 400-on-first-use entry in the picker.
    providerModelId: 'free/deepseek-v4-pro-0813',
    servedBy: 'apinex',
    endpoint: APINEX_ENDPOINT,
    pricingSource: 'apinex.bond/v1/models + live completion',
    pricingFetchedAt: '2026-10-04'
  },
  {
    id: 'apinex-mimo-v2.6-pro',
    label: 'Mimo V2.6 Pro (APINEX, free)',
    provider: 'APINEX',
    kind: 'hosted',
    inputPerMillion: 0,
    outputPerMillion: 0,
    contextWindow: null,
    providerModelId: 'free/mimo-v2.6-pro',
    servedBy: 'apinex',
    endpoint: APINEX_ENDPOINT,
    pricingSource: 'apinex.bond/v1/models + live completion',
    pricingFetchedAt: '2026-10-04'
  },
  {
    id: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    provider: 'Zhipu',
    kind: 'hosted',
    inputPerMillion: 0.2,
    outputPerMillion: 0.8,
    contextWindow: 128_000
  },
  {
    id: 'deepseek-coder',
    label: 'DeepSeek Coder',
    provider: 'DeepSeek',
    kind: 'hosted',
    inputPerMillion: 0.14,
    outputPerMillion: 0.28,
    contextWindow: 64_000
  }
]

/**
 * OpenRouter free models that were offered and deliberately left out.
 *
 * Recorded here rather than silently dropped, because "why is this one missing"
 * is otherwise unanswerable and the obvious next move is to add it and ship a
 * row that 403s on first use. Each was exercised against the live API on
 * 2026-10-05 with the owner's key.
 */
export const REJECTED_OPENROUTER_MODELS: { id: string; reason: string }[] = [
  {
    id: 'thinkingmachines/inkling:free',
    reason: 'HTTP 403 "only available on agentic harnesses" — refused on every call'
  },
  {
    id: 'thinkingmachines/inkling-small:free',
    reason: 'HTTP 403 "only available on agentic harnesses" — refused on every call'
  },
  {
    id: 'inception/mercury-decide:free',
    reason: 'POST /alpha/decisions returns HTTP 404 — the decisions endpoint does not exist'
  },
  {
    id: 'respan/span-01-lite:free',
    reason: 'POST /alpha/decisions returns HTTP 404 — the decisions endpoint does not exist'
  },
  {
    id: 'google/gemma-4-26b-a4b-it:free',
    reason: 'Sustained HTTP 429 upstream rate limiting across repeated attempts'
  },
  {
    id: 'google/gemma-4-31b-it:free',
    reason: 'Sustained HTTP 429 upstream rate limiting across repeated attempts'
  },
  {
    id: 'poolside/laguna-xs-2.1:free',
    reason: 'Sustained HTTP 429 upstream rate limiting across repeated attempts'
  },
  {
    id: 'nvidia/nemotron-3.5-content-safety:free',
    reason: 'Answers as a moderation classifier and never emits tool calls, so it cannot drive the agent'
  },
  {
    id: 'liquid/lfm-2.5-embedding-350m:free',
    reason: 'Embeddings model — works (1024 dims) but /api/v1/embeddings is not chat/completions'
  },
  {
    id: 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
    reason: 'Embeddings model — works (2048 dims) but /api/v1/embeddings is not chat/completions'
  },
  {
    id: 'nvidia/llama-nemotron-rerank-vl-1b-v2:free',
    reason: 'Rerank model — works but /api/v1/rerank is not chat/completions'
  }
]

export const MODEL_BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]))

/** Wire identifiers -> descriptor, so a namespaced id prices exactly like its UI key. */
export const MODEL_BY_WIRE = new Map(MODEL_CATALOG.map((m) => [m.providerModelId ?? m.id, m]))

export function findModel(idOrWireId: string): ModelDescriptor | undefined {
  return MODEL_BY_ID.get(idOrWireId) ?? MODEL_BY_WIRE.get(idOrWireId)
}

/** One coin = one cent of modelled cost. Keeps the balance legible. */
export const USD_PER_COIN = 0.01

export interface ModelConfig {
  /** `none` disables the gateway entirely; the agent stays deterministic-only. */
  provider: ProviderKind
  endpoint: string
  model: string
  /** Credential-store key holding the API key. */
  credentialKey: string | null
  /** Daily ceiling in coins. */
  dailyBudgetCoins: number
  /** Optional `HTTP-Referer` for OpenRouter's public attribution headers. */
  referer?: string
}

export interface BudgetState {
  usedCoins: number
  budgetCoins: number
  /** ISO date (UTC) the counter applies to. */
  day: string
  exceeded: boolean
  /**
   * False when the user's own key pays the provider. Cryptoric-funded usage
   * draws the daily allowance; a key the user typed does not — the user is
   * already paying the provider directly, so charging them twice is a bug.
   */
  metered: boolean
  /** USD modelled today, metered or not. Kept because it is the real number. */
  spendUsd: number
}

/**
 * A tool the model may call, in the OpenAI function-calling shape.
 *
 * `parameters` is JSON Schema. Passing a loose schema is how a model invents
 * arguments the tool then rejects, so these are built from the tool's real zod
 * schema rather than hand-written prose.
 */
export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** A tool call the model asked for. `arguments` is parsed, never a raw string. */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  /** True when the model's `arguments` was not valid JSON. */
  malformed: boolean
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /**
   * Tool calls the assistant requested. Must be echoed back verbatim alongside
   * the matching `tool` messages, or providers reject the turn as inconsistent.
   */
  tool_calls?: RawToolCall[]
  /** Links a `tool` message to the call it answers. */
  tool_call_id?: string
}

/** Wire shape of a tool call, as it must be sent back to the provider. */
export interface RawToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface CompletionRequest {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /**
   * Advertised tools. Omitted for a plain chat turn; the agent loop passes the
   * registry so the model can act rather than only talk.
   */
  tools?: ToolSpec[]
}

export interface CompletionResult {
  ok: boolean
  text: string
  usage: UsageRecord
  /** Model the gateway actually called. */
  model: string
  error: string | null
  /** Tool calls the model requested. Empty for a plain chat turn. */
  toolCalls: ToolCall[]
  /**
   * The assistant message to append to the conversation, carrying `tool_calls`
   * in wire form so the next turn can answer them.
   */
  assistantMessage: ChatMessage | null
}

export interface ModelGatewayDeps {
  config: ModelConfig
  /**
   * Resolve the API key for a credential-store slot. The gateway passes the slot
   * its configuration names rather than a hardcoded one, because a provider
   * switch has to move to that provider's key — reusing the previous provider's
   * key is how a request ends up authenticated as somebody else's account.
   */
  getApiKey(credentialKey: string | null): string | null
  onUsage: (usage: UsageRecord, costUsd: number) => void
  /**
   * Optional timeline note. Used to make a retry visible: a silent re-issued
   * request is indistinguishable from a hang.
   */
  note?: (message: string) => void
}

/**
 * Estimate cost from the declared price table.
 *
 * Returns `null` when the model is unpriced — an unpriced model must not be
 * reported as free, because that would silently understate the budget.
 */
export function estimateCostUsd(modelId: string, usage: UsageRecord): number | null {
  const model = findModel(modelId)
  if (!model) return null
  if (model.kind === 'local') return 0
  const inputRate = model.inputPerMillion
  const outputRate = model.outputPerMillion
  if (inputRate === null || outputRate === null) return null
  const billableInput = Math.max(0, usage.inputTokens - usage.cachedTokens)
  return (billableInput / 1_000_000) * inputRate + (usage.outputTokens / 1_000_000) * outputRate
}

export function toCoins(usd: number): number {
  return Math.round(usd / USD_PER_COIN)
}

export class ModelGateway {
  private usage: UsageRecord = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 }
  private dayStamp = todayUtc()
  private usedTodayUsd = 0

  constructor(private deps: ModelGatewayDeps) {}

  getConfig(): ModelConfig {
    return this.deps.config
  }

  setConfig(config: ModelConfig): void {
    this.deps.config = config
  }

  getUsage(): UsageRecord {
    return { ...this.usage }
  }

  /** True when the endpoint is authenticated with the user's own key (BYOK). */
  usesUserKey(): boolean {
    return this.deps.getApiKey(this.deps.config.credentialKey) !== null
  }

  /** Current balance. Rolls over at UTC midnight. */
  budget(): BudgetState {
    const today = todayUtc()
    if (today !== this.dayStamp) {
      this.dayStamp = today
      this.usedTodayUsd = 0
    }
    const metered = !this.usesUserKey()
    const usedCoins = metered ? toCoins(this.usedTodayUsd) : 0
    return {
      usedCoins,
      budgetCoins: this.deps.config.dailyBudgetCoins,
      day: today,
      exceeded: metered && usedCoins >= this.deps.config.dailyBudgetCoins,
      metered,
      spendUsd: Number(this.usedTodayUsd.toFixed(6))
    }
  }

  isEnabled(): boolean {
    return this.deps.config.provider !== 'none'
  }

  /**
   * Request headers for the configured provider.
   *
   * OpenRouter is OpenAI-compatible on the wire but wants two extra headers for
   * public attribution. `HTTP-Referer` is only sent when the user configured
   * one — inventing a domain to fill the field would be a lie in an HTTP header
   * that gets logged.
   */
  /**
   * POST with a bounded retry for transient failures.
   *
   * Measured need: OpenRouter's free `inclusionai/ling-3.1-flash` returned HTTP
   * 429 "temporarily rate-limited upstream" on four consecutive calls and then
   * succeeded once ~30s of backoff had passed. Without a retry the agent loop
   * treats a provider failure as the end of the run, so one burst of rate
   * limiting would look to the user exactly like the model giving up mid-task.
   *
   * The waits are the measured ones, not a guess: a plain 1/2/4 second ladder
   * gave up at 7 seconds total and still failed.
   *
   * Only 429 and 5xx are retried. A retry re-issues the request, so it is
   * surfaced as a note rather than done silently.
   */
  private async fetchWithRetry(
    url: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<Response> {
    const backoffMs = [3000, 10_000, 25_000]
    const maxAttempts = backoffMs.length + 1
    let last: Response | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) break
      const res = await fetch(url, {
        method: 'POST',
        headers,
        signal: signal ?? AbortSignal.timeout(120_000),
        body: JSON.stringify(payload)
      })

      if (res.ok) return res

      const transient = res.status === 429 || res.status >= 500
      last = res
      if (!transient || attempt === maxAttempts) return res

      // Release the connection; an unread body holds the socket open.
      await res.body?.cancel().catch(() => undefined)

      // Honour a server-sent Retry-After when it is a sane number of seconds,
      // otherwise the measured ladder.
      const header = Number(res.headers.get('retry-after'))
      const fallback = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 5000
      const waitMs = Number.isFinite(header) && header > 0 && header <= 60 ? header * 1000 : fallback
      this.deps.note?.(
        `model endpoint returned ${res.status}, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1} of ${maxAttempts})`
      )
      await new Promise((r) => setTimeout(r, waitMs))
    }

    return last ?? new Response('request aborted', { status: 499 })
  }

  private headers(opts: { json?: boolean } = {}): Record<string, string> {
    const { provider, referer } = this.deps.config
    const headers: Record<string, string> = {}
    if (opts.json) headers['Content-Type'] = 'application/json'
    const key = this.deps.getApiKey(this.deps.config.credentialKey)
    if (key) headers['Authorization'] = `Bearer ${key}`
    if (provider === 'openrouter') {
      headers['X-Title'] = 'Cryptoric Agent'
      if (referer) headers['HTTP-Referer'] = referer
    }
    return headers
  }

  /**
   * Refuse a call that would cross the budget.
   *
   * The check is *before* the request because a request that succeeds and then
   * trips the ceiling is money already spent.
   */
  private checkBudget(): { allowed: boolean; reason: string | null } {
    if (this.deps.config.provider === 'none') {
      return { allowed: false, reason: 'No model provider is configured. Set one in Settings.' }
    }
    const state = this.budget()
    if (state.exceeded) {
      return {
        allowed: false,
        reason: `Daily budget reached (${state.usedCoins} / ${state.budgetCoins} coins). Raise it in Settings or wait for the next day.`
      }
    }
    return { allowed: true, reason: null }
  }

  /**
   * List models available at the configured endpoint.
   *
   * Local servers expose `/v1/models`; a failure is reported rather than hidden,
   * because "no models" and "endpoint unreachable" are different problems.
   */
  async listAvailable(): Promise<{ ok: boolean; models: { id: string }[]; error: string | null }> {
    const { provider, endpoint } = this.deps.config
    if (provider === 'none') {
      return { ok: false, models: [], error: 'No model provider is configured.' }
    }
    const url = `${endpoint.replace(/\/$/, '')}/models`
    try {
      const headers = this.headers()

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) })
      if (!res.ok) return { ok: false, models: [], error: `Endpoint returned ${res.status}.` }
      const body = (await res.json()) as {
        data?: { id?: string }[]
        models?: { id?: string; name?: string }[]
      }
      const raw: { id?: string; name?: string }[] = body.data ?? body.models ?? []
      return {
        ok: true,
        models: raw
          .map((m) => ({ id: m.id ?? m.name ?? '' }))
          .filter((m) => m.id.length > 0),
        error: null
      }
    } catch (err) {
      return {
        ok: false,
        models: [],
        error: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  /** Send a chat completion through the OpenAI-compatible endpoint. */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const budget = this.checkBudget()
    if (!budget.allowed) {
      // `allowed: false` always carries a reason; the fallback keeps the
      // failure report non-empty rather than handing back a bare `ok: false`.
      return failed(
        this.getUsage(),
        this.deps.config.model,
        budget.reason ?? 'The model call was refused by the gateway.'
      )
    }

    const { endpoint, model, provider } = this.deps.config
    const url = `${endpoint.replace(/\/$/, '')}/chat/completions`

    const headers = this.headers({ json: true })
    if (provider === 'ollama') headers['X-Return-Format'] = 'openai'

    // Tools are only advertised when the caller actually wants them. Sending an
    // empty `tools` array is rejected by several OpenAI-compatible servers.
    const payload: Record<string, unknown> = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 2048,
      stream: false
    }
    if (request.tools && request.tools.length > 0) {
      payload['tools'] = request.tools
      payload['tool_choice'] = 'auto'
    }

    try {
      const res = await this.fetchWithRetry(url, headers, payload, request.signal)

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300)
        return failed(this.getUsage(), model, `Model endpoint returned ${res.status}. ${detail}`)
      }

      const body = (await res.json()) as {
        choices?: {
          message?: {
            content?: string | null
            tool_calls?: {
              id?: string
              type?: string
              function?: { name?: string; arguments?: string }
            }[]
          }
        }[]
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
        }
      }

      const usage: UsageRecord = {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        cachedTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        estimatedCostUsd: 0
      }
      const cost = estimateCostUsd(model, usage) ?? 0
      usage.estimatedCostUsd = cost

      this.usage = {
        inputTokens: this.usage.inputTokens + usage.inputTokens,
        outputTokens: this.usage.outputTokens + usage.outputTokens,
        cachedTokens: this.usage.cachedTokens + usage.cachedTokens,
        estimatedCostUsd: this.usage.estimatedCostUsd + cost
      }
      // Spend is always recorded; only Cryptoric-funded calls draw the daily
      // allowance. `budget()` decides which of the two this is.
      this.usedTodayUsd += cost
      this.deps.onUsage(usage, cost)

      const message = body.choices?.[0]?.message
      const rawCalls = message?.tool_calls ?? []
      const parsed = rawCalls.map((call, index) => parseToolCall(call, index))

      return {
        ok: true,
        text: message?.content ?? '',
        usage: this.getUsage(),
        model,
        error: null,
        toolCalls: parsed,
        assistantMessage: buildAssistantMessage(message?.content ?? '', rawCalls)
      }
    } catch (err) {
      return failed(this.getUsage(), model, err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Ask the provider whether the stored key is actually usable.
   *
   * This is the difference between "the key field is filled in" and "the key
   * works". OpenRouter answers `GET /key` with the key's label, remaining limit
   * and usage. No part of the key itself is returned by this function, logged,
   * or sent onward.
   */
  async describeKey(): Promise<{
    ok: boolean
    configured: boolean
    label: string | null
    usage: number | null
    limit: number | null
    limitRemaining: number | null
    isFreeTier: boolean | null
    error: string | null
  }> {
    const empty = {
      ok: false,
      configured: false,
      label: null,
      usage: null,
      limit: null,
      limitRemaining: null,
      isFreeTier: null,
      error: null
    }
    if (!this.usesUserKey()) {
      return { ...empty, error: 'No API key is stored for this provider.' }
    }
    if (this.deps.config.provider === 'apinex') {
      return this.describeApinexKey(empty)
    }
    if (this.deps.config.provider !== 'openrouter') {
      return {
        ...empty,
        configured: true,
        error: 'Key verification is implemented for OpenRouter and APINEX. Local and generic OpenAI-compatible endpoints are not probed.'
      }
    }
    const url = `${this.deps.config.endpoint.replace(/\/$/, '')}/key`
    try {
      const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(8000) })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200)
        return { ...empty, configured: true, error: `Key check returned ${res.status}. ${detail}` }
      }
      const body = (await res.json()) as {
        data?: {
          label?: string
          usage?: number
          limit?: number | null
          limit_remaining?: number | null
          is_free_tier?: boolean
        }
      }
      const d = body.data ?? {}
      return {
        ok: true,
        configured: true,
        label: safeLabel(d.label),
        usage: typeof d.usage === 'number' ? d.usage : null,
        limit: typeof d.limit === 'number' ? d.limit : null,
        limitRemaining: typeof d.limit_remaining === 'number' ? d.limit_remaining : null,
        isFreeTier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
        error: null
      }
    } catch (err) {
      return { ...empty, configured: true, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Verify an APINEX key.
   *
   * APINEX exposes no `/key` equivalent, but `GET /v1/models` is a real check:
   * measured on 2026-10-04 it answers 200 for a working key and 401 with
   * `"Invalid API key"` otherwise. What it cannot tell us is a balance or a
   * label, so those stay null rather than being invented as zero.
   */
  private async describeApinexKey(
    empty: {
      ok: boolean
      configured: boolean
      label: string | null
      usage: number | null
      limit: number | null
      limitRemaining: number | null
      isFreeTier: boolean | null
      error: string | null
    }
  ): Promise<{
    ok: boolean
    configured: boolean
    label: string | null
    usage: number | null
    limit: number | null
    limitRemaining: number | null
    isFreeTier: boolean | null
    error: string | null
  }> {
    const url = `${APINEX_ENDPOINT}/models`
    try {
      const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(8000) })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200)
        return { ...empty, configured: true, error: `Key check returned ${res.status}. ${detail}` }
      }
      const body = (await res.json()) as { data?: { id?: string }[] }
      const models = Array.isArray(body.data) ? body.data.length : 0
      return {
        ok: true,
        configured: true,
        label: null,
        usage: null,
        limit: null,
        limitRemaining: null,
        isFreeTier: null,
        error: null,
        ...(models > 0 ? {} : { error: 'Key accepted but the provider returned no model list.' })
      }
    } catch (err) {
      return { ...empty, configured: true, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * The wire identifier for a catalogue entry.
   *
   * Hosted catalogues namespace their models, so `id` is a UI key and not
   * necessarily something an API accepts. Guessing here is how a model that
   * looks selectable turns out to 400 on the first call.
   */
  wireModelId(modelId?: string): string {
    if (!modelId) return this.deps.config.model
    return MODEL_BY_ID.get(modelId)?.providerModelId ?? modelId
  }

  /** True when `configModel` is the entry `model` refers to, by key or wire id. */
  isActive(model: ModelDescriptor, configModel = this.deps.config.model): boolean {
    return model.id === configModel || (model.providerModelId ?? model.id) === configModel
  }

  /**
   * Configuration a catalogue entry implies — provider, endpoint and wire id.
   *
   * Returns null for a model that declares no provider (the local placeholder),
   * so selecting it leaves whatever the user configured untouched.
   *
   * A provider with its own credential slot takes that slot, overriding the
   * configured one. Preferring the configured slot here would hand one
   * provider's key to another: pick an APINEX model while configured for
   * OpenRouter and the OpenRouter key would be sent to apinex.bond.
   */
  resolveModel(modelId: string): ModelConfig | null {
    const model = MODEL_BY_ID.get(modelId)
    if (!model?.servedBy) return null
    return {
      ...this.deps.config,
      provider: model.servedBy,
      endpoint: model.endpoint ?? this.deps.config.endpoint,
      model: model.providerModelId ?? model.id,
      credentialKey: PROVIDER_CREDENTIAL_SLOTS[model.servedBy] ?? this.deps.config.credentialKey ?? null
    }
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function failed(usage: UsageRecord, model: string, error: string): CompletionResult {
  return {
    ok: false,
    text: '',
    usage,
    model,
    error,
    toolCalls: [],
    assistantMessage: null
  }
}

/**
 * Turn one wire tool call into a parsed one.
 *
 * A model that emits `"arguments": "{path: index.html"` is not an error to throw
 * on — it is a recoverable turn. The call is marked `malformed` with an empty
 * argument object so the loop can answer it with a real tool error, which the
 * model then reads and corrects. Silently dropping it would leave the
 * conversation with an unanswered `tool_call_id`, which providers reject.
 */
function parseToolCall(
  call: { id?: string; function?: { name?: string; arguments?: string } },
  index: number
): ToolCall {
  const name = call.function?.name ?? ''
  const raw = call.function?.arguments ?? ''
  // An id is required to answer the call, and some servers omit it.
  const id = call.id ?? `call_${index}_${name || 'unnamed'}`
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { id, name, arguments: parsed as Record<string, unknown>, malformed: false }
    }
    return { id, name, arguments: {}, malformed: true }
  } catch {
    return { id, name, arguments: {}, malformed: true }
  }
}

/**
 * Echo the assistant turn back to the provider.
 *
 * The `tool_calls` array must be reproduced exactly — same ids, same argument
 * strings — or the matching `tool` messages that follow are orphaned and the
 * next request fails. Returning null when there is nothing to say and nothing
 * to call keeps the caller from appending empty turns.
 */
function buildAssistantMessage(
  content: string,
  rawCalls: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[]
): ChatMessage | null {
  if (rawCalls.length === 0) {
    return content.trim().length > 0 ? { role: 'assistant', content } : null
  }
  return {
    role: 'assistant',
    content,
    tool_calls: rawCalls.map((call, index) => ({
      id: call.id ?? `call_${index}_${call.function?.name ?? 'unnamed'}`,
      type: 'function' as const,
      function: {
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '{}'
      }
    }))
  }
}

/**
 * Keep a provider's key label out of the log if it is really the key.
 *
 * Some providers set `label` to a masked form of the key itself. That is not
 * the gateway's to publish, so anything shaped like a key is dropped rather
 * than surfaced to a log file.
 */
function safeLabel(label: unknown): string | null {
  if (typeof label !== 'string' || !label) return null
  return /\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+/i.test(label) ? null : label
}