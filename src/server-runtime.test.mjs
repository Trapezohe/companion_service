import test from 'node:test'
import assert from 'node:assert/strict'

import { createCompanionServer } from './server.mjs'
import { addPendingRun, clearCronStoreForTests } from './cron-store.mjs'
import { cleanupAllSessions } from './runtime.mjs'
import { clearRunStoreForTests, listRuns } from './run-store.mjs'
import { clearBrowserLedgerForTests } from './browser-ledger.mjs'
import {
  clearApprovalStoreForTests,
  createApproval,
  flushApprovalStore,
  getApprovalById,
} from './approval-store.mjs'

function createMcpManagerStub() {
  return {
    getConnectedCount: () => 0,
    getAllTools: () => [],
    getServers: () => [],
    callTool: async () => ({ ok: true }),
    restartServer: async () => {},
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function interruptibleLongRunningCommand() {
  const nodeScript = "process.on('SIGINT', () => process.exit(130)); setInterval(() => {}, 1000)"
  if (process.platform === 'win32') {
    return `node -e "${nodeScript}"`
  }
  // Force the shell wrapper to ignore SIGINT so the endpoint must signal
  // the whole session tree instead of only the shell process.
  return `trap "" INT; node -e "${nodeScript}"`
}

async function startTestServer(options = {}) {
  if (!options.preserveStores) {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    await clearCronStoreForTests()
    await clearBrowserLedgerForTests()
  }
  const token = 'test-token'
  const mcpManager = options.mcpManager || createMcpManagerStub()
  const server = createCompanionServer({
    token,
    mcpManager,
    ...(typeof options.setMcpServerConfig === 'function'
      ? { setMcpServerConfig: options.setMcpServerConfig }
      : {}),
    ...(typeof options.removeMcpServerConfig === 'function'
      ? { removeMcpServerConfig: options.removeMcpServerConfig }
      : {}),
    ...(typeof options.normalizeMediaImage === 'function'
      ? { normalizeMediaImage: options.normalizeMediaImage }
      : {}),
    ...(typeof options.getMediaSupport === 'function'
      ? { getMediaSupport: options.getMediaSupport }
      : {}),
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server.')
  }

  return {
    token,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

async function stopTestServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function requestJson(ctx, endpoint, options = {}) {
  const { method = 'GET', body } = options
  const headers = {
    Authorization: `Bearer ${ctx.token}`,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${ctx.baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json()
  return {
    status: response.status,
    payload,
  }
}

test('media normalization endpoint converts HEIC payloads through the injected normalizer', async (t) => {
  const ctx = await startTestServer({
    getMediaSupport: async () => ({ available: true, engine: 'test-engine' }),
    normalizeMediaImage: async (body) => ({
      changed: true,
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      bytesBase64: Buffer.from('jpeg-binary').toString('base64'),
      normalization: {
        status: 'normalized',
        sourceMimeType: body.mimeType,
        outputMimeType: 'image/jpeg',
        via: 'companion',
        engine: 'test-engine',
      },
      pipelineHints: {
        source: 'image',
        summary: 'Image normalized from image/heic to image/jpeg via test-engine. OCR hook not enabled yet.',
        ocrReady: false,
      },
    }),
  })
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const response = await requestJson(ctx, '/api/media/normalize', {
    method: 'POST',
    body: {
      name: 'photo.heic',
      mimeType: 'image/heic',
      bytesBase64: Buffer.from('heic-binary').toString('base64'),
    },
  })

  assert.equal(response.status, 200)
  assert.equal(response.payload.changed, true)
  assert.equal(response.payload.mimeType, 'image/jpeg')
  assert.equal(response.payload.normalization.engine, 'test-engine')
  assert.deepEqual(response.payload.pipelineHints, {
    source: 'image',
    summary: 'Image normalized from image/heic to image/jpeg via test-engine. OCR hook not enabled yet.',
    ocrReady: false,
  })
})

test('media normalization endpoint accepts payloads above the default JSON body cap', async (t) => {
  const largeBase64 = Buffer.alloc(800 * 1024, 7).toString('base64')
  const ctx = await startTestServer({
    getMediaSupport: async () => ({ available: true, engine: 'test-engine' }),
    normalizeMediaImage: async (body) => ({
      changed: false,
      name: body.name,
      mimeType: body.mimeType,
      bytesBase64: body.bytesBase64,
      normalization: {
        status: 'unchanged',
        sourceMimeType: body.mimeType,
        outputMimeType: body.mimeType,
        via: 'none',
      },
      pipelineHints: {
        source: 'image',
        summary: `Image retained as ${body.mimeType}. OCR hook not enabled yet.`,
        ocrReady: false,
      },
    }),
  })
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const response = await requestJson(ctx, '/api/media/normalize', {
    method: 'POST',
    body: {
      name: 'camera-roll.heic',
      mimeType: 'image/heic',
      bytesBase64: largeBase64,
    },
  })

  assert.equal(response.status, 200)
  assert.equal(response.payload.name, 'camera-roll.heic')
  assert.equal(response.payload.bytesBase64.length, largeBase64.length)
})

test('health and capabilities endpoints expose protocol contract fields', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const health = await requestJson(ctx, '/healthz')
  assert.equal(health.status, 200)
  assert.equal(typeof health.payload.protocolVersion, 'string')
  assert.equal(typeof health.payload.supportedFeatures, 'object')
  assert.equal(health.payload.supportedFeatures.acp, true)
  assert.equal(health.payload.supportedFeatures.mcp, true)
  assert.equal(health.payload.supportedFeatures.cronReplay, true)
  assert.equal(health.payload.supportedFeatures.browserLedger, true)
  assert.equal(health.payload.supportedFeatures.browserEvents, true)

  const capabilities = await requestJson(ctx, '/api/system/capabilities')
  assert.equal(capabilities.status, 200)
  assert.equal(capabilities.payload.protocolVersion, health.payload.protocolVersion)
  assert.equal(capabilities.payload.version, health.payload.version)
  assert.equal(capabilities.payload.supportedFeatures.runLedger, true)
  assert.equal(capabilities.payload.supportedFeatures.approvalStore, true)
  assert.equal(capabilities.payload.supportedFeatures.browserLedger, true)
  assert.equal(capabilities.payload.supportedFeatures.browserEvents, true)
})

test('diagnostics and self-check endpoints return structured companion health details', async (t) => {
  const ctx = await startTestServer({
    getMediaSupport: async () => ({ available: true, engine: 'test-engine' }),
    mcpManager: {
      getConnectedCount: () => 1,
      getAllTools: () => [{ server: 'bnbchain-mcp', name: 'get_latest_block' }],
      getServers: () => [{
        name: 'bnbchain-mcp',
        status: 'connected',
        toolCount: 1,
        command: 'node',
        args: ['server.js'],
        restartable: true,
        restartPending: false,
        nextRetryAt: null,
      }],
      callTool: async () => ({ ok: true }),
      restartServer: async () => {},
    },
  })
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const diagnostics = await requestJson(ctx, '/api/system/diagnostics')
  assert.equal(diagnostics.status, 200)
  assert.equal(typeof diagnostics.payload.protocolVersion, 'string')
  assert.equal(typeof diagnostics.payload.version, 'string')
  assert.equal(typeof diagnostics.payload.mcp.connectedServers, 'number')
  assert.ok(Array.isArray(diagnostics.payload.mcp.servers))
  assert.equal(diagnostics.payload.mcp.servers[0]?.restartable, true)
  assert.equal(diagnostics.payload.mcp.servers[0]?.restartPending, false)
  assert.ok(Array.isArray(diagnostics.payload.runs.recentFailed))
  assert.ok(Array.isArray(diagnostics.payload.approvals.pending))
  assert.equal(typeof diagnostics.payload.acp.totalSessions, 'number')
  assert.equal(typeof diagnostics.payload.nativeHostRegistration, 'object')
  assert.equal(typeof diagnostics.payload.capabilitySummary.totalFeatures, 'number')
  assert.ok(Array.isArray(diagnostics.payload.capabilitySummary.availableFeatures))
  assert.equal(typeof diagnostics.payload.acpIngressSummary.recentRuns, 'number')
  assert.equal(diagnostics.payload.mediaNormalizationSummary.available, true)
  assert.equal(diagnostics.payload.mediaNormalizationSummary.engine, 'test-engine')
  assert.ok(Array.isArray(diagnostics.payload.nativeHostRegistration?.hostNames))
  assert.equal(typeof diagnostics.payload.browser.enabled, 'boolean')
  assert.equal(typeof diagnostics.payload.browser.loaded, 'boolean')
  assert.equal(typeof diagnostics.payload.browser.sessions.active, 'number')
  assert.equal(typeof diagnostics.payload.browser.actions.failedRecent, 'number')
  assert.equal(typeof diagnostics.payload.browser.artifacts.recent, 'number')

  const selfCheck = await requestJson(ctx, '/api/system/self-check')
  assert.equal(selfCheck.status, 200)
  // This endpoint test validates shape, not host-specific health state.
  // A clean CI runner may have no native host/config pre-registered yet.
  assert.equal(typeof selfCheck.payload.ok, 'boolean')
  assert.equal(typeof selfCheck.payload.checks.configReadable.ok, 'boolean')
  assert.equal(typeof selfCheck.payload.checks.tokenPresent.ok, 'boolean')
  assert.equal(typeof selfCheck.payload.checks.workspacePolicy.ok, 'boolean')
  assert.equal(typeof selfCheck.payload.checks.nativeHostRegistration.ok, 'boolean')
  assert.ok(Array.isArray(selfCheck.payload.checks.mcpExecutables))
})

test('browser ledger sync and query endpoints persist browser runtime records', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const sessionSync = await requestJson(ctx, '/api/browser/sessions/sync', {
    method: 'POST',
    body: {
      session: {
        sessionId: 'browser-session-1',
        driver: 'extension-tab',
        state: 'ready',
        createdAt: 1_710_000_200_000,
        updatedAt: 1_710_000_200_100,
        profileId: 'default',
        primaryTargetId: 'target-1',
        capabilities: {
          navigate: true,
          snapshot: true,
          click: true,
          type: true,
          upload: false,
          dialog: false,
          console: false,
          screenshot: false,
          pdf: false,
        },
      },
      targets: [{
        targetId: 'target-1',
        sessionId: 'browser-session-1',
        kind: 'page',
        url: 'https://example.com',
        title: 'Example',
        active: true,
        attached: true,
        lastSeenAt: 1_710_000_200_100,
      }],
      link: {
        runId: 'run-browser-1',
        conversationId: 'conv-browser-1',
        sourceToolName: 'browser_navigate',
        sourceToolCallId: 'tool-call-browser-1',
        approvalRequestId: 'approval-browser-1',
      },
      source: 'extension-background',
    },
  })
  assert.equal(sessionSync.status, 200)
  assert.equal(sessionSync.payload.ok, true)
  assert.equal(sessionSync.payload.session.session.sessionId, 'browser-session-1')

  const actionSync = await requestJson(ctx, '/api/browser/actions/sync', {
    method: 'POST',
    body: {
      action: {
        actionId: 'browser-action-1',
        sessionId: 'browser-session-1',
        targetId: 'target-1',
        kind: 'navigate',
        status: 'completed',
        startedAt: 1_710_000_200_200,
        finishedAt: 1_710_000_200_250,
        inputSummary: 'navigate to example.com',
        resultSummary: 'navigation complete',
        nextSnapshotId: 'snapshot-1',
      },
      snapshot: {
        snapshotId: 'snapshot-1',
        sessionId: 'browser-session-1',
        targetId: 'target-1',
        format: 'ai',
        url: 'https://example.com',
        title: 'Example',
        body: 'Example body',
        refs: [],
        stats: {
          chars: 12,
          lines: 1,
          refs: 0,
          interactive: 0,
          truncated: false,
        },
        createdAt: 1_710_000_200_240,
        source: 'navigate',
      },
      link: {
        runId: 'run-browser-1',
        conversationId: 'conv-browser-1',
        sourceToolName: 'browser_navigate',
        sourceToolCallId: 'tool-call-browser-1',
        approvalRequestId: 'approval-browser-1',
      },
    },
  })
  assert.equal(actionSync.status, 200)
  assert.equal(actionSync.payload.ok, true)
  assert.equal(actionSync.payload.action.action.actionId, 'browser-action-1')

  const artifactSync = await requestJson(ctx, '/api/browser/artifacts/sync', {
    method: 'POST',
    body: {
      artifact: {
        artifactId: 'browser-artifact-1',
        sessionId: 'browser-session-1',
        targetId: 'target-1',
        kind: 'screenshot',
        createdAt: 1_710_000_200_260,
        mimeType: 'image/png',
        byteLength: 128,
        storage: 'companion',
        pathOrKey: 'browser/browser-artifact-1.png',
      },
      actionId: 'browser-action-1',
    },
  })
  assert.equal(artifactSync.status, 200)
  assert.equal(artifactSync.payload.ok, true)
  assert.equal(artifactSync.payload.artifact.artifact.artifactId, 'browser-artifact-1')

  const sessions = await requestJson(ctx, '/api/browser/sessions?limit=10&offset=0')
  assert.equal(sessions.status, 200)
  assert.equal(sessions.payload.total, 1)
  assert.equal(sessions.payload.sessions[0].session.sessionId, 'browser-session-1')
  assert.equal(sessions.payload.sessions[0].link.runId, 'run-browser-1')

  const sessionsByRun = await requestJson(ctx, '/api/browser/sessions?runId=run-browser-1')
  assert.equal(sessionsByRun.status, 200)
  assert.equal(sessionsByRun.payload.total, 1)
  assert.equal(sessionsByRun.payload.sessions[0].link.sourceToolCallId, 'tool-call-browser-1')

  const detail = await requestJson(ctx, '/api/browser/sessions/browser-session-1')
  assert.equal(detail.status, 200)
  assert.equal(detail.payload.session.session.sessionId, 'browser-session-1')
  assert.equal(detail.payload.session.targets[0].targetId, 'target-1')
  assert.equal(detail.payload.session.link.approvalRequestId, 'approval-browser-1')

  const actions = await requestJson(ctx, '/api/browser/actions?sessionId=browser-session-1')
  assert.equal(actions.status, 200)
  assert.equal(actions.payload.total, 1)
  assert.equal(actions.payload.actions[0].action.status, 'completed')
  assert.equal(actions.payload.actions[0].snapshot.snapshotId, 'snapshot-1')
  assert.equal(actions.payload.actions[0].link.runId, 'run-browser-1')

  const actionsByToolCall = await requestJson(ctx, '/api/browser/actions?sourceToolCallId=tool-call-browser-1')
  assert.equal(actionsByToolCall.status, 200)
  assert.equal(actionsByToolCall.payload.total, 1)
  assert.equal(actionsByToolCall.payload.actions[0].link.sourceToolName, 'browser_navigate')

  const artifacts = await requestJson(ctx, '/api/browser/artifacts?sessionId=browser-session-1')
  assert.equal(artifacts.status, 200)
  assert.equal(artifacts.payload.total, 1)
  assert.equal(artifacts.payload.artifacts[0].artifact.artifactId, 'browser-artifact-1')
  assert.equal(artifacts.payload.artifacts[0].actionId, 'browser-action-1')

  const diagnostics = await requestJson(ctx, '/api/browser/diagnostics')
  assert.equal(diagnostics.status, 200)
  assert.equal(diagnostics.payload.sessions.linked, 1)
  assert.equal(diagnostics.payload.sessions.recentLinked[0].link.runId, 'run-browser-1')
  assert.equal(diagnostics.payload.actions.linked, 1)
  assert.equal(diagnostics.payload.actions.recentLinked[0].link.sourceToolCallId, 'tool-call-browser-1')
})

test('browser events endpoint returns cursor-paged browser sync events', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const baseline = await requestJson(ctx, '/api/browser/events?after=0&limit=1')
  assert.equal(baseline.status, 200)
  const startCursor = baseline.payload.nextCursor

  await requestJson(ctx, '/api/browser/sessions/sync', {
    method: 'POST',
    body: {
      session: {
        sessionId: 'browser-session-events-1',
        driver: 'extension-tab',
        state: 'ready',
        createdAt: 1_710_000_300_000,
        updatedAt: 1_710_000_300_100,
        profileId: 'default',
      },
    },
  })

  await requestJson(ctx, '/api/browser/actions/sync', {
    method: 'POST',
    body: {
      action: {
        actionId: 'browser-action-events-1',
        sessionId: 'browser-session-events-1',
        kind: 'navigate',
        status: 'completed',
        startedAt: 1_710_000_300_200,
        finishedAt: 1_710_000_300_250,
        inputSummary: 'navigate to example.com',
      },
    },
  })

  await requestJson(ctx, '/api/browser/artifacts/sync', {
    method: 'POST',
    body: {
      artifact: {
        artifactId: 'browser-artifact-events-1',
        sessionId: 'browser-session-events-1',
        kind: 'screenshot',
        createdAt: 1_710_000_300_260,
        mimeType: 'image/png',
        byteLength: 128,
        storage: 'companion',
        pathOrKey: 'browser/browser-artifact-events-1.png',
      },
      actionId: 'browser-action-events-1',
    },
  })

  const events = await requestJson(ctx, `/api/browser/events?after=${startCursor}&limit=10`)
  assert.equal(events.status, 200)
  assert.equal(events.payload.ok, true)
  assert.deepEqual(events.payload.events.map((event) => event.type), [
    'session_synced',
    'action_synced',
    'artifact_synced',
  ])
  assert.equal(events.payload.events[0].sessionId, 'browser-session-events-1')
  assert.equal(events.payload.events[1].actionId, 'browser-action-events-1')
  assert.equal(events.payload.events[2].artifactId, 'browser-artifact-events-1')
  assert.equal(typeof events.payload.nextCursor, 'number')
})

test('repair endpoint returns updated self-check payload for supported repair actions', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const repaired = await requestJson(ctx, '/api/system/repair', {
    method: 'POST',
    body: {
      action: 'repair_config',
    },
  })

  assert.equal(repaired.status, 200)
  assert.equal(repaired.payload.ok, true)
  assert.equal(repaired.payload.action, 'repair_config')
  assert.equal(typeof repaired.payload.selfCheck?.ok, 'boolean')
  assert.ok(Array.isArray(repaired.payload.selfCheck?.repairActions))
})

test('cron pending endpoints expose occurrence pendingIds and ack them independently', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const first = await addPendingRun('task-occurrence')
  const second = await addPendingRun('task-occurrence')
  const third = await addPendingRun('task-other')

  const listed = await requestJson(ctx, '/api/cron/pending')
  assert.equal(listed.status, 200)
  assert.equal(listed.payload.pending.length, 3)
  assert.equal(
    listed.payload.pending.every((item) => typeof item.pendingId === 'string' && item.pendingId.length > 0),
    true,
  )

  const acked = await requestJson(ctx, '/api/cron/pending/ack', {
    method: 'POST',
    body: { pendingIds: [first.pendingId, third.pendingId] },
  })
  assert.equal(acked.status, 200)
  assert.equal(acked.payload.ok, true)
  assert.equal(acked.payload.acked, 2)

  const remaining = await requestJson(ctx, '/api/cron/pending')
  assert.equal(remaining.status, 200)
  assert.deepEqual(
    remaining.payload.pending.map((item) => item.pendingId),
    [second.pendingId],
  )
})

test('cron pending ack remains backward compatible with taskIds', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  await addPendingRun('task-legacy')
  await addPendingRun('task-legacy')
  const other = await addPendingRun('task-still-pending')

  const acked = await requestJson(ctx, '/api/cron/pending/ack', {
    method: 'POST',
    body: { taskIds: ['task-legacy'] },
  })
  assert.equal(acked.status, 200)
  assert.equal(acked.payload.ok, true)
  assert.equal(acked.payload.acked, 2)

  const remaining = await requestJson(ctx, '/api/cron/pending')
  assert.equal(remaining.status, 200)
  assert.deepEqual(
    remaining.payload.pending.map((item) => item.pendingId),
    [other.pendingId],
  )
})

async function waitForSessionExit(ctx, sessionId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await requestJson(ctx, `/api/runtime/session/${sessionId}`)
    if (res.status === 200 && res.payload.status === 'exited') return
    await delay(25)
  }
  throw new Error(`Timed out waiting for session to exit: ${sessionId}`)
}

