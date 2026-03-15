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
    assert.deepEqual(binding, {
      key: 'persistent:daily-brief',
      sessionId: 'acp-1',
    })

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
    assert.deepEqual(binding, {
      key: 'persistent:nightly-report',
      sessionId: 'acp-fresh-1',
    })
  })
})
