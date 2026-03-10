import test from 'node:test'
import assert from 'node:assert/strict'

import { buildDiagnosticsPayload } from './diagnostics.mjs'
import { clearRunStoreForTests, createRun, flushRunStore } from './run-store.mjs'
import { clearApprovalStoreForTests, createApproval, flushApprovalStore } from './approval-store.mjs'

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
  t.after(async () => {
    await clearRunStoreForTests()
    await clearApprovalStoreForTests()
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

  const payload = await buildDiagnosticsPayload({
    protocolVersion: 'trapezohe-companion/2026-03-07',
    version: '0.1.0-test',
    supportedFeatures: {
      ...BASE_FEATURES,
      mcp: false,
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
})
