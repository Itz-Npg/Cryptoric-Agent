import { describe, expect, it } from 'vitest'
import { compareVersions, describeConstraint, parseVersion, satisfiesConstraint } from '../../src/main/services/env/semver'

describe('parseVersion', () => {
  it('parses partial versions and fills missing components with zero', () => {
    expect(parseVersion('v22.11')).toEqual({ major: 22, minor: 11, patch: 0, prerelease: null })
    expect(parseVersion('3')).toEqual({ major: 3, minor: 0, patch: 0, prerelease: null })
  })

  it('captures prerelease tags', () => {
    expect(parseVersion('1.2.3-rc.1')?.prerelease).toBe('rc.1')
  })

  it('returns null for non-versions', () => {
    expect(parseVersion('not-a-version')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions(parseVersion('2.0.0')!, parseVersion('10.0.0')!)).toBe(-1)
    expect(compareVersions(parseVersion('1.10.0')!, parseVersion('1.9.0')!)).toBe(1)
    expect(compareVersions(parseVersion('1.2.3')!, parseVersion('1.2.3')!)).toBe(0)
  })

  it('sorts a prerelease below its release', () => {
    expect(compareVersions(parseVersion('1.2.3-rc.1')!, parseVersion('1.2.3')!)).toBe(-1)
  })
})

describe('satisfiesConstraint', () => {
  it('honours minimum-version constraints', () => {
    expect(satisfiesConstraint('20.20.2', '>=18')).toBe(true)
    expect(satisfiesConstraint('16.20.2', '>=18')).toBe(false)
  })

  it('honours caret ranges within a major line', () => {
    expect(satisfiesConstraint('18.9.0', '^18.2')).toBe(true)
    expect(satisfiesConstraint('19.0.0', '^18.2')).toBe(false)
  })

  it('honours tilde ranges within a minor line', () => {
    expect(satisfiesConstraint('3.9.7', '~3.9')).toBe(true)
    expect(satisfiesConstraint('3.10.0', '~3.9')).toBe(false)
  })

  it('honours wildcard majors', () => {
    expect(satisfiesConstraint('22.3.0', '22.x')).toBe(true)
    expect(satisfiesConstraint('21.9.0', '22.x')).toBe(false)
  })

  it('treats || alternatives as OR', () => {
    expect(satisfiesConstraint('20.1.0', '18 || 20')).toBe(true)
    expect(satisfiesConstraint('19.1.0', '18 || 20')).toBe(false)
  })

  it('returns true for an absent constraint and false for an unparseable version', () => {
    expect(satisfiesConstraint('1.0.0', null)).toBe(true)
    expect(satisfiesConstraint('garbage', '>=1')).toBe(false)
  })

  it('excludes prereleases from a plain release constraint', () => {
    expect(satisfiesConstraint('2.0.0-rc.1', '>=2.0.0')).toBe(false)
  })
})

describe('describeConstraint', () => {
  it('normalises a bare major into a minimum', () => {
    expect(describeConstraint('22')).toBe('>=22')
  })

  it('preserves explicit operators and alternatives', () => {
    expect(describeConstraint('^18 || >=20')).toBe('^18 || >=20')
  })
})