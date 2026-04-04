import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'

async function withTempHome(run, options = {}) {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-run-store-test-'))
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  const prevMaxRuns = process.env.TRAPEZOHE_MAX_RUNS
  let mod
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome
  if (options.maxRuns) {
    process.env.TRAPEZOHE_MAX_RUNS = String(options.maxRuns)
  } else {
    delete process.env.TRAPEZOHE_MAX_RUNS
  }

  try {
    const cacheBust = `${Date.now()}-${Math.random()}`
    mod = await import(`./run-store.mjs?bust=${cacheBust}`)
    await mod.loadRunStore()
    await run({ tempHome, mod })
  } finally {
    // Flush any debounced writes before removing the temp HOME to avoid
    // unhandled async ENOENT errors after the test finishes.
    await mod?.flushRunStore?.().catch(() => undefined)
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevUserProfile
    if (prevMaxRuns === undefined) delete process.env.TRAPEZOHE_MAX_RUNS
    else process.env.TRAPEZOHE_MAX_RUNS = prevMaxRuns
    await rm(tempHome, { recursive: true, force: true })
  }
}

test('run store supports create -> update -> list -> get -> diagnostics', async () => {
  await withTempHome(async ({ mod }) => {
    const run = await mod.createRun({
      type: 'exec',
      state: 'running',
      summary: 'Executing command',
      startedAt: Date.now(),
      sessionId: 'session-exec-1',
      sessionType: 'chat/main',
      laneId: 'remote:exec',
      source: 'remote',
      contractVersion: 2,
      meta: { command: 'echo ok' },
    })
    assert.ok(run.runId)
    assert.equal(run.state, 'running')
    assert.equal(run.sessionId, 'session-exec-1')
    assert.equal(run.sessionType, 'chat/main')
    assert.equal(run.laneId, 'remote:exec')
    assert.equal(run.source, 'remote')
    assert.equal(run.contractVersion, 2)
    assert.equal(run.attemptId, `${run.runId}:attempt-1`)
    assert.equal(run.meta?.sessionType, 'chat/main')

    const updated = await mod.updateRun(run.runId, {
      state: 'done',
      finishedAt: Date.now(),
      summary: 'Command completed',
    })
    assert.equal(updated.state, 'done')
    assert.equal(typeof updated.finishedAt, 'number')

    const listed = await mod.listRuns({ type: 'exec', limit: 10 })
    assert.equal(listed.total, 1)
    assert.equal(listed.runs[0].runId, run.runId)
    assert.equal(listed.runs[0].durationMs !== null, true)

    const fetched = await mod.getRunById(run.runId)
    assert.equal(fetched.runId, run.runId)
    assert.equal(fetched.state, 'done')
    assert.equal(fetched.sessionId, 'session-exec-1')
    assert.equal(fetched.sessionType, 'chat/main')
    assert.equal(fetched.contractVersion, 2)

    const diagnostics = await mod.getRunDiagnostics({ limit: 20 })
    assert.equal(diagnostics.ok, true)
    assert.equal(diagnostics.sampled >= 1, true)
    assert.equal(diagnostics.byType.exec.total >= 1, true)
    assert.equal(typeof diagnostics.generatedAt, 'number')
  })
})

test('run store keeps only max configured runs', async () => {
  await withTempHome(async ({ mod }) => {
    for (let index = 0; index < 6; index += 1) {
      const created = await mod.createRun({
        type: 'exec',
        state: 'done',
        summary: `run-${index}`,
      })
      await mod.updateRun(created.runId, {
        state: 'done',
        finishedAt: Date.now(),
      })
    }

    await mod.flushRunStore()
    const listed = await mod.listRuns({ limit: 20, offset: 0 })
    assert.equal(listed.total, 3)
    const summaries = new Set(listed.runs.map((item) => item.summary))
    assert.equal(summaries.has('run-5'), true)
    assert.equal(summaries.has('run-4'), true)
    assert.equal(summaries.has('run-3'), true)
    assert.equal(summaries.has('run-2'), false)
  }, { maxRuns: 3 })
})

