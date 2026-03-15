import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

import { buildDiagnosticsPayload } from './diagnostics.mjs'
import { clearRunStoreForTests, createRun, flushRunStore } from './run-store.mjs'
import { clearApprovalStoreForTests, createApproval, flushApprovalStore } from './approval-store.mjs'
import {
  clearMemoryShadowStoreForTests,
  flushMemoryShadowStore,
  ingestMemoryShadowEnvelope,
} from './memory-shadow-store.mjs'
import {
  clearBrowserLedgerForTests,
  flushBrowserLedger,
  syncBrowserAction,
  syncBrowserArtifact,
  syncBrowserSession,
} from './browser-ledger.mjs'
import { cleanupAllAcpSessions, createAcpSession } from './acp-session.mjs'
import {
  clearAutomationSessionStoreForTests,
  setAutomationSessionBinding,
} from './automation-session-store.mjs'
import {
  clearCronStoreForTests,
  upsertJob,
} from './cron-store.mjs'

const previousConfigDir = process.env.TRAPEZOHE_CONFIG_DIR
const testConfigDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-diagnostics-test-'))
process.env.TRAPEZOHE_CONFIG_DIR = testConfigDir

after(async () => {
  await clearRunStoreForTests().catch(() => undefined)
  await clearApprovalStoreForTests().catch(() => undefined)
  await clearMemoryShadowStoreForTests().catch(() => undefined)
  await clearBrowserLedgerForTests().catch(() => undefined)
  await clearAutomationSessionStoreForTests().catch(() => undefined)
  await clearCronStoreForTests().catch(() => undefined)
  cleanupAllAcpSessions()
  if (previousConfigDir === undefined) delete process.env.TRAPEZOHE_CONFIG_DIR
  else process.env.TRAPEZOHE_CONFIG_DIR = previousConfigDir
  await rm(testConfigDir, { recursive: true, force: true }).catch(() => undefined)
})

const BASE_FEATURES = {
  acp: true,
  mcp: true,
  cronReplay: true,
  diagnostics: true,
  approvalStore: true,
  runLedger: true,
  browserDrilldown: true,
  mediaNormalization: true,
}


function makeShadowEnvelope() {
  const latestPointer = {
    version: 1,
    generation: '2026-03-13T00-00-00.000Z',
    committedAt: 1700000005000,
    manifestKey: 'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/manifest.json',
  }
  const history = {
    version: 1,
    generation: '2026-03-13T00-00-00.000Z',
    previousGeneration: '2026-03-12T00-00-00.000Z',
    coverageDay: '2026-03-13',
    committedAt: 1700000005000,
    manifestKey: latestPointer.manifestKey,
    artifactCount: 2,
    requiredArtifactCount: 2,
    lastHistoryKey: 'memory-checkpoints/history/2026-03-13T00-00-00.000Z.json',
  }
  const manifest = {
    version: 1,
    generatedAt: 1700000000000,
    committedAt: 1700000005000,
    generation: '2026-03-13T00-00-00.000Z',
    previousGeneration: '2026-03-12T00-00-00.000Z',
    latestPointerKey: 'memory-checkpoints/latest.json',
    overallHash: 'overall-hash',
    nodeCount: 1,
    coreDocCount: 0,
    dailyLogCount: 0,
    structuredContextCount: 1,
    artifacts: [
      {
        key: 'context-nodes.json',
        label: 'Context Snapshot',
        kind: 'context_snapshot',
        updatedAt: 1700000000000,
        checksum: 'ctx-checksum',
        count: 1,
        bytes: 128,
        storageKey: 'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/context-nodes.json',
        required: true,
      },
      {
        key: 'memory-index.json',
        label: 'memory-index.json',
        kind: 'derived_meta',
        updatedAt: 1700000005000,
        checksum: 'memory-index-checksum',
        bytes: 32,
        storageKey: 'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/indexes/memory-index.json',
        required: true,
      },
    ],
  }
  return {
    version: 1,
    authority: 'extension_primary',
    generation: '2026-03-13T00-00-00.000Z',
    previousGeneration: '2026-03-12T00-00-00.000Z',
    committedAt: 1700000005000,
    latestPointer,
    latestPointerPayload: JSON.stringify(latestPointer),
    history,
    historyPayload: JSON.stringify(history),
    manifest,
    manifestPayload: JSON.stringify(manifest),
    artifactPayloads: {
      'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/context-nodes.json': '{"nodes":true}',
      'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/indexes/memory-index.json': '[{"id":"mem-1"}]',
    },
  }
}