async function waitForSessionStdout(ctx, sessionId, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await requestJson(ctx, `/api/runtime/session/${sessionId}`)
    if (res.status === 200 && String(res.payload.stdout || '').includes(expected)) return
    await delay(25)
  }
  throw new Error(`Timed out waiting for session stdout: ${sessionId}`)
}

async function waitForRuns(ctx, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await requestJson(ctx, '/api/runtime/runs?limit=100')
    if (res.status === 200 && predicate(res.payload.runs || [])) {
      return res.payload.runs || []
    }
    await delay(25)
  }
  throw new Error('Timed out waiting for expected run data.')
}

test('runtime session list endpoints support new and legacy paths', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const started = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: 'node -e "setTimeout(() => process.stdout.write(\'still-running\'), 1200)"',
      timeoutMs: 5_000,
      origin: 'chat',
      inputProvenance: {
        kind: 'remote_user',
        sourceChannel: 'telegram',
        conversationId: 'conv-acp-approval',
        remoteActorId: 'tg:77',
      },
    },
  })
  assert.equal(started.status, 200)
  const { sessionId } = started.payload
  assert.ok(sessionId)

  const newPath = await requestJson(ctx, '/api/runtime/sessions?status=running&limit=1&offset=0')
  assert.equal(newPath.status, 200)
  assert.ok(Array.isArray(newPath.payload.sessions))
  assert.equal(newPath.payload.limit, 1)
  assert.equal(newPath.payload.offset, 0)
  assert.equal(newPath.payload.sessions.every((item) => item.status === 'running'), true)
  assert.ok(newPath.payload.sessions.length <= 1)

  const legacyPath = await requestJson(ctx, '/api/local-runtime/sessions?limit=10')
  assert.equal(legacyPath.status, 200)
  assert.ok(Array.isArray(legacyPath.payload.sessions))
  assert.ok(legacyPath.payload.sessions.some((item) => item.sessionId === sessionId))
})

