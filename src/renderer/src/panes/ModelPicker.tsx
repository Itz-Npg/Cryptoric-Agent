/**
 * Model picker and coin balance.
 *
 * Not a settings page — a popover. Three things matter at a glance: which model
 * is active, what the balance is, and what the next call will roughly cost.
 *
 * Every figure is real. Usage comes from the gateway's accounting of actual
 * token counts returned by the endpoint; the balance is derived from that usage
 * against the configured daily ceiling.
 */

import { useEffect, useRef, useState } from 'react'
import { FREE_DAILY_COINS, SIGNUP_BONUS_COINS } from '@shared/coins'
import { Button, Chip, Icon, SectionHead } from '../components/primitives'

export interface ModelSummary {
  id: string
  label: string
  provider: string
  kind: 'local' | 'hosted'
  inputPerMillion: number | null
  outputPerMillion: number | null
  active: boolean
}

export interface BudgetSummary {
  usedCoins: number
  budgetCoins: number
  day: string
  exceeded: boolean
  enabled: boolean
  model: string
}

export function ModelPicker({
  models,
  budget,
  onSelect,
  onConfigure
}: {
  models: ModelSummary[]
  budget: BudgetSummary
  onSelect: (modelId: string) => void
  onConfigure: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = models.find((m) => m.active)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const ratio = budget.budgetCoins > 0 ? Math.min(1, budget.usedCoins / budget.budgetCoins) : 0

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="topbar-btn" data-on={open ? 'true' : undefined} onClick={() => setOpen((v) => !v)}>
        <Icon name="sparkle" size={15} />
        <span className="truncate" style={{ maxWidth: 150 }}>
          {active?.label ?? (budget.enabled ? budget.model : 'No model')}
        </span>
      </button>

      <button className="topbar-btn" onClick={() => setOpen((v) => !v)} title="Coin balance">
        <Icon name="coin" size={15} />
        <span className="mono" style={{ color: budget.exceeded ? 'var(--err)' : 'var(--text-2)' }}>
          {budget.usedCoins} / {budget.budgetCoins}
        </span>
      </button>

      {open && (
        <div
          className="card"
          role="dialog"
          aria-label="Model picker"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 336,
            zIndex: 70,
            boxShadow: 'var(--elev-3)',
            overflow: 'hidden',
            animation: 'picker-in var(--t-fast) var(--ease)'
          }}
        >
          <style>{`@keyframes picker-in { from { opacity: 0; transform: translateY(-4px) } to { opacity: 1; transform: none } }`}</style>

          <div style={{ padding: 16, display: 'grid', gap: 10, borderBottom: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontWeight: 600 }}>Balance</span>
              <div style={{ flex: 1 }} />
              <span className="mono">
                {budget.usedCoins} / {budget.budgetCoins} coins
              </span>
            </div>
            <span style={{ height: 4, borderRadius: 2, background: 'var(--surface-4)', display: 'block', overflow: 'hidden' }}>
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${ratio * 100}%`,
                  background: budget.exceeded ? 'var(--err)' : 'var(--accent)',
                  transition: 'width var(--t-base) var(--ease)'
                }}
              />
            </span>
            {budget.exceeded ? (
              // "Daily budget reached" is a phrase about a system. The user
              // needs to know their position and their options, so the chip
              // carries the same wording the refusal does.
              <Chip tone="error">No coins left today</Chip>
            ) : (
              <span className="caption">
                {budget.budgetCoins > FREE_DAILY_COINS
                  ? `${budget.budgetCoins} today (includes your ${SIGNUP_BONUS_COINS}-coin signup bonus) · `
                  : ''}
                Resets at midnight UTC · {Math.max(0, budget.budgetCoins - budget.usedCoins)} coins remaining
              </span>
            )}
          </div>

          <div style={{ padding: 10, maxHeight: 340, overflow: 'auto' }}>
            <SectionHead>Models</SectionHead>
            <div style={{ display: 'grid', gap: 2 }}>
              {models.map((model) => (
                <button
                  key={model.id}
                  className="row"
                  data-clickable="true"
                  onClick={() => {
                    onSelect(model.id)
                    setOpen(false)
                  }}
                  style={{
                    background: model.active ? 'var(--accent-soft)' : undefined,
                    minHeight: 46
                  }}
                >
                  <div className="row-label" style={{ display: 'grid', gap: 1 }}>
                    <span style={{ fontWeight: 550, color: model.active ? 'var(--accent)' : 'var(--text-1)' }}>
                      {model.label}
                    </span>
                    <span className="caption">{model.provider}</span>
                  </div>
                  <span className="caption mono" style={{ fontSize: 'var(--t-xs)', textAlign: 'right' }}>
                    {model.kind === 'local' ? 'free' : costLabel(model)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div style={{ padding: 12, borderTop: '1px solid var(--line)', display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={onConfigure} style={{ flex: 1 }}>
              Provider settings
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function costLabel(model: ModelSummary): string {
  if (model.inputPerMillion === null) return 'unpriced'
  const out = model.outputPerMillion ?? 0
  return `~${(model.inputPerMillion + out).toFixed(2)} coins/1k`
}

export function StatusBar({
  runtimeSummary,
  branch,
  changes,
  ready,
  version,
  online
}: {
  runtimeSummary: { label: string; tone: 'ok' | 'warn' | 'error' | 'idle' }[]
  branch: string | null
  changes: number
  ready: boolean
  version: string
  online: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 'var(--statusbar-h)',
        padding: '0 14px',
        background: 'var(--surface-1)',
        borderTop: '1px solid var(--line)',
        fontSize: 'var(--t-xs)'
      }}
    >
      {runtimeSummary.slice(0, 3).map((r) => (
        <span key={r.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-3)' }}>
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background:
                r.tone === 'ok' ? 'var(--ok)' : r.tone === 'warn' ? 'var(--warn)' : r.tone === 'error' ? 'var(--err)' : 'var(--text-3)'
            }}
          />
          {r.label}
        </span>
      ))}

      {branch && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-3)' }}>
          <Icon name="branch" size={12} />
          {branch}
        </span>
      )}

      {changes > 0 && <span style={{ color: 'var(--text-3)' }}>{changes} change{changes === 1 ? '' : 's'}</span>}

      <div style={{ flex: 1 }} />

      {!online && <span style={{ color: 'var(--warn)' }}>Offline</span>}
      <span style={{ color: ready ? 'var(--text-2)' : 'var(--text-3)' }}>{ready ? 'Ready' : 'Idle'}</span>
      <span className="mono" style={{ color: 'var(--text-3)' }}>
        v{version}
      </span>
    </div>
  )
}