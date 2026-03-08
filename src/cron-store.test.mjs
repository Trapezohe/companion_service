import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'

async function withTempHome(run, options = {}) {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-cron-store-test-'))
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome

  try {
    const configMod = await import('./config.mjs')
    const configDir = configMod.getConfigDir()
    await mkdir(configDir, { recursive: true })
    await Promise.all([
      unlink(path.join(configDir, 'cron-jobs.json')).catch(() => undefined),
      unlink(path.join(configDir, 'cron-jobs.json.bak')).catch(() => undefined),
      unlink(path.join(configDir, 'cron-jobs.json.tmp')).catch(() => undefined),
    ])

    if (typeof options.beforeLoad === 'function') {
      await options.beforeLoad({ tempHome, configDir })
    }

    const cacheBust = `${Date.now()}-${Math.random()}`
    const mod = await import(`./cron-store.mjs?bust=${cacheBust}`)
    await mod.loadCronStore()
    if (!options.preserveStore) {
      await mod.clearCronStoreForTests()
    }
    await run({ tempHome, configDir, mod })
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevUserProfile
    await rm(tempHome, { recursive: true, force: true })
  }
}

test('addPendingRun preserves distinct occurrences for the same taskId', async () => {
  await withTempHome(async ({ mod }) => {
    const first = await mod.addPendingRun('task-a')
    const second = await mod.addPendingRun('task-a')
    const third = await mod.addPendingRun('task-a')

    const pending = mod.getPendingRuns()
    assert.equal(pending.length, 3)
    assert.deepEqual(pending.map((item) => item.taskId), ['task-a', 'task-a', 'task-a'])
    assert.equal(new Set(pending.map((item) => item.pendingId)).size, 3)
    assert.equal(first.pendingId, pending[0].pendingId)
    assert.equal(second.pendingId, pending[1].pendingId)
    assert.equal(third.pendingId, pending[2].pendingId)
  })
})

test('addPendingRun preserves entries for different taskIds', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.addPendingRun('task-a')
    await mod.addPendingRun('task-b')
    await mod.addPendingRun('task-a')

    const pending = mod.getPendingRuns()
    assert.equal(pending.length, 3)
    assert.deepEqual(pending.map((item) => item.taskId), ['task-a', 'task-b', 'task-a'])
  })
})

test('ackPendingRuns removes only the requested pendingIds', async () => {
  await withTempHome(async ({ mod }) => {
    const first = await mod.addPendingRun('task-a')
    const second = await mod.addPendingRun('task-a')
    const third = await mod.addPendingRun('task-c')

    const acked = await mod.ackPendingRuns({
      pendingIds: [first.pendingId, third.pendingId],
    })
    assert.equal(acked, 2)

    const pending = mod.getPendingRuns()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].pendingId, second.pendingId)
    assert.equal(pending[0].taskId, 'task-a')
  })
})

test('ackPendingRuns still supports legacy taskIds', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.addPendingRun('task-a')
    await mod.addPendingRun('task-a')
    const other = await mod.addPendingRun('task-b')

    const acked = await mod.ackPendingRuns(['task-a'])
    assert.equal(acked, 2)

    const pending = mod.getPendingRuns()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].pendingId, other.pendingId)
  })
})

test('addPendingRun returns a correlated pending record with stable fields', async () => {
  await withTempHome(async ({ mod }) => {
    const pending = await mod.addPendingRun('task-z')
    assert.equal(pending.taskId, 'task-z')
    assert.equal(typeof pending.pendingId, 'string')
    assert.equal(typeof pending.missedAt, 'number')
  })
})

test('loadCronStore backfills stable pendingIds for legacy pending entries', async () => {
  await withTempHome(async ({ mod, configDir }) => {
    await mkdir(configDir, { recursive: true })
    await writeFile(path.join(configDir, 'cron-jobs.json'), JSON.stringify({
      jobs: [],
      pending: [
        { taskId: 'legacy-task', missedAt: 1234 },
      ],
    }, null, 2))

    await mod.loadCronStore()
    const firstLoad = mod.getPendingRuns()
    assert.equal(firstLoad.length, 1)
    assert.equal(firstLoad[0].taskId, 'legacy-task')
    assert.equal(typeof firstLoad[0].pendingId, 'string')

    const firstPendingId = firstLoad[0].pendingId
    await mod.loadCronStore()
    const secondLoad = mod.getPendingRuns()
    assert.equal(secondLoad[0].pendingId, firstPendingId)
  })
})

test('cron store falls back to backup file when main file is corrupted', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.loadCronStore()

    assert.deepEqual(mod.getJobs(), [{ id: 'job-backup', name: 'Recovered Job', enabled: true }])
    assert.deepEqual(mod.getPendingRuns(), [{ taskId: 'task-backup', pendingId: 'pending-backup', missedAt: 1234 }])
  }, {
    preserveStore: true,
    beforeLoad: async ({ configDir }) => {
      const backupPayload = JSON.stringify({
        jobs: [{ id: 'job-backup', name: 'Recovered Job', enabled: true }],
        pending: [{ taskId: 'task-backup', pendingId: 'pending-backup', missedAt: 1234 }],
      }, null, 2)
      await writeFile(path.join(configDir, 'cron-jobs.json.bak'), `${backupPayload}\n`, 'utf8')
      await writeFile(path.join(configDir, 'cron-jobs.json'), '{ invalid json', 'utf8')
    },
  })
})

test('cron store writes via tmp plus backup and leaves no orphan tmp file', async () => {
  await withTempHome(async ({ mod, configDir }) => {
    const cronFile = path.join(configDir, 'cron-jobs.json')
    const backupFile = path.join(configDir, 'cron-jobs.json.bak')
    const tmpFile = path.join(configDir, 'cron-jobs.json.tmp')

    await mod.upsertJob({
      id: 'job-original',
      name: 'Original Job',
      enabled: true,
      schedule: { kind: 'interval', minutes: 5 },
    })
    await mod.upsertJob({
      id: 'job-next',
      name: 'Next Job',
      enabled: true,
      schedule: { kind: 'interval', minutes: 10 },
    })

    const primary = JSON.parse(await readFile(cronFile, 'utf8'))
    const backup = JSON.parse(await readFile(backupFile, 'utf8'))

    assert.equal(primary.jobs.length, 2)
    assert.equal(backup.jobs.length, 1)
    await assert.rejects(access(tmpFile))
  })
})

test('upsertJob preserves nextRunAt metadata', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.upsertJob({
      id: 'job-next',
      name: 'Job next',
      enabled: true,
      schedule: { kind: 'interval', minutes: 5 },
      nextRunAt: 123456,
    })

    const jobs = mod.getJobs()
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].nextRunAt, 123456)
  })
})