test('runtime session log endpoints support stream pagination on new and legacy paths', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const started = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: 'node -e "process.stdout.write(\'0123456789\');process.stderr.write(\'abcdefghij\')"',
      timeoutMs: 5_000,
    },
  })
  assert.equal(started.status, 200)
  const { sessionId } = started.payload
  assert.ok(sessionId)

  await waitForSessionExit(ctx, sessionId)

  const newPath = await requestJson(ctx, `/api/runtime/sessions/${sessionId}/log?stream=stdout&offset=2&limit=4`)
  assert.equal(newPath.status, 200)
  assert.equal(newPath.payload.stream, 'stdout')
  assert.equal(newPath.payload.output, '2345')
  assert.equal(newPath.payload.total, 10)
  assert.equal(newPath.payload.nextOffset, 6)
  assert.equal(newPath.payload.hasMore, true)

  const legacyPath = await requestJson(
    ctx,
    `/api/local-runtime/sessions/${sessionId}/log?stream=both&offset=3&limit=4`,
  )
  assert.equal(legacyPath.status, 200)
  assert.equal(legacyPath.payload.stream, 'both')
  assert.equal(legacyPath.payload.stdout.output, '3456')
  assert.equal(legacyPath.payload.stderr.output, 'defg')
})

test('runtime session write endpoint sends stdin to running session', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const started = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: 'node -e "process.stdin.setEncoding(\'utf8\');process.stdin.on(\'data\',d=>{process.stdout.write(\'IN:\'+d);if(d.includes(\'quit\'))process.exit(0)})"',
      timeoutMs: 8_000,
    },
  })
  assert.equal(started.status, 200)
  const { sessionId } = started.payload
  assert.ok(sessionId)

  const writeRes = await requestJson(ctx, `/api/runtime/session/${sessionId}/write`, {
    method: 'POST',
    body: { text: 'hello', submit: true },
  })
  assert.equal(writeRes.status, 200)
  assert.equal(writeRes.payload.ok, true)
  assert.equal(typeof writeRes.payload.written, 'number')

  await waitForSessionStdout(ctx, sessionId, 'IN:hello')

  await requestJson(ctx, `/api/runtime/session/${sessionId}/write`, {
    method: 'POST',
    body: { text: 'quit', submit: true },
  })
  await waitForSessionExit(ctx, sessionId)
})

