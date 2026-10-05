/**
 * Known AI providers, so the user picks a name instead of typing a URL.
 *
 * Lives in `shared` rather than `main` because the renderer draws the dropdown
 * from it and the main process validates against it. Two copies of this list
 * would drift, and the drift would show up as a preset in the picker that the
 * backend then rejects.
 *
 * The URL is *prefilled and editable*, never forced. A preset is a shortcut,
 * not a restriction: someone pointing this at their own gateway that happens to
 * speak the OpenAI wire format must still be able to paste their own address.
 *
 * The model hint is a real id from that provider, because guessing a model id is
 * the part people actually get wrong.
 */

export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  modelHint: string
  /** False for endpoints that need no key. */
  needsKey: boolean
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelHint: 'anthropic/claude-sonnet-4', needsKey: true },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4o', needsKey: true },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', modelHint: 'llama3.1', needsKey: false },
  { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', modelHint: 'local-model', needsKey: false },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', modelHint: 'llama-3.3-70b-versatile', needsKey: true },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', modelHint: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', needsKey: true },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', modelHint: 'mistral-large-latest', needsKey: true },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat', needsKey: true },
  { id: 'custom', label: 'Custom / other OpenAI-compatible', baseUrl: '', modelHint: '', needsKey: true }
])

export function findPreset(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? null
}

/**
 * Case-insensitive prefix-then-substring match for the dropdown's search box.
 *
 * Prefix matches come first so typing "o" surfaces OpenRouter and Ollama above
 * a provider that merely contains an "o" somewhere.
 */
export function searchPresets(query: string): ProviderPreset[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return [...PROVIDER_PRESETS]
  const starts = PROVIDER_PRESETS.filter((p) => p.label.toLowerCase().startsWith(q) || p.id.startsWith(q))
  const contains = PROVIDER_PRESETS.filter((p) => !starts.includes(p) && p.label.toLowerCase().includes(q))
  return [...starts, ...contains]
}