test('run store falls back to backup file when main file is corrupted', async () => {
  await withTempHome(async ({ mod }) => {
    const configMod = await import('./config.mjs')
    const configDir = configMod.getConfigDir()
    await mod.createRun({
      runId: 'run-backup',
      type: 'heartbeat',
      state: 'done',
      summary: 'from backup',
    })
    await mod.flushRunStore()

    const runsFile = path.join(configDir, 'runs.json')
    const backupFile = path.join(configDir, 'runs.json.bak')
    const baseline = await mod.listRuns({ limit: 20, offset: 0 })
    const rawRuns = baseline.runs.map(({ durationMs, ...rest }) => rest)
    const payload = JSON.stringify({ runs: rawRuns }, null, 2) + '\n'
    await writeFile(backupFile, payload, 'utf8')
    await writeFile(runsFile, '{ invalid json', 'utf8')

    const cacheBust = `${Date.now()}-${Math.random()}`
    const reloaded = await import(`./run-store.mjs?bust=${cacheBust}`)
    await reloaded.loadRunStore()

    const run = await reloaded.getRunById('run-backup')
    assert.ok(run)
    assert.equal(run.summary, 'from backup')
  })
})

test('run store persists runs across module reload', async () => {
  await withTempHome(async ({ mod }) => {
    const created = await mod.createRun({
      runId: 'run-persisted',
      type: 'exec',
      state: 'done',
      summary: 'persist me',
    })
    assert.equal(created.runId, 'run-persisted')
    await mod.flushRunStore()

    const cacheBust = `${Date.now()}-${Math.random()}`
    const reloaded = await import(`./run-store.mjs?bust=${cacheBust}`)
    await reloaded.loadRunStore()

    const fetched = await reloaded.getRunById('run-persisted')
    assert.ok(fetched)
    assert.equal(fetched.summary, 'persist me')
  })
})

test('run store loads mixed legacy persisted rows and keeps replay lineage across upgrade reload', async () => {
  await withTempHome(async () => {
    const configMod = await import('./config.mjs')
    const configDir = configMod.getConfigDir()
    const replayLineage = {
      kind: 'cron_pending',
      pendingId: 'pending-upgrade-1',
      taskId: 'job-upgrade-1',
      missedAt: 1_710_000_000_500,
    }

    await writeFile(
      path.join(configDir, 'runs.json'),
      JSON.stringify({
        runs: [
          {
            runId: 'run-legacy-upgrade',
            type: 'session',
            state: 'running',
            createdAt: 1_710_000_000_000,
            updatedAt: 1_710_000_000_100,
            meta: {
              sessionId: 'session-legacy-upgrade',
              command: 'node legacy.js',
            },
          },
          {
            runId: 'run-replay-upgrade',
            type: 'acp',
            state: 'running',
            createdAt: 1_710_000_000_200,
            updatedAt: 1_710_000_000_300,
            source: 'replay',
            sessionType: 'acp/acp-replay-upgrade',
            parentRunId: 'run-parent-upgrade',
            contractVersion: 2,
            meta: {
              sessionId: 'acp-replay-upgrade',
              sessionType: 'acp/acp-replay-upgrade',
              replayOf: replayLineage,
            },
          },
        ],
        sessionLinks: {
          'session-legacy-upgrade': { runId: 'run-legacy-upgrade' },
          'acp-replay-upgrade': { runId: 'run-replay-upgrade', type: 'acp' },
        },
        actionLinks: {},
      }, null, 2) + '\n',
      'utf8',
    )

    const cacheBust = `${Date.now()}-${Math.random()}`
    const reloaded = await import(`./run-store.mjs?bust=${cacheBust}`)
    await reloaded.loadRunStore()

    const legacy = await reloaded.getRunById('run-legacy-upgrade')
    assert.ok(legacy)
    assert.equal(legacy.contractVersion, 1)
    assert.equal(legacy.sessionId, 'session-legacy-upgrade')
    assert.equal(legacy.attemptId, undefined)

    const replay = await reloaded.getRunById('run-replay-upgrade')
    assert.ok(replay)
    assert.equal(replay.contractVersion, 2)
    assert.equal(replay.sessionId, 'acp-replay-upgrade')
    assert.equal(replay.sessionType, 'acp/acp-replay-upgrade')
    assert.equal(replay.source, 'replay')
    assert.equal(replay.parentRunId, 'run-parent-upgrade')
    assert.deepEqual(replay.meta?.replayOf, replayLineage)
    assert.equal(typeof replay.attemptId, 'string')

    const replayLink = await reloaded.getSessionRunLink('acp-replay-upgrade')
    assert.equal(replayLink?.runId, 'run-replay-upgrade')
  })
})

