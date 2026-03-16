import test from 'node:test'
import assert from 'node:assert/strict'

import {
  mergeRunIntoRollup,
  evaluateCompactionDecision,
  rollupDateStr,
} from './automation-rollup.mjs'

test('mergeRunIntoRollup creates a fresh rollup from null', () => {
  const rollup = mergeRunIntoRollup(null, {
    summary: 'BTC reached new ATH',
    timestamp: 1700000000000,
  })

  assert.equal(rollup.headline, 'BTC reached new ATH')
  assert.equal(rollup.runCount, 1)
  assert.equal(rollup.firstRunAt, 1700000000000)
  assert.equal(rollup.lastRunAt, 1700000000000)
  assert.deepEqual(rollup.keyFindings, [])
  assert.deepEqual(rollup.unresolved, [])
})

test('mergeRunIntoRollup accumulates workflow summaries as key findings', () => {
  let rollup = mergeRunIntoRollup(null, {
    summary: 'Run 1',
    workflowSummary: 'Finding A',
    timestamp: 1000,
  })
  rollup = mergeRunIntoRollup(rollup, {
    summary: 'Run 2',
    workflowSummary: 'Finding B',
    timestamp: 2000,
  })

  assert.equal(rollup.runCount, 2)
  assert.equal(rollup.headline, 'Run 2')
  assert.deepEqual(rollup.keyFindings, ['Finding A', 'Finding B'])
  assert.equal(rollup.firstRunAt, 1000)
  assert.equal(rollup.lastRunAt, 2000)
})

test('mergeRunIntoRollup deduplicates identical workflow summaries', () => {
  let rollup = mergeRunIntoRollup(null, {
    summary: 'Run 1',
    workflowSummary: 'Same finding',
    timestamp: 1000,
  })
  rollup = mergeRunIntoRollup(rollup, {
    summary: 'Run 2',
    workflowSummary: 'Same finding',
    timestamp: 2000,
  })

  assert.deepEqual(rollup.keyFindings, ['Same finding'])
})

test('mergeRunIntoRollup tracks delivery summary as nextAnchor', () => {
  const rollup = mergeRunIntoRollup(null, {
    summary: 'Run complete',
    deliverySummary: 'Delivered via telegram',
    timestamp: 1000,
  })

  assert.equal(rollup.nextAnchor, 'Delivered via telegram')
})

test('evaluateCompactionDecision triggers on critical health', () => {
  const result = evaluateCompactionDecision({
    budgetPolicy: { mode: 'default', maxContextBudget: 60000, compactAfterRuns: null },
    budgetLedger: { health: 'critical', approxInputTokens: 70000, approxOutputTokens: 5000 },
    runsSinceLastCompaction: 1,
  })

  assert.equal(result.shouldCompact, true)
  assert.equal(result.reason, 'budget_critical')
})

test('evaluateCompactionDecision triggers on run threshold', () => {
  const result = evaluateCompactionDecision({
    budgetPolicy: { mode: 'lean', maxContextBudget: 36000, compactAfterRuns: 4 },
    budgetLedger: { health: 'healthy', approxInputTokens: 1000, approxOutputTokens: 500 },
    runsSinceLastCompaction: 4,
  })

  assert.equal(result.shouldCompact, true)
  assert.equal(result.reason, 'run_threshold')
})

test('evaluateCompactionDecision does not trigger when healthy and under threshold', () => {
  const result = evaluateCompactionDecision({
    budgetPolicy: { mode: 'default', maxContextBudget: 60000, compactAfterRuns: 6 },
    budgetLedger: { health: 'healthy', approxInputTokens: 1000, approxOutputTokens: 500 },
    runsSinceLastCompaction: 3,
  })

  assert.equal(result.shouldCompact, false)
  assert.equal(result.reason, null)
})

test('evaluateCompactionDecision returns false when no budget policy', () => {
  const result = evaluateCompactionDecision({
    budgetPolicy: null,
    budgetLedger: { health: 'critical' },
    runsSinceLastCompaction: 100,
  })

  assert.equal(result.shouldCompact, false)
})

test('rollupDateStr returns YYYY-MM-DD for a given timestamp', () => {
  const dateStr = rollupDateStr(Date.parse('2026-03-16T10:30:00Z'))
  assert.equal(dateStr, '2026-03-16')
})
