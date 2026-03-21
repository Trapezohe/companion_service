import test from 'node:test'
import assert from 'node:assert/strict'

import {
  initializeAutomationWorkflow,
  advanceAutomationWorkflow,
  resumeAutomationWorkflowRetry,
  cancelAutomationWorkflow,
  buildAutomationWorkflowPrompt,
} from './automation-workflow.mjs'

test('initializeAutomationWorkflow seeds research_synthesis with plan -> research -> synthesize', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })

  assert.equal(workflow.template, 'research_synthesis')
  assert.equal(workflow.policy, null)
  assert.equal(workflow.state?.currentStepId, 'plan')
  assert.deepEqual(
    workflow.state?.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      state: step.state,
    })),
    [
      { id: 'plan', kind: 'plan', state: 'running' },
      { id: 'research', kind: 'research', state: 'queued' },
      { id: 'synthesize', kind: 'synthesize', state: 'queued' },
    ],
  )
  assert.equal(workflow.state?.lastContinuationAt, null)
  assert.equal(workflow.state?.terminalState, null)
})

test('initializeAutomationWorkflow seeds research_decision with plan -> compare -> decide -> write', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_decision',
    policy: { maxStepAttempts: 3, retryBackoffMinutes: 5 },
    state: null,
  })

  assert.equal(workflow.template, 'research_decision')
  assert.deepEqual(workflow.policy, { maxStepAttempts: 3, retryBackoffMinutes: 5 })
  assert.equal(workflow.state?.currentStepId, 'plan')
  assert.deepEqual(
    workflow.state?.steps.map((step) => step.kind),
    ['plan', 'compare', 'decide', 'write'],
  )
})

test('advanceAutomationWorkflow marks each completed step and finishes after synthesize', () => {
  let workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })

  const afterPlan = advanceAutomationWorkflow(workflow, {
    runId: 'run-workflow',
    terminalState: 'done',
    stepSummary: 'Plan the research scope.',
    handoffSummary: 'Research targets: A, B, C',
  })
  workflow = afterPlan.workflow

  assert.equal(afterPlan.continued, true)
  assert.equal(afterPlan.completed, false)
  assert.equal(afterPlan.nextStep?.id, 'research')
  assert.equal(workflow.state?.currentStepId, 'research')
  assert.equal(workflow.state?.steps[0]?.state, 'done')
  assert.equal(workflow.state?.steps[0]?.summary, 'Plan the research scope.')
  assert.equal(workflow.state?.steps[0]?.handoffSummary, 'Research targets: A, B, C')
  assert.equal(workflow.state?.steps[1]?.state, 'running')
  assert.equal(typeof workflow.state?.lastContinuationAt, 'number')

  const afterResearch = advanceAutomationWorkflow(workflow, {
    runId: 'run-workflow',
    terminalState: 'done',
    stepSummary: 'Collected evidence from sources.',
  })
  workflow = afterResearch.workflow

  assert.equal(afterResearch.continued, true)
  assert.equal(afterResearch.nextStep?.id, 'synthesize')
  assert.equal(workflow.state?.currentStepId, 'synthesize')

  const afterSynthesize = advanceAutomationWorkflow(workflow, {
    runId: 'run-workflow',
    terminalState: 'done',
    stepSummary: 'Final synthesis ready.',
  })

  assert.equal(afterSynthesize.continued, false)
  assert.equal(afterSynthesize.completed, true)
  assert.equal(afterSynthesize.workflow.state?.currentStepId, null)
  assert.equal(afterSynthesize.workflow.state?.terminalState, 'done')
  assert.equal(afterSynthesize.workflow.state?.lastWorkflowSummary, 'Final synthesis ready.')
})