test('clearRunStoreForTests prevents stale backup recovery after the primary file is corrupted', async () => {
  await withTempHome(async ({ mod }) => {
    const configMod = await import('./config.mjs')
    const configDir = configMod.getConfigDir()
    const runsFile = path.join(configDir, 'runs.json')
    const backupFile = path.join(configDir, 'runs.json.bak')

    await mod.createRun({
      runId: 'run-cleared-backup',
      type: 'exec',
      state: 'done',
      summary: 'should not come back',
    })
    await mod.flushRunStore()

    await writeFile(backupFile, await readFile(runsFile, 'utf8'), 'utf8')

    await mod.clearRunStoreForTests()
    await writeFile(runsFile, '{ invalid json', 'utf8')

    const cacheBust = `${Date.now()}-${Math.random()}`
    const reloaded = await import(`./run-store.mjs?bust=${cacheBust}`)
    await reloaded.loadRunStore()

    assert.equal(await reloaded.getRunById('run-cleared-backup'), null)
    const listed = await reloaded.listRuns({ limit: 10, offset: 0 })
    assert.equal(listed.total, 0)
  })
})

test('run store preserves lifecycle phase meta across reload', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.createRun({
      runId: 'run-lifecycle-meta',
      type: 'cron',
      state: 'done',
      summary: 'persist lifecycle meta',
      meta: {
        taskState: 'done',
        stepState: 'deliver',
        lifecycleSummary: 'Lifecycle summary ready.',
      },
    })
    await mod.flushRunStore()

    const cacheBust = `${Date.now()}-${Math.random()}`
    const reloaded = await import(`./run-store.mjs?bust=${cacheBust}`)
    await reloaded.loadRunStore()

    const fetched = await reloaded.getRunById('run-lifecycle-meta')
    assert.ok(fetched)
    assert.equal(fetched.meta?.taskState, 'done')
    assert.equal(fetched.meta?.stepState, 'deliver')
    assert.equal(fetched.meta?.lifecycleSummary, 'Lifecycle summary ready.')
  })
})

test('run store preserves workflow step ledgers across reload', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.createRun({
      runId: 'run-workflow-meta',
      type: 'cron',
      state: 'running',
      summary: 'persist workflow meta',
      meta: {
        workflow: {
          template: 'research_synthesis',
          state: {
            currentStepId: 'research',
            steps: [
              { id: 'plan', kind: 'plan', state: 'done', runId: 'run-workflow-meta', summary: 'Plan ready.' },
              { id: 'research', kind: 'research', state: 'running', runId: 'run-workflow-meta', summary: null },
              { id: 'synthesize', kind: 'synthesize', state: 'queued', runId: null, summary: null },
            ],
            lastWorkflowSummary: 'Plan ready.',
          },
        },
      },
    })
    await mod.flushRunStore()

    const cacheBust = `${Date.now()}-${Math.random()}`
    const reloaded = await import(`./run-store.mjs?bust=${cacheBust}`)
    await reloaded.loadRunStore()

    const fetched = await reloaded.getRunById('run-workflow-meta')
    assert.ok(fetched)
    assert.equal(fetched.meta?.workflow?.template, 'research_synthesis')
    assert.equal(fetched.meta?.workflow?.state?.currentStepId, 'research')
    assert.equal(fetched.meta?.workflow?.state?.steps?.[0]?.summary, 'Plan ready.')
    assert.equal(fetched.meta?.workflow?.state?.steps?.[1]?.state, 'running')
    assert.equal(fetched.meta?.workflow?.state?.lastWorkflowSummary, 'Plan ready.')
  })
})

