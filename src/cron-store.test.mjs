import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

async function withTempHome(run) {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-cron-store-test-'))
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome

  try {
    // Cache-bust to get fresh module state
    const cacheBust = `${Date.now()}-${Math.random()}`
    const mod = await import(`./cron-store.mjs?bust=${cacheBust}`)
    await mod.loadCronStore()
    await run({ tempHome, mod })
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevUserProfile
    await rm(tempHome, { recursive: true, force: true })
  }
}

test('addPendingRun compacts older entries for the same taskId', async () => {
  await withTempHome(async ({ mod }) => {
    // Add 3 pending entries for the same task
    await mod.addPendingRun('task-a')
    await mod.addPendingRun('task-a')
    await mod.addPendingRun('task-a')

    const pending = mod.getPendingRuns()
    // Should only have 1 entry (latest), not 3
    assert.equal(pending.length, 1)
    assert.equal(pending[0].taskId, 'task-a')
  })
})

test('addPendingRun preserves entries for different taskIds', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.addPendingRun('task-a')
    await mod.addPendingRun('task-b')
    await mod.addPendingRun('task-a')  // replaces the first task-a

    const pending = mod.getPendingRuns()
    assert.equal(pending.length, 2)
    const taskIds = pending.map((p) => p.taskId).sort()
    assert.deepEqual(taskIds, ['task-a', 'task-b'])
  })
})

test('ackPendingRuns removes all entries for given taskIds', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.addPendingRun('task-a')
    await mod.addPendingRun('task-b')
    await mod.addPendingRun('task-c')

    await mod.ackPendingRuns(['task-a', 'task-c'])

    const pending = mod.getPendingRuns()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].taskId, 'task-b')
  })
})