test('advanceAutomationWorkflow always returns a boolean failed flag', () => {
  const nonWorkflow = advanceAutomationWorkflow(null, {
    terminalState: '',
    stepSummary: '',
  })
  const failedWorkflow = advanceAutomationWorkflow(initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  }), {
    runId: 'run-workflow',
    terminalState: 'failed',
    stepSummary: 'Research step failed.',
  })

  assert.equal(nonWorkflow.failed, false)
  assert.equal(typeof nonWorkflow.failed, 'boolean')
  assert.equal(failedWorkflow.failed, true)
  assert.equal(typeof failedWorkflow.failed, 'boolean')
  assert.equal(failedWorkflow.workflow.state?.terminalState, 'failed')
})

test('advanceAutomationWorkflow enters needs_retry when under maxStepAttempts', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    policy: { maxStepAttempts: 3, retryBackoffMinutes: 5 },
    state: null,
  })

  const result = advanceAutomationWorkflow(workflow, {
    runId: 'run-1',
    terminalState: 'failed',
    stepSummary: 'timeout error',
  })

  assert.equal(result.needsRetry, true)
  assert.equal(result.completed, false)
  assert.equal(result.failed, false)
  assert.equal(result.currentStep?.state, 'needs_retry')
  assert.equal(result.currentStep?.retry?.attempt, 1)
  assert.equal(result.currentStep?.retry?.lastError, 'timeout error')
  assert.equal(typeof result.currentStep?.retry?.nextRetryAt, 'number')
})

test('advanceAutomationWorkflow terminally fails when maxStepAttempts exhausted', () => {
  let workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    policy: { maxStepAttempts: 2, retryBackoffMinutes: 1 },
    state: null,
  })

  // First failure -> needs_retry (attempt 1 of 2)
  const first = advanceAutomationWorkflow(workflow, {
    runId: 'run-1',
    terminalState: 'failed',
    stepSummary: 'first failure',
  })
  assert.equal(first.needsRetry, true)

  // Manually simulate retry resume by setting step back to running
  const state = first.workflow.state
  state.steps[0].state = 'running'
  state.steps[0].retry.nextRetryAt = null

  // Second failure -> terminal (attempt 2 >= maxStepAttempts=2)
  const second = advanceAutomationWorkflow(
    { ...first.workflow, state },
    { runId: 'run-2', terminalState: 'failed', stepSummary: 'second failure' },
  )
  assert.equal(second.needsRetry, false)
  assert.equal(second.failed, true)
  assert.equal(second.completed, true)
  assert.equal(second.workflow.state?.terminalState, 'failed')
})

test('advanceAutomationWorkflow step attempt accumulates across retries', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    policy: { maxStepAttempts: 5, retryBackoffMinutes: 1 },
    state: null,
  })

  // Set step to already have 2 prior attempts
  workflow.state.steps[0].retry = { attempt: 2, lastError: 'prior error', nextRetryAt: null }

  const result = advanceAutomationWorkflow(workflow, {
    runId: 'run-1',
    terminalState: 'failed',
    stepSummary: 'third failure',
  })

  assert.equal(result.needsRetry, true)
  assert.equal(result.currentStep?.retry?.attempt, 3)
})

test('resumeAutomationWorkflowRetry flips needs_retry step back to running when nextRetryAt has passed', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    policy: { maxStepAttempts: 3, retryBackoffMinutes: 1 },
    state: null,
  })

  // Set plan step to needs_retry with a past nextRetryAt
  workflow.state.steps[0].state = 'needs_retry'
  workflow.state.steps[0].retry = {
    attempt: 1,
    lastError: 'timeout',
    nextRetryAt: Date.now() - 1000, // already passed
  }

  const result = resumeAutomationWorkflowRetry(workflow, { runId: 'run-retry' })
  assert.equal(result.resumed, true)
  assert.equal(result.step?.state, 'running')
  assert.equal(result.step?.retry?.nextRetryAt, null)
  assert.equal(result.step?.runId, 'run-retry')
  assert.equal(result.workflow.state?.currentStepId, 'plan')
})

