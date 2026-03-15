import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { rmSync } from 'node:fs'

let sharedPromise = null

async function getSharedModules() {
  if (!sharedPromise) {
    sharedPromise = (async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-automation-session-store-'))
      process.once('exit', () => {
        rmSync(tempDir, { recursive: true, force: true })
      })
      process.env.TRAPEZOHE_CONFIG_DIR = tempDir

      const store = await import('./automation-session-store.mjs')
      return { tempDir, store }
    })()
  }

  return sharedPromise
}

async function withFreshStore(run) {
  const { store } = await getSharedModules()
  await store.clearAutomationSessionStoreForTests()
  await run(store)
}

test('resolvePersistentAutomationSession stores a new mapping and reuses restartable sessions', async () => {
  await withFreshStore(async (store) => {
    const sessions = new Map()
    let created = 0

    const createSession = () => {
      created += 1
      const session = { sessionId: `acp-${created}`, state: 'idle' }
      sessions.set(session.sessionId, session)
      return session
    }

    const first = await store.resolvePersistentAutomationSession('persistent:daily-brief', {
      getSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      createSession,
    })

    assert.equal(first.sessionId, 'acp-1')
    assert.equal(first.reused, false)
    assert.equal(first.created, true)

    const binding = await store.getAutomationSessionBinding('persistent:daily-brief')
    assert.equal(binding.key, 'persistent:daily-brief')
    assert.equal(binding.sessionId, 'acp-1')
    assert.equal(typeof binding.updatedAt, 'number')
    assert.equal(typeof binding.lastRunAt, 'number')

    sessions.get('acp-1').state = 'done'

    const second = await store.resolvePersistentAutomationSession('persistent:daily-brief', {
      getSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      createSession,
    })

    assert.equal(second.sessionId, 'acp-1')
    assert.equal(second.reused, true)
    assert.equal(second.created, false)
    assert.equal(created, 1)
  })
})

test('resolvePersistentAutomationSession replaces stale or blocked mappings', async () => {
  await withFreshStore(async (store) => {
    await store.setAutomationSessionBinding('persistent:nightly-report', 'acp-stale')

    const sessions = new Map([
      ['acp-stale', { sessionId: 'acp-stale', state: 'error' }],
    ])
    let created = 0

    const resolved = await store.resolvePersistentAutomationSession('persistent:nightly-report', {
      getSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      createSession: () => {
        created += 1
        const session = { sessionId: `acp-fresh-${created}`, state: 'idle' }
        sessions.set(session.sessionId, session)
        return session
      },
    })

    assert.equal(resolved.sessionId, 'acp-fresh-1')
    assert.equal(resolved.reused, false)
    assert.equal(resolved.created, true)

    const binding = await store.getAutomationSessionBinding('persistent:nightly-report')
    assert.equal(binding.key, 'persistent:nightly-report')
    assert.equal(binding.sessionId, 'acp-fresh-1')
    assert.equal(typeof binding.updatedAt, 'number')
    assert.equal(typeof binding.lastRunAt, 'number')
  })
})


test('sweepAutomationSessionBindings removes missing, expired, and retention-hit bindings', async () => {
  await withFreshStore(async (store) => {
    const now = 1_700_000_000_000
    await store.setAutomationSessionBinding('persistent:missing-session', 'acp-missing', { updatedAt: now })
    await store.setAutomationSessionBinding('persistent:expired-run', 'acp-expired', { updatedAt: now })
    await store.setAutomationSessionBinding('persistent:retention-hit', 'acp-retention', { updatedAt: now - (10 * 24 * 60 * 60 * 1000) })
    await store.setAutomationSessionBinding('persistent:healthy', 'acp-healthy', { updatedAt: now })

    const summary = await store.sweepAutomationSessionBindings({
      now,
      retentionByKey: {
        'persistent:retention-hit': { maxAgeDays: 7, maxRuns: null },
      },
      getSessionById: (sessionId) => {
        if (sessionId === 'acp-missing') return null
        return { sessionId, state: 'idle' }
      },
      listRuns: async () => ({
        runs: [
          { runId: 'run-retention', meta: { sessionTarget: 'persistent:retention-hit', acpSessionId: 'acp-retention' } },
          { runId: 'run-healthy', meta: { sessionTarget: 'persistent:healthy', acpSessionId: 'acp-healthy' } },
        ],
      }),
    })

    assert.equal(summary.scanned, 4)
    assert.equal(summary.removed, 3)
    assert.equal(summary.kept, 1)
    assert.equal(summary.reasons.missing_session, 1)
    assert.equal(summary.reasons.run_meta_expired, 1)
    assert.equal(summary.reasons.retention_max_age, 1)

    const bindings = await store.listAutomationSessionBindings()
    assert.deepEqual(bindings.map((binding) => binding.key), ['persistent:healthy'])
  })
})

test('sweepAutomationSessionBindings removes bindings that exceed retention maxRuns', async () => {
  await withFreshStore(async (store) => {
    const now = 1_700_000_000_000
    await store.setAutomationSessionBinding('persistent:max-runs-hit', 'acp-max-runs', { updatedAt: now })
    await store.setAutomationSessionBinding('persistent:max-runs-ok', 'acp-max-runs-ok', { updatedAt: now })

    const summary = await store.sweepAutomationSessionBindings({
      now,
      retentionByKey: {
        'persistent:max-runs-hit': { maxRuns: 2 },
        'persistent:max-runs-ok': { maxRuns: 3 },
      },
      getSessionById: (sessionId) => ({ sessionId, state: 'idle' }),
      listRuns: async () => ({
        runs: [
          { runId: 'run-1', meta: { sessionTarget: 'persistent:max-runs-hit', acpSessionId: 'acp-max-runs' } },
          { runId: 'run-2', meta: { sessionTarget: 'persistent:max-runs-hit', acpSessionId: 'acp-max-runs' } },
          { runId: 'run-3', meta: { sessionTarget: 'persistent:max-runs-hit', acpSessionId: 'acp-max-runs' } },
          { runId: 'run-4', meta: { sessionTarget: 'persistent:max-runs-ok', acpSessionId: 'acp-max-runs-ok' } },
          { runId: 'run-5', meta: { sessionTarget: 'persistent:max-runs-ok', acpSessionId: 'acp-max-runs-ok' } },
        ],
      }),
    })

    assert.equal(summary.removed, 1)
    assert.equal(summary.reasons.retention_max_runs, 1)

    const bindings = await store.listAutomationSessionBindings()
    assert.deepEqual(bindings.map((binding) => binding.key), ['persistent:max-runs-ok'])
  })
})
