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
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-automation-runtime-e2e-'))
      process.once('exit', () => {
        rmSync(tempDir, { recursive: true, force: true })
      })
      process.env.TRAPEZOHE_CONFIG_DIR = tempDir

      const runStore = await import('./run-store.mjs')
      const sessionStore = await import('./automation-session-store.mjs')
      const outbox = await import('./automation-outbox.mjs')
      const executor = await import('./automation-executor.mjs')
      const diagnostics = await import('./diagnostics.mjs')
      const acp = await import('./acp-session.mjs')
      return { runStore, sessionStore, outbox, executor, diagnostics, acp }
    })()
  }

  return sharedPromise
}

async function withFreshState(run) {
  const { runStore, sessionStore, outbox, acp, executor, diagnostics } = await getSharedModules()
  await runStore.clearRunStoreForTests()
  await sessionStore.clearAutomationSessionStoreForTests()
  await outbox.clearAutomationOutboxForTests()
  acp.cleanupAllAcpSessions()
  await run({ runStore, sessionStore, outbox, acp, executor, diagnostics })
}

const BASE_FEATURES = {
  acp: true,
  mcp: true,
  cronReplay: true,
  diagnostics: true,
  approvalStore: true,
  runLedger: true,
  automationExecutor: true,
  automationOutbox: true,
  mediaNormalization: false,
}

async function buildDiagnostics(diagnostics) {
  return diagnostics.buildDiagnosticsPayload({
    protocolVersion: 'trapezohe-companion/2026-03-07',
    version: '0.1.0-test',
    supportedFeatures: BASE_FEATURES,
    getPermissionPolicy: () => ({ mode: 'full', workspaceRoots: [] }),
    getMediaSupport: async () => ({ available: false, engine: null, reason: 'feature_disabled' }),
    mcpManager: {
      getConnectedCount: () => 0,
      getAllTools: () => [],
      getServers: () => [],
    },
  })
}

test('automation runtime keeps browser-open extension_chat jobs on the legacy pending path', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const result = await executor.executeAutomationJob(createJob({
      executor: 'extension_chat',
      delivery: { mode: 'chat', notification: false, chat: true, target: null },
    }))

    assert.equal(result.mode, 'extension_pending')
    const runs = await runStore.listRuns({ type: 'cron', limit: 10, offset: 0 })
    assert.equal(runs.runs.length, 0)
  })
})

test('automation runtime delivers companion webhook jobs directly when the browser is closed', async () => {
  await withFreshState(async ({ executor, runStore, acp }) => {
    const fetchCalls = []

    const launched = await executor.executeAutomationJob(createJob({
      id: 'job-webhook',
      name: 'Webhook report',
      executor: 'companion_acp',
      agentType: 'codex',
      delivery: {
        mode: 'webhook',
        notification: false,
        chat: false,
        target: { url: 'https://hooks.example.com/automation' },
      },
    }), {
      createAcpSession: () => acp.createAcpSession({ agentType: 'codex', origin: 'automation' }),
      getAcpSessionById: acp.getAcpSessionById,
      enqueuePrompt: async (sessionId) => ({ ok: true, sessionId, turnId: 'turn-1' }),
    })

    const delivery = await executor.deliverAutomationRunResult({
      runId: launched.runId,
      sessionId: 'acp-webhook',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({ events: [{ type: 'text_delta', text: 'Webhook payload ready.' }] }),
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init })
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    assert.equal(delivery.mode, 'webhook')
    assert.equal(fetchCalls.length, 1)

    const run = await runStore.getRunById(launched.runId)
    assert.equal(run?.deliveryState?.channel, 'webhook')
  })
})

test('automation runtime queues companion chat deliveries and clears them after reconnect drain ack', async () => {
  await withFreshState(async ({ executor, outbox, diagnostics, acp }) => {

    const launched = await executor.executeAutomationJob(createJob({
      id: 'job-chat',
      name: 'Chat report',
      executor: 'companion_acp',
      agentType: 'codex',
      delivery: { mode: 'chat', notification: false, chat: true, target: null },
    }), {
      createAcpSession: () => acp.createAcpSession({ agentType: 'codex', origin: 'automation' }),
      getAcpSessionById: acp.getAcpSessionById,
      enqueuePrompt: async (sessionId) => ({ ok: true, sessionId, turnId: 'turn-1' }),
    })

    await executor.deliverAutomationRunResult({
      runId: launched.runId,
      sessionId: 'acp-chat',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({ events: [{ type: 'text_delta', text: 'Chat delivery ready.' }] }),
      enqueueAutomationOutboxItem: outbox.enqueueAutomationOutboxItem,
    })

    let payload = await buildDiagnostics(diagnostics)
    assert.equal(payload.automation.outbox.depth, 1)
    assert.equal(payload.automation.execution.activeAcpSessions, 1)

    const acked = await outbox.ackAutomationOutboxItems([launched.runId])
    assert.equal(acked.acked, 1)

    payload = await buildDiagnostics(diagnostics)
    assert.equal(payload.automation.outbox.depth, 0)
  })
})

test('automation runtime reuses persistent companion sessions across repeated runs', async () => {
  await withFreshState(async ({ executor }) => {
    const sessions = new Map()
    let created = 0

    const deps = {
      createAcpSession: () => {
        created += 1
        const session = { sessionId: `acp-${created}`, state: 'idle', origin: 'automation' }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: (sessionId, runId) => ({ sessionId, runId }),
      enqueuePrompt: async (sessionId) => ({ ok: true, sessionId, turnId: `turn-${created}` }),
    }

    const first = await executor.executeAutomationJob(createJob({
      id: 'job-persistent',
      name: 'Research loop',
      executor: 'companion_acp',
      agentType: 'codex',
      sessionTarget: 'persistent:research-loop',
    }), deps)

    sessions.get(first.sessionId).state = 'done'

    const second = await executor.executeAutomationJob(createJob({
      id: 'job-persistent',
      name: 'Research loop',
      executor: 'companion_acp',
      agentType: 'codex',
      sessionTarget: 'persistent:research-loop',
    }), deps)

    assert.equal(first.sessionId, second.sessionId)
    assert.equal(second.reusedSession, true)
    assert.equal(created, 1)
  })
})