test('resumeAutomationWorkflowRetry does not resume if nextRetryAt is in the future', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    policy: { maxStepAttempts: 3, retryBackoffMinutes: 60 },
    state: null,
  })

  workflow.state.steps[0].state = 'needs_retry'
  workflow.state.steps[0].retry = {
    attempt: 1,
    lastError: 'timeout',
    nextRetryAt: Date.now() + 999_999_999, // far future
  }

  const result = resumeAutomationWorkflowRetry(workflow)
  assert.equal(result.resumed, false)
  assert.equal(result.step, null)
})

test('advanceAutomationWorkflow tracks research_decision through all 4 steps', () => {
  let workflow = initializeAutomationWorkflow({
    template: 'research_decision',
    state: null,
  })

  const stepKinds = ['plan', 'compare', 'decide', 'write']
  for (let i = 0; i < stepKinds.length; i++) {
    const result = advanceAutomationWorkflow(workflow, {
      runId: `run-${i}`,
      terminalState: 'done',
      stepSummary: `${stepKinds[i]} done`,
    })
    workflow = result.workflow

    if (i < stepKinds.length - 1) {
      assert.equal(result.continued, true)
      assert.equal(result.completed, false)
      assert.equal(result.nextStep?.kind, stepKinds[i + 1])
    } else {
      assert.equal(result.continued, false)
      assert.equal(result.completed, true)
      assert.equal(result.workflow.state?.terminalState, 'done')
    }
  }
})

test('buildAutomationWorkflowPrompt wraps the base prompt with step-specific instructions', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })

  const prompt = buildAutomationWorkflowPrompt({
    workflow,
    basePrompt: 'Summarize the weekly market moves.',
  })

  assert.match(prompt, /Workflow template: research_synthesis\./)
  assert.match(prompt, /Current workflow step: plan \(1\/3\)\./)
  assert.match(prompt, /Do not produce the final user-facing output yet\./)
  assert.match(prompt, /Summarize the weekly market moves\./)
})

test('buildAutomationWorkflowPrompt includes compare step instruction for research_decision', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_decision',
    state: null,
  })
  // Advance past plan
  workflow.state.steps[0].state = 'done'
  workflow.state.steps[1].state = 'running'
  workflow.state.currentStepId = 'compare'

  const prompt = buildAutomationWorkflowPrompt({
    workflow,
    basePrompt: 'Compare investment options.',
  })

  assert.match(prompt, /compare the findings side by side/)
  assert.match(prompt, /Highlight contradictions/)
})

test('buildAutomationWorkflowPrompt includes decide step instruction for research_decision', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_decision',
    state: null,
  })
  workflow.state.steps[0].state = 'done'
  workflow.state.steps[1].state = 'done'
  workflow.state.steps[2].state = 'running'
  workflow.state.currentStepId = 'decide'

  const prompt = buildAutomationWorkflowPrompt({
    workflow,
    basePrompt: 'Decide on allocation.',
  })

  assert.match(prompt, /explicit recommendation/)
  assert.match(prompt, /tradeoff matrix/)
  assert.match(prompt, /confidence level/)
})

test('buildAutomationWorkflowPrompt includes handoff from previous step', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })
  workflow.state.steps[0].state = 'done'
  workflow.state.steps[0].handoffSummary = 'Key findings: A, B, C'
  workflow.state.steps[1].state = 'running'
  workflow.state.currentStepId = 'research'

  const prompt = buildAutomationWorkflowPrompt({
    workflow,
    basePrompt: 'Continue research.',
  })

  assert.match(prompt, /Previous step handoff: Key findings: A, B, C/)
})

test('buildAutomationWorkflowPrompt includes recipe section headings and guidance for plan step', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })

  const prompt = buildAutomationWorkflowPrompt({
    workflow,
    basePrompt: 'Research AI agents.',
  })

  // Recipe sections for plan step
  assert.match(prompt, /Scope, Evidence Targets, Execution Order/)
  // Recipe guidance lines
  assert.match(prompt, /Define the research scope/)
  assert.match(prompt, /Order execution steps by dependency/)
})

