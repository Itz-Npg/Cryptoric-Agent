/**
 * The model catalogue this server publishes.
 *
 * Read from a JSON file rather than hardcoded, so the same file your provider
 * server serves is the one the account server prices against. Pricing follows
 * `byok`: a model the user brings costs 5 coins, one this project pays for costs
 * 10. That flag has to come from the catalogue, not from the client — a client
 * that named its own tier would be naming its own price.
 *
 * A malformed catalogue is an empty one, loudly. Falling back to a default list
 * would mean shipping prices nobody chose.
 */

import { readFileSync } from 'node:fs'

/**
 * @param {string} path
 * @returns {object[]} models the client may select
 */
export function readCatalogueFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const models = Array.isArray(parsed) ? parsed : parsed?.models
    if (!Array.isArray(models)) return []
    return models
      .filter((m) => typeof m?.id === 'string' && m.id.length > 0)
      .map((m) => ({
        id: m.id,
        label: typeof m.label === 'string' ? m.label : m.id,
        description: typeof m.description === 'string' ? m.description : '',
        contextWindow: Number.isFinite(Number(m.contextWindow)) ? Number(m.contextWindow) : 0,
        byok: m.byok !== false
      }))
  } catch (err) {
    console.error(`Could not read the catalogue at ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}