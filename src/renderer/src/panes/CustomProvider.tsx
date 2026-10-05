/**
 * Add a provider the user brought themselves.
 *
 * Three inputs, kept deliberately separate because they are three different
 * kinds of thing:
 *
 *  - **Base URL** — where requests go. Validated before it is sent, so a typo
 *    is a message rather than an opaque network failure later.
 *  - **API key** — a password field. It goes to the encrypted credential store
 *    in the main process and is never sent back to the renderer, so the list of
 *    saved providers below can show "key saved" without ever holding the key.
 *  - **Models** — free text, because nobody knows their provider's model list
 *    better than they do and no built-in catalogue covers a private endpoint.
 *    One per line, because that is what every provider prints.
 *
 * Editing an existing provider reuses the same form: the id is sent back so the
 * entry is replaced rather than duplicated.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Chip } from '../components/primitives'

interface SavedProvider {
  id: string
  label: string
  baseUrl: string
  models: string[]
  enabled: boolean
}

function parseModels(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
}

export function CustomProviderSection(): React.ReactElement {
  const [saved, setSaved] = useState<SavedProvider[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelsText, setModelsText] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<{ ok: boolean; tone: 'ok' | 'warn' | 'error' | 'idle'; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const settings = (await window.cryptoric.settings.get()) as { providers?: SavedProvider[] }
      setSaved(settings.providers ?? [])
    } catch {
      setSaved([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const reset = (): void => {
    setEditingId(null)
    setLabel('')
    setBaseUrl('')
    setApiKey('')
    setModelsText('')
    setReport(null)
  }

  const edit = (provider: SavedProvider): void => {
    setEditingId(provider.id)
    setLabel(provider.label)
    setBaseUrl(provider.baseUrl)
    // The stored key is deliberately not fetched: it never leaves the main
    // process. Leaving this blank keeps the existing key.
    setApiKey('')
    setModelsText(provider.models.join('\n'))
    setReport(null)
  }

  const save = async (): Promise<void> => {
    const models = parseModels(modelsText)
    if (models.length === 0) {
      setReport({ ok: false, tone: 'warn', text: 'Add at least one model id.' })
      return
    }
    setBusy(true)
    setReport(null)
    try {
      const result = await window.cryptoric.models.saveCustomProvider({
        ...(editingId ? { id: editingId } : {}),
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        // An empty string while editing means "keep the key I already stored".
        ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
        models
      })
      if (result.ok) {
        setReport({ ok: true, tone: 'ok', text: `Saved "${label.trim()}". Its models are selectable now.` })
        reset()
        await load()
      } else {
        setReport({ ok: false, tone: 'error', text: result.error ?? 'Could not save that provider.' })
      }
    } catch (err) {
      setReport({ ok: false, tone: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.cryptoric.models.removeCustomProvider(id)
      if (!result.ok) {
        setReport({ ok: false, tone: 'error', text: result.error ?? 'Could not remove that provider.' })
      } else {
        if (editingId === id) reset()
        await load()
      }
    } finally {
      setBusy(false)
    }
  }

  const modelCount = parseModels(modelsText).length

  return (
    <div className="card card-pad" style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontWeight: 550 }}>Your own provider</span>
        <span className="caption">
          Any OpenAI-compatible endpoint: a hosted service, a gateway, or a local server. The key is
          stored in the OS credential store, never in settings.
        </span>
      </div>

      {report && <Chip tone={report.tone}>{report.text}</Chip>}

      <div style={{ display: 'grid', gap: 6 }}>
        <label className="caption" htmlFor="cp-label">
          Name
        </label>
        <input
          id="cp-label"
          className="palette-input"
          placeholder="My gateway"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <label className="caption" htmlFor="cp-url">
          Base URL
        </label>
        <input
          id="cp-url"
          className="palette-input"
          placeholder="https://api.example.com/v1"
          spellCheck={false}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <label className="caption" htmlFor="cp-key">
          API key {editingId ? '(leave blank to keep the stored key)' : '(a local server needs none)'}
        </label>
        <input
          id="cp-key"
          className="palette-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <label className="caption" htmlFor="cp-models">
          Models — one per line, exactly as your provider spells them
          {modelCount > 0 && ` (${modelCount})`}
        </label>
        <textarea
          id="cp-models"
          className="palette-input"
          rows={4}
          spellCheck={false}
          placeholder={'my-model-1\nmy-model-2'}
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
        />
      </div>

      <div className="row" style={{ gap: 8 }}>
        <Button
          variant="primary"
          disabled={busy || label.trim().length === 0 || baseUrl.trim().length === 0 || modelCount === 0}
          onClick={() => void save()}
        >
          {editingId ? 'Update provider' : 'Add provider'}
        </Button>
        {editingId && (
          <Button variant="ghost" onClick={reset}>
            Cancel
          </Button>
        )}
      </div>

      {saved.length > 0 && (
        <div style={{ display: 'grid', gap: 6, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <span className="caption">Saved providers</span>
          {saved.map((provider) => (
            <div key={provider.id} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="row-label" style={{ display: 'grid', minWidth: 0 }}>
                <span style={{ fontWeight: 550 }}>{provider.label}</span>
                <span className="caption">
                  {provider.baseUrl} · {provider.models.length} model(s)
                </span>
              </div>
              <Button variant="ghost" disabled={busy} onClick={() => edit(provider)}>
                Edit
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void remove(provider.id)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
