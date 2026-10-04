/**
 * Live check: does the coin-allowance migration actually fix a real install?
 *
 * Copies the user's real `settings.json` shape into a temp directory, loads it
 * through the real `SettingsStore`, and asserts the retired 500-coin default is
 * gone. Written because the unit test proves the function and this proves the
 * wiring — the two failed separately once already.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../../src/main/services/settings/store'

let failures = 0
const pass = (m: string) => console.log(`[PASS] ${m}`)
const fail = (m: string) => { failures++; console.error(`[FAIL] ${m}`) }

const dir = mkdtempSync(join(tmpdir(), 'cryptoric-migration-'))
try {
  // Exactly what an install that predates the change has on disk.
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      version: 2,
      updatedAt: new Date().toISOString(),
      data: { usage: { dailyAllowanceCoins: 500, streakEnabled: false, lowBalanceWarningAt: 50 } }
    }),
    'utf8'
  )

  const store = new SettingsStore({ userDataDir: dir })
  await store.load()
  const usage = store.get().usage

  if (usage.dailyAllowanceCoins === 25) pass(`retired default migrated: 500 -> ${usage.dailyAllowanceCoins}`)
  else fail(`still ${usage.dailyAllowanceCoins}, expected 25`)

  if (usage.lowBalanceWarningAt === 5) pass(`warning threshold migrated: 50 -> ${usage.lowBalanceWarningAt}`)
  else fail(`warning still ${usage.lowBalanceWarningAt}, expected 5`)

  // A second load must be a no-op, or the migration would run forever.
  await store.load()
  if (store.get().usage.dailyAllowanceCoins === 25) pass('second load is idempotent')
  else fail('second load changed the value again')
} finally {
  console.log(`--- ${failures} failed ---`)
  rmSync(dir, { recursive: true, force: true })
  process.exitCode = failures === 0 ? 0 : 1
}
