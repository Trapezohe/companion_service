import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAutomationLifecycleSummary } from './automation-lifecycle.mjs'

test('buildAutomationLifecycleSummary returns null without usable automation text', () => {
  const summary = buildAutomationLifecycleSummary({
    run: {
      runId: 'run-empty',
      summary: '',
      meta: { taskName: 'Empty automation' },
    },
    events: [],
    terminalState: 'done',
  })

  assert.equal(summary, null)
})

test('buildAutomationLifecycleSummary formats terminal state, delivery mode, and last outcome', () => {
  const summary = buildAutomationLifecycleSummary({
    run: {
      runId: 'run-1',
      summary: 'fallback',
      meta: {
        taskName: 'Research loop',
        sessionTarget: 'persistent:research-loop',
        deliveryMode: 'chat',
      },
    },
    events: [
      { type: 'text_delta', text: 'BTC broke out above resistance.' },
    ],
    terminalState: 'done',
  })

  assert.match(summary, /Research loop/)
  assert.match(summary, /Terminal state: done/)
  assert.match(summary, /Delivery: chat/)
  assert.match(summary, /Outcome: BTC broke out above resistance\./)
})