test('buildDiagnosticsPayload summarizes capability coverage, ACP ingress, and media normalization support', async (t) => {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  await clearMemoryShadowStoreForTests()
  await clearBrowserLedgerForTests()
  await clearCronStoreForTests()
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    await clearMemoryShadowStoreForTests()
    await clearBrowserLedgerForTests()
    await clearCronStoreForTests()
  })

  await createRun({ type: 'acp', state: 'done', summary: 'acp ok' })
  await createRun({ type: 'acp', state: 'failed', summary: 'acp failed', error: 'boom' })
  await createRun({ type: 'cron', state: 'done', summary: 'cron ok' })
  await createApproval({
    requestId: 'approval-1',
    conversationId: 'conv-1',
    toolName: 'swap',
    toolPreview: 'swap preview',
    riskLevel: 'high',
    channels: ['sidepanel'],
  })
  await flushRunStore()
  await flushApprovalStore()
  await syncBrowserSession({
    session: {
      sessionId: 'browser-session-1',
      driver: 'extension-tab',
      state: 'ready',
      createdAt: 1_710_000_100_000,
      updatedAt: 1_710_000_100_100,
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
      lastSeenAt: 1_710_000_100_100,
    }],
    link: {
      runId: 'run-browser-1',
      conversationId: 'conv-browser-1',
      sourceToolName: 'browser_navigate',
      sourceToolCallId: 'tool-call-browser-1',
      approvalRequestId: 'approval-browser-1',
    },
    source: 'extension-background',
  })
  await syncBrowserAction({
    action: {
      actionId: 'browser-action-1',
      sessionId: 'browser-session-1',
      targetId: 'target-1',
      kind: 'click',
      status: 'failed',
      startedAt: 1_710_000_100_200,
      finishedAt: 1_710_000_100_250,
      inputSummary: 'click [1]',
      error: {
        code: 'TARGET_STALE',
        message: 'Please refresh snapshot.',
        retryable: true,
      },
    },
    link: {
      runId: 'run-browser-1',
      conversationId: 'conv-browser-1',
      sourceToolName: 'browser_click',
      sourceToolCallId: 'tool-call-browser-1',
      approvalRequestId: 'approval-browser-1',
    },
  })
  await syncBrowserArtifact({
    artifact: {
      artifactId: 'browser-artifact-1',
      sessionId: 'browser-session-1',
      targetId: 'target-1',
      kind: 'screenshot',
      createdAt: 1_710_000_100_300,
      mimeType: 'image/png',
      byteLength: 42,
      storage: 'companion',
      pathOrKey: 'browser/browser-artifact-1.png',
    },
    actionId: 'browser-action-1',
  })
  await flushBrowserLedger()

  const payload = await buildDiagnosticsPayload({
    protocolVersion: 'trapezohe-companion/2026-03-07',
    version: '0.1.0-test',
    supportedFeatures: {
      ...BASE_FEATURES,
      mcp: false,
      browserLedger: true,
      browserEvents: true,
    },
    getPermissionPolicy: () => ({ mode: 'full', workspaceRoots: [] }),
    getMediaSupport: async () => ({ available: true, engine: 'test-engine' }),
    mcpManager: {
      getConnectedCount: () => 0,
      getAllTools: () => [],
      getServers: () => [],
    },
  })

  assert.equal(payload.capabilitySummary.totalFeatures >= 7, true)
  assert.equal(payload.capabilitySummary.availableFeatures.includes('acp'), true)
  assert.equal(payload.capabilitySummary.availableFeatures.includes('automationExecutor'), true)
  assert.equal(payload.capabilitySummary.availableFeatures.includes('automationOutbox'), true)
  assert.equal(payload.capabilitySummary.availableFeatures.includes('browserDrilldown'), true)
  assert.equal(payload.capabilitySummary.unavailableFeatures.includes('mcp'), true)
  assert.equal(payload.acpIngressSummary.recentRuns, 2)
  assert.equal(payload.acpIngressSummary.failedRuns, 1)
  assert.equal(payload.acpIngressSummary.pendingApprovals, 1)
  assert.equal(payload.automation.totalJobs, 0)
  assert.equal(payload.automation.companionExecutableJobs, 0)
  assert.equal(payload.automation.outboxDeliveries, 0)
  assert.equal(payload.mediaNormalizationSummary.enabled, true)
  assert.equal(payload.mediaNormalizationSummary.available, true)
  assert.equal(payload.mediaNormalizationSummary.engine, 'test-engine')
  assert.equal(payload.browser.enabled, true)
  assert.equal(payload.browser.loaded, true)
  assert.equal(payload.browser.capabilities.browserLedger, true)
  assert.equal(payload.browser.capabilities.browserEvents, true)
  assert.equal(payload.browser.capabilities.browserDrilldown, true)
  assert.equal(payload.browser.sessions.total, 1)
  assert.equal(payload.browser.sessions.active, 1)
  assert.equal(payload.browser.sessions.linked, 1)
  assert.equal(payload.browser.sessions.recentLinked[0].link.runId, 'run-browser-1')
  assert.equal(payload.browser.actions.failedRecent, 1)
  assert.equal(payload.browser.actions.linked, 1)
  assert.equal(payload.browser.actions.recentLinked[0].link.sourceToolCallId, 'tool-call-browser-1')
  assert.equal(payload.browser.artifacts.recent, 1)
  assert.equal(payload.browser.events.total, 3)
  assert.equal(payload.browser.events.recent[0].type, 'artifact_synced')
  assert.equal(payload.browser.operator.drilldownAvailable, true)
  assert.equal(payload.browser.operator.routes.drilldown, '/api/browser/drilldown')
  assert.deepEqual(payload.browser.operator.eventWindowModes, ['tail'])
})

