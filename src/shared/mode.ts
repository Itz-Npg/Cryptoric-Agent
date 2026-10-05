/**
 * Which mode this install runs in.
 *
 * Two, and the default matters:
 *
 *  - **`local`** — everything on this machine. Coins live in a local ledger, the
 *    agent runs without a network account, and nothing about the user leaves the
 *    device beyond their own model requests. This is the default because a build
 *    that silently starts phoning home is a different product from the one
 *    someone installed.
 *  - **`hosted`** — the account server is the source of truth for identity,
 *    coins and the model catalogue. The balance then survives uninstalling the
 *    app and follows the user to another device, because it was never local in
 *    the first place.
 *
 * `hosted` without a server URL is an **error**, never a fallback to `local`.
 * Quietly degrading to local would leave a user believing their balance is
 * synced when it is not, and would look exactly like a successful install.
 *
 * Pure and import-free, so the rule is testable without booting anything.
 */

/** `CRYPTORIC_MODE`. Anything else is rejected rather than guessed. */
export type RunMode = 'local' | 'hosted'

export const RUN_MODES: RunMode[] = ['local', 'hosted']

export interface ModeResolution {
  mode: RunMode
  /** Where the account server is, in `hosted`. Empty in `local`. */
  serverUrl: string
  /**
   * Why the mode is what it is. Empty when nothing had to be said.
   *
   * Surfaced in the UI, because "why is this build asking me to sign in" is a
   * question a user deserves an answer to.
   */
  note: string
}

export type ModeResult =
  | ({ ok: true } & ModeResolution)
  | { ok: false; error: string }

function readEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Strip a trailing slash and reject anything that is not an http(s) URL.
 *
 * A bare host would otherwise produce `undefined/v1/balance` at runtime, which
 * fails far away from the mistake.
 */
export function normaliseServerUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  if (raw.length === 0) return { ok: false, error: 'the server URL is empty' }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, error: `"${raw}" is not a valid URL` }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: `unsupported protocol "${parsed.protocol}" — use https, or http for localhost` }
  }
  return { ok: true, url: raw.replace(/\/+$/, '') }
}

/**
 * Read the mode from the environment.
 *
 * `CRYPTORIC_MODE` decides; `AGENT_SERVER_URL` must agree with it. A build with
 * no environment at all is `local`, which is what running from source looks like.
 */
export function resolveMode(env: Record<string, string | undefined>): ModeResult {
  const rawMode = readEnv(env, 'CRYPTORIC_MODE').toLowerCase()
  const rawUrl = readEnv(env, 'AGENT_SERVER_URL')

  if (rawMode.length === 0) {
    // A URL with no mode is someone who set half the configuration. Say so
    // rather than ignoring it — they clearly meant to connect.
    if (rawUrl.length > 0) {
      return {
        ok: false,
        error: 'AGENT_SERVER_URL is set but CRYPTORIC_MODE is not. Set CRYPTORIC_MODE=hosted to use it.'
      }
    }
    return { ok: true, mode: 'local', serverUrl: '', note: '' }
  }

  if (!RUN_MODES.includes(rawMode as RunMode)) {
    return {
      ok: false,
      error: `CRYPTORIC_MODE="${rawMode}" is not a mode. Use ${RUN_MODES.join(' or ')}.`
    }
  }

  if (rawMode === 'local') {
    if (rawUrl.length > 0) {
      return {
        ok: false,
        error:
          'CRYPTORIC_MODE=local but AGENT_SERVER_URL is set. In local mode nothing is sent to a server; ' +
          'remove the URL or set CRYPTORIC_MODE=hosted.'
      }
    }
    return { ok: true, mode: 'local', serverUrl: '', note: '' }
  }

  const url = normaliseServerUrl(rawUrl)
  if (!url.ok) {
    return { ok: false, error: `CRYPTORIC_MODE=hosted needs a server: ${url.error}.` }
  }
  // Plain http is refused for anything that is not loopback: the account token
  // and the balance would cross the network in the clear.
  const host = new URL(url.url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (new URL(url.url).protocol === 'http:' && !loopback) {
    return {
      ok: false,
      error: 'AGENT_SERVER_URL uses http on a non-local host. The account token would cross the network in the clear.'
    }
  }
  return { ok: true, mode: 'hosted', serverUrl: url.url, note: '' }
}

/** One line a user can read to know what this build is doing. */
export function describeMode(mode: RunMode): string {
  return mode === 'hosted'
    ? 'Hosted — your account, coins and models live on a Cryptoric server.'
    : 'Local — coins and history stay on this computer.'
}

/** Does this mode need a signed-in account before the agent may run? */
export function modeRequiresAccount(mode: RunMode): boolean {
  return mode === 'hosted'
}