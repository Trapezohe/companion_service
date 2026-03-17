/**
 * Automation workflow template registry.
 *
 * Each template defines the ordered steps for a multi-turn workflow.
 * Templates are pure data — runtime behavior lives in automation-workflow.mjs.
 */

const WORKFLOW_TEMPLATES = {
  research_synthesis: {
    id: 'research_synthesis',
    steps: [
      { id: 'plan', kind: 'plan' },
      { id: 'research', kind: 'research' },
      { id: 'synthesize', kind: 'synthesize' },
    ],
  },
  research_decision: {
    id: 'research_decision',
    steps: [
      { id: 'plan', kind: 'plan' },
      { id: 'compare', kind: 'compare' },
      { id: 'decide', kind: 'decide' },
      { id: 'write', kind: 'write' },
    ],
  },
}

Object.values(WORKFLOW_TEMPLATES).forEach((t) => Object.freeze(t.steps.forEach((s) => Object.freeze(s))) || Object.freeze(t))
Object.freeze(WORKFLOW_TEMPLATES)

const MULTI_TURN_TEMPLATES = new Set(Object.keys(WORKFLOW_TEMPLATES))

export function getWorkflowTemplate(templateName) {
  return WORKFLOW_TEMPLATES[templateName] || null
}

export function isMultiTurnTemplate(templateName) {
  return MULTI_TURN_TEMPLATES.has(templateName)
}

export function listWorkflowTemplates() {
  return Object.keys(WORKFLOW_TEMPLATES)
}

export function buildInitialSteps(templateName) {
  const template = getWorkflowTemplate(templateName)
  if (!template) return null
  return template.steps.map((step, index) => ({
    id: step.id,
    kind: step.kind,
    state: index === 0 ? 'running' : 'queued',
    runId: null,
    source: null,
    attemptId: null,
    summary: null,
    startedAt: null,
    finishedAt: null,
    handoffSummary: null,
    retry: null,
  }))
}
