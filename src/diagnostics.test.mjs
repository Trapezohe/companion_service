import test from 'node:test'
import assert from 'node:assert/strict'

import { buildDiagnosticsPayload } from './diagnostics.mjs'
import { clearRunStoreForTests, createRun, flushRunStore } from './run-store.mjs'
import { clearApprovalStoreForTests, createApproval, flushApprovalStore } from './approval-store.mjs'
import {
  clearBrowserLedgerForTests,
  flushBrowserLedger,
  syncBrowserAction,
  syncBrowserArtifact,
  syncBrowserSession,
} from './browser-ledger.mjs'

const BASE_FEATURES = {
  acp: true,
  mcp: true,
  cronReplay: true,
  diagnostics: true,
  approvalStore: true,
  runLedger: true,
  mediaNormalization: true,
}

test('buildDiagnosticsPayload summarizes capability coverage, ACP ingress, and media normalization support', async (t) => {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  await clearBrowserLedgerForTests()
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
    await clearBrowserLedgerForTests()
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
  assert.equal(payload.capabilitySummary.unavailableFeatures.includes('mcp'), true)
  assert.equal(payload.acpIngressSummary.recentRuns, 2)
  assert.equal(payload.acpIngressSummary.failedRuns, 1)
  assert.equal(payload.acpIngressSummary.pendingApprovals, 1)
  assert.equal(payload.mediaNormalizationSummary.enabled, true)
  assert.equal(payload.mediaNormalizationSummary.available, true)
  assert.equal(payload.mediaNormalizationSummary.engine, 'test-engine')
  assert.equal(payload.browser.enabled, true)
  assert.equal(payload.browser.loaded, true)
  assert.equal(payload.browser.capabilities.browserLedger, true)
  assert.equal(payload.browser.capabilities.browserEvents, true)
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
})
