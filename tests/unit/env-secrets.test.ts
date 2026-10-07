/**
 * Inherited credentials must not reach spawned processes.
 *
 * The tests below are the two halves of the same claim: the filter recognises a
 * credential by name, and the environment manager actually applies it to what it
 * hands a child. A filter that is never wired in protects nothing, and a wiring
 * that filters everything breaks the machine — both are asserted here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EnvironmentManager } from '../../src/main/services/env/manager'
import { envGet, platformSpec } from '../../src/main/services/env/layers'
import { isSecretEnvName, parsePassEnv, stripSecretEnv } from '../../src/main/services/env/secrets'

describe('recognising an inherited credential', () => {
  it('catches the provider names a real shell has exported', () => {
    for (const name of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'NPM_TOKEN',
      'NODE_AUTH_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'STRIPE_SECRET_KEY',
      'DB_PASSWORD',
      'PGPASSWORD',
      'CI_JOB_TOKEN',
      'DOCKER_AUTH_CONFIG',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'SLACK_BOT_TOKEN'
    ]) {
      expect(isSecretEnvName(name), name).toBe(true)
    }
  })

  it('catches a provider it has never heard of', () => {
    // The whole point of matching the suffix: an enumerated list of vendors is
    // wrong the moment a new vendor exists.
    expect(isSecretEnvName('SOMETHING_NEW_TOKEN')).toBe(true)
    expect(isSecretEnvName('ACME_WIDGETS_API_KEY')).toBe(true)
    expect(isSecretEnvName('MY_SERVICE_CREDENTIALS')).toBe(true)
  })

  it('leaves the machine environment alone', () => {
    for (const name of [
      'PATH',
      'Path',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      'ComSpec',
      'SystemRoot',
      'windir',
      'PATHEXT',
      'NODE_ENV',
      'TERM_PROGRAM',
      'LANG',
      'HOSTNAME',
      'NUMBER_OF_PROCESSORS',
      'PROCESSOR_ARCHITECTURE',
      'GIT_SSH_COMMAND',
      'NODE_OPTIONS',
      'ELECTRON_RENDERER_URL'
    ]) {
      expect(isSecretEnvName(name), name).toBe(false)
    }
  })

  it('keeps the names that point at a socket or a helper, not a secret', () => {
    // Stripping these would break git-over-SSH while protecting nothing: the
    // value is a path to something that holds the credential, not the credential.
    expect(isSecretEnvName('SSH_AUTH_SOCK')).toBe(false)
    expect(isSecretEnvName('GIT_ASKPASS')).toBe(false)
    expect(isSecretEnvName('SSH_ASKPASS')).toBe(false)
    expect(isSecretEnvName('XDG_SESSION_ID')).toBe(false)
  })

  it('matches whatever case the variable was spelled in', () => {
    // Upper case is a convention, not a guarantee, and real tools read
    // lower-case names. Under-matching leaks a credential; over-matching costs
    // one opt-in entry.
    expect(isSecretEnvName('github_token')).toBe(true)
    expect(isSecretEnvName('Github_Token')).toBe(true)
    expect(isSecretEnvName('aws_secret_access_key')).toBe(true)
  })

  it('honours an explicit opt-in, including for a name it would otherwise drop', () => {
    expect(isSecretEnvName('NPM_TOKEN', { allow: ['NPM_TOKEN'] })).toBe(false)
    expect(isSecretEnvName('NPM_TOKEN', { allow: ['OTHER'] })).toBe(true)
  })

  it('parses the opt-in list out of the environment honestly', () => {
    expect(parsePassEnv(undefined)).toEqual([])
    expect(parsePassEnv('')).toEqual([])
    expect(parsePassEnv('NPM_TOKEN, AWS_SECRET_ACCESS_KEY')).toEqual(['NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'])
    expect(parsePassEnv('NPM_TOKEN,,  ')).toEqual(['NPM_TOKEN'])
  })
})

describe('stripping the inherited layer', () => {
  it('removes the credentials and reports their names', () => {
    const { env, dropped } = stripSecretEnv({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      GITHUB_TOKEN: 'ghp_notarealtoken',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI',
      PGPASSWORD: 'hunter2',
      TERM_PROGRAM: 'vscode'
    })

    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'TERM_PROGRAM'])
    // The names are reported so a user can see what disappeared and why.
    expect(dropped.sort()).toEqual(['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'PGPASSWORD'])
  })

  it('never lets a credential value through under a surviving name', () => {
    const { env } = stripSecretEnv({ PATH: '/usr/bin', NPM_TOKEN: 'npm_secret' })
    expect(JSON.stringify(env)).not.toContain('npm_secret')
  })

  it('re-admits an explicitly permitted name without re-admitting the rest', () => {
    const { env, dropped } = stripSecretEnv(
      { NPM_TOKEN: 'npm_secret', AWS_SECRET_ACCESS_KEY: 'aws_secret' },
      { allow: ['NPM_TOKEN'] }
    )
    expect(env['NPM_TOKEN']).toBe('npm_secret')
    expect(dropped).toEqual(['AWS_SECRET_ACCESS_KEY'])
  })
})

// ---------------------------------------------------------------------------
// The wiring: an unwired filter protects nothing, so it is checked through the
// manager that actually builds the environment a child receives.
// ---------------------------------------------------------------------------

const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH'
let savedPath: string | undefined
let savedPathAlias: string | undefined

beforeEach(() => {
  savedPath = process.env['PATH']
  savedPathAlias = process.env['Path']
})

afterEach(() => {
  // `publish()` mirrors the resolved PATH back into the main process, which is
  // real behaviour — the test just must not leave that behind for its neighbours.
  if (savedPath === undefined) delete process.env['PATH']
  else process.env['PATH'] = savedPath
  if (savedPathAlias === undefined) delete process.env['Path']
  else process.env['Path'] = savedPathAlias
})

function managerWith(vars: Record<string, string>, platform: NodeJS.Platform = process.platform, passEnv?: string[]) {
  return new EnvironmentManager({
    userDataDir: 'userdata',
    managedRoot: 'managed-that-does-not-exist',
    scratchDir: 'scratch',
    platform,
    ...(passEnv ? { passEnv } : {}),
    readMachineEnvironment: async () => ({ path: vars[PATH_KEY] ?? '', vars, source: 'windows-registry' })
  })
}

describe('what a child process actually receives', () => {
  it('does not inherit a provider key that was merely exported in the shell', async () => {
    const manager = managerWith({
      [PATH_KEY]: '/usr/bin',
      HOME: '/home/dev',
      OPENAI_API_KEY: 'sk-should-never-be-inherited',
      AWS_SECRET_ACCESS_KEY: 'should-never-be-inherited'
    })

    await manager.init()
    const env = manager.getSnapshot().values

    expect(env['HOME']).toBe('/home/dev')
    expect(env['OPENAI_API_KEY']).toBeUndefined()
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain('should-never-be-inherited')
  })

  it('says which names it withheld, so the removal is not silent', async () => {
    const manager = managerWith({ [PATH_KEY]: '/usr/bin', NPM_TOKEN: 'npm_secret' })
    await manager.init()
    expect(manager.inheritedSecretsDropped).toEqual(['NPM_TOKEN'])
  })

  it('applies the same rule on a refresh, not only at boot', async () => {
    const manager = managerWith({ [PATH_KEY]: '/usr/bin', GITHUB_TOKEN: 'ghp_x' })
    await manager.init()
    const refreshed = await manager.refresh('manual-refresh')
    expect(refreshed.values['GITHUB_TOKEN']).toBeUndefined()
  })

  it('lets the user put a credential back deliberately', async () => {
    const manager = managerWith({ [PATH_KEY]: '/usr/bin', NPM_TOKEN: 'npm_secret' }, process.platform, [
      'NPM_TOKEN'
    ])
    await manager.init()
    expect(manager.getSnapshot().values['NPM_TOKEN']).toBe('npm_secret')
  })

  it('never blocks the variables the machine itself needs', async () => {
    const manager = managerWith({
      [PATH_KEY]: '/usr/bin',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      USERPROFILE: 'C:\\Users\\dev'
    })
    await manager.init()
    const env = manager.getSnapshot().values
    // Looked up through `envGet` because Windows resolution canonicalises every
    // key to upper case, and that is a property of the resolver, not this filter.
    const spec = platformSpec(process.platform)
    expect(envGet(env, 'ComSpec', spec)).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(envGet(env, 'SystemRoot', spec)).toBe('C:\\Windows')
    expect(envGet(env, 'TEMP', spec)).toBe('C:\\Temp')
  })
})
