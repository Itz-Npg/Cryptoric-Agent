/**
 * Settings and Tools.
 *
 * Settings is deliberately quiet: providers, appearance, diagnostics. The Tools
 * surface exposes the agent's actual capability surface — registered tools,
 * permission policy and discovered skills — because in an autonomous agent those
 * are the three things a user should be able to audit.
 */

import { useEffect, useState } from 'react'
import type { EnvironmentGap, ProjectProfile, ToolStatus } from '@shared/types'
import { Button, Chip, CryptoricMark, Icon, SectionHead, toneForInstallState } from '../components/primitives'
import type { ModelSummary } from './ModelPicker'
import type { AppStateShape } from '../state/useAppState'

// ----------------------------------------------------------------- settings

/**
 * Provider credential row.
 *
 * Exists because a hosted model is only as real as its key: the user has to be
 * able to add one, and — more importantly — to ask the provider whether it
 * works instead of trusting that the field is filled in. Verification is a
 * live call; the key is stored encrypted and never sent back to the renderer.
 */
function ProviderKeyRow(): React.ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<{
    ok: boolean
    tone: 'ok' | 'warn' | 'error' | 'idle'
    text: string
  } | null>(null)

  const run = async (fn: () => Promise<import('../../../preload').ModelKeyReportDto>): Promise<void> => {
    setBusy(true)
    try {
      const r = await fn()
      if (!r.configured) {
        setReport({ ok: false, tone: 'warn', text: r.error ?? 'No key is stored for this provider.' })
      } else if (!r.ok) {
        setReport({ ok: false, tone: 'error', text: r.error ?? 'The provider rejected the key.' })
      } else {
        const bits = ['Key accepted by the provider']
        if (r.label) bits.push(r.label)
        if (r.isFreeTier) bits.push('free tier')
        if (r.limitRemaining !== null) bits.push(`${r.limitRemaining} of ${r.limit ?? '—'} remaining`)
        setReport({ ok: true, tone: 'ok', text: bits.join(' · ') })
      }
    } catch (err) {
      setReport({ ok: false, tone: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row" style={{ borderTop: '1px solid var(--line)', borderRadius: 0, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <div className="row-label" style={{ display: 'grid', minWidth: 0 }}>
        <span style={{ fontWeight: 550 }}>Provider key</span>
        <span className="caption">
          Stored in the OS-encrypted credential store. Verification is a live request to the provider.
        </span>
      </div>

      {report && <Chip tone={report.tone}>{report.text}</Chip>}

      {editing ? (
        <>
          <input
            className="palette-input"
            style={{ flex: '1 1 260px', minWidth: 200 }}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the provider API key"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            variant="primary"
            disabled={busy || draft.trim().length < 8}
            onClick={() => {
              void run(() => window.cryptoric.models.setKey(draft.trim())).then(() => {
                setDraft('')
                setEditing(false)
              })
            }}
          >
            Save
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <Button disabled={busy} onClick={() => void run(() => window.cryptoric.models.verifyKey())}>
            Verify key
          </Button>
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Add key
          </Button>
        </>
      )}
    </div>
  )
}

export function SettingsSurface({
  state,
  models,
  onSelectModel,
  onSetTheme,
  onRefresh,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate
}: {
  state: AppStateShape
  models: ModelSummary[]
  onSelectModel: (id: string) => void
  onSetTheme: (t: 'graphite' | 'bone') => void
  onRefresh: () => void
  onCheckForUpdates: (force?: boolean) => Promise<unknown>
  onDownloadUpdate: () => Promise<unknown>
  onInstallUpdate: () => Promise<unknown>
}) {
  const [rules, setRules] = useState<{ domain: string; default: string }[]>([])
  const [theme, setTheme] = useState<'graphite' | 'bone'>('graphite')

  useEffect(() => {
    void window.cryptoric.permission
      .list()
      .then((r) => setRules(r as { domain: string; default: string }[]))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'bone' ? 'bone' : 'graphite')
  }, [])

  return (
    <div className="scroll" style={{ padding: '28px 32px 48px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', display: 'grid', gap: 30 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <CryptoricMark size={30} />
          <div>
            <h1 className="title">Settings</h1>
            <p className="subtitle" style={{ margin: '4px 0 0' }}>
              Providers, appearance and the agent's permissions.
            </p>
          </div>
        </header>

        <section>
          <SectionHead>Models</SectionHead>
          <div className="card" style={{ overflow: 'hidden' }}>
            {models.length === 0 && (
              <div className="row">
                <span className="caption">No models configured. The agent runs deterministically only.</span>
              </div>
            )}
            {models.map((model, index) => (
              <button
                key={model.id}
                className="row"
                data-clickable="true"
                onClick={() => onSelectModel(model.id)}
                style={{
                  borderTop: index === 0 ? 'none' : '1px solid var(--line)',
                  borderRadius: 0,
                  background: model.active ? 'var(--accent-soft)' : undefined,
                  minHeight: 46
                }}
              >
                <div className="row-label" style={{ display: 'grid' }}>
                  <span style={{ fontWeight: 550, color: model.active ? 'var(--accent)' : undefined }}>
                    {model.label}
                  </span>
                  <span className="caption">{model.provider}</span>
                </div>
                {model.kind === 'local' && <Chip tone="ok">local · free</Chip>}
              </button>
            ))}
            <ProviderKeyRow />
          </div>
        </section>

        <section>
          <SectionHead>Appearance</SectionHead>
          <div className="card card-pad" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ fontWeight: 550 }}>Theme</span>
            <div style={{ flex: 1 }} />
            <div className="segmented">
              <button
                data-on={theme === 'graphite' ? 'true' : undefined}
                onClick={() => onSetTheme('graphite')}
                type="button"
              >
                Graphite
              </button>
              <button data-on={theme === 'bone' ? 'true' : undefined} onClick={() => onSetTheme('bone')} type="button">
                Bone
              </button>
            </div>
          </div>
        </section>

        <section>
          <SectionHead>Permissions</SectionHead>
          <div className="card" style={{ overflow: 'hidden' }}>
            {rules.map((rule, index) => (
              <div
                key={rule.domain}
                className="row"
                style={{ borderTop: index === 0 ? 'none' : '1px solid var(--line)', borderRadius: 0 }}
              >
                <span className="row-label mono" style={{ fontSize: 'var(--t-sm)' }}>
                  {rule.domain}
                </span>
                <select
                  className="field"
                  style={{ width: 108, height: 28 }}
                  value={rule.default}
                  onChange={(e) => {
                    void window.cryptoric.permission
                      .set(rule.domain, e.target.value as 'allow' | 'ask' | 'deny')
                      .then((r) => setRules(r as { domain: string; default: string }[]))
                  }}
                  aria-label={`Permission for ${rule.domain}`}
                >
                  <option value="allow">allow</option>
                  <option value="ask">ask</option>
                  <option value="deny">deny</option>
                </select>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionHead>Environment</SectionHead>
          <div className="card card-pad" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ fontWeight: 550 }}>Snapshot {state.snapshotId ?? '—'}</span>
            <span className="caption">
              {state.tools.filter((t) => t.state === 'present').length} of {state.tools.length} runtimes available
            </span>
            <div style={{ flex: 1 }} />
            <Button onClick={onRefresh}>Re-read OS environment</Button>
          </div>
        </section>

        <UpdatesSection
          state={state}
          onCheck={onCheckForUpdates}
          onDownload={onDownloadUpdate}
          onInstall={onInstallUpdate}
        />
      </div>
    </div>
  )
}

// -------------------------------------------------------------------- tools

export function ToolsSurface({
  tools,
  notice
}: {
  project: ProjectProfile | null
  gaps: EnvironmentGap[]
  tools: ToolStatus[]
  notice: (m: string | null) => void
}) {
  const [descriptors, setDescriptors] = useState<{ id: string; label: string; description: string; tier: string }[]>([])
  const [skills, setSkills] = useState<{ id: string; name: string; description: string; enabled: boolean; scope: string }[]>([])

  useEffect(() => {
    void Promise.all([window.cryptoric.agent.tools(), window.cryptoric.skill.list()])
      .then(([t, s]) => {
        setDescriptors(t as { id: string; label: string; description: string; tier: string }[])
        setSkills(s as { id: string; name: string; description: string; enabled: boolean; scope: string }[])
      })
      .catch((e: unknown) => notice(String(e)))
  }, [notice])

  return (
    <div className="scroll" style={{ padding: '28px 32px 48px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', display: 'grid', gap: 30 }}>
        <header>
          <h1 className="title">Tools</h1>
          <p className="subtitle" style={{ margin: '6px 0 0' }}>
            What Cryptoric Chan can do, and which skills are loaded on demand.
          </p>
        </header>

        <section>
          <SectionHead>Agent tools</SectionHead>
          <div className="card" style={{ overflow: 'hidden' }}>
            {descriptors.map((tool, index) => (
              <div
                key={tool.id}
                className="row"
                style={{ borderTop: index === 0 ? 'none' : '1px solid var(--line)', borderRadius: 0, alignItems: 'flex-start', padding: '14px 16px' }}
              >
                <div className="row-label" style={{ display: 'grid', gap: 3 }}>
                  <span className="mono" style={{ color: 'var(--text-1)' }}>
                    {tool.id}
                  </span>
                  <span style={{ color: 'var(--text-2)', fontSize: 'var(--t-sm)' }}>{tool.description}</span>
                </div>
                <Chip tone={tool.tier === 'destructive' ? 'error' : tool.tier === 'safe' ? 'ok' : 'idle'}>
                  {tool.tier}
                </Chip>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionHead>Skills</SectionHead>
          <p className="caption" style={{ marginTop: 0 }}>
            Only skills relevant to the current task are loaded into context. Everything else is skipped,
            and the router reports why.
          </p>
          <div className="card" style={{ overflow: 'hidden' }}>
            {skills.length === 0 && (
              <div className="row">
                <span className="caption">No skills discovered on this machine.</span>
              </div>
            )}
            {skills.map((skill, index) => (
              <div
                key={skill.id}
                className="row"
                style={{ borderTop: index === 0 ? 'none' : '1px solid var(--line)', borderRadius: 0, minHeight: 50 }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: skill.enabled ? 'var(--ok)' : 'var(--text-3)'
                  }}
                />
                <div className="row-label" style={{ display: 'grid', gap: 1 }}>
                  <span style={{ fontWeight: 550 }}>{skill.name}</span>
                  <span className="caption truncate">{skill.description || skill.id}</span>
                </div>
                <span className="caption">{skill.scope}</span>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void window.cryptoric.skill
                      .setEnabled(skill.id, !skill.enabled)
                      .then(() => window.cryptoric.skill.list())
                      .then((s) => setSkills(s as typeof skills))
                  }}
                >
                  {skill.enabled ? 'Disable' : 'Enable'}
                </Button>
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionHead>Runtime detection</SectionHead>
          <div className="card" style={{ overflow: 'hidden' }}>
            {tools.map((tool, index) => (
              <div
                key={tool.spec.id}
                className="row"
                style={{ borderTop: index === 0 ? 'none' : '1px solid var(--line)', borderRadius: 0 }}
              >
                <span className="row-label">{tool.spec.label}</span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    color: 'var(--text-2)',
                    fontSize: 'var(--t-sm)'
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background:
                        toneForInstallState(tool.state) === 'ok'
                          ? 'var(--ok)'
                          : toneForInstallState(tool.state) === 'error'
                            ? 'var(--err)'
                            : 'var(--text-3)'
                    }}
                  />
                  {tool.version ?? tool.state}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

/**
 * Application updates.
 *
 * Built from the same `SectionHead` / `card` / `row` / `Button` primitives as
 * every other section here, so it adds a capability rather than a new visual
 * language.
 *
 * The rule this screen exists to honour: the app never says it is up to date
 * when it could not check. A development build genuinely has no update feed, so
 * it says exactly that instead of showing a reassuring all-clear.
 */
function UpdatesSection({
  state,
  onCheck,
  onDownload,
  onInstall
}: {
  state: AppStateShape
  onCheck: (force?: boolean) => Promise<unknown>
  onDownload: () => Promise<unknown>
  onInstall: () => Promise<unknown>
}): JSX.Element {
  const update = state.update
  const [checking, setChecking] = useState(false)

  const currentVersion = update?.currentVersion ?? ''

  const line = ((): string => {
    if (!update) return 'Not checked yet.'
    switch (update.state) {
      case 'unsupported':
        return update.unavailableReason ?? 'This build cannot check for updates.'
      case 'checking':
        return 'Checking for updates…'
      case 'available':
        return `Version ${update.availableVersion} is available. You are on ${update.currentVersion}.`
      case 'not-available':
        return `${update.currentVersion} is the latest version.`
      case 'downloading':
        return `Downloading ${update.availableVersion ?? 'the update'} — ${Math.round(update.progress?.percent ?? 0)}%.`
      case 'downloaded':
        return `Version ${update.availableVersion ?? ''} is downloaded. Restart to install it.`
      case 'error':
        return update.error ?? 'The update check failed.'
      default:
        // `idle` means no check has run, which is not the same claim as
        // "checking", and definitely not "you are up to date".
        return 'Not checked yet.'
    }
  })()

  const busy = checking || update?.state === 'checking' || update?.state === 'downloading'
  // Enabled on `idle` too: a user who has not been told anything yet must be
  // able to ask.
  const canCheck = !busy && update?.state !== 'unsupported'

  return (
    <section>
      <SectionHead>Updates</SectionHead>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="row" style={{ borderRadius: 0 }}>
          <div className="row-label" style={{ display: 'grid' }}>
            <span style={{ fontWeight: 550 }}>Version {currentVersion || '—'}</span>
            <span className="caption" style={{ marginTop: 3 }}>
              {line}
            </span>
          </div>
          <div style={{ display: 'inline-flex', gap: 8 }}>
            <Button
              variant="ghost"
              disabled={!canCheck}
              onClick={() => {
                setChecking(true)
                void Promise.resolve(onCheck(true)).finally(() => setChecking(false))
              }}
            >
              Check now
            </Button>
            <Button
              disabled={update?.state !== 'available' || busy}
              // The same state that disables it is the reason it is disabled,
              // so the button says which one instead of leaving the user to work
              // out why a click did nothing.
              title={
                update?.state === 'not-available'
                  ? `${update.currentVersion} is already the latest version.`
                  : update?.state === 'idle'
                    ? 'Check for updates first.'
                    : update?.state === 'downloaded'
                      ? 'Already downloaded — use Restart & install.'
                      : 'No update is ready to download yet.'
              }
              onClick={() => void onDownload()}
            >
              Download
            </Button>
            <Button
              disabled={update?.state !== 'downloaded'}
              title={
                update?.state === 'downloaded'
                  ? 'Restart and install the downloaded update.'
                  : 'Nothing has been downloaded yet.'
              }
              onClick={() => void onInstall()}
            >
              Restart &amp; install
            </Button>
          </div>
        </div>
        {update?.releasePageUrl && (
          <div className="row" style={{ borderTop: '1px solid var(--line)', borderRadius: 0, minHeight: 40 }}>
            <span className="row-label caption">Release notes</span>
            <a
              href={update.releasePageUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent)', fontSize: 'var(--t-sm)' }}
            >
              {update.releasePageUrl}
            </a>
          </div>
        )}
      </div>
    </section>
  )
}

export { Icon }
