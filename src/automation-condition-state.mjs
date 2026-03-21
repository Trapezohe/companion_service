// src/automation-condition-state.mjs

export function createConditionState() {
  return {
    lastTriggeredAt: null,
    previouslyMet: false,
    baselineValue: null,
    baselineSetAt: null,
    triggerCount: 0,
  }
}

export function shouldTrigger(state, evalResult, options = {}) {
  const { cooldownMs = 0, edgeTrigger = false } = options
  const now = Date.now()

  if (!evalResult.met) {
    state.previouslyMet = false
    return false
  }

  if (edgeTrigger && state.previouslyMet) {
    return false
  }

  if (state.lastTriggeredAt && cooldownMs > 0) {
    const elapsed = now - state.lastTriggeredAt
    if (elapsed < cooldownMs) {
      return false
    }
  }

  return true
}

export function recordTrigger(state, timestamp = Date.now()) {
  state.lastTriggeredAt = timestamp
  state.previouslyMet = true
  state.triggerCount += 1
}

export function updatePreviouslyMet(state, met) {
  state.previouslyMet = met
}

export function serializeConditionState(state) {
  return JSON.stringify(state)
}

export function deserializeConditionState(json) {
  if (!json) return createConditionState()
  try {
    const parsed = JSON.parse(json)
    return { ...createConditionState(), ...parsed }
  } catch {
    return createConditionState()
  }
}
