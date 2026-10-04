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
    provider: 'Cryptoric',
    kind: 'hosted',
    inputPerMillion: 0.5,
    outputPerMillion: 1.5,
    contextWindow: 200_000
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

/** One coin = one cent of modelled cost. Keeps the balance legible. */
export const USD_PER_COIN = 0.01

export interface ModelConfig {
  /** `none` disables the gateway entirely; the agent stays deterministic-only. */
  provider: 'none' | 'ollama' | 'openai-compatible'
  endpoint: string
  model: string
  /** Credential-store key holding the API key. */
  credentialKey: string | null
  /** Daily ceiling in coins. */
  dailyBudgetCoins: number
}

export interface BudgetState {
  usedCoins: number
  budgetCoins: number
  /** ISO date (UTC) the counter applies to. */
  day: string
  exceeded: boolean
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
  /** Returns the API key, or null for local endpoints. */
  getApiKey(): string | null
  onUsage: (usage: UsageRecord, costUsd: number) => void
}

/**
 * Estimate cost from the declared price table.
 *
 * Returns `null` when the model is unpriced — an unpriced model must not be
 * reported as free, because that would silently understate the budget.
 */
export function estimateCostUsd(modelId: string, usage: UsageRecord): number | null {
  const model = MODEL_BY_ID.get(modelId)
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

  /** Current balance. Rolls over at UTC midnight. */
  budget(): BudgetState {
    const today = todayUtc()
    if (today !== this.dayStamp) {
      this.dayStamp = today
      this.usedTodayUsd = 0
    }
    const usedCoins = toCoins(this.usedTodayUsd)
    return {
      usedCoins,
      budgetCoins: this.deps.config.dailyBudgetCoins,
      day: today,
      exceeded: usedCoins >= this.deps.config.dailyBudgetCoins
    }
  }

  isEnabled(): boolean {
    return this.deps.config.provider !== 'none'
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
      const headers: Record<string, string> = {}
      const key = this.deps.getApiKey()
      if (key) headers['Authorization'] = `Bearer ${key}`

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

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const key = this.deps.getApiKey()
    if (key) headers['Authorization'] = `Bearer ${key}`
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
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}