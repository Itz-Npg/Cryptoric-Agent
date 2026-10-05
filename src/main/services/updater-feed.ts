/**
 * Translating `electron-updater`'s answer into ours.
 *
 * This lives apart from `updater-electron.ts` on purpose. That file imports
 * `electron` and `electron-updater`, so it cannot be loaded in a unit test — and
 * the `UpdateService` tests exercise the *service* against a fake port, not the
 * real transport. The consequence was concrete: the one line that decides
 * whether an up-to-date build is told it has an update available
 * (`result.isUpdateAvailable`) was **never covered by a single test**, and shipped
 * in `v0.1.3`. An installed build on the newest release was prompted to download
 * itself: *"Version 0.1.3 is available. You are on 0.1.3."*
 *
 * So the rule lives here, with no imports at all, and is pinned directly.
 */

/** One entry of the array form of `releaseNotes`. */
export interface FeedReleaseNote {
  version?: string | null
  note?: string | null
}

/**
 * The shape of `UpdateInfo` this module reads. Kept structural on purpose.
 *
 * `releaseNotes` has **three** shapes in the wild, not one: a plain string, an
 * object keyed by platform, and an array of `{ version, note }`. The array form
 * is what the library's own types declare, and the previous inline implementation
 * accepted only the first two — so a per-release note list was silently dropped
 * and the user saw no notes at all.
 */
export interface FeedUpdateInfo {
  version?: string | null
  releaseDate?: string | null
  releaseNotes?: string | { [platform: string]: string | undefined } | FeedReleaseNote[] | null
}

/** The subset of `checkForUpdates()`'s result this module reads. */
export interface FeedCheckResult {
  updateInfo?: FeedUpdateInfo | null
  isUpdateAvailable?: boolean
}

export interface TranslatedFeed {
  /** The version to offer, or `null` when there is genuinely nothing newer. */
  version: string | null
  releaseNotes: string | null
  releaseDate: string | null
  releasePageUrl: string | null
}

const REPO_OWNER = 'Itz-Npg'
const REPO_NAME = 'Cryptoric-Agent'

/** Where a human reads what changed. Built from the feed, never hardcoded. */
function releasePageFor(version: string | null): string | null {
  if (!version) return null
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/v${version}`
}

/**
 * Decide what the feed is actually saying.
 *
 * The subtle part, and the whole reason this file exists:
 * `electron-updater` populates `updateInfo` from the feed **whether or not** an
 * update applies. On a build that is already current, `updateInfo.version` is the
 * running version and `isUpdateAvailable` is `false`. Reading `updateInfo.version`
 * alone therefore reports the installed build as an available update, which is how
 * `v0.1.3` cheerfully offered itself to users already running `v0.1.3`.
 *
 * `isUpdateAvailable` is the authoritative answer. Only when it is absent — older
 * library shapes, which do not set the flag — does the version get used.
 */
export function translateFeedResult(result: FeedCheckResult | null | undefined): TranslatedFeed {
  const info = result?.updateInfo
  const version = result?.isUpdateAvailable === false ? null : (info?.version ?? null)

  // `releaseNotes` arrives in one of three shapes; all three are handled rather
  // than only the two that happened to appear in testing.
  let notes: string | null = null
  const raw = info?.releaseNotes
  if (typeof raw === 'string' && raw.trim()) {
    notes = raw
  } else if (Array.isArray(raw)) {
    // Ascending by version, so the newest note is last. An empty array, or one
    // with no note text, yields nothing rather than a blank string.
    for (const entry of raw) {
      if (entry?.note && entry.note.trim()) notes = entry.note
    }
  } else if (raw && typeof raw === 'object') {
    const bucket = raw as Record<string, string | undefined>
    const first = bucket['win32'] ?? bucket['default'] ?? bucket['linux'] ?? bucket['darwin']
    if (first && first.trim()) notes = first
  }

  return {
    version,
    releaseNotes: notes,
    releaseDate: info?.releaseDate ?? null,
    releasePageUrl: releasePageFor(version)
  }
}