import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

async function withTempHome(run) {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-cron-scheduler-test-'))
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome

  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const scheduled = []
  const cleared = []

  globalThis.setTimeout = ((fn, delay) => {
    const timer = {
      id: scheduled.length + 1,
      delay,
      unref() {},
      fn,
    }
    scheduled.push(timer)
    return timer
  })
  globalThis.clearTimeout = ((timer) => {
    cleared.push(timer?.id ?? timer)
  })

  try {
    const cronStore = await import('./cron-store.mjs')
    await cronStore.loadCronStore()
    const cacheBust = `${Date.now()}-${Math.random()}`
    const cronScheduler = await import(`./cron-scheduler.mjs?bust=${cacheBust}`)
    await run({ tempHome, cronStore, cronScheduler, scheduled, cleared })
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevUserProfile
    await rm(tempHome, { recursive: true, force: true })
  }
}

test('startCronScheduler only schedules enabled jobs', async () => {
  await withTempHome(async ({ cronStore, cronScheduler, scheduled }) => {
    await cronStore.upsertJob({
      id: 'job-enabled',
      name: 'Enabled Job',
      enabled: true,
      schedule: { kind: 'interval', minutes: 5 },
    })
    await cronStore.upsertJob({
      id: 'job-disabled',
      name: 'Disabled Job',
      enabled: false,
      schedule: { kind: 'interval', minutes: 5 },
    })

    cronScheduler.startCronScheduler()
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].delay, 5 * 60_000)

    cronScheduler.stopCronScheduler()
  })
})

test('rescheduleJob clears existing timer before scheduling a new one', async () => {
  await withTempHome(async ({ cronScheduler, scheduled, cleared }) => {
    const job = {
      id: 'job-1',
      name: 'Job 1',
      enabled: true,
      schedule: { kind: 'interval', minutes: 1 },
    }

    cronScheduler.rescheduleJob(job)
    assert.equal(scheduled.length, 1)

    cronScheduler.rescheduleJob({
      ...job,
      schedule: { kind: 'interval', minutes: 2 },
    })
    assert.equal(cleared.length >= 1, true)
    assert.equal(scheduled.length, 2)
    assert.equal(scheduled[1].delay, 2 * 60_000)

    cronScheduler.stopCronScheduler()
  })
})
