import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

async function withTempConfig(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-automation-budget-store-'))
  const prevConfigDir = process.env.TRAPEZOHE_CONFIG_DIR
  let mod
  process.env.TRAPEZOHE_CONFIG_DIR = tempDir

  try {
    const cacheBust = `${Date.now()}-${Math.random()}`
    mod = await import(`./automation-budget-store.mjs?bust=${cacheBust}`)
    await mod.clearAutomationBudgetStoreForTests()
    await run({ tempDir, mod })
  } finally {
    await mod?.flushAutomationBudgetStore?.().catch(() => undefined)
    if (prevConfigDir === undefined) delete process.env.TRAPEZOHE_CONFIG_DIR
    else process.env.TRAPEZOHE_CONFIG_DIR = prevConfigDir
    await rm(tempDir, { recursive: true, force: true })
  }
}

test('automation budget store persists ledgers by persistent session key', async () => {
  await withTempConfig(async ({ mod }) => {
    await mod.setAutomationBudgetLedger('persistent:research-loop', {
      approxInputTokens: 12,
      approxOutputTokens: 7,
      compactionCount: 2,
      lastRollupAt: 1_700_000_000_000,
      health: 'warning',
    })
    await mod.flushAutomationBudgetStore()

    const listed = await mod.listAutomationBudgetLedgers()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].key, 'persistent:research-loop')

    const cacheBust = `${Date.now()}-${Math.random()}`
    const reloaded = await import(`./automation-budget-store.mjs?bust=${cacheBust}`)
    const ledger = await reloaded.getAutomationBudgetLedger('persistent:research-loop')
    assert.deepEqual(ledger, {
      approxInputTokens: 12,
      approxOutputTokens: 7,
      compactionCount: 2,
      lastRollupAt: 1_700_000_000_000,
      health: 'warning',
    })
  })
})
