/**
 * The session ledger on disk.
 *
 * Two properties matter and neither is obvious: a charge must be on disk before
 * the caller continues (a charge still in memory when the app exits is time the
 * user paid for and lost), and the balance must be *derived* from the rows so
 * that editing one number cannot invent time.
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SessionLedger } from '../../src/main/services/session/ledger'
import { startSession, type SessionGrant } from '../../src/shared/session-time'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cryptoric-ledger-'))
  file = join(dir, 'sessions.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Buy a session. `tier` is what decides the charge: own is 5, hosted is 10. */
async function buy(now: number, tier: 'own' | 'hosted' = 'own'): Promise<SessionGrant> {
  const result = startSession({
    id: `g-${now}-${tier}`,
    model: 'm',
    tier,
    available: 20,
    now,
    projectRoot: dir,
    prompt: 'work'
  })
  if (!result.ok) throw new Error(result.error)
  return result.grant
}

describe('SessionLedger', () => {
  it('has the charge on disk before record() returns', async () => {
    const ledger = new SessionLedger(file)
    const grant = await buy(Date.now())
    await ledger.record(grant)
    // Read the file directly rather than asking the ledger: a write that only
    // the in-memory copy can see is not a write.
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { grants: SessionGrant[] }
    expect(onDisk.grants.map((g) => g.id)).toEqual([grant.id])
  })

  it('survives a restart', async () => {
    const first = new SessionLedger(file)
    const grant = await buy(Date.now())
    await first.record(grant)

    const second = new SessionLedger(file)
    await second.load()
    expect(second.list()).toHaveLength(1)
    expect(second.list()[0]?.id).toBe(grant.id)
  })

  it('totals what was charged today', async () => {
    const ledger = new SessionLedger(file)
    const day = new Date().toISOString().slice(0, 10)
    await ledger.record(await buy(Date.now(), 'own'))
    await ledger.record(await buy(Date.now(), 'hosted'))
    expect(ledger.chargedOn(day)).toBe(15)
    expect(ledger.chargedOn('1999-01-01')).toBe(0)
  })

  it('marks a session consumed exactly once', async () => {
    const ledger = new SessionLedger(file)
    const grant = await buy(Date.now())
    await ledger.record(grant)
    await ledger.markConsumed(grant.id)
    await ledger.markConsumed(grant.id)
    expect(ledger.list()[0]?.consumed).toBe(true)
  })

  it('starts empty when the file is corrupt, rather than charging for nothing', async () => {
    // A user owed the full allowance is the safe failure. Refusing to start
    // because a file is damaged would punish them for our bug.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ this is not json', 'utf8')
    const ledger = new SessionLedger(file)
    await ledger.load()
    expect(ledger.list()).toEqual([])
    expect(ledger.chargedOn(new Date().toISOString().slice(0, 10))).toBe(0)
  })

  it('does not lose concurrent charges', async () => {
    const ledger = new SessionLedger(file)
    const now = Date.now()
    // Two charges without awaiting between them: the queue has to serialise
    // them, or one overwrites the other.
    await Promise.all([ledger.record(await buy(now)), ledger.record(await buy(now + 1, 'hosted'))])
    expect(ledger.list()).toHaveLength(2)
    await ledger.settled()
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { grants: SessionGrant[] }
    expect(onDisk.grants).toHaveLength(2)
  })
})