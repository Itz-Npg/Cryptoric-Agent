/**
 * Fuzzy subsequence matching.
 *
 * Lives in `shared/` so the command palette's matching behaviour is unit
 * testable from the node test project without pulling React or the renderer
 * TypeScript config into scope.
 */

/**
 * Lowercase and drop the separators between words, keeping a map back to the
 * original offsets so a match can still be scored against word boundaries.
 */
function normalise(value: string): { text: string; origins: number[] } {
  let text = ''
  const origins: number[] = []
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] as string
    if (/[\s._\-/\\:]/.test(char)) continue
    text += char.toLowerCase()
    origins.push(i)
  }
  return { text, origins }
}

/**
 * True when every character of `needle` appears in `haystack`, in order.
 * Matching ignores case and the spacing/punctuation between words, so "open"
 * finds "Open project" and "renv" finds "Refresh environment".
 */
export function subsequence(haystack: string, needle: string): boolean {
  return fuzzyScore(haystack, needle) >= 0
}

/**
 * Ranking score for a match: contiguous runs and word-boundary hits score
 * higher, so the strongest candidate sorts to the top of the palette.
 * Returns -1 when the needle is not a subsequence at all.
 */
export function fuzzyScore(haystack: string, needle: string): number {
  const h = normalise(haystack)
  const n = normalise(needle)
  if (n.text.length === 0) return 0
  if (n.text.length > h.text.length) return -1

  let score = 0
  let cursor = 0
  let previous = -2
  for (let k = 0; k < n.text.length; k += 1) {
    const index = h.text.indexOf(n.text[k] as string, cursor)
    if (index === -1) return -1
    if (index === previous + 1) score += 6
    const origin = h.origins[index] as number
    const before = origin === 0 ? '' : (haystack[origin - 1] as string)
    const after = haystack[origin + 1] ?? ''
    if (origin === 0 || /[\s._\-/\\:]/.test(before)) score += 3
    if (/[\s._\-/\\:]/.test(after)) score += 1
    score += 1
    previous = index
    cursor = index + 1
  }
  // Shorter labels are more likely to be what was meant.
  return score + Math.max(0, 10 - h.text.length)
}