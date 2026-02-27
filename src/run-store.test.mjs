import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'

async function withTempHome(run, options = {}) {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-run-store-test-'))
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  const prevMaxRuns = process.env.TRAPEZOHE_MAX_RUNS
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome
  if (options.maxRuns) {
    process.env.TRAPEZOHE_MAX_RUNS = String(options.maxRuns)
  } else {
    delete process.env.TRAPEZOHE_MAX_RUNS
  }

  try {
    const cacheBust = `${Date.now()}-${Math.random()}`
    const mod = await import(`./run-store.mjs?bust=${cacheBust}`)
    await mod.loadRunStore()
    await run({ tempHome, mod })
  } finally {
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
      meta: { command: 'echo ok' },
    })
    assert.ok(run.runId)
    assert.equal(run.state, 'running')

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
