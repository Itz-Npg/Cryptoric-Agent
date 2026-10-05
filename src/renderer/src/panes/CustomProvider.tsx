/**
 * Add a provider the user brought themselves.
 *
 * Shape follows what people actually do: pick the provider from a list, paste
 * the key, paste the model id. The base URL is prefilled from the choice and
 * stays editable, because a preset is a shortcut and not a restriction —
 * someone pointing this at their own gateway must still be able to.
 *
 * Three things are kept deliberately separate, because they are three different
 * kinds of thing:
 *
 *  - **Base URL** — where requests go. Validated here, so a typo is a message
 *    rather than an opaque network failure later.
 *  - **API key** — a password field, written straight to the encrypted
 *    credential store in the main process. It is never sent back to the
 *    renderer, so the saved list below can say "key saved" without ever holding
 *    the key.
 *  - **Model id** — free text. Copy it from the provider rather than guessing;
 *    a wrong id fails as a 404 from the provider with nothing useful in it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Chip } from '../components/primitives'
import { PROVIDER_PRESETS, searchPresets } from '@shared/provider-presets'

interface SavedProvider {
  id: string
  label: string
  baseUrl: string
  models: string[]
  enabled: boolean
  /** User-declared budgets in tokens. Absent when the user left them blank. */
  contextWindow?: number
  maxOutputTokens?: number
}

function parseModels(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
}

/**
 * A limit typed into a box, or undefined when the box is blank.
 *
 * `NaN` is passed through rather than swallowed: someone who types "32k" gets
 * told it is not a number, instead of quietly getting an unlimited provider.
 * The main process owns the wording of that message, so there is one rule, not
 * two that can disagree.
 */
function parseLimit(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  return Number(trimmed)
}

function formatLimit(value: number | undefined): string | null {
  return typeof value === 'number' ? value.toLocaleString('en-US') : null
}

function Field(props: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label className="caption" htmlFor={props.id} style={{ fontWeight: 550 }}>
        {props.label}
      </label>
      {props.children}
      {props.hint && <span className="caption">{props.hint}</span>}
    </div>
  )
}

