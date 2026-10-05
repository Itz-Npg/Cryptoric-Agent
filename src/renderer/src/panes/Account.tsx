/**
 * Account.
 *
 * The only surface that signs anyone in. It exists because the bridge had four
 * `auth.*` calls and nothing in the renderer ever made them, so sign-in was
 * reachable only by hand-editing a credential store.
 *
 * Two ways in, both real:
 *   - the button, which opens Google and waits on the loopback listener;
 *   - a paste box, for a browser that refuses to open `127.0.0.1`. Those exist
 *     inside corporate networks, and the person still has the address bar.
 *
 * Everything shown comes from `accountView`, which decides what is true. This
 * file draws it and forwards intent.
 */

import { useState } from 'react'
import { Button, Chip, Dot, SectionHead } from '../components/primitives'
import { accountView, parsePastedRedirect, type SignInPhase } from '@shared/account-view'
import type { AuthStatus } from '../../../preload'

export interface AccountProps {
  status: AuthStatus | null
  phase: SignInPhase
  error: string | null
  /** True when this install is pointed at the agent server rather than running alone. */
  hosted: boolean
  onSignIn: () => void
  onSignOut: () => void
  onComplete: (code: string, state: string) => void
}

export function AccountPane({
  status,
  phase,
  error,
  hosted,
  onSignIn,
  onSignOut,
  onComplete
}: AccountProps) {
  const view = accountView(status, phase, error)
  const [pasted, setPasted] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)

  const submitPasted = (): void => {
    const parsed = parsePastedRedirect(pasted)
    if (!parsed.ok) {
      setPasteError(parsed.error)
      return
    }
    setPasteError(null)
    setPasted('')
    onComplete(parsed.code, parsed.state)
  }

  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', flex: 1 }}>
      <div className="surface" style={{ padding: 20, overflow: 'auto', display: 'grid', gap: 16, alignContent: 'start' }}>
        <SectionHead>Account</SectionHead>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Dot tone={view.tone} pulse={view.busy} />
          <span style={{ fontWeight: 550 }} className="truncate">
            {view.chip}
          </span>
          <div style={{ flex: 1 }} />
          {hosted && <Chip tone="accent">Hosted</Chip>}
        </div>

        <p className="subtitle" style={{ margin: 0 }}>
          {view.detail}
        </p>

        {view.action && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant={view.action.kind === 'sign-out' ? 'ghost' : 'primary'}
              disabled={view.busy}
              onClick={() => {
                if (view.action?.kind === 'sign-out') onSignOut()
                else onSignIn()
              }}
            >
              {view.action.label}
            </Button>
            {view.busy && (
              <Button
                variant="ghost"
                onClick={onSignOut}
                title="Give up on this attempt and release the redirect port"
              >
                Cancel
              </Button>
            )}
          </div>
        )}

        {view.notice && status?.configured === false && (
          <div className="card card-pad" style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 'var(--t-sm)' }}>{view.notice}</span>
            <span className="caption">
              Restart Cryptoric Agent after setting it. A client id is public by design — it identifies the app,
              it does not grant access — so it does not belong in a secret store.
            </span>
          </div>
        )}

        {status?.signedIn && status.account && (
          <div className="card card-pad" style={{ display: 'grid', gap: 6 }}>
            <Row label="Name" value={status.account.name ?? '—'} />
            <Row label="Email" value={status.account.email ?? '—'} />
            <Row label="Account id" value={status.account.accountId} mono />
            <Row label="Signed in" value={new Date(status.account.signedInAt).toLocaleString()} />
          </div>
        )}
      </div>

      <div className="surface" style={{ padding: 20, overflow: 'auto', display: 'grid', gap: 14, alignContent: 'start' }}>
        <SectionHead>If your browser did not come back</SectionHead>
        <p className="subtitle" style={{ margin: 0 }}>
          Some managed browsers block <span className="mono">127.0.0.1</span>. Start sign-in, let the page fail,
          then copy the address it tried to reach and paste it here.
        </p>
        <input
          className="field"
          placeholder="http://127.0.0.1:53123/callback?code=…&state=…"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitPasted()
          }}
          aria-label="Paste the sign-in redirect address"
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button disabled={pasted.trim().length === 0} onClick={submitPasted}>
            Finish sign-in
          </Button>
          {pasteError && <span style={{ color: 'var(--err)', fontSize: 'var(--t-sm)' }}>{pasteError}</span>}
        </div>
        <span className="caption">
          The code is exchanged in the main process and checked against the state this app issued. A pasted link
          from anywhere else is refused.
        </span>
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: 10, alignItems: 'baseline' }}>
      <span className="caption">{label}</span>
      <span className={mono ? 'mono truncate' : 'truncate'} style={{ fontSize: 'var(--t-sm)' }}>
        {value}
      </span>
    </div>
  )
}

/** The topbar chip. Shows the account without taking any space in the stage. */
export function AccountChip({
  status,
  phase,
  error,
  onOpen
}: {
  status: AuthStatus | null
  phase: SignInPhase
  error: string | null
  onOpen: () => void
}) {
  const view = accountView(status, phase, error)
  return (
    <button className="topbar-btn" onClick={onOpen} title="Account">
      <Dot tone={view.tone} pulse={view.busy} />
      <span className="truncate" style={{ maxWidth: 140 }}>
        {view.chip}
      </span>
    </button>
  )
}
