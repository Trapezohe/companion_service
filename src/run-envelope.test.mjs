import test from 'node:test'
import assert from 'node:assert/strict'

import { RUN_CONTRACT_VERSION, normalizeRun } from './run-envelope.mjs'

test('normalizeRun preserves canonical v2 fields', () => {
  const createdAt = 1_710_000_000_000
  const run = normalizeRun({
    runId: 'run-1',
    type: 'cron',
    state: 'queued',
    createdAt,
    updatedAt: createdAt,
    sessionId: 'session-1',
    attemptId: 'attempt-1',
    laneId: 'automation:task:daily-brief',
    source: 'cron',
    contractVersion: RUN_CONTRACT_VERSION,
    meta: {
      runtime: {
        priority: 'scheduled',
      },
    },
  })

  assert.equal(run.runId, 'run-1')
  assert.equal(run.sessionId, 'session-1')
  assert.equal(run.attemptId, 'attempt-1')
  assert.equal(run.laneId, 'automation:task:daily-brief')
  assert.equal(run.source, 'cron')
  assert.equal(run.contractVersion, RUN_CONTRACT_VERSION)
  assert.equal(run.meta.sessionId, 'session-1')
  assert.equal(run.meta.runtime.priority, 'scheduled')
})

test('normalizeRun derives a default attemptId for new canonical rows', () => {
  const run = normalizeRun({
    runId: 'run-attempt',
    type: 'exec',
    state: 'running',
    createdAt: 1_710_000_000_000,
    updatedAt: 1_710_000_000_000,
    sessionId: 'session-attempt',
    source: 'remote',
    contractVersion: RUN_CONTRACT_VERSION,
  })

  assert.equal(run.attemptId, 'run-attempt:attempt-1')
})
