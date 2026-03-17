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


test('createApproval preserves canonical ACP provenance metadata across retries', async (t) => {
  await clearApprovalStoreForTests()
  t.after(async () => {
    await clearApprovalStoreForTests()
  })

  const provenance = {
    kind: 'remote_user',
    sourceChannel: 'telegram',
    conversationId: 'conv-acp-approval',
    remoteActorId: 'tg:77',
  }

  await createApproval({
    requestId: 'req-acp-approval-2',
    conversationId: 'conv-acp-approval',
    toolName: 'acp_permission',
    toolPreview: 'Approve filesystem write',
    riskLevel: 'high',
    channels: ['sidepanel'],
    expiresAt: Date.now() + 60_000,
    meta: {
      runId: 'run-acp-approval-2',
      sessionId: 'session-acp-approval-2',
      turnId: 'turn-acp-approval-2',
      inputProvenance: provenance,
    },
  })

  const retried = await createApproval({
    requestId: 'req-acp-approval-2',
    conversationId: 'conv-ignored-retry',
    toolName: 'ignored',
    toolPreview: 'ignored',
    riskLevel: 'low',
    channels: ['telegram'],
    expiresAt: Date.now() + 120_000,
    meta: {
      runId: 'run-overwrite-attempt',
      sessionId: 'session-overwrite-attempt',
      turnId: 'turn-overwrite-attempt',
      inputProvenance: { kind: 'internal_system', sourceChannel: 'system', conversationId: 'wrong' },
    },
  })

  assert.equal(retried.meta?.runId, 'run-acp-approval-2')
  assert.equal(retried.meta?.sessionId, 'session-acp-approval-2')
  assert.equal(retried.meta?.turnId, 'turn-acp-approval-2')
  assert.deepEqual(retried.meta?.inputProvenance, provenance)
})

test('createApproval mirrors the canonical approval request id into meta and preserves it across retries', async (t) => {
  await clearApprovalStoreForTests()
  t.after(async () => {
    await clearApprovalStoreForTests()
  })

  const created = await createApproval({
    requestId: 'req-canonical-approval-3',
    conversationId: 'conv-canonical-approval-3',
    toolName: 'Write',
    toolPreview: 'Write file',
    riskLevel: 'high',
    channels: ['sidepanel'],
    expiresAt: Date.now() + 60_000,
    meta: {
      runId: 'run-canonical-approval-3',
    },
  })

  assert.equal(created.meta?.approvalRequestId, 'req-canonical-approval-3')
  assert.equal(created.meta?.requestId, 'req-canonical-approval-3')

  const retried = await createApproval({
    requestId: 'req-canonical-approval-3',
    conversationId: 'conv-ignored',
    toolName: 'Ignored',
    toolPreview: 'Ignored',
    riskLevel: 'low',
    channels: ['telegram'],
    expiresAt: Date.now() + 120_000,
    meta: {
      approvalRequestId: 'wrong-approval-id',
      requestId: 'wrong-request-id',
    },
  })

  assert.equal(retried.meta?.approvalRequestId, 'req-canonical-approval-3')
  assert.equal(retried.meta?.requestId, 'req-canonical-approval-3')
  assert.equal(retried.meta?.runId, 'run-canonical-approval-3')
})
