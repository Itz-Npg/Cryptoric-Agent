/**
 * Self-hosted entry point.
 *
 * `node agentserver/src/index.mjs` — the same handler Vercel runs, on a plain
 * `node:http` server, so the thing you deploy to a host is the thing you can
 * test on your machine first.
 *
 * Refuses to start without a token. An account server with no authentication is
 * an open proxy that hands out coins, and starting "just to look" is exactly how
 * one ends up exposed.
 */

import { createServer } from 'node:http'

import { createHandler } from './handlers.mjs'
import { MemoryStore } from './store.mjs'
import { readCatalogueFile } from './catalogue.mjs'

/**
 * `AGENT_SERVER_PORT`, never bare `PORT`.
 *
 * Hosting platforms set `PORT` for their own routing — and in a dev container it
 * is often `0`, meaning "pick any free port". Reading it silently bound this
 * server to a random port, so it started, looked healthy, and was not reachable
 * where anyone expected. Caught by running the real binary, not by a unit test.
 */
const PORT = Number(process.env.AGENT_SERVER_PORT ?? 8789)
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`AGENT_SERVER_PORT="${process.env.AGENT_SERVER_PORT}" is not a port number.`)
  process.exitCode = 1
}
const TOKEN = process.env.AGENT_SERVER_TOKEN ?? ''
/**
 * Operator credential, separate from `AGENT_SERVER_TOKEN` on purpose.
 *
 * `POST /v1/integrity` bans an account, and the client token ships inside
 * every installed copy of the app — so it cannot be the credential that
 * authorises a ban. Without this, that route stays disabled rather than
 * becoming a way for any user to delete any other user's account.
 */
const ADMIN_TOKEN = process.env.AGENT_SERVER_ADMIN_TOKEN ?? ''
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? ''
const CATALOGUE_PATH = process.env.MODEL_CATALOGUE_PATH ?? ''

if (TOKEN.length === 0) {
  console.error(
    'AGENT_SERVER_TOKEN is required. Without it this server would hand out coins to anyone who asked.\n' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  )
  process.exitCode = 1
} else if (Number.isInteger(PORT)) {
  const store = new MemoryStore()
  const models = CATALOGUE_PATH.length > 0 ? readCatalogueFile(CATALOGUE_PATH) : []

  const server = createServer(
    createHandler({ store, token: TOKEN, models, allowOrigin: ALLOW_ORIGIN, adminToken: ADMIN_TOKEN })
  )
  server.listen(PORT, () => {
    console.log(`cryptoric agent server on http://127.0.0.1:${PORT} · ${models.length} models · store: in-memory`)
    if (models.length === 0) {
      console.log('No MODEL_CATALOGUE_PATH set, so /v1/models is empty. Every model will price at the BYOK rate.')
    }
    if (ADMIN_TOKEN.length === 0 || ADMIN_TOKEN === TOKEN) {
      console.log(
        'No separate AGENT_SERVER_ADMIN_TOKEN set, so POST /v1/integrity is disabled: a ban needs a credential that installs do not carry.'
      )
    }
  })
}