test('buildDiagnosticsPayload summarizes automation execution bindings and active automation sessions', async (t) => {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  await clearAutomationSessionStoreForTests()
  await clearCronStoreForTests()
  cleanupAllAcpSessions()
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    await clearAutomationSessionStoreForTests()
    await clearCronStoreForTests()
    cleanupAllAcpSessions()
  })

  const automationSession = createAcpSession({
    agentType: 'codex',
    origin: 'automation',
  })
  createAcpSession({
    agentType: 'codex',
    origin: 'interactive',
  })
  await setAutomationSessionBinding('persistent:daily-brief', automationSession.sessionId)

  const payload = await buildDiagnosticsPayload({
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

  assert.equal(payload.automation.execution.persistentBindings, 1)
  assert.equal(payload.automation.execution.activeAcpSessions, 1)
  assert.equal(payload.automation.execution.runningAcpSessions, 0)
  assert.equal(payload.automation.execution.recentBindings[0].key, 'persistent:daily-brief')
  assert.equal(payload.automation.execution.recentBindings[0].sessionId, automationSession.sessionId)
})

test('buildDiagnosticsPayload exposes lifecycle-capable automation job counts', async (t) => {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  await clearCronStoreForTests()
  cleanupAllAcpSessions()
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    await clearCronStoreForTests()
    cleanupAllAcpSessions()
  })

  await upsertJob({
    id: 'job-main',
    name: 'Main task',
    executor: 'extension_chat',
    sessionTarget: 'main',
    delivery: { mode: 'notification' },
  })
  await upsertJob({
    id: 'job-persistent',
    name: 'Persistent task',
    executor: 'companion_acp',
    agentType: 'codex',
    sessionTarget: 'persistent:research-loop',
    sessionRetention: {
      maxAgeDays: 14,
      maxRuns: 30,
    },
    delivery: { mode: 'chat' },
  })

  const payload = await buildDiagnosticsPayload({
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

  assert.equal(payload.automation.totalJobs, 2)
  assert.equal(payload.automation.lifecycleCapableJobs, 1)
})


