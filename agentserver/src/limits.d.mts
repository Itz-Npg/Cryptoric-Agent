/**
 * Types for the rate limiter.
 *
 * Hand-written for the same reason the store's are: the server is plain
 * JavaScript and this repository does not enable `allowJs`, so a `.mjs` module
 * needs a declaration to be usable from the TypeScript tests.
 */

export interface RateLimitVerdict {
  allowed: boolean
  remaining: number
  /** Seconds to wait. Never zero when `allowed` is false. */
  retryAfterSeconds: number
}

export interface RateLimiter {
  check(key: string): RateLimitVerdict
  size(): number
  reset(): void
}

export declare function createRateLimiter(options: {
  limit: number
  windowMs: number
  now?: () => number
  maxKeys?: number
}): RateLimiter
