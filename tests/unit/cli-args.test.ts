/**
 * CLI argument parsing.
 *
 * The parser is the CLI's outermost trust boundary: it is the only thing
 * standing between a typo and a flag that silently does not apply. `--yes` is
 * the sharpest example — dropping it because it was misspelled would leave the
 * run asking for approval it should have asked for, and accepting it because it
 * was unknown would pre-approve destructive work. Both directions have to fail
 * loudly.
 */

import { describe, expect, it } from 'vitest'
import { HELP_TEXT, parseArgs } from '../../cli/src/args'

describe('parseArgs', () => {
  it('opens the interactive session when given nothing', () => {
    // `cryptoric` with no subcommand is the product: a prompt box. Help is what
    // you get when you ask for it, not what you get for having a shell.
    const result = parseArgs([])
    expect(result).toEqual({ ok: true, command: { kind: 'chat' } })
  })

  it('still reaches help on request', () => {
    expect(parseArgs(['help'])).toEqual({ ok: true, command: { kind: 'help' } })
  })

  it.each([
    [['help']],
    [['--help']],
    [['-h']]
  ])('treats %j as help', (argv) => {
    expect(parseArgs(argv)).toEqual({ ok: true, command: { kind: 'help' } })
  })

  it.each([
    [['version']],
    [['--version']],
    [['-v']]
  ])('treats %j as a version request', (argv) => {
    expect(parseArgs(argv)).toEqual({ ok: true, command: { kind: 'version' } })
  })

  it('rejects an unknown command rather than guessing', () => {
    const result = parseArgs(['frobnicate'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Unknown command')
  })

  it('rejects an unknown option rather than ignoring it', () => {
    const result = parseArgs(['run', 'do a thing', '--yes-please'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Unknown option')
  })

  it('rejects a misspelled safety flag instead of dropping it', () => {
    // The regression this guards: `--yes` typed as `--ye` silently running with
    // interactive approvals, or worse, an unknown flag being treated as "allow".
    const result = parseArgs(['run', 'do a thing', '--ye'])
    expect(result.ok).toBe(false)
  })

  it('rejects a run with no task', () => {
    const result = parseArgs(['run'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Nothing to run')
  })

  it('joins an unquoted multi-word task', () => {
    const result = parseArgs(['run', 'add', 'a', 'readme'])
    expect(result.ok).toBe(true)
    if (result.ok && result.command.kind === 'run') {
      expect(result.command.task).toBe('add a readme')
    }
  })

  it('defaults approval to prompting, never to allowing', () => {
    const result = parseArgs(['run', 'do a thing'])
    expect(result.ok).toBe(true)
    if (result.ok && result.command.kind === 'run') {
      expect(result.command.approval).toBe('prompt')
    }
  })

  it('honours --yes', () => {
    const result = parseArgs(['run', 'do a thing', '--yes'])
    expect(result.ok).toBe(true)
    if (result.ok && result.command.kind === 'run') {
      expect(result.command.approval).toBe('allow')
    }
  })

  it('honours --deny', () => {
    const result = parseArgs(['run', 'do a thing', '--deny'])
    expect(result.ok).toBe(true)
    if (result.ok && result.command.kind === 'run') {
      expect(result.command.approval).toBe('deny')
    }
  })

  it('reads --cwd', () => {
    const result = parseArgs(['run', 'x', '--cwd', '/tmp/project'])
    expect(result.ok).toBe(true)
    if (result.ok && result.command.kind === 'run') {
      expect(result.command.cwd).toBe('/tmp/project')
    }
  })

  it('accepts --flag=value as well as --flag value', () => {
    const result = parseArgs(['run', 'x', '--cwd=/tmp/other'])
    expect(result.ok).toBe(true)
    if (result.ok && result.command.kind === 'run') {
      expect(result.command.cwd).toBe('/tmp/other')
    }
  })

  it('rejects a value flag with no value', () => {
    const result = parseArgs(['run', 'x', '--cwd'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('needs a value')
  })

  it('converts --timeout seconds to milliseconds', () => {
    const result = parseArgs(['run', 'x', '--timeout', '90'])
    expect(result.ok).toBe(true)
    if (result.ok && result.command.kind === 'run') {
      expect(result.command.timeoutMs).toBe(90_000)
    }
  })

  it.each([['0'], ['-5'], ['abc']])('rejects --timeout %s', (value) => {
    const result = parseArgs(['run', 'x', '--timeout', value])
    expect(result.ok).toBe(false)
  })

  it('parses tools with and without --json', () => {
    expect(parseArgs(['tools'])).toEqual({ ok: true, command: { kind: 'tools', json: false } })
    expect(parseArgs(['tools', '--json'])).toEqual({ ok: true, command: { kind: 'tools', json: true } })
  })

  it('rejects an unknown option to tools', () => {
    const result = parseArgs(['tools', '--nope'])
    expect(result.ok).toBe(false)
  })

  it('documents every exit code it can return', () => {
    // The codes are a published contract for scripts. A verdict with no
    // documented code is a verdict nobody can branch on.
    for (const line of ['0 COMPLETED', '1 FAILED', '2 BLOCKED', '3 CANCELLED']) {
      expect(HELP_TEXT).toContain(line)
    }
  })
})