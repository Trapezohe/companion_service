import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { rmSync } from 'node:fs'

let sharedPromise = null

function createJob(partial = {}) {
  return {
    id: 'job-1',
    name: 'Daily brief',
    prompt: 'summarize',
    schedule: { kind: 'interval', minutes: 30 },
    enabled: true,
    sessionTarget: 'isolated',
    trustClass: 'scheduled_trusted',
    executor: 'extension_chat',
    agentType: null,
    model: null,
    timeoutMs: null,
    delivery: { mode: 'notification', notification: true, chat: false, target: null },
    ...partial,
  }
}

async function getSharedModules() {
  if (!sharedPromise) {
    sharedPromise = (async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-automation-executor-'))
      process.once('exit', () => {
        rmSync(tempDir, { recursive: true, force: true })
      })
      process.env.TRAPEZOHE_CONFIG_DIR = tempDir

      const runStore = await import('./run-store.mjs')
      const sessionStore = await import('./automation-session-store.mjs')
      const executor = await import('./automation-executor.mjs')
      return { tempDir, runStore, sessionStore, executor }
    })()
  }

  return sharedPromise
}

async function withFreshState(run) {
  const { runStore, sessionStore, executor } = await getSharedModules()
  await runStore.clearRunStoreForTests()
  await sessionStore.clearAutomationSessionStoreForTests()
  await run({ runStore, sessionStore, executor })
}

test('executeAutomationJob keeps extension_chat jobs on legacy pending path', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    let createRunCalled = 0

    const result = await executor.executeAutomationJob(createJob(), {
      createRun: async () => {
        createRunCalled += 1
        throw new Error('should not create run for extension_pending path')
      },
    })

    assert.equal(result.mode, 'extension_pending')
    assert.equal(createRunCalled, 0)

    const runs = await runStore.listRuns({ type: 'cron', limit: 10, offset: 0 })
    assert.equal(runs.runs.length, 0)
  })
})

test('executeAutomationJob starts isolated companion_acp runs without writing pending state', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const createdSessions = []
    const attached = []
    const enqueued = []
    const sessions = new Map()

    const result = await executor.executeAutomationJob(createJob({
      executor: 'companion_acp',
      agentType: 'codex',
    }), {
      createAcpSession: (input) => {
        const session = { sessionId: `acp-${createdSessions.length + 1}`, state: 'idle', ...input }
        createdSessions.push(input)
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: (sessionId, runId) => {
        attached.push({ sessionId, runId })
        return { sessionId, runId }
      },
      enqueuePrompt: async (sessionId, input) => {
        enqueued.push({ sessionId, input })
        return { ok: true, sessionId, turnId: 'turn-1' }
      },
    })

    assert.equal(result.mode, 'companion_acp')
    assert.equal(result.sessionId, 'acp-1')
    assert.equal(result.reusedSession, false)
    assert.equal(createdSessions.length, 1)
    assert.deepEqual(attached, [{ sessionId: 'acp-1', runId: result.runId }])
    assert.equal(enqueued.length, 1)
    assert.equal(enqueued[0].input.prompt, 'summarize')

    const runs = await runStore.listRuns({ type: 'cron', limit: 10, offset: 0 })
    assert.equal(runs.runs.length, 1)
    assert.equal(runs.runs[0].state, 'running')
    assert.equal(runs.runs[0].meta?.executionMode, 'companion_acp')
    assert.equal(runs.runs[0].meta?.acpSessionId, 'acp-1')

    const link = await runStore.getSessionRunLink('acp-1')
    assert.equal(link?.runId, result.runId)
  })
})

