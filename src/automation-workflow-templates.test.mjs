import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getWorkflowTemplate,
  isMultiTurnTemplate,
  listWorkflowTemplates,
  buildInitialSteps,
} from './automation-workflow-templates.mjs'

test('research_synthesis resolves to plan -> research -> synthesize', () => {
  const template = getWorkflowTemplate('research_synthesis')
  assert.equal(template.id, 'research_synthesis')
  assert.deepEqual(
    template.steps.map((s) => s.kind),
    ['plan', 'research', 'synthesize'],
  )
})

test('research_decision resolves to plan -> compare -> decide -> write', () => {
  const template = getWorkflowTemplate('research_decision')
  assert.equal(template.id, 'research_decision')
  assert.deepEqual(
    template.steps.map((s) => s.kind),
    ['plan', 'compare', 'decide', 'write'],
  )
})

test('single_turn returns null from getWorkflowTemplate', () => {
  assert.equal(getWorkflowTemplate('single_turn'), null)
  assert.equal(getWorkflowTemplate('unknown'), null)
})

test('isMultiTurnTemplate correctly classifies templates', () => {
  assert.equal(isMultiTurnTemplate('research_synthesis'), true)
  assert.equal(isMultiTurnTemplate('research_decision'), true)
  assert.equal(isMultiTurnTemplate('single_turn'), false)
  assert.equal(isMultiTurnTemplate('unknown'), false)
})

test('listWorkflowTemplates returns all registered templates', () => {
  const templates = listWorkflowTemplates()
  assert.equal(templates.includes('research_synthesis'), true)
  assert.equal(templates.includes('research_decision'), true)
  assert.equal(templates.includes('conditional_monitor'), true)
  assert.equal(templates.length, 3)
})

test('buildInitialSteps creates step array with first step running', () => {
  const steps = buildInitialSteps('research_decision')
  assert.equal(steps.length, 4)
  assert.equal(steps[0].state, 'running')
  assert.equal(steps[0].kind, 'plan')
  assert.equal(steps[1].state, 'queued')
  assert.equal(steps[1].kind, 'compare')
  assert.equal(steps[2].state, 'queued')
  assert.equal(steps[2].kind, 'decide')
  assert.equal(steps[3].state, 'queued')
  assert.equal(steps[3].kind, 'write')
  // v2.3 step fields
  assert.equal(steps[0].startedAt, null)
  assert.equal(steps[0].finishedAt, null)
  assert.equal(steps[0].handoffSummary, null)
  assert.equal(steps[0].retry, null)
})

test('buildInitialSteps returns null for unknown templates', () => {
  assert.equal(buildInitialSteps('single_turn'), null)
  assert.equal(buildInitialSteps('unknown'), null)
})
