/**
 * Permission prompts.
 *
 * A pending approval is a question the app is blocked on, so it is rendered
 * above every pane rather than inside one of them. That is not a styling
 * preference: approvals can be raised by any gated IPC channel, including ones
 * triggered from Settings or the runtime list, and a prompt that renders only in
 * the Chan pane means clicking a button anywhere else appears to do nothing at
 * all. That is exactly how "Restart & install" came to look broken — the gate
 * fired, the prompt was created, and nobody was ever shown it.
 *
 * The card is the one Chan already used. Same primitives, same three answers,
 * just promoted to a surface that cannot be scrolled past.
 */

import { Button, Dot } from './primitives'

export interface ApprovalLike {
  id: string
  toolId: string
  title: string
  detail: string
  risk: string
}

export interface ApprovalOverlayProps {
  approvals: ApprovalLike[]
  onResolve: (id: string, approved: boolean, remember?: boolean, toolId?: string) => void
}

/** One question. Large, because the answer is not safe to guess. */
function ApprovalCard({
  request,
  onResolve,
  elevated
}: {
  request: ApprovalLike
  onResolve: ApprovalOverlayProps['onResolve']
  elevated: boolean
}) {
  return (
    <div
      className="card"
      role="alertdialog"
      aria-label={request.title}
      style={{
        borderColor: 'var(--accent-line)',
        // In the overlay it sits on a backdrop, so it earns a shadow to separate.
        ...(elevated ? { boxShadow: '0 24px 70px rgba(0, 0, 0, 0.55)' } : {}),
        width: 'min(720px, 92vw)'
      }}
    >
      <div className="card-pad" style={{ display: 'grid', gap: 14, padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Dot tone="accent" pulse />
          <span style={{ fontWeight: 650, fontSize: 'var(--t-md)' }}>{request.title}</span>
        </div>

        <pre
          className="mono selectable"
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--text-2)',
            maxHeight: elevated ? 320 : 200,
            overflow: 'auto',
            // Bigger than the in-chat card. In the overlay this is the entire
            // content of the dialog, so a 10px monospace dump would be the one
            // thing on screen nobody can read.
            fontSize: elevated ? 'var(--t-sm)' : 'var(--t-xs)',
            lineHeight: 1.55
          }}
        >
          {request.detail}
        </pre>

        <span className="caption">{request.risk}</span>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={() => onResolve(request.id, true)}>
            Approve once
          </Button>
          {/* Granting for the session is the difference between one prompt and
              one prompt per file when the agent is doing a real job. */}
          <Button onClick={() => onResolve(request.id, true, true, request.toolId)}>
            Allow for this session
          </Button>
          <Button onClick={() => onResolve(request.id, false)}>Deny</Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Every pending approval, newest first, over a dimmed backdrop.
 *
 * Renders nothing at all when there is no approval, so the ordinary app is
 * untouched.
 */
export function ApprovalOverlay({ approvals, onResolve }: ApprovalOverlayProps): JSX.Element | null {
  if (approvals.length === 0) return null

  return (
    <div
      // `z-index` sits above the status bar and the update prompt: a gate the
      // app is blocked on outranks a suggestion to download something.
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(6, 7, 9, 0.66)',
        backdropFilter: 'blur(2px)'
      }}
    >
      <div
        style={{
          display: 'grid',
          gap: 16,
          justifyItems: 'center',
          maxHeight: '100%',
          overflow: 'auto'
        }}
      >
        {approvals
          .slice()
          .reverse()
          .map((request) => (
            <ApprovalCard key={request.id} request={request} onResolve={onResolve} elevated />
          ))}
      </div>
    </div>
  )
}