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
import {
  clearAutomationBudgetStoreForTests,
  setAutomationBudgetLedger,
} from './automation-budget-store.mjs'

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
  await clearAutomationBudgetStoreForTests().catch(() => undefined)
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
  assert.deepEqual(payload.automation.featureFlags, {
    scheduledWriteGuardV22: true,
    persistentBudgetV22: true,
    workflowKernelV22: true,
    watcherPolicyV23: true,
    orchestrationRegistryV23: false,
    watcherEscalationV23: false,
    sessionQualityRollupV23: false,
    recipeLayerV23: false,
  })
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
  await clearAutomationBudgetStoreForTests()
  cleanupAllAcpSessions()
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    await clearCronStoreForTests()
    await clearAutomationBudgetStoreForTests()
    cleanupAllAcpSessions()
  })

  await upsertJob({
    id: 'job-main',
    name: 'Main task',
    executor: 'extension_chat',
    sessionTarget: 'main',
    scheduledWritePolicy: {
      mode: 'allowlist',
      allowedTools: ['write_file'],
      allowedPaths: ['/tmp/reports'],
      allowedCommandPrefixes: null,
      enforcement: 'extension_hard',
    },
    delivery: { mode: 'notification' },
  })
  await upsertJob({
    id: 'job-persistent',
    name: 'Persistent task',
    executor: 'companion_acp',
    agentType: 'codex',
    sessionTarget: 'persistent:research-loop',
    scheduledWritePolicy: {
      mode: 'allowlist',
      allowedTools: ['write_file'],
      allowedPaths: ['/tmp/reports'],
      allowedCommandPrefixes: null,
      enforcement: 'prompt_only',
    },
    workflow: {
      template: 'research_synthesis',
      state: null,
    },
    watcher: {
      policy: {
        mode: 'change_only',
        minNotifyIntervalMinutes: 30,
      },
      state: null,
    },
    sessionBudget: {
      policy: {
        mode: 'deep_research',
        maxContextBudget: 24000,
        dayRollupEnabled: true,
        compactAfterRuns: 6,
      },
      ledger: null,
    },
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
  assert.equal(payload.automation.allowlistScheduledWrites, 2)
  assert.equal(payload.automation.workflowCapableJobs, 1)
  assert.equal(payload.automation.watcherConfiguredJobs, 1)
  assert.equal(payload.automation.budgetManagedJobs, 1)
  assert.equal(payload.automation.scheduledWriteEnforcements.extensionHard, 1)
  assert.equal(payload.automation.scheduledWriteEnforcements.promptOnly, 1)
})

test('buildDiagnosticsPayload exposes workflow step ledgers for recent companion automation runs', async (t) => {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  await clearCronStoreForTests()
  await clearAutomationBudgetStoreForTests()
  cleanupAllAcpSessions()
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    await clearCronStoreForTests()
    await clearAutomationBudgetStoreForTests()
    cleanupAllAcpSessions()
  })

  await createRun({
    runId: 'run-workflow-diagnostics',
    type: 'cron',
    state: 'running',
    summary: 'workflow running',
    meta: {
      taskId: 'task-workflow',
      taskName: 'Workflow task',
      executionMode: 'companion_acp',
      taskState: 'running',
      stepState: 'execute',
      workflow: {
        template: 'research_synthesis',
        state: {
          currentStepId: 'research',
          steps: [
            { id: 'plan', kind: 'plan', state: 'done', runId: 'run-workflow-diagnostics', summary: 'Plan ready.' },
            { id: 'research', kind: 'research', state: 'running', runId: 'run-workflow-diagnostics', summary: null },
            { id: 'synthesize', kind: 'synthesize', state: 'queued', runId: null, summary: null },
          ],
          lastWorkflowSummary: 'Plan ready.',
        },
      },
    },
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

  assert.equal(payload.automation.recentLifecyclePhases[0]?.runId, 'run-workflow-diagnostics')
  assert.equal(payload.automation.activeWorkflowRuns, 1)
  assert.equal(payload.automation.recentLifecyclePhases[0]?.workflow?.template, 'research_synthesis')
  assert.equal(payload.automation.recentLifecyclePhases[0]?.workflow?.state?.currentStepId, 'research')
  assert.equal(payload.automation.recentLifecyclePhases[0]?.workflow?.state?.steps?.[0]?.summary, 'Plan ready.')
  assert.equal(payload.automation.recentLifecyclePhases[0]?.workflow?.state?.lastWorkflowSummary, 'Plan ready.')
})

