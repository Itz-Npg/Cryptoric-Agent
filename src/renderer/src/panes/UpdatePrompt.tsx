import { Button } from '../components/primitives'
import type { UpdateStatusDto } from '../../../preload'

/**
 * The update prompt.
 *
 * The flow the owner asked for, which is also the only honest one:
 *
 *   available  -> "Download now" / "Download later"
 *   downloading -> progress, no choice to interrupt mid-transfer
 *   downloaded -> "Restart now" / "Restart later"
 *
 * "Later" is never a cancellation. The update is found again on the next launch,
 * and once it has downloaded, `autoInstallOnAppQuit` applies it when the app
 * closes — so "Restart later" means "when I get round to it", not "never".
 *
 * Built from the same `card`/`row`/`Button` primitives as the rest of the app so
 * it adds a capability rather than a new visual language.
 */
export function UpdatePrompt({
  status,
  busy,
  onDownload,
  onInstall,
  onDismiss
}: {
  status: UpdateStatusDto
  busy: boolean
  onDownload: () => void
  onInstall: () => void
  onDismiss: () => void
}): JSX.Element | null {
  if (status.state === 'available') {
    return (
      <div
        role="dialog"
        aria-label="Update available"
        className="card"
        style={{
          position: 'fixed',
          right: 20,
          bottom: 44,
          zIndex: 90,
          width: 'min(420px, calc(100vw - 40px))',
          padding: 16,
          display: 'grid',
          gap: 12,
          boxShadow: 'var(--elev-3)'
        }}
      >
        <div style={{ display: 'grid', gap: 2 }}>
          <span style={{ fontWeight: 600 }}>Version {status.availableVersion} is available</span>
          <span className="caption">
            You are on {status.currentVersion}. Downloading does not interrupt your work.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onDismiss}>
            Download later
          </Button>
          <Button disabled={busy} onClick={onDownload}>
            Download now
          </Button>
        </div>
      </div>
    )
  }

  if (status.state === 'downloaded') {
    return (
      <div
        role="dialog"
        aria-label="Update ready to install"
        className="card"
        style={{
          position: 'fixed',
          right: 20,
          bottom: 44,
          zIndex: 90,
          width: 'min(420px, calc(100vw - 40px))',
          padding: 16,
          display: 'grid',
          gap: 12,
          boxShadow: 'var(--elev-3)'
        }}
      >
        <div style={{ display: 'grid', gap: 2 }}>
          <span style={{ fontWeight: 600 }}>Version {status.availableVersion} is ready</span>
          <span className="caption">
            Restart to install it now, or close the app and it installs on the way out.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onDismiss}>
            Restart later
          </Button>
          <Button disabled={busy} onClick={onInstall}>
            Restart now
          </Button>
        </div>
      </div>
    )
  }

  return null
}