test('buildAutomationWorkflowPrompt includes recipe guidance for compare step', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_decision',
    state: null,
  })
  workflow.state.steps[0].state = 'done'
  workflow.state.steps[1].state = 'running'
  workflow.state.currentStepId = 'compare'

  const prompt = buildAutomationWorkflowPrompt({
    workflow,
    basePrompt: 'Compare options.',
  })

  // Recipe sections for compare step
  assert.match(prompt, /Comparison Matrix, Agreements, Contradictions/)
  assert.match(prompt, /Compare findings side by side/)
})

test('buildAutomationWorkflowPrompt includes retry context when step has retry info', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })
  workflow.state.steps[0].retry = { attempt: 2, lastError: 'network timeout', nextRetryAt: null }

  const prompt = buildAutomationWorkflowPrompt({
    workflow,
    basePrompt: 'Retry the plan.',
  })

  assert.match(prompt, /retry attempt 2/)
  assert.match(prompt, /network timeout/)
})

// --- Step lineage tests ---

test('advanceAutomationWorkflow records source and attemptId on next step', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })

  const result = advanceAutomationWorkflow(workflow, {
    runId: 'run-lineage',
    terminalState: 'done',
    stepSummary: 'Plan done.',
  })

  assert.equal(result.nextStep?.source, 'advance:run-lineage')
  assert.equal(result.nextStep?.attemptId, 'research:run-lineage:1')
})

test('resumeAutomationWorkflowRetry records retry source and attemptId', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    policy: { maxStepAttempts: 3, retryBackoffMinutes: 1 },
    state: null,
  })

  workflow.state.steps[0].state = 'needs_retry'
  workflow.state.steps[0].retry = {
    attempt: 2,
    lastError: 'timeout',
    nextRetryAt: Date.now() - 1000,
  }

  const result = resumeAutomationWorkflowRetry(workflow, { runId: 'run-retry-2' })
  assert.equal(result.resumed, true)
  assert.equal(result.step?.source, 'retry:run-retry-2')
  assert.equal(result.step?.attemptId, 'plan:run-retry-2:3')
})

test('initializeAutomationWorkflow seeds steps with source and attemptId as null', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })

  for (const step of workflow.state.steps) {
    assert.equal(step.source, null)
    assert.equal(step.attemptId, null)
  }
})

// --- Cancel cascade tests ---

test('cancelAutomationWorkflow cascades to all active steps', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })

  // Simulate: plan done, research running, synthesize queued
  workflow.state.steps[0].state = 'done'
  workflow.state.steps[1].state = 'running'
  workflow.state.currentStepId = 'research'

  const cancelled = cancelAutomationWorkflow(workflow, { reason: 'user_cancelled' })
  assert.equal(cancelled.state.terminalState, 'cancelled')
  assert.equal(cancelled.state.currentStepId, null)
  assert.equal(cancelled.state.steps[0].state, 'done') // already done — untouched
  assert.equal(cancelled.state.steps[1].state, 'failed') // was running
  assert.equal(cancelled.state.steps[1].summary, 'user_cancelled')
  assert.equal(cancelled.state.steps[2].state, 'failed') // was queued
})

test('cancelAutomationWorkflow clears retry.nextRetryAt on needs_retry steps', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    policy: { maxStepAttempts: 3, retryBackoffMinutes: 5 },
    state: null,
  })

  workflow.state.steps[0].state = 'needs_retry'
  workflow.state.steps[0].retry = {
    attempt: 1,
    lastError: 'timeout',
    nextRetryAt: Date.now() + 999_999,
  }

  const cancelled = cancelAutomationWorkflow(workflow, { reason: 'abort' })
  assert.equal(cancelled.state.steps[0].state, 'failed')
  assert.equal(cancelled.state.steps[0].retry.nextRetryAt, null)
  assert.equal(cancelled.state.terminalState, 'cancelled')
})

test('cancelAutomationWorkflow returns workflow unchanged for single_turn', () => {
  const result = cancelAutomationWorkflow({ template: 'single_turn', state: null })
  assert.equal(result.template, 'single_turn')
  assert.equal(result.state, null)
})

// --- Condition routing tests ---

