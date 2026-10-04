/**
 * Minimal semver comparison sufficient for toolchain constraints.
 *
 * Supports the constraint forms Cryptoric actually emits:
 *   `>=20`  `>=20.11.0`  `^18.2`  `~3.9`  `22.x`  `20 || 22`  `=21.6.0`
 *
 * Deliberately not a full npm-semver implementation: it only needs to answer
 * "is the installed runtime new enough for this project?".
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string | null
}

export function parseVersion(raw: string): ParsedVersion | null {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?/.exec(raw.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    prerelease: match[4] ?? null
  }
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  // A prerelease sorts below its release (1.2.3-rc.1 < 1.2.3).
  if (a.prerelease && !b.prerelease) return -1
  if (!a.prerelease && b.prerelease) return 1
  if (a.prerelease && b.prerelease) return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0
  return 0
}

function satisfiesSingle(version: ParsedVersion, constraint: string): boolean {
  const c = constraint.trim()
  if (c === '' || c === '*') return true

  const opMatch = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(c)
  if (!opMatch) return false
  const op = opMatch[1] ?? '='
  const target = parseVersion(opMatch[2] as string)
  if (!target) return false

  // Wildcard forms: `22.x`, `22.*` — match any release on that major line.
  // `>=22.x` additionally requires a release at or above the minor when given.
  if (/\.(x|\*)$/i.test(opMatch[2] as string)) {
    const raw = opMatch[2] as string
    const base = parseVersion(raw.replace(/[.][x*]$/i, ''))
    if (!base) return false
    if (version.major !== base.major) return false
    if (op === '>=' && /[.]\d+[.][x*]$/i.test(raw)) {
      return compareVersions(version, base) >= 0
    }
    return true
  }

  const cmp = compareVersions(version, target)
  // A bare major (`18`, `20`) carries no precision beyond the major component.
  const partial = !/[.x*]/i.test(opMatch[2] as string)

  switch (op) {
    case '>=':
      return cmp >= 0
    case '<=':
      return cmp <= 0
    case '>':
      return cmp > 0
    case '<':
      return cmp < 0
    case '=':
      // A partial target (`18`) matches the whole major line: 18.2.0 satisfies it.
      return partial ? version.major === target.major : cmp === 0
    case '^': {
      if (cmp < 0) return false
      if (target.major > 0) return version.major === target.major
      if (target.minor > 0) return version.major === 0 && version.minor === target.minor
      return version.major === 0 && version.minor === 0 && version.patch === target.patch
    }
    case '~': {
      if (cmp < 0) return false
      return version.major === target.major && version.minor === target.minor
    }
    default:
      return false
  }
}

/** `||` separated alternatives are OR-ed. */
export function satisfiesConstraint(version: string, constraint: string | undefined | null): boolean {
  if (!constraint) return true
  const parsed = parseVersion(version)
  if (!parsed) return false
  return constraint
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((c) => satisfiesSingle(parsed, c))
}

/**
 * Normalise a project constraint into a `>=-style` minimum when possible, so the
 * UI can say "needs 20 or newer" rather than echoing the raw manifest string.
 */
export function describeConstraint(constraint: string): string {
  const alternatives = constraint.split('||').map((s) => s.trim()).filter(Boolean)
  if (alternatives.length === 0) return 'any'
  const parts = alternatives.map((alt) => {
    if (alt.startsWith('>=') || alt.startsWith('^') || alt.startsWith('~')) return alt
    if (alt.startsWith('>') || alt.startsWith('<') || alt.startsWith('=')) return alt
    const parsed = parseVersion(alt)
    return parsed ? `>=${parsed.major}` : alt
  })
  return parts.join(' || ')
}