test('buildDiagnosticsPayload exposes stable run explanations for blocked, waiting, cancelled, replaying, and failed runs', async (t) => {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  cleanupAllAcpSessions()
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    cleanupAllAcpSessions()
  })

  await createApproval({
    requestId: 'approval-wait-1',
    conversationId: 'conv-1',
    toolName: 'write_file',
    toolPreview: 'write report.md',
    riskLevel: 'high',
    channels: ['sidepanel'],
  })

  await createRun({
    runId: 'run-blocked-1',
    type: 'exec',
    state: 'failed',
    source: 'remote',
    contractVersion: 2,
    summary: 'Blocked by remote policy',
    error: 'blocked_by_remote_mode_high_risk',
    meta: {
      policyReason: 'blocked_by_remote_mode_high_risk',
    },
  })
  await createRun({
    runId: 'run-waiting-1',
    type: 'approval',
    state: 'waiting_approval',
    source: 'remote',
    contractVersion: 2,
    summary: 'Awaiting approval',
    meta: {
      requestId: 'approval-wait-1',
      approvalStatus: 'pending',
    },
  })
  await createRun({
    runId: 'run-cancelled-1',
    type: 'approval',
    state: 'cancelled',
    source: 'remote',
    contractVersion: 2,
    summary: 'Approval rejected',
    meta: {
      requestId: 'approval-cancelled-1',
      approvalStatus: 'rejected',
    },
  })
  await createRun({
    runId: 'run-replaying-1',
    type: 'cron',
    state: 'retrying',
    source: 'replay',
    contractVersion: 2,
    summary: 'Retrying replay',
    meta: {
      replayOf: { kind: 'cron_pending', pendingId: 'pending-1' },
    },
  })
  await createRun({
    runId: 'run-failed-1',
    type: 'cron',
    state: 'failed',
    source: 'replay',
    contractVersion: 2,
    summary: 'Replay failed',
    error: 'fetch failed: socket hang up',
    meta: {
      replayOf: { kind: 'cron_pending', pendingId: 'pending-2' },
    },
  })
  await flushRunStore()
  await flushApprovalStore()

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

  assert.equal(payload.contractVersion, 2)
  assert.equal(payload.permissionPolicy.policyReason, 'policy_mode:full')

  const blocked = payload.runs.recentExplanations.find((item) => item.runId === 'run-blocked-1')
  const waiting = payload.runs.recentExplanations.find((item) => item.runId === 'run-waiting-1')
  const cancelled = payload.runs.recentExplanations.find((item) => item.runId === 'run-cancelled-1')
  const replaying = payload.runs.recentExplanations.find((item) => item.runId === 'run-replaying-1')
  const failed = payload.runs.recentExplanations.find((item) => item.runId === 'run-failed-1')

  assert.equal(blocked.lifecycle, 'blocked')
  assert.equal(blocked.runOwner, 'remote')
  assert.equal(blocked.policyReason, 'blocked_by_remote_mode_high_risk')
  assert.equal(blocked.failureCategory, 'policy_blocked')

  assert.equal(waiting.lifecycle, 'waiting_approval')
  assert.equal(waiting.policyReason, 'awaiting_user_approval')
  assert.equal(waiting.failureCategory, 'approval_wait')
  assert.equal(typeof waiting.approvalWaitMs, 'number')

  assert.equal(cancelled.lifecycle, 'cancelled')
  assert.equal(cancelled.failureCategory, 'cancelled')

  assert.equal(replaying.lifecycle, 'replaying')
  assert.equal(replaying.runOwner, 'replay')
  assert.equal(replaying.replayCount, 1)

  assert.equal(failed.lifecycle, 'failed')
  assert.equal(failed.runOwner, 'replay')
  assert.equal(failed.replayCount, 1)
  assert.equal(failed.failureCategory, 'network')
})