test('advanceAutomationWorkflow skips step when condition not met and onFalse is skip', () => {
  const workflow = {
    template: 'conditional_monitor',
    policy: { maxStepAttempts: 1 },
    state: {
      currentStepId: 'condition_check',
      steps: [
        { id: 'condition_check', kind: 'condition_check', state: 'running', condition: null, runId: 'r1', source: null, attemptId: null, summary: null, startedAt: Date.now(), finishedAt: null, handoffSummary: null, handoffData: null, retry: null },
        { id: 'analyze', kind: 'analyze', state: 'queued', condition: { evaluated: false }, runId: null, source: null, attemptId: null, summary: null, startedAt: null, finishedAt: null, handoffSummary: null, handoffData: null, retry: null },
        { id: 'notify', kind: 'notify', state: 'queued', condition: null, runId: null, source: null, attemptId: null, summary: null, startedAt: null, finishedAt: null, handoffSummary: null, handoffData: null, retry: null },
      ],
      lastWorkflowSummary: null,
      lastContinuationAt: null,
      terminalState: null,
    },
  }

  const result = advanceAutomationWorkflow(workflow, {
    terminalState: 'done',
    stepSummary: 'Condition check complete',
    handoffSummary: 'Price did not meet threshold',
    conditionResult: { met: false, onFalse: 'skip' },
  })

  assert.equal(result.workflow.state.steps[1].state, 'skipped')
})

// --- handoffData tests ---

test('advanceAutomationWorkflow passes handoffData to completed step', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })

  const handoffData = { price: 2450.30, tokenId: 'ethereum' }
  const result = advanceAutomationWorkflow(workflow, {
    runId: 'run-hd',
    terminalState: 'done',
    stepSummary: 'Plan complete.',
    handoffSummary: 'ETH price checked',
    handoffData,
  })

  // handoffData should be stored on the completed step (step 0)
  assert.deepEqual(result.currentStep?.handoffData, { price: 2450.30, tokenId: 'ethereum' })
  assert.equal(result.workflow.state?.steps[0]?.handoffData?.tokenId, 'ethereum')
  assert.equal(result.workflow.state?.steps[0]?.handoffData?.price, 2450.30)
  // handoffSummary still works alongside
  assert.equal(result.currentStep?.handoffSummary, 'ETH price checked')
})

test('advanceAutomationWorkflow defaults handoffData to null when not provided', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })

  const result = advanceAutomationWorkflow(workflow, {
    runId: 'run-no-hd',
    terminalState: 'done',
    stepSummary: 'Plan complete.',
  })

  assert.equal(result.currentStep?.handoffData, null)
})

test('buildAutomationWorkflowPrompt includes structured handoffData from previous step', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })
  workflow.state.steps[0].state = 'done'
  workflow.state.steps[0].handoffSummary = 'ETH price dropped'
  workflow.state.steps[0].handoffData = { price: 2450.30, changePercent: -6.5, tokenId: 'ethereum' }
  workflow.state.steps[1].state = 'running'
  workflow.state.currentStepId = 'research'

  const prompt = buildAutomationWorkflowPrompt({
    workflow,
    basePrompt: 'Continue.',
  })

  assert.match(prompt, /Previous Step Data \(structured\)/)
  assert.match(prompt, /"price": 2450\.3/)
  assert.match(prompt, /"tokenId": "ethereum"/)
  assert.match(prompt, /"changePercent": -6\.5/)
})

test('buildAutomationWorkflowPrompt omits structured section when handoffData is null', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })
  workflow.state.steps[0].state = 'done'
  workflow.state.steps[0].handoffSummary = 'Plan done'
  workflow.state.steps[1].state = 'running'
  workflow.state.currentStepId = 'research'

  const prompt = buildAutomationWorkflowPrompt({
    workflow,
    basePrompt: 'Continue.',
  })

  assert.ok(!prompt.includes('Previous Step Data (structured)'))
})

test('initializeAutomationWorkflow seeds steps with handoffData as null', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })

  for (const step of workflow.state.steps) {
    assert.equal(step.handoffData, null)
  }
})
