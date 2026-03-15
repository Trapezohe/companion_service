import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, unlink } from 'node:fs/promises'

let sharedModulesPromise = null

async function getSharedModules() {
  if (!sharedModulesPromise) {
    sharedModulesPromise = (async () => {
      const tempHome = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-cron-scheduler-test-'))
      process.once('exit', () => {
        rmSync(tempHome, { recursive: true, force: true })
      })

      process.env.HOME = tempHome
      process.env.USERPROFILE = tempHome

      const configMod = await import('./config.mjs')
      const configDir = configMod.getConfigDir()
      const cronStore = await import('./cron-store.mjs')
      const runStore = await import('./run-store.mjs')
      const cacheBust = `${Date.now()}-${Math.random()}`
      const cronScheduler = await import(`./cron-scheduler.mjs?bust=${cacheBust}`)

      return {
        tempHome,
        configDir,
        cronStore,
        runStore,
        cronScheduler,
      }
    })()
  }

  return sharedModulesPromise
}

async function withTempHome(run) {
  const {
    tempHome,
    configDir,
    cronStore,
    runStore,
    cronScheduler,
  } = await getSharedModules()

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
    await mkdir(configDir, { recursive: true })
    await Promise.all([
      unlink(path.join(configDir, 'cron-jobs.json')).catch(() => undefined),
      unlink(path.join(configDir, 'cron-jobs.json.bak')).catch(() => undefined),
      unlink(path.join(configDir, 'cron-jobs.json.tmp')).catch(() => undefined),
      unlink(path.join(configDir, 'runs.json')).catch(() => undefined),
      unlink(path.join(configDir, 'runs.json.bak')).catch(() => undefined),
      unlink(path.join(configDir, 'runs.json.tmp')).catch(() => undefined),
    ])

    await cronStore.loadCronStore()
    await cronStore.clearCronStoreForTests()
    await runStore.clearRunStoreForTests()
    cronScheduler.stopCronScheduler()
    await run({ tempHome, cronStore, cronScheduler, runStore, scheduled, cleared })
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    cronScheduler.stopCronScheduler()
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



test('timer firings keep extension_chat jobs on pending replay even when automation executor is available', async () => {
  await withTempHome(async ({ cronStore, cronScheduler, scheduled }) => {
    const automationCalls = []

    await cronStore.upsertJob({
      id: 'job-extension-chat',
      name: 'Extension Chat Job',
      prompt: 'summarize',
      enabled: true,
      executor: 'extension_chat',
      sessionTarget: 'isolated',
      agentType: null,
      schedule: { kind: 'interval', minutes: 1 },
    })

    cronScheduler.startCronScheduler({
      automationExecutor: async (job) => {
        automationCalls.push(job.id)
        return { mode: 'companion_acp' }
      },
    })
    assert.equal(scheduled.length, 1)

    await scheduled[0].fn()

    const pending = cronStore.getPendingRuns()
    assert.equal(pending.length, 1)
    assert.deepEqual(automationCalls, [])
  })
})

test('timer firings route companion_acp jobs to automation executor instead of pending replay', async () => {
  await withTempHome(async ({ cronStore, cronScheduler, scheduled }) => {
    const automationCalls = []

    await cronStore.upsertJob({
      id: 'job-companion-acp',
      name: 'Companion ACP Job',
      prompt: 'summarize',
      enabled: true,
      executor: 'companion_acp',
      sessionTarget: 'isolated',
      agentType: 'codex',
      schedule: { kind: 'interval', minutes: 1 },
    })

    cronScheduler.startCronScheduler({
      automationExecutor: async (job) => {
        automationCalls.push(job.id)
        return { mode: 'companion_acp', sessionId: 'acp-1', runId: 'run-1' }
      },
    })
    assert.equal(scheduled.length, 1)

    await scheduled[0].fn()

    const pending = cronStore.getPendingRuns()
    assert.equal(pending.length, 0)
    assert.deepEqual(automationCalls, ['job-companion-acp'])
  })
})

test('timer firings retain occurrence-level pendingIds and record them in cron runs', async () => {
  await withTempHome(async ({ cronStore, cronScheduler, runStore, scheduled }) => {
    await cronStore.upsertJob({
      id: 'job-occurrence',
      name: 'Occurrence Job',
      enabled: true,
      schedule: { kind: 'interval', minutes: 1 },
    })

    cronScheduler.startCronScheduler()
    assert.equal(scheduled.length, 1)

    const firstCronTimer = scheduled[0]
    await firstCronTimer.fn()

    const secondCronTimer = scheduled
      .filter((timer) => timer.delay === 60_000)
      .at(-1)
    assert.ok(secondCronTimer)
    await secondCronTimer.fn()

    const pending = cronStore.getPendingRuns()
    assert.equal(pending.length, 2)
    assert.deepEqual(pending.map((item) => item.taskId), ['job-occurrence', 'job-occurrence'])
    assert.equal(new Set(pending.map((item) => item.pendingId)).size, 2)

    const runs = await runStore.listRuns({ type: 'cron', limit: 10, offset: 0 })
    assert.equal(runs.runs.length, 2)
    assert.deepEqual(
      runs.runs.map((run) => run.meta?.pendingId).sort(),
      pending.map((item) => item.pendingId).sort(),
    )

    cronScheduler.stopCronScheduler()
  })
})