test('run store persists session-to-run links across module reload', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.setSessionRunLink('session-1', 'run-1', { type: 'session' })
    await mod.flushRunStore()

    const cacheBust = `${Date.now()}-${Math.random()}`
    const reloaded = await import(`./run-store.mjs?bust=${cacheBust}`)
    await reloaded.loadRunStore()

    const link = await reloaded.getSessionRunLink('session-1')
    assert.deepEqual(link, {
      runId: 'run-1',
      type: 'session',
      updatedAt: link.updatedAt,
    })
    assert.equal(typeof link.updatedAt, 'number')
  })
})

test('run store returns null for missing run updates', async () => {
  await withTempHome(async ({ mod }) => {
    const updated = await mod.updateRun('missing-run', {
      state: 'done',
      summary: 'should not exist',
    })
    assert.equal(updated, null)
  })
})

test('run store filters by state and paginates deterministically', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.clearRunStoreForTests()
    await mod.createRun({ runId: 'run-queued', type: 'exec', state: 'queued', summary: 'queued' })
    await mod.createRun({ runId: 'run-running', type: 'session', state: 'running', summary: 'running', startedAt: Date.now() })
    await mod.createRun({ runId: 'run-failed', type: 'acp', state: 'failed', summary: 'failed', finishedAt: Date.now() })

    const running = await mod.listRuns({ state: 'running', limit: 10, offset: 0 })
    assert.equal(running.total, 1)
    assert.equal(running.runs[0].runId, 'run-running')

    const paged = await mod.listRuns({ limit: 2, offset: 1 })
    assert.equal(paged.limit, 2)
    assert.equal(paged.offset, 1)
    assert.equal(paged.runs.length, 2)
    assert.equal(paged.hasMore, false)
  })
})

test('run store clamps negative duration to zero for malformed timestamps', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.createRun({
      runId: 'run-negative-duration',
      type: 'exec',
      state: 'done',
      startedAt: Date.now(),
      finishedAt: Date.now() - 1_000,
      summary: 'negative duration',
    })

    const fetched = await mod.getRunById('run-negative-duration')
    assert.ok(fetched)
    assert.equal(fetched.durationMs, 0)
  })
})

test('run store preserves concurrent create and update operations after flush', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.clearRunStoreForTests()
    await Promise.all(
      Array.from({ length: 4 }, (_, index) => mod.createRun({
        runId: `run-concurrent-${index}`,
        type: 'exec',
        state: 'running',
        startedAt: Date.now() - 1_000,
        summary: `run-${index}`,
      })),
    )

    await Promise.all(
      Array.from({ length: 4 }, (_, index) => mod.updateRun(`run-concurrent-${index}`, {
        state: 'done',
        finishedAt: Date.now(),
        summary: `done-${index}`,
      })),
    )

    await mod.flushRunStore()

    const cacheBust = `${Date.now()}-${Math.random()}`
    const reloaded = await import(`./run-store.mjs?bust=${cacheBust}`)
    await reloaded.loadRunStore()
    const listed = await reloaded.listRuns({ limit: 10, offset: 0 })
    const ours = listed.runs.filter((run) => String(run.runId).startsWith('run-concurrent-'))
    assert.equal(ours.length, 4)
    assert.equal(ours.every((run) => run.state === 'done'), true)
  })
})
