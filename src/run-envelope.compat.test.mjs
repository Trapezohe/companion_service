import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeRun } from './run-envelope.mjs'

test('legacy rows still load through normalizeRun', () => {
  const run = normalizeRun({
    runId: 'run-legacy',
    type: 'session',
    state: 'running',
    createdAt: 1_710_000_000_000,
    updatedAt: 1_710_000_000_100,
    meta: {
      sessionId: 'session-legacy',
      command: 'node server.js',
    },
  })

  assert.equal(run.runId, 'run-legacy')
  assert.equal(run.sessionId, 'session-legacy')
  assert.equal(run.contractVersion, 1)
  assert.equal(run.attemptId, undefined)
  assert.equal(run.meta.sessionId, 'session-legacy')
  assert.equal(run.meta.command, 'node server.js')
})

test('legacy rows ignore invalid v2-only source fields', () => {
  const run = normalizeRun({
    runId: 'run-legacy-invalid-source',
    type: 'exec',
    state: 'done',
    createdAt: 1_710_000_000_000,
    updatedAt: 1_710_000_000_100,
    source: 'invalid-source',
  })

  assert.equal(run.contractVersion, 1)
  assert.equal(run.source, undefined)
})
