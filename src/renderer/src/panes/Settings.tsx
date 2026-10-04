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

export function SettingsSurface({
  state,
  models,
  onSelectModel,
  onSetTheme,
  onRefresh
}: {
  state: AppStateShape
  models: ModelSummary[]
  onSelectModel: (id: string) => void
  onSetTheme: (t: 'graphite' | 'bone') => void
  onRefresh: () => void
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

export { Icon }