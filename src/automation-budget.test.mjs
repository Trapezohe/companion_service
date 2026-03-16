import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveAutomationBudgetLedgerUpdate } from './automation-budget.mjs'

function createBudgetConfig(overrides = {}) {
  return {
    policy: {
      mode: 'default',
      maxContextBudget: 120,
      dayRollupEnabled: true,
      compactAfterRuns: null,
      ...(overrides.policy || {}),
    },
    ledger: {
      approxInputTokens: 10,
      approxOutputTokens: 12,
      compactionCount: 1,
      lastRollupAt: null,
      health: 'healthy',
      ...(overrides.ledger || {}),
    },
  }
}

test('deriveAutomationBudgetLedgerUpdate accumulates usage and preserves rollup stamps', () => {
  const now = 1_700_000_000_000
  const ledger = deriveAutomationBudgetLedgerUpdate({
    sessionBudget: createBudgetConfig({
      policy: {
        mode: 'default',
        maxContextBudget: 180,
      },
    }),
    promptText: 'Research the overnight move and compare it against yesterday support levels. '.repeat(4),
    outputText: 'Summary: support held, rotation stayed contained, and no intervention is needed. '.repeat(3),
    compactionCountDelta: 2,
    rollupAt: now,
  })

  assert.equal(ledger.compactionCount, 3)
  assert.equal(ledger.lastRollupAt, now)
  assert.equal(ledger.health, 'warning')
  assert.equal(ledger.approxInputTokens > 10, true)
  assert.equal(ledger.approxOutputTokens > 12, true)
})

test('deriveAutomationBudgetLedgerUpdate marks the ledger critical once cumulative usage crosses the cap', () => {
  const ledger = deriveAutomationBudgetLedgerUpdate({
    sessionBudget: createBudgetConfig({
      policy: {
        mode: 'lean',
        maxContextBudget: 24,
        dayRollupEnabled: false,
      },
      ledger: {
        approxInputTokens: 8,
        approxOutputTokens: 6,
        compactionCount: 0,
        lastRollupAt: null,
        health: 'healthy',
      },
    }),
    promptText: 'Check the last three runs and summarize the main deltas.',
    outputText: 'The latest run added a new failure mode and requires follow-up.',
  })

  assert.equal(ledger.health, 'critical')
  assert.equal(ledger.lastRollupAt, null)
})
