/**
 * Request rate limiting.
 *
 * The server holds one shared bearer token and no per-user credential, so a
 * token is guessable by brute force in exactly one way: by asking repeatedly.
 * Everything else that costs the server something — a body to parse, a store to
 * query, a session to price — costs it again on every attempt. A ceiling on
 * requests from one origin is what turns an unbounded search into a slow one.
 *
 * Fixed window rather than a sliding log, deliberately. A sliding window is
 * more precise and needs a timestamp per request, which is the same memory
 * growth problem moved somewhere less visible; a counter and a reset instant per
 * key is bounded by construction and easy to reason about. The cost is that a
 * caller can spend a full window's budget at the end of one window and again at
 * the start of the next — acceptable when the limit exists to stop a search, not
 * to meter a paid API.
 *
 * The map is bounded too (`maxKeys`). An unbounded `Map` keyed by something a
 * caller influences is a memory leak that presents as an out-of-memory crash
 * hours later, which is the worst kind of bug to attribute.
 */

/**
 * @param {object} options
 * @param {number} options.limit       Requests permitted per window, per key.
 * @param {number} options.windowMs    Window length in milliseconds.
 * @param {() => number} [options.now]
 * @param {number} [options.maxKeys]   Hard ceiling on tracked keys.
 * @returns {{ check(key: string): {allowed: boolean, remaining: number, retryAfterSeconds: number}, size(): number, reset(): void }}
 */
export function createRateLimiter({ limit, windowMs, now = () => Date.now(), maxKeys = 4096 }) {
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('limit must be a positive number')
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs must be a positive number')

  /** @type {Map<string, {count: number, resetAt: number}>} */
  const buckets = new Map()

  /**
   * Drop expired buckets, then the oldest live ones until there is room.
   *
   * Dropping a live bucket forgives a caller who was over the limit, which is
   * the safe direction: the alternative is unbounded memory. Insertion order is
   * oldest-first in a `Map`, so the oldest buckets are at the front of the
   * iterator.
   */
  function makeRoom(at) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key)
    }
    let overflow = buckets.size - maxKeys + 1
    if (overflow <= 0) return
    for (const key of buckets.keys()) {
      if (overflow <= 0) break
      buckets.delete(key)
      overflow -= 1
    }
  }

  return {
    /**
     * Count one request against `key`.
     *
     * Over the limit, `retryAfterSeconds` is never zero: a `Retry-After: 0` is
     * an instruction to retry immediately, which is the behaviour being asked
     * to stop.
     */
    check(key) {
      const at = now()
      const bucket = buckets.get(key)

      if (!bucket || bucket.resetAt <= at) {
        if (buckets.size >= maxKeys) makeRoom(at)
        buckets.set(key, { count: 1, resetAt: at + windowMs })
        return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 }
      }

      if (bucket.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - at) / 1000))
        }
      }

      bucket.count += 1
      return { allowed: true, remaining: limit - bucket.count, retryAfterSeconds: 0 }
    },

    /** Tracked keys, for tests that assert the bound rather than trust it. */
    size() {
      return buckets.size
    },

    reset() {
      buckets.clear()
    }
  }
}