test('runtime session send-keys endpoint can interrupt running process', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const started = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: interruptibleLongRunningCommand(),
      timeoutMs: 15_000,
    },
  })
  assert.equal(started.status, 200)
  const { sessionId } = started.payload
  assert.ok(sessionId)

  const sendKeys = await requestJson(ctx, `/api/runtime/session/${sessionId}/send-keys`, {
    method: 'POST',
    body: { keys: 'ctrl-c' },
  })
  assert.equal(sendKeys.status, 200)
  assert.equal(sendKeys.payload.ok, true)

  await waitForSessionExit(ctx, sessionId, 10_000)
})

test('runtime session-events endpoint returns exited events with cursor paging', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const baseline = await requestJson(ctx, '/api/runtime/session-events?after=0&limit=1')
  assert.equal(baseline.status, 200)
  const startCursor = Number(baseline.payload.nextCursor || 0)

  const started = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: 'node -e "setTimeout(() => process.exit(9), 80)"',
      timeoutMs: 5_000,
    },
  })
  assert.equal(started.status, 200)
  const { sessionId } = started.payload
  await waitForSessionExit(ctx, sessionId)

  const events = await requestJson(
    ctx,
    `/api/runtime/session-events?after=${startCursor}&limit=10`,
  )
  assert.equal(events.status, 200)
  assert.ok(Array.isArray(events.payload.events))
  const exitEvent = events.payload.events.find((item) => item.sessionId === sessionId)
  assert.ok(exitEvent)
  assert.equal(exitEvent.type, 'session_exited')
  assert.equal(typeof events.payload.nextCursor, 'number')
})