test('buildDiagnosticsPayload surfaces mirrored checkpoint shadow status without promoting it to primary authority', async (t) => {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  await clearMemoryShadowStoreForTests()
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    await clearMemoryShadowStoreForTests()
  })

  await ingestMemoryShadowEnvelope(makeShadowEnvelope(), { shadowedAt: 1700000009000 })
  await flushMemoryShadowStore()

  const payload = await buildDiagnosticsPayload({
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

  assert.equal(payload.memoryShadow.authority, 'extension_primary')
  assert.equal(payload.memoryShadow.mirroredGeneration, '2026-03-13T00-00-00.000Z')
  assert.equal(payload.memoryShadow.mirroredCommittedAt, 1700000005000)
  assert.equal(payload.memoryShadow.freshness.state, 'fresh')
  assert.equal(payload.memoryShadow.freshness.shadowedAt, 1700000009000)
  assert.equal(payload.memoryShadow.verification.state, 'unknown')
})


test('buildDiagnosticsPayload distinguishes extension-primary freshness from shadow-refresh freshness', async (t) => {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  await clearMemoryShadowStoreForTests()
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    await clearMemoryShadowStoreForTests()
  })

  const staleCommittedAt = Date.UTC(2026, 2, 10, 0, 0, 0)
  const envelope = makeShadowEnvelope()
  envelope.committedAt = staleCommittedAt
  envelope.latestPointer.committedAt = staleCommittedAt
  envelope.history.committedAt = staleCommittedAt
  envelope.manifest.committedAt = staleCommittedAt
  envelope.manifest.generatedAt = staleCommittedAt - 1000
  envelope.latestPointerPayload = JSON.stringify(envelope.latestPointer)
  envelope.historyPayload = JSON.stringify(envelope.history)
  envelope.manifestPayload = JSON.stringify(envelope.manifest)
  await ingestMemoryShadowEnvelope(envelope, { shadowedAt: staleCommittedAt })
  await flushMemoryShadowStore()

  const payload = await buildDiagnosticsPayload({
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
    memoryShadowRefresh: {
      available: true,
      freshnessSlaHours: 30,
      getState: async () => ({
        state: 'shadow_refresh_fresh',
        freshnessOwner: 'shadow_refresh',
        freshnessSlaHours: 30,
        lastAttemptAt: Date.UTC(2026, 2, 13, 12, 0, 0),
        lastOutcome: 'published',
        lastError: null,
        lastSourceGeneration: envelope.generation,
        lastSourceCommittedAt: staleCommittedAt,
        lastPublishedGeneration: '2026-03-13T12-00-00.000Z',
        lastPublishedAt: Date.UTC(2026, 2, 13, 12, 0, 0),
        lastPublishSource: 'shadow_refresh',
      }),
    },
  })

  assert.equal(payload.memoryShadowRefresh.available, true)
  assert.equal(payload.memoryShadowRefresh.state, 'shadow_refresh_fresh')
  assert.equal(payload.memoryShadowRefresh.freshnessOwner, 'shadow_refresh')
  assert.equal(payload.memoryShadowRefresh.lastPublishSource, 'shadow_refresh')
  assert.equal(payload.memoryShadowRefresh.lastPublishedGeneration, '2026-03-13T12-00-00.000Z')
})