export function CustomProviderSection(): React.ReactElement {
  const [saved, setSaved] = useState<SavedProvider[]>([])
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const [presetId, setPresetId] = useState('openrouter')
  const [query, setQuery] = useState('')
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS[0]?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [revealKey, setRevealKey] = useState(false)
  const [modelId, setModelId] = useState('')
  const [moreModels, setMoreModels] = useState('')
  const [name, setName] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [maxOutputTokens, setMaxOutputTokens] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<{ ok: boolean; tone: 'ok' | 'warn' | 'error' | 'idle'; text: string } | null>(null)

  const preset = useMemo(() => PROVIDER_PRESETS.find((p) => p.id === presetId) ?? PROVIDER_PRESETS[0], [presetId])
  const results = useMemo(() => searchPresets(query), [query])
  const extraModels = useMemo(() => parseModels(moreModels), [moreModels])
  const models = useMemo(() => parseModels(modelId).concat(extraModels), [modelId, extraModels])

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

  const choosePreset = (id: string): void => {
    const next = PROVIDER_PRESETS.find((p) => p.id === id)
    setPresetId(id)
    setOpen(false)
    setQuery('')
    // Prefill only. Overwriting a URL the user typed would lose their work.
    if (next && next.baseUrl.length > 0) setBaseUrl(next.baseUrl)
    if (next && next.modelHint.length > 0 && modelId.trim().length === 0) setModelId(next.modelHint)
    if (next && !next.needsKey) setApiKey('')
  }

  const reset = (): void => {
    setEditingId(null)
    setPresetId('openrouter')
    setQuery('')
    setBaseUrl(PROVIDER_PRESETS[0]?.baseUrl ?? '')
    setApiKey('')
    setRevealKey(false)
    setModelId('')
    setMoreModels('')
    setName('')
    setContextWindow('')
    setMaxOutputTokens('')
    setShowAdvanced(false)
    setReport(null)
  }

  const edit = (provider: SavedProvider): void => {
    setEditingId(provider.id)
    setName(provider.label)
    setBaseUrl(provider.baseUrl)
    // Preset is a guess: a provider saved by hand has no preset, and claiming
    // otherwise would silently rewrite its URL on the next edit.
    const match = PROVIDER_PRESETS.find((p) => p.baseUrl === provider.baseUrl)
    setPresetId(match?.id ?? 'custom')
    setModelId(provider.models[0] ?? '')
    setMoreModels(provider.models.slice(1).join('\n'))
    setContextWindow(provider.contextWindow !== undefined ? String(provider.contextWindow) : '')
    setMaxOutputTokens(provider.maxOutputTokens !== undefined ? String(provider.maxOutputTokens) : '')
    // The stored key never leaves the main process, so this stays blank and
    // leaving it blank keeps the key.
    setApiKey('')
    setReport(null)
  }

  const save = async (): Promise<void> => {
    if (models.length === 0) {
      setReport({ ok: false, tone: 'warn', text: 'Enter a model id, copied from your provider.' })
      return
    }
    setBusy(true)
    setReport(null)
    try {
      const result = await window.cryptoric.models.saveCustomProvider({
        ...(editingId ? { id: editingId } : {}),
        // A custom entry may have no name of its own; the preset's label is
        // better than a blank row in the list.
        label: name.trim().length > 0 ? name.trim() : (preset?.label ?? 'Custom provider'),
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
        models,
        contextWindow: parseLimit(contextWindow) ?? null,
        maxOutputTokens: parseLimit(maxOutputTokens) ?? null
      })
      if (result.ok) {
        setReport({ ok: true, tone: 'ok', text: `Saved. Its models are selectable now.` })
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

  // ---- empty state -------------------------------------------------------
  if (saved.length === 0 && !open && editingId === null && !report) {
    return (
      <div
        className="card card-pad"
        style={{ display: 'grid', gap: 14, placeItems: 'center', textAlign: 'center', padding: '30px 20px' }}
      >
        <div style={{ display: 'grid', gap: 6, maxWidth: 420 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>Connect your first provider</span>
          <span className="caption">
            Bring an OpenRouter key, a gateway, or any other OpenAI-compatible service. The key is
            stored in your OS credential store, never in a project file.
          </span>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setOpen(true)
            setReport(null)
          }}
        >
          Add provider
        </Button>
        {saved.length > 0 && <SavedList saved={saved} onEdit={edit} onRemove={remove} busy={busy} />}
      </div>
    )
  }

  // ---- saved list only (form closed) -------------------------------------
  if (!open && editingId === null) {
    return (
      <div className="card card-pad" style={{ display: 'grid', gap: 12 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span style={{ fontWeight: 550 }}>Your providers</span>
          <div style={{ flex: 1 }} />
          <Button variant="primary" onClick={() => setOpen(true)}>
            Add provider
          </Button>
        </div>
        {report && <Chip tone={report.tone}>{report.text}</Chip>}
        <SavedList saved={saved} onEdit={edit} onRemove={remove} busy={busy} />
      </div>
    )
  }

  // ---- the form ----------------------------------------------------------
  const needsKey = preset !== undefined && preset.needsKey !== false

  return (
    <div className="card card-pad" style={{ display: 'grid', gap: 16 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{editingId ? 'Edit provider' : 'Add provider'}</span>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => { reset(); setOpen(false) }}>
          Back
        </Button>
      </div>

      {report && <Chip tone={report.tone}>{report.text}</Chip>}

      <Field id="cp-preset" label="Provider">
        <div style={{ position: 'relative', display: 'grid' }}>
          <button
            id="cp-preset"
            type="button"
            className="palette-input"
            style={{ textAlign: 'left', cursor: 'pointer' }}
            onClick={() => setOpen((v) => v)}
            aria-expanded={open}
          >
            {preset?.label ?? 'Select a provider'}
          </button>
          {open && (
            <div
              className="card"
              style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4, padding: 6, maxHeight: 260, overflowY: 'auto' }}
            >
              <input
                className="palette-input"
                autoFocus
                placeholder="Search providers..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Escape closes without selecting, so a stray keystroke
                  // cannot quietly rewrite the URL.
                  if (e.key === 'Escape') {
                    setOpen(false)
                    setQuery('')
                  }
                }}
              />
              <div style={{ display: 'grid', gap: 2, marginTop: 6 }}>
                {results.length === 0 && <span className="caption" style={{ padding: 8 }}>No provider matches that.</span>}
                {results.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="row"
                    style={{ background: 'transparent', border: 0, padding: '8px 10px', cursor: 'pointer', textAlign: 'left', color: 'inherit', borderRadius: 6 }}
                    onClick={() => choosePreset(p.id)}
                  >
                    <span style={{ fontWeight: p.id === presetId ? 600 : 450 }}>{p.label}</span>
                    {p.baseUrl.length > 0 && <span className="caption" style={{ marginLeft: 'auto' }}>{p.needsKey ? 'key required' : 'no key'}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {preset !== undefined && preset.baseUrl.length > 0 && (
          <span className="caption">
            Requests go to <code style={{ color: 'var(--accent)' }}>{preset.baseUrl}</code>. You can change it below.
          </span>
        )}
      </Field>

      <Field id="cp-url" label="Base URL" hint="Edit this if you use a gateway or a self-hosted server.">
        <input
          id="cp-url"
          className="palette-input"
          placeholder="https://api.example.com/v1"
          spellCheck={false}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </Field>

      <Field
        id="cp-key"
        label="API key"
        hint={
          needsKey
            ? 'Saved in your OS credential store. It is never written to a project file, and never sent back to this screen.'
            : 'This is a local server, so it does not need a key.'
        }
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            id="cp-key"
            className="palette-input"
            style={{ flex: 1 }}
            type={revealKey ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            placeholder={needsKey ? 'Paste your API key' : 'Not required'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {needsKey && (
            <Button variant="ghost" onClick={() => setRevealKey((v) => !v)}>
              {revealKey ? 'Hide' : 'Show'}
            </Button>
          )}
        </div>
        {editingId && apiKey.trim().length === 0 && (
          <span className="caption">Leave blank to keep the key already stored for this provider.</span>
        )}
      </Field>

      <Field id="cp-model" label="Model ID" hint="Copy the exact ID from your provider. A wrong id fails as a 404 with nothing useful in it.">
        <input
          id="cp-model"
          className="palette-input"
          placeholder="provider/model-name"
          spellCheck={false}
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
        />
      </Field>

      <div>
        <button
          type="button"
          className="row"
          style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', gap: 8 }}
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
        >
          <span style={{ transform: showAdvanced ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>▶</span>
          <span style={{ fontWeight: 550 }}>Advanced settings</span>
          <span className="caption">Name and model limits</span>
        </button>

        {showAdvanced && (
          <div style={{ display: 'grid', gap: 14, paddingTop: 12 }}>
            <Field id="cp-name" label="Connection name" hint="Optional. Defaults to the provider you picked.">
              <input
                id="cp-name"
                className="palette-input"
                placeholder={preset?.label ?? 'For example, Personal'}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

            <Field
              id="cp-more"
              label="Extra models"
              hint={`One per line. ${extraModels.length} added.`}
            >
              <textarea
                id="cp-more"
                className="palette-input"
                rows={3}
                spellCheck={false}
                placeholder={'my-model-2\nmy-model-3'}
                value={moreModels}
                onChange={(e) => setMoreModels(e.target.value)}
              />
            </Field>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <label className="caption" htmlFor="cp-context" style={{ fontWeight: 550 }}>
                    Context window tokens
                  </label>
                  <input
                    id="cp-context"
                    className="palette-input"
                    inputMode="numeric"
                    placeholder="32768"
                    value={contextWindow}
                    onChange={(e) => setContextWindow(e.target.value)}
                  />
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  <label className="caption" htmlFor="cp-output" style={{ fontWeight: 550 }}>
                    Maximum output tokens
                  </label>
                  <input
                    id="cp-output"
                    className="palette-input"
                    inputMode="numeric"
                    placeholder="4096"
                    value={maxOutputTokens}
                    onChange={(e) => setMaxOutputTokens(e.target.value)}
                  />
                </div>
              </div>
              <span className="caption">
                Use limits supported by your model. These are budgets, not detected capabilities: the
                output ceiling clamps every reply, and a conversation longer than the window is stopped
                with the numbers instead of being sent and rejected.
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <span className="caption">
          {models.length === 0 ? 'Enter a model id to save.' : `${models.length} model${models.length === 1 ? '' : 's'} will be added.`}
        </span>
        <div style={{ flex: 1 }} />
        <Button
          variant="ghost"
          onClick={() => {
            reset()
            setOpen(false)
          }}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={busy || baseUrl.trim().length === 0 || models.length === 0}
          onClick={() => void save()}
        >
          {editingId ? 'Update provider' : 'Save provider'}
        </Button>
      </div>
    </div>
  )
}

function SavedList(props: {
  saved: SavedProvider[]
  onEdit: (p: SavedProvider) => void
  onRemove: (id: string) => void
  busy: boolean
}): React.ReactElement | null {
  if (props.saved.length === 0) return null
  return (
    <div style={{ display: 'grid', gap: 6, width: '100%', marginTop: 8 }}>
      {props.saved.map((provider) => (
        <div key={provider.id} className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="row-label" style={{ display: 'grid', minWidth: 0 }}>
            <span style={{ fontWeight: 550 }}>{provider.label}</span>
            <span className="caption">
              {[
                provider.baseUrl,
                `${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`,
                ...(provider.contextWindow !== undefined
                  ? [`${formatLimit(provider.contextWindow)} ctx`]
                  : []),
                ...(provider.maxOutputTokens !== undefined
                  ? [`${formatLimit(provider.maxOutputTokens)} out`]
                  : [])
              ].join(' · ')}
            </span>
          </div>
          <Chip tone="ok">key saved</Chip>
          <Button variant="ghost" disabled={props.busy} onClick={() => props.onEdit(provider)}>
            Edit
          </Button>
          <Button variant="ghost" disabled={props.busy} onClick={() => void props.onRemove(provider.id)}>
            Remove
          </Button>
        </div>
      ))}
    </div>
  )
}