test('runtime runs endpoints expose exec/session lifecycle and diagnostics', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const execRes = await requestJson(ctx, '/api/runtime/exec', {
    method: 'POST',
    body: {
      command: 'node -e "process.stdout.write(\'ok\')"',
      timeoutMs: 5_000,
    },
  })
  assert.equal(execRes.status, 200)
  assert.equal(execRes.payload.ok, true)

  const runsAfterExec = await waitForRuns(
    ctx,
    (runs) => runs.some((run) => run.type === 'exec' && (run.state === 'done' || run.state === 'failed')),
  )
  const execRun = runsAfterExec.find(
    (run) => run.type === 'exec' && String(run.meta?.command || '').includes('process.stdout.write'),
  ) || runsAfterExec.find((run) => run.type === 'exec')
  assert.ok(execRun)
  assert.equal(execRun.state, 'done')
  assert.equal(String(execRun.meta?.command || '').length > 0, true)

  const runDetail = await requestJson(ctx, `/api/runtime/runs/${encodeURIComponent(execRun.runId)}`)
  assert.equal(runDetail.status, 200)
  assert.equal(runDetail.payload.ok, true)
  assert.equal(runDetail.payload.run.runId, execRun.runId)

  const sessionStart = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: 'node -e "setTimeout(() => process.exit(0), 80)"',
      timeoutMs: 5_000,
    },
  })
  assert.equal(sessionStart.status, 200)
  await waitForSessionExit(ctx, sessionStart.payload.sessionId)

  const runsAfterSession = await waitForRuns(
    ctx,
    (runs) => runs.some((run) => run.type === 'session' && run.meta?.sessionId === sessionStart.payload.sessionId),
  )
  const sessionRun = runsAfterSession.find(
    (run) => run.type === 'session' && run.meta?.sessionId === sessionStart.payload.sessionId,
  )
  assert.ok(sessionRun)
  assert.equal(sessionRun.state, 'done')

  const diagnostics = await requestJson(ctx, '/api/runtime/runs/diagnostics?limit=50')
  assert.equal(diagnostics.status, 200)
  assert.equal(diagnostics.payload.ok, true)
  assert.equal(diagnostics.payload.totalRuns >= 2, true)
  assert.equal(diagnostics.payload.byType.exec.total >= 1, true)
  assert.equal(diagnostics.payload.byType.session.total >= 1, true)

  const legacyList = await requestJson(ctx, '/api/local-runtime/runs?limit=20')
  assert.equal(legacyList.status, 200)
  assert.equal(Array.isArray(legacyList.payload.runs), true)
})

test('mcp server upsert endpoint persists config and returns updated server', async (t) => {
  const servers = []
  let capturedUpsert = null
  const ctx = await startTestServer({
    getMediaSupport: async () => ({ available: true, engine: 'test-engine' }),
    mcpManager: {
      getConnectedCount: () => servers.length,
      getAllTools: () => [],
      getServers: () => servers,
      callTool: async () => ({ ok: true }),
      restartServer: async () => {},
    },
    setMcpServerConfig: async (name, config) => {
      capturedUpsert = { name, config }
      const next = {
        name,
        status: 'connected',
        toolCount: 56,
        command: config.command,
        args: Array.isArray(config.args) ? config.args : [],
        startedAt: Date.now(),
      }
      const index = servers.findIndex((item) => item.name === name)
      if (index >= 0) servers[index] = next
      else servers.push(next)
      return { ok: true, name }
    },
  })
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const response = await requestJson(ctx, '/api/mcp/servers/upsert', {
    method: 'POST',
    body: {
      name: 'bnbchain-mcp',
      config: {
        command: 'npx',
        args: ['-y', '@bnb-chain/mcp@latest'],
      },
    },
  })

  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(capturedUpsert?.name, 'bnbchain-mcp')
  assert.equal(capturedUpsert?.config?.command, 'npx')
  assert.equal(response.payload.server?.name, 'bnbchain-mcp')
  assert.equal(response.payload.server?.toolCount, 56)
})