test('buildDiagnosticsPayload summarizes companion budget health across tracked persistent sessions', async (t) => {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  await clearCronStoreForTests()
  await clearAutomationBudgetStoreForTests()
  cleanupAllAcpSessions()
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    await clearCronStoreForTests()
    await clearAutomationBudgetStoreForTests()
    cleanupAllAcpSessions()
  })

  await setAutomationBudgetLedger('persistent:healthy-loop', {
    approxInputTokens: 1200,
    approxOutputTokens: 900,
    compactionCount: 1,
    lastRollupAt: 1_700_000_000_000,
    health: 'healthy',
  })
  await setAutomationBudgetLedger('persistent:warning-loop', {
    approxInputTokens: 2400,
    approxOutputTokens: 1600,
    compactionCount: 4,
    lastRollupAt: 1_700_000_100_000,
    health: 'warning',
  })
  await setAutomationBudgetLedger('persistent:critical-loop', {
    approxInputTokens: 3400,
    approxOutputTokens: 2600,
    compactionCount: 8,
    lastRollupAt: 1_700_000_200_000,
    health: 'critical',
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

  assert.equal(payload.automation.budgetHealth.trackedSessions, 3)
  assert.equal(payload.automation.budgetHealth.healthy, 1)
  assert.equal(payload.automation.budgetHealth.warning, 1)
  assert.equal(payload.automation.budgetHealth.critical, 1)
  assert.equal(payload.automation.budgetHealth.lastRollupAt, 1_700_000_200_000)
})


test('buildDiagnosticsPayload exposes v2.3 feature flags and orchestration template counts', async (t) => {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  await clearCronStoreForTests()
  await clearAutomationBudgetStoreForTests()
  cleanupAllAcpSessions()
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    await clearCronStoreForTests()
    await clearAutomationBudgetStoreForTests()
    cleanupAllAcpSessions()
  })

  await upsertJob({
    id: 'job-decision',
    name: 'Decision task',
    executor: 'companion_acp',
    agentType: 'codex',
    sessionTarget: 'persistent:decision-loop',
    workflow: { template: 'research_decision', state: null },
    watcher: {
      policy: {
        mode: 'change_only',
        minNotifyIntervalMinutes: 30,
        escalateWithWorkflow: true,
        escalationTemplate: 'research_synthesis',
      },
      state: null,
    },
    sessionBudget: {
      policy: { mode: 'default', maxContextBudget: null, dayRollupEnabled: true, compactAfterRuns: null },
      ledger: { approxInputTokens: 3400, approxOutputTokens: 2600, compactionCount: 8, lastRollupAt: null, health: 'critical' },
    },
    delivery: { mode: 'notification' },
  })
  await upsertJob({
    id: 'job-synthesis',
    name: 'Synthesis task',
    executor: 'companion_acp',
    agentType: 'codex',
    sessionTarget: 'persistent:synthesis-loop',
    workflow: { template: 'research_synthesis', state: null },
    delivery: { mode: 'notification' },
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

  // v2.3 feature flags
  assert.equal(payload.automation.featureFlags.orchestrationRegistryV23, false)
  assert.equal(payload.automation.featureFlags.watcherEscalationV23, false)
  assert.equal(payload.automation.featureFlags.sessionQualityRollupV23, false)
  assert.equal(payload.automation.featureFlags.recipeLayerV23, false)
  // v2.3 orchestration template counts
  assert.equal(typeof payload.automation.activeWorkflowTemplates, 'object')
  assert.equal(payload.automation.activeWorkflowTemplates.research_synthesis, 1)
  assert.equal(payload.automation.activeWorkflowTemplates.research_decision, 1)
  // v2.3 watcher escalation pending
  assert.equal(payload.automation.watcherEscalationsPending, 1)
  // v2.3 critical session quality
  assert.equal(payload.automation.criticalSessionQuality, 1)
  // v2.3 rollup-backed and compaction counters
  assert.equal(typeof payload.automation.rollupBackedSessions, 'number')
  assert.equal(typeof payload.automation.recentCompactions, 'number')
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
