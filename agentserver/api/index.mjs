/**
 * Vercel entry point.
 *
 * `api/index.mjs` is what Vercel looks for, and it is the same handler
 * `src/index.mjs` mounts on `node:http` — not a second implementation. Two
 * implementations is how the deployed server and the tested server stop being
 * the same program.
 *
 * The store here is in-memory, which is correct for a single instance and wrong
 * for anything scaled: a serverless function can be recycled between requests, so
 * a balance kept in memory does not survive. `MongoStore` in `src/mongo.mjs` is
 * the answer for that, and `MONGODB_URI` selects it. Failing loudly beats
 * serving a balance that resets.
 */

import { createHandler } from '../src/handlers.mjs'
import { MemoryStore } from '../src/store.mjs'
import { readCatalogueFile } from '../src/catalogue.mjs'
import { createMongoStore } from '../src/mongo.mjs'

const TOKEN = process.env.AGENT_SERVER_TOKEN ?? ''
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? ''
const CATALOGUE_PATH = process.env.MODEL_CATALOGUE_PATH ?? ''
const MONGO_URI = process.env.MONGODB_URI ?? ''

if (TOKEN.length === 0) {
  throw new Error(
    'AGENT_SERVER_TOKEN is required. An account server with no token hands out coins to anyone who asks.'
  )
}

const models = CATALOGUE_PATH.length > 0 ? readCatalogueFile(CATALOGUE_PATH) : []
const store = MONGO_URI.length > 0 ? createMongoStore(MONGO_URI) : new MemoryStore()
if (MONGO_URI.length === 0) {
  console.warn(
    'MONGODB_URI is not set, so the balance is held in memory. It will not survive a restart, and a ' +
      'serverless function can be recycled between requests. Set MONGODB_URI before deploying this.'
  )
}

const handler = createHandler({ store, token: TOKEN, models, allowOrigin: ALLOW_ORIGIN })

export default async function vercelHandler(req, res) {
  try {
    await handler(req, res)
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
    }
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal error' }))
  }
}