test('mcp server delete endpoint removes server config', async (t) => {
  const servers = [
    {
      name: 'bnbchain-mcp',
      status: 'connected',
      toolCount: 12,
      startedAt: Date.now(),
    },
  ]
  const removed = []
  const ctx = await startTestServer({
    getMediaSupport: async () => ({ available: true, engine: 'test-engine' }),
    mcpManager: {
      getConnectedCount: () => servers.length,
      getAllTools: () => [],
      getServers: () => servers,
      callTool: async () => ({ ok: true }),
      restartServer: async () => {},
    },
    removeMcpServerConfig: async (name) => {
      removed.push(name)
      const index = servers.findIndex((item) => item.name === name)
      if (index >= 0) servers.splice(index, 1)
      return { ok: true, name, removed: index >= 0 }
    },
  })
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const response = await requestJson(ctx, '/api/mcp/servers/bnbchain-mcp', {
    method: 'DELETE',
  })

  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.removed, true)
  assert.deepEqual(removed, ['bnbchain-mcp'])
  assert.equal(servers.length, 0)
})

test('ACP session creation and prompt execution preserve ingress provenance in the runtime runs ledger', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const created = await requestJson(ctx, '/api/acp/sessions', {
    method: 'POST',
    body: {
      agentType: 'raw',
      cwd: process.cwd(),
      command: [
        'node',
        '-e',
        'process.stdin.on("data", () => { console.log(JSON.stringify({ type: "message_stop", message: { stop_reason: "end_turn" } })); process.exit(0); })',
      ],
      timeoutMs: 5_000,
      origin: 'code_agent',
      inputProvenance: {
        kind: 'inter_agent',
        sourceChannel: 'code_agent',
        conversationId: 'conv-acp-ledger',
        originSessionId: 'code-agent-session-1',
        metaOnly: true,
      },
    },
  })
  assert.equal(created.status, 200)
  assert.ok(created.payload.sessionId)
  assert.ok(created.payload.runId)
  assert.equal(created.payload.origin, 'code_agent')
  assert.deepEqual(created.payload.inputProvenance, {
    kind: 'inter_agent',
    sourceChannel: 'code_agent',
    conversationId: 'conv-acp-ledger',
    originSessionId: 'code-agent-session-1',
    metaOnly: true,
  })

  const promptRes = await requestJson(ctx, `/api/acp/sessions/${created.payload.sessionId}/prompt`, {
    method: 'POST',
    body: {
      prompt: 'hello',
      inputProvenance: {
        kind: 'inter_agent',
        sourceChannel: 'code_agent',
        conversationId: 'conv-acp-ledger',
        originSessionId: 'code-agent-session-1',
        metaOnly: true,
      },
    },
  })
  assert.equal(promptRes.status, 200)
  assert.equal(typeof promptRes.payload.turnId, 'string')

  const deadline = Date.now() + 8_000
  let acpRun = null
  while (Date.now() < deadline) {
    const runs = await listRuns({ limit: 100, offset: 0 })
    acpRun = runs.runs.find((run) => run.runId === created.payload.runId) || null
    if (acpRun && ['done', 'failed'].includes(acpRun.state)) {
      break
    }
    await delay(50)
  }
  assert.ok(acpRun)
  assert.equal(acpRun.type, 'acp')
  assert.equal(acpRun.meta?.sessionId, created.payload.sessionId)
  assert.equal(acpRun.meta?.origin, 'code_agent')
  assert.deepEqual(acpRun.meta?.inputProvenance, {
    kind: 'inter_agent',
    sourceChannel: 'code_agent',
    conversationId: 'conv-acp-ledger',
    originSessionId: 'code-agent-session-1',
    metaOnly: true,
  })
  assert.equal(acpRun.meta?.conversationId, 'conv-acp-ledger')
  assert.equal(acpRun.state, 'done')
})

test('approval lifecycle is mirrored into the runtime runs ledger with correlation metadata', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const created = await requestJson(ctx, '/api/runtime/approvals', {
    method: 'POST',
    body: {
      requestId: 'approval-1',
      conversationId: 'conv-approval',
      toolName: 'execute_transaction',
      toolPreview: 'Transfer 1 USDT to 0xabc',
      riskLevel: 'high',
      channels: ['sidepanel'],
      expiresAt: Date.now() + 60_000,
      meta: {
        correlationId: 'corr-approval-1',
        toolCallId: 'call-tool-1',
      },
    },
  })
  assert.equal(created.status, 201)
  assert.equal(created.payload.requestId, 'approval-1')
  assert.equal(created.payload.status, 'pending')
  assert.equal(created.payload.meta?.correlationId, 'corr-approval-1')
  assert.equal(created.payload.meta?.toolCallId, 'call-tool-1')
  assert.equal(typeof created.payload.meta?.runId, 'string')
  assert.ok(created.payload.meta.runId)

  let approvalRun = null
  const approvalRunId = created.payload.meta.runId
  const pendingDeadline = Date.now() + 5_000
  while (Date.now() < pendingDeadline) {
    const runs = await listRuns({ limit: 100, offset: 0 })
    approvalRun = runs.runs.find((run) => run.runId === approvalRunId) || null
    if (approvalRun) break
    await delay(25)
  }

  assert.ok(approvalRun)
  assert.equal(approvalRun.type, 'approval')
  assert.equal(approvalRun.state, 'waiting_approval')
  assert.equal(approvalRun.meta?.requestId, 'approval-1')
  assert.equal(approvalRun.meta?.conversationId, 'conv-approval')
  assert.equal(approvalRun.meta?.toolCallId, 'call-tool-1')

  const resolved = await requestJson(ctx, '/api/runtime/approvals/approval-1/resolve', {
    method: 'POST',
    body: {
      resolution: 'approved',
      resolvedBy: 'sidepanel',
    },
  })
  assert.equal(resolved.status, 200)
  assert.equal(resolved.payload.status, 'approved')

  const doneDeadline = Date.now() + 5_000
  while (Date.now() < doneDeadline) {
    const run = await listRuns({ limit: 100, offset: 0 })
    approvalRun = run.runs.find((item) => item.runId === approvalRunId) || null
    if (approvalRun?.state === 'done') break
    await delay(25)
  }

  assert.ok(approvalRun)
  assert.equal(approvalRun.state, 'done')
  assert.equal(approvalRun.meta?.approvalStatus, 'approved')
  assert.equal(approvalRun.meta?.resolvedBy, 'sidepanel')
})

