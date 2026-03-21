// src/automation-condition-state.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createConditionState,
  shouldTrigger,
  recordTrigger,
} from './automation-condition-state.mjs'

test('shouldTrigger returns true on first trigger when condition met', () => {
  const state = createConditionState()
  const evalResult = { met: true, value: -6.5 }
  assert.equal(shouldTrigger(state, evalResult, { cooldownMs: 60000 }), true)
})

test('shouldTrigger returns false when condition not met', () => {
  const state = createConditionState()
  const evalResult = { met: false, value: -2.0 }
  assert.equal(shouldTrigger(state, evalResult, { cooldownMs: 60000 }), false)
})

test('shouldTrigger returns false during cooldown', () => {
  const state = createConditionState()
  recordTrigger(state, Date.now())
  const evalResult = { met: true, value: -6.5 }
  assert.equal(shouldTrigger(state, evalResult, { cooldownMs: 60000 }), false)
})

test('shouldTrigger returns true after cooldown expires', () => {
  const state = createConditionState()
  recordTrigger(state, Date.now() - 70000) // 70s ago
  const evalResult = { met: true, value: -6.5 }
  assert.equal(shouldTrigger(state, evalResult, { cooldownMs: 60000 }), true)
})

test('edge-trigger: does not re-trigger if condition stayed met without transition', () => {
  const state = createConditionState()
  state.previouslyMet = true
  recordTrigger(state, Date.now() - 70000) // cooldown expired
  const evalResult = { met: true, value: -6.5 }
  assert.equal(shouldTrigger(state, evalResult, { cooldownMs: 60000, edgeTrigger: true }), false)
})

test('edge-trigger: triggers on false→true transition', () => {
  const state = createConditionState()
  state.previouslyMet = false
  const evalResult = { met: true, value: -6.5 }
  assert.equal(shouldTrigger(state, evalResult, { cooldownMs: 60000, edgeTrigger: true }), true)
})

test('shouldTrigger sets previouslyMet to false when condition not met', () => {
  const state = createConditionState()
  state.previouslyMet = true
  const evalResult = { met: false, value: -2.0 }
  shouldTrigger(state, evalResult, { cooldownMs: 60000 })
  assert.equal(state.previouslyMet, false)
})

test('recordTrigger updates lastTriggeredAt and previouslyMet', () => {
  const state = createConditionState()
  const now = Date.now()
  recordTrigger(state, now)
  assert.equal(state.lastTriggeredAt, now)
  assert.equal(state.previouslyMet, true)
})
