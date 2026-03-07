import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearApprovalStoreForTests,
  createApproval,
  getApprovalById,
  listPendingApprovals,
} from './approval-store.mjs'

test('createApproval is idempotent for the same requestId and preserves the canonical run link', async (t) => {
  await clearApprovalStoreForTests()
  t.after(async () => {
    await clearApprovalStoreForTests()
  })

  const first = await createApproval({
    requestId: 'req-approval-1',
    conversationId: 'conv-approval-1',
    toolName: 'Read',
    toolPreview: 'Read /tmp/one.txt',
    riskLevel: 'medium',
    channels: ['sidepanel'],
    expiresAt: Date.now() + 60_000,
    meta: {
      runId: 'run-approval-1',
      correlationId: 'corr-approval-1',
    },
  })

  const retried = await createApproval({
    requestId: 'req-approval-1',
    conversationId: 'conv-approval-retry',
    toolName: 'Bash',
    toolPreview: 'Run ls',
    riskLevel: 'high',
    channels: ['telegram'],
    expiresAt: Date.now() + 120_000,
    meta: {
      correlationId: 'corr-approval-retry',
    },
  })

  assert.equal(retried.requestId, first.requestId)
  assert.equal(retried.createdAt, first.createdAt)
  assert.equal(retried.status, 'pending')
  assert.equal(retried.meta?.runId, 'run-approval-1')
  assert.equal(retried.meta?.correlationId, 'corr-approval-1')

  const stored = await getApprovalById('req-approval-1')
  assert.equal(stored?.meta?.runId, 'run-approval-1')

  const pending = await listPendingApprovals()
  assert.equal(pending.filter((item) => item.requestId === 'req-approval-1').length, 1)
})