test('executeAutomationJob reuses persistent companion sessions across runs', async () => {
  await withFreshState(async ({ executor }) => {
    const sessions = new Map()
    let created = 0

    const deps = {
      createAcpSession: () => {
        created += 1
        const session = { sessionId: `acp-${created}`, state: 'idle' }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: (sessionId, runId) => ({ sessionId, runId }),
      enqueuePrompt: async (sessionId) => ({ ok: true, sessionId, turnId: `turn-${created}` }),
    }

    const first = await executor.executeAutomationJob(createJob({
      id: 'job-persistent',
      sessionTarget: 'persistent:research-loop',
      executor: 'companion_acp',
      agentType: 'codex',
    }), deps)

    sessions.get(first.sessionId).state = 'done'

    const second = await executor.executeAutomationJob(createJob({
      id: 'job-persistent',
      sessionTarget: 'persistent:research-loop',
      executor: 'companion_acp',
      agentType: 'codex',
    }), deps)

    assert.equal(first.sessionId, 'acp-1')
    assert.equal(second.sessionId, 'acp-1')
    assert.equal(second.reusedSession, true)
    assert.equal(created, 1)
  })
})



test('deliverAutomationRunResult sends webhook deliveries directly and updates the run ledger', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const run = await runStore.createRun({
      runId: 'run-webhook',
      type: 'cron',
      state: 'done',
      summary: 'Automation finished',
      meta: {
        taskId: 'task-webhook',
        taskName: 'Webhook report',
        executionMode: 'companion_acp',
        deliveryMode: 'webhook',
        target: { url: 'https://hooks.example.com/automation' },
      },
    })

    const fetchCalls = []
    /** @type {AbortSignal | undefined} */
    let capturedSignal
    const delivery = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-webhook',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({
        events: [
          { type: 'text_delta', text: 'Webhook payload ready.' },
          { type: 'done', result: 'ignored' },
        ],
      }),
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init })
        capturedSignal = init?.signal
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    assert.equal(delivery.mode, 'webhook')
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].url, 'https://hooks.example.com/automation')
    assert.ok(capturedSignal instanceof AbortSignal)
    assert.equal(capturedSignal.aborted, false)

    const updated = await runStore.getRunById(run.runId)
    assert.deepEqual(updated?.deliveryState, {
      channel: 'webhook',
      attempts: 1,
      lastAttemptAt: updated?.deliveryState?.lastAttemptAt,
    })
  })
})

test('deliverAutomationRunResult queues chat deliveries into the automation outbox', async () => {
  await withFreshState(async ({ executor, runStore, sessionStore }) => {
    const outbox = await import('./automation-outbox.mjs')
    await outbox.clearAutomationOutboxForTests()
    const run = await runStore.createRun({
      runId: 'run-chat',
      type: 'cron',
      state: 'done',
      summary: 'Automation finished',
      meta: {
        taskId: 'task-chat',
        taskName: 'Chat report',
        executionMode: 'companion_acp',
        deliveryMode: 'chat',
      },
    })

    const delivery = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-chat',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({
        events: [
          { type: 'text_delta', text: 'Chat delivery ready.' },
        ],
      }),
      enqueueAutomationOutboxItem: outbox.enqueueAutomationOutboxItem,
    })

    assert.equal(delivery.mode, 'outbox')
    const listed = await outbox.listAutomationOutboxItems()
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].id, 'run-chat')
    assert.equal(listed.items[0].mode, 'chat')
    assert.equal(listed.items[0].text, 'Chat delivery ready.')

    const updated = await runStore.getRunById(run.runId)
    assert.equal(updated?.deliveryState?.channel, 'outbox')
  })
})

test('deliverAutomationRunResult queues remote channel deliveries with target metadata preserved', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const outbox = await import('./automation-outbox.mjs')
    await outbox.clearAutomationOutboxForTests()
    const run = await runStore.createRun({
      runId: 'run-remote',
      type: 'cron',
      state: 'done',
      summary: 'Automation finished',
      meta: {
        taskId: 'task-remote',
        taskName: 'Remote report',
        executionMode: 'companion_acp',
        deliveryMode: 'remote_channel',
        target: {
          channelId: 'telegram',
          authToken: 'bot-token',
          bindingKey: 'chat:1',
        },
      },
    })

    const delivery = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-remote',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({
        events: [
          { type: 'text_delta', text: 'Remote delivery ready.' },
        ],
      }),
      enqueueAutomationOutboxItem: outbox.enqueueAutomationOutboxItem,
    })

    assert.equal(delivery.mode, 'outbox')
    const listed = await outbox.listAutomationOutboxItems()
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].mode, 'remote_channel')
    assert.deepEqual(listed.items[0].target, {
      channelId: 'telegram',
      authToken: 'bot-token',
      bindingKey: 'chat:1',
    })
  })
})

test('executeAutomationJob rejects unsupported main-session companion jobs with a failed run', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    let createAcpSessionCalled = 0

    const result = await executor.executeAutomationJob(createJob({
      executor: 'companion_acp',
      agentType: 'codex',
      sessionTarget: 'main',
    }), {
      createAcpSession: () => {
        createAcpSessionCalled += 1
        throw new Error('should not create acp session for rejected jobs')
      },
    })

    assert.equal(result.mode, 'rejected')
    assert.equal(result.reason, 'main_session_not_supported')
    assert.equal(createAcpSessionCalled, 0)

    const runs = await runStore.listRuns({ type: 'cron', limit: 10, offset: 0 })
    assert.equal(runs.runs.length, 1)
    assert.equal(runs.runs[0].state, 'failed')
    assert.equal(runs.runs[0].meta?.unsupportedReason, 'main_session_not_supported')
  })
})
