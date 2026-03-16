import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

async function withTempConfig(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-rollup-store-'))
  const prevDir = process.env.TRAPEZOHE_CONFIG_DIR
  process.env.TRAPEZOHE_CONFIG_DIR = dir
  try {
    const mod = await import(`./automation-rollup-store.mjs?bust=${Date.now()}-${Math.random()}`)
    await mod.clearAutomationRollupStoreForTests()
    await run(mod, dir)
    await mod.flushAutomationRollupStore()
  } finally {
    process.env.TRAPEZOHE_CONFIG_DIR = prevDir
    await rm(dir, { recursive: true, force: true })
  }
}

test('rollup store round-trips a day rollup by persistent key and date', async () => {
  await withTempConfig(async (store) => {
    const rollup = {
      headline: 'Market update',
      keyFindings: ['BTC up 5%', 'ETH stable'],
      unresolved: ['Macro risk'],
      nextAnchor: 'Continue monitoring',
      runCount: 3,
    }

    const saved = await store.setRollup('persistent:research-loop', '2026-03-16', rollup)
    assert.deepEqual(saved, rollup)

    const loaded = await store.getRollup('persistent:research-loop', '2026-03-16')
    assert.deepEqual(loaded, rollup)

    // Different session key should return null
    const other = await store.getRollup('persistent:other-loop', '2026-03-16')
    assert.equal(other, null)

    // Different date should return null
    const otherDate = await store.getRollup('persistent:research-loop', '2026-03-15')
    assert.equal(otherDate, null)
  })
})

test('rollup store persists across reimport', async () => {
  await withTempConfig(async (store, dir) => {
    await store.setRollup('persistent:persist-test', '2026-01-01', { headline: 'test' })
    await store.flushAutomationRollupStore()

    // Reimport from same config dir
    const mod2 = await import(`./automation-rollup-store.mjs?bust=${Date.now()}-reimport`)
    process.env.TRAPEZOHE_CONFIG_DIR = dir
    const loaded = await mod2.getRollup('persistent:persist-test', '2026-01-01')
    assert.deepEqual(loaded, { headline: 'test' })
  })
})

test('rollup store lists rollups for a session sorted by date', async () => {
  await withTempConfig(async (store) => {
    await store.setRollup('persistent:list-test', '2026-03-15', { headline: 'day1' })
    await store.setRollup('persistent:list-test', '2026-03-16', { headline: 'day2' })
    await store.setRollup('persistent:other', '2026-03-16', { headline: 'other' })

    const rollups = await store.listRollups('persistent:list-test')
    assert.equal(rollups.length, 2)
    assert.equal(rollups[0].dateStr, '2026-03-15')
    assert.equal(rollups[1].dateStr, '2026-03-16')
    assert.equal(rollups[0].rollup.headline, 'day1')
    assert.equal(rollups[1].rollup.headline, 'day2')
  })
})

test('rollup store rejects invalid session keys', async () => {
  await withTempConfig(async (store) => {
    const result = await store.setRollup('not-persistent', '2026-03-16', { headline: 'test' })
    assert.equal(result, null)

    const loaded = await store.getRollup('not-persistent', '2026-03-16')
    assert.equal(loaded, null)
  })
})

test('sweepRollups removes entries older than maxDays', async () => {
  await withTempConfig(async (store) => {
    // Set up entries spanning many days
    await store.setRollup('persistent:sweep-test', '2020-01-01', { headline: 'very old' })
    await store.setRollup('persistent:sweep-test', '2020-01-15', { headline: 'old' })
    const today = new Date().toISOString().slice(0, 10)
    await store.setRollup('persistent:sweep-test', today, { headline: 'today' })

    const removed = await store.sweepRollups('persistent:sweep-test', 30)
    assert.equal(removed, 2) // the two 2020 entries

    const remaining = await store.listRollups('persistent:sweep-test')
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].dateStr, today)
  })
})

test('removeRollupsForSession removes all rollups for a given session', async () => {
  await withTempConfig(async (store) => {
    await store.setRollup('persistent:orphan', '2026-03-15', { headline: 'a' })
    await store.setRollup('persistent:orphan', '2026-03-16', { headline: 'b' })
    await store.setRollup('persistent:keep', '2026-03-16', { headline: 'keep' })

    const removed = await store.removeRollupsForSession('persistent:orphan')
    assert.equal(removed, 2)

    const orphanRollups = await store.listRollups('persistent:orphan')
    assert.equal(orphanRollups.length, 0)

    const keepRollups = await store.listRollups('persistent:keep')
    assert.equal(keepRollups.length, 1)
  })
})