test('repeated approval POSTs reuse the canonical run and resolve that same run', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const body = {
    requestId: 'approval-dedupe-1',
    conversationId: 'conv-dedupe-1',
    toolName: 'execute_transaction',
    toolPreview: 'Transfer 5 USDT to 0xdef',
    riskLevel: 'high',
    channels: ['sidepanel'],
    expiresAt: Date.now() + 60_000,
    meta: {
      correlationId: 'corr-dedupe-1',
      toolCallId: 'tool-call-dedupe-1',
    },
  }

  const created = await requestJson(ctx, '/api/runtime/approvals', {
    method: 'POST',
    body,
  })
  assert.equal(created.status, 201)
  assert.equal(typeof created.payload.meta?.runId, 'string')

  const retried = await requestJson(ctx, '/api/runtime/approvals', {
    method: 'POST',
    body: {
      ...body,
      toolPreview: 'Transfer 5 USDT retry',
      meta: {
        correlationId: 'corr-dedupe-retry',
      },
    },
  })
  assert.ok([200, 201].includes(retried.status))
  assert.equal(retried.payload.requestId, 'approval-dedupe-1')
  assert.equal(retried.payload.meta?.runId, created.payload.meta?.runId)

  let approvalRuns = []
  const pendingDeadline = Date.now() + 5_000
  while (Date.now() < pendingDeadline) {
    const runs = await listRuns({ limit: 100, offset: 0 })
    approvalRuns = runs.runs.filter((run) => run.meta?.requestId === 'approval-dedupe-1')
    if (approvalRuns.length >= 1) break
    await delay(25)
  }

  assert.equal(approvalRuns.length, 1)
  assert.equal(approvalRuns[0].runId, created.payload.meta.runId)
  assert.equal(approvalRuns[0].state, 'waiting_approval')

  const resolved = await requestJson(ctx, '/api/runtime/approvals/approval-dedupe-1/resolve', {
    method: 'POST',
    body: {
      resolution: 'approved',
      resolvedBy: 'retry-test',
    },
  })
  assert.equal(resolved.status, 200)
  assert.equal(resolved.payload.meta?.runId, created.payload.meta.runId)

  const doneDeadline = Date.now() + 5_000
  while (Date.now() < doneDeadline) {
    const runs = await listRuns({ limit: 100, offset: 0 })
    approvalRuns = runs.runs.filter((run) => run.meta?.requestId === 'approval-dedupe-1')
    if (approvalRuns.length === 1 && approvalRuns[0].state === 'done') break
    await delay(25)
  }

  assert.equal(approvalRuns.length, 1)
  assert.equal(approvalRuns[0].state, 'done')
  assert.equal(approvalRuns[0].meta?.approvalStatus, 'approved')
  assert.equal(approvalRuns[0].meta?.resolvedBy, 'retry-test')
})

test('repeating POST after approval resolution does not reopen the canonical run', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const body = {
    requestId: 'approval-resolved-retry-1',
    conversationId: 'conv-resolved-retry-1',
    toolName: 'execute_transaction',
    toolPreview: 'Transfer 9 USDT to 0x999',
    riskLevel: 'high',
    channels: ['sidepanel'],
    expiresAt: Date.now() + 60_000,
    meta: {
      correlationId: 'corr-resolved-retry-1',
      toolCallId: 'tool-call-resolved-retry-1',
    },
  }

  const created = await requestJson(ctx, '/api/runtime/approvals', {
    method: 'POST',
    body,
  })
  assert.equal(created.status, 201)
  assert.equal(typeof created.payload.meta?.runId, 'string')
  const runId = created.payload.meta.runId

  const resolved = await requestJson(ctx, '/api/runtime/approvals/approval-resolved-retry-1/resolve', {
    method: 'POST',
    body: {
      resolution: 'approved',
      resolvedBy: 'initial-resolution',
    },
  })
  assert.equal(resolved.status, 200)
  assert.equal(resolved.payload.status, 'approved')

  let firstDone = null
  const firstDoneDeadline = Date.now() + 5_000
  while (Date.now() < firstDoneDeadline) {
    const result = await requestJson(ctx, `/api/runtime/runs/${runId}`)
    if (result.status === 200) {
      firstDone = result.payload.run || null
      if (firstDone?.state === 'done') break
    }
    await delay(25)
  }
  assert.ok(firstDone)
  assert.equal(firstDone.state, 'done')

  const retried = await requestJson(ctx, '/api/runtime/approvals', {
    method: 'POST',
    body: {
      ...body,
      toolPreview: 'Transfer 9 USDT retry after resolve',
    },
  })
  assert.equal(retried.status, 200)
  assert.equal(retried.payload.status, 'approved')
  assert.equal(retried.payload.meta?.runId, runId)

  const runAfterRetry = await requestJson(ctx, `/api/runtime/runs/${runId}`)
  assert.equal(runAfterRetry.status, 200)
  assert.equal(runAfterRetry.payload.run.state, 'done')
  assert.equal(runAfterRetry.payload.run.meta?.approvalStatus, 'approved')
  assert.equal(runAfterRetry.payload.run.meta?.resolvedBy, 'initial-resolution')
})

test('repeated POST repairs stale approval run links when the stored run is missing', async (t) => {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  await createApproval({
    requestId: 'approval-stale-run-1',
    conversationId: 'conv-stale-run-1',
    toolName: 'execute_transaction',
    toolPreview: 'Transfer 1 USDT to 0xabc',
    riskLevel: 'high',
    channels: ['sidepanel'],
    expiresAt: Date.now() + 60_000,
    meta: {
      runId: 'missing-run',
      correlationId: 'corr-stale-run-1',
    },
  })
  await flushApprovalStore()

  const ctx = await startTestServer({ preserveStores: true })
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const retried = await requestJson(ctx, '/api/runtime/approvals', {
    method: 'POST',
    body: {
      requestId: 'approval-stale-run-1',
      conversationId: 'conv-stale-run-1',
      toolName: 'execute_transaction',
      toolPreview: 'Transfer 1 USDT retry',
      riskLevel: 'high',
      channels: ['sidepanel'],
      meta: {
        correlationId: 'corr-stale-run-retry-1',
      },
    },
  })

  assert.equal(retried.status, 200)
  assert.equal(typeof retried.payload.meta?.runId, 'string')
  assert.notEqual(retried.payload.meta.runId, 'missing-run')

  const repairedApproval = await getApprovalById('approval-stale-run-1')
  assert.ok(repairedApproval)
  assert.equal(repairedApproval.meta?.runId, retried.payload.meta.runId)
  assert.equal(repairedApproval.meta?.correlationId, 'corr-stale-run-1')

  const repairedRun = await requestJson(ctx, `/api/runtime/runs/${retried.payload.meta.runId}`)
  assert.equal(repairedRun.status, 200)
  assert.equal(repairedRun.payload.run.meta?.requestId, 'approval-stale-run-1')
})

