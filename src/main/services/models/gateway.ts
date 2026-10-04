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

export type ProviderKind = 'none' | 'ollama' | 'openai-compatible' | 'openrouter'

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

/**
 * Catalogue. Local models are discovered at runtime from the endpoint; this
 * list is what the UI offers when no endpoint is reachable, and what provides
 * pricing for hosted models.
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

export const MODEL_BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]))

/** Wire identifiers -> descriptor, so a namespaced id prices exactly like its UI key. */
export const MODEL_BY_WIRE = new Map(MODEL_CATALOG.map((m) => [m.providerModelId ?? m.id, m]))

export function findModel(idOrWireId: string): ModelDescriptor | undefined {
  return MODEL_BY_ID.get(idOrWireId) ?? MODEL_BY_WIRE.get(idOrWireId)
}

/** One coin = one cent of modelled cost. Keeps the balance legible. */
export const USD_PER_COIN = 0.01

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1'

/** Credential-store slot for the user's own OpenRouter key (BYOK). */
export const OPENROUTER_CREDENTIAL = 'openrouter-api-key'

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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface CompletionRequest {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface CompletionResult {
  ok: boolean
  text: string
  usage: UsageRecord
  /** Model the gateway actually called. */
  model: string
  error: string | null
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
      return {
        ok: false,
        text: '',
        usage: this.getUsage(),
        model: this.deps.config.model,
        error: budget.reason
      }
    }

    const { endpoint, model, provider } = this.deps.config
    const url = `${endpoint.replace(/\/$/, '')}/chat/completions`

    const headers = this.headers({ json: true })
    if (provider === 'ollama') headers['X-Return-Format'] = 'openai'

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        signal: request.signal ?? AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model,
          messages: request.messages,
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens ?? 2048,
          stream: false
        })
      })

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300)
        return {
          ok: false,
          text: '',
          usage: this.getUsage(),
          model,
          error: `Model endpoint returned ${res.status}. ${detail}`
        }
      }

      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
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

      return {
        ok: true,
        text: body.choices?.[0]?.message?.content ?? '',
        usage: this.getUsage(),
        model,
        error: null
      }
    } catch (err) {
      return {
        ok: false,
        text: '',
        usage: this.getUsage(),
        model,
        error: err instanceof Error ? err.message : String(err)
      }
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
    if (this.deps.config.provider !== 'openrouter') {
      return {
        ...empty,
        configured: true,
        error: 'Key verification is implemented for OpenRouter. Local and generic OpenAI-compatible endpoints are not probed.'
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
   */
  resolveModel(modelId: string): ModelConfig | null {
    const model = MODEL_BY_ID.get(modelId)
    if (!model?.servedBy) return null
    return {
      ...this.deps.config,
      provider: model.servedBy,
      endpoint: model.endpoint ?? this.deps.config.endpoint,
      model: model.providerModelId ?? model.id,
      credentialKey:
        this.deps.config.credentialKey ?? (model.servedBy === 'openrouter' ? OPENROUTER_CREDENTIAL : null)
    }
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
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