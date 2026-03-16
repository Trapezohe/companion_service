import test from 'node:test'
import assert from 'node:assert/strict'

import {
  initializeAutomationWorkflow,
  advanceAutomationWorkflow,
  buildAutomationWorkflowPrompt,
} from './automation-workflow.mjs'

test('initializeAutomationWorkflow seeds research_synthesis with plan -> research -> synthesize', () => {
  const workflow = initializeAutomationWorkflow({
    template: 'research_synthesis',
    state: null,
  })

  assert.equal(workflow.template, 'research_synthesis')
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
  })
  workflow = afterPlan.workflow

  assert.equal(afterPlan.continued, true)
  assert.equal(afterPlan.completed, false)
  assert.equal(afterPlan.nextStep?.id, 'research')
  assert.equal(workflow.state?.currentStepId, 'research')
  assert.equal(workflow.state?.steps[0]?.state, 'done')
  assert.equal(workflow.state?.steps[0]?.summary, 'Plan the research scope.')
  assert.equal(workflow.state?.steps[1]?.state, 'running')

  const afterResearch = advanceAutomationWorkflow(workflow, {
    runId: 'run-workflow',
    terminalState: 'done',
    stepSummary: 'Collected evidence from sources.',
  })
  workflow = afterResearch.workflow

  assert.equal(afterResearch.continued, true)
  assert.equal(afterResearch.nextStep?.id, 'synthesize')
  assert.equal(workflow.state?.currentStepId, 'synthesize')
  assert.equal(workflow.state?.steps[1]?.state, 'done')
  assert.equal(workflow.state?.steps[2]?.state, 'running')

  const afterSynthesize = advanceAutomationWorkflow(workflow, {
    runId: 'run-workflow',
    terminalState: 'done',
    stepSummary: 'Final synthesis ready.',
  })

  assert.equal(afterSynthesize.continued, false)
  assert.equal(afterSynthesize.completed, true)
  assert.equal(afterSynthesize.workflow.state?.currentStepId, null)
  assert.equal(afterSynthesize.workflow.state?.steps[2]?.state, 'done')
  assert.equal(afterSynthesize.workflow.state?.lastWorkflowSummary, 'Final synthesis ready.')
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