test('concurrent duplicate approval POSTs leave only one waiting approval run in the ledger', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const body = {
    requestId: 'approval-concurrent-1',
    conversationId: 'conv-concurrent-1',
    toolName: 'execute_transaction',
    toolPreview: 'Transfer 7 USDT to 0x777',
    riskLevel: 'high',
    channels: ['sidepanel'],
    expiresAt: Date.now() + 60_000,
    meta: {
      correlationId: 'corr-concurrent-1',
    },
  }

  const [first, second] = await Promise.all([
    requestJson(ctx, '/api/runtime/approvals', { method: 'POST', body }),
    requestJson(ctx, '/api/runtime/approvals', { method: 'POST', body }),
  ])

  assert.deepEqual(
    new Set([first.status, second.status]),
    new Set([201, 200]),
  )
  assert.equal(first.payload.meta?.runId, second.payload.meta?.runId)

  let approvalRuns = []
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const runs = await listRuns({ limit: 100, offset: 0 })
    approvalRuns = runs.runs.filter((run) => run.meta?.requestId === 'approval-concurrent-1')
    if (approvalRuns.length === 1) break
    await delay(25)
  }

  assert.equal(approvalRuns.length, 1)
  assert.equal(approvalRuns[0].runId, first.payload.meta.runId)
  assert.equal(approvalRuns[0].state, 'waiting_approval')
})

test('ACP permission waits create approval records tied to the existing ACP run', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const created = await requestJson(ctx, '/api/acp/sessions', {
    method: 'POST',
    body: {
      agentType: 'raw',
      cwd: process.cwd(),
      command: [
        'node',
        '-e',
        'process.stderr.write("Requested permissions were not granted yet.\\n"); setInterval(() => {}, 1000)',
      ],
      timeoutMs: 5_000,
    },
  })
  assert.equal(created.status, 200)
  assert.ok(created.payload.sessionId)
  assert.ok(created.payload.runId)

  const promptRes = await requestJson(ctx, `/api/acp/sessions/${created.payload.sessionId}/prompt`, {
    method: 'POST',
    body: {
      prompt: 'inspect the workspace',
      inputProvenance: {
        kind: 'remote_user',
        sourceChannel: 'telegram',
        conversationId: 'conv-acp-approval',
        remoteActorId: 'tg:77',
      },
    },
  })
  assert.equal(promptRes.status, 200)

  let pendingApproval = null
  const approvalDeadline = Date.now() + 5_000
  while (Date.now() < approvalDeadline) {
    const pending = await requestJson(ctx, '/api/runtime/approvals/pending')
    assert.equal(pending.status, 200)
    pendingApproval = (pending.payload.approvals || []).find((item) => item.meta?.runId === created.payload.runId) || null
    if (pendingApproval) break
    await delay(25)
  }

  assert.ok(pendingApproval)
  assert.equal(pendingApproval.status, 'pending')
  assert.equal(pendingApproval.meta?.runId, created.payload.runId)
  assert.equal(pendingApproval.meta?.sessionId, created.payload.sessionId)
  assert.deepEqual(pendingApproval.meta?.inputProvenance, {
    kind: 'remote_user',
    sourceChannel: 'telegram',
    conversationId: 'conv-acp-approval',
    remoteActorId: 'tg:77',
  })
  assert.equal(pendingApproval.meta?.conversationId, 'conv-acp-approval')

  let acpRun = null
  const runDeadline = Date.now() + 5_000
  while (Date.now() < runDeadline) {
    const run = await listRuns({ limit: 100, offset: 0 })
    acpRun = run.runs.find((item) => item.runId === created.payload.runId) || null
    if (acpRun?.state === 'waiting_approval') break
    await delay(25)
  }

  assert.ok(acpRun)
  assert.equal(acpRun.state, 'waiting_approval')
  assert.equal(acpRun.meta?.requestId, pendingApproval.requestId)
  assert.equal(acpRun.meta?.approvalStatus, 'pending')

  const cancelled = await requestJson(ctx, `/api/acp/sessions/${created.payload.sessionId}/cancel`, {
    method: 'POST',
    body: {},
  })
  assert.equal(cancelled.status, 200)
})

test('startup recovery marks orphaned session and ACP runs as failed after companion restart', async (t) => {
  const { createRun, flushRunStore, getRunById } = await import('./run-store.mjs')
  const { flushApprovalStore } = await import('./approval-store.mjs')
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()

  await createRun({
    runId: 'session-orphan',
    type: 'session',
    state: 'running',
    startedAt: Date.now() - 10_000,
    summary: 'Session started',
    meta: { sessionId: 'session-1', command: 'node run.js' },
  })
  await createRun({
    runId: 'acp-orphan',
    type: 'acp',
    state: 'idle',
    summary: 'ACP session created',
    meta: { sessionId: 'acp-1', agentType: 'codex' },
  })
  await flushRunStore()
  await flushApprovalStore()

  const ctx = await startTestServer({ preserveStores: true })
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  await delay(50)

  const orphanSessionRun = await getRunById('session-orphan')
  const orphanAcpRun = await getRunById('acp-orphan')

  assert.equal(orphanSessionRun?.state, 'failed')
  assert.equal(orphanSessionRun?.meta?.recoveredAfterRestart, true)
  assert.equal(orphanAcpRun?.state, 'failed')
  assert.equal(orphanAcpRun?.meta?.recoveredAfterRestart, true)
})
