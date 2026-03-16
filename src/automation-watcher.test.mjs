import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateWatcherEscalation } from './automation-watcher.mjs'

test('evaluateWatcherEscalation returns no escalation when escalateWithWorkflow is false', () => {
  const result = evaluateWatcherEscalation({
    watcherPolicy: { mode: 'change_only', minNotifyIntervalMinutes: 30, escalateWithWorkflow: false, escalationTemplate: null },
    watcherState: null,
    currentHash: 'hash-abc',
    runId: 'run-1',
  })

  assert.equal(result.shouldEscalate, false)
  assert.equal(result.reason, 'escalation_not_configured')
  assert.equal(result.watcherStatePatch, null)
})

test('evaluateWatcherEscalation returns no escalation when escalationTemplate is missing', () => {
  const result = evaluateWatcherEscalation({
    watcherPolicy: { mode: 'change_only', minNotifyIntervalMinutes: 30, escalateWithWorkflow: true, escalationTemplate: null },
    watcherState: null,
    currentHash: 'hash-abc',
    runId: 'run-1',
  })

  assert.equal(result.shouldEscalate, false)
  assert.equal(result.reason, 'escalation_template_missing')
})

test('evaluateWatcherEscalation does not re-escalate when currentHash matches lastInvestigatedHash', () => {
  const result = evaluateWatcherEscalation({
    watcherPolicy: { mode: 'change_only', minNotifyIntervalMinutes: 30, escalateWithWorkflow: true, escalationTemplate: 'research_synthesis' },
    watcherState: { lastInvestigatedHash: 'hash-abc', lastEscalationRunId: 'run-prev', lastEscalationAt: 1000 },
    currentHash: 'hash-abc',
    runId: 'run-2',
  })

  assert.equal(result.shouldEscalate, false)
  assert.equal(result.reason, 'already_investigated')
  assert.equal(result.escalationTemplate, 'research_synthesis')
  assert.equal(result.watcherStatePatch, null)
})

test('evaluateWatcherEscalation escalates on new hash when escalation is configured', () => {
  const now = Date.now()
  const result = evaluateWatcherEscalation({
    watcherPolicy: { mode: 'change_only', minNotifyIntervalMinutes: 30, escalateWithWorkflow: true, escalationTemplate: 'research_synthesis' },
    watcherState: { lastInvestigatedHash: 'hash-old', lastEscalationRunId: 'run-prev', lastEscalationAt: 1000 },
    currentHash: 'hash-new',
    runId: 'run-3',
    now,
  })

  assert.equal(result.shouldEscalate, true)
  assert.equal(result.escalationTemplate, 'research_synthesis')
  assert.equal(result.reason, 'change_detected')
  assert.deepEqual(result.watcherStatePatch, {
    lastEscalationRunId: 'run-3',
    lastEscalationAt: now,
    lastInvestigatedHash: 'hash-new',
  })
})

test('evaluateWatcherEscalation escalates on first change when no prior investigation exists', () => {
  const now = 1700000000000
  const result = evaluateWatcherEscalation({
    watcherPolicy: { mode: 'change_only', minNotifyIntervalMinutes: 60, escalateWithWorkflow: true, escalationTemplate: 'research_decision' },
    watcherState: null,
    currentHash: 'hash-first',
    runId: 'run-first',
    now,
  })

  assert.equal(result.shouldEscalate, true)
  assert.equal(result.escalationTemplate, 'research_decision')
  assert.deepEqual(result.watcherStatePatch, {
    lastEscalationRunId: 'run-first',
    lastEscalationAt: now,
    lastInvestigatedHash: 'hash-first',
  })
})

test('evaluateWatcherEscalation re-escalates after a different hash arrives post-investigation', () => {
  const now = Date.now()
  const result = evaluateWatcherEscalation({
    watcherPolicy: { mode: 'change_only', minNotifyIntervalMinutes: 30, escalateWithWorkflow: true, escalationTemplate: 'research_synthesis' },
    watcherState: { lastInvestigatedHash: 'hash-investigated', lastEscalationRunId: 'run-prev', lastEscalationAt: 5000 },
    currentHash: 'hash-brand-new',
    runId: 'run-re-esc',
    now,
  })

  assert.equal(result.shouldEscalate, true)
  assert.equal(result.reason, 'change_detected')
  assert.deepEqual(result.watcherStatePatch, {
    lastEscalationRunId: 'run-re-esc',
    lastEscalationAt: now,
    lastInvestigatedHash: 'hash-brand-new',
  })
})
