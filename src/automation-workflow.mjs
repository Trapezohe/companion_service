function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function compactText(raw, maxLength = 320) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!text) return null
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(32, maxLength - 16)).trimEnd()}...[truncated]`
}

function normalizeTemplate(raw) {
  return raw === 'research_synthesis' ? 'research_synthesis' : 'single_turn'
}

function findCurrentStepIndex(state) {
  if (!state || !Array.isArray(state.steps) || state.steps.length === 0) return -1
  const byCurrentId = typeof state.currentStepId === 'string'
    ? state.steps.findIndex((step) => step?.id === state.currentStepId)
    : -1
  if (byCurrentId >= 0) return byCurrentId
  return state.steps.findIndex((step) => step?.state === 'running' || step?.state === 'queued')
}

function buildResearchWorkflowState() {
  return {
    currentStepId: 'plan',
    steps: [
      { id: 'plan', kind: 'plan', state: 'running', runId: null, summary: null },
      { id: 'research', kind: 'research', state: 'queued', runId: null, summary: null },
      { id: 'synthesize', kind: 'synthesize', state: 'queued', runId: null, summary: null },
    ],
    lastWorkflowSummary: null,
  }
}

export function initializeAutomationWorkflow(workflow) {
  const template = normalizeTemplate(workflow?.template)
  if (template !== 'research_synthesis') {
    return {
      template: 'single_turn',
      state: null,
    }
  }

  if (workflow?.state && typeof workflow.state === 'object' && !Array.isArray(workflow.state)) {
    return {
      template,
      state: clone(workflow.state),
    }
  }

  return {
    template,
    state: buildResearchWorkflowState(),
  }
}

export function advanceAutomationWorkflow(workflow, {
  runId = null,
  terminalState = '',
  stepSummary = '',
} = {}) {
  const currentWorkflow = initializeAutomationWorkflow(workflow)
  if (currentWorkflow.template !== 'research_synthesis' || !currentWorkflow.state) {
    return {
      workflow: currentWorkflow,
      currentStep: null,
      nextStep: null,
      continued: false,
      completed: true,
      failed: Boolean(terminalState) && terminalState !== 'done',
    }
  }

  const state = clone(currentWorkflow.state)
  const currentIndex = findCurrentStepIndex(state)
  if (currentIndex < 0) {
    return {
      workflow: { template: currentWorkflow.template, state },
      currentStep: null,
      nextStep: null,
      continued: false,
      completed: true,
      failed: Boolean(terminalState) && terminalState !== 'done',
    }
  }

  const currentStep = state.steps[currentIndex]
  const normalizedSummary = compactText(stepSummary)
  currentStep.runId = typeof runId === 'string' && runId ? runId : currentStep.runId || null
  currentStep.summary = normalizedSummary
  state.lastWorkflowSummary = normalizedSummary

  if (terminalState && terminalState !== 'done') {
    currentStep.state = 'failed'
    state.currentStepId = null
    return {
      workflow: {
        template: currentWorkflow.template,
        state,
      },
      currentStep: clone(currentStep),
      nextStep: null,
      continued: false,
      completed: true,
      failed: true,
    }
  }

  currentStep.state = 'done'
  const nextStep = state.steps[currentIndex + 1] || null
  if (!nextStep) {
    state.currentStepId = null
    return {
      workflow: {
        template: currentWorkflow.template,
        state,
      },
      currentStep: clone(currentStep),
      nextStep: null,
      continued: false,
      completed: true,
      failed: false,
    }
  }

  nextStep.state = 'running'
  nextStep.runId = typeof runId === 'string' && runId ? runId : nextStep.runId || null
  state.currentStepId = nextStep.id
  return {
    workflow: {
      template: currentWorkflow.template,
      state,
    },
    currentStep: clone(currentStep),
    nextStep: clone(nextStep),
    continued: true,
    completed: false,
    failed: false,
  }
}

export function failAutomationWorkflowStep(workflow, {
  stepId = null,
  runId = null,
  summary = '',
} = {}) {
  const currentWorkflow = initializeAutomationWorkflow(workflow)
  if (currentWorkflow.template !== 'research_synthesis' || !currentWorkflow.state) {
    return currentWorkflow
  }

  const state = clone(currentWorkflow.state)
  const index = typeof stepId === 'string' && stepId
    ? state.steps.findIndex((step) => step.id === stepId)
    : findCurrentStepIndex(state)
  if (index < 0) {
    state.currentStepId = null
    return {
      template: currentWorkflow.template,
      state,
    }
  }

  const step = state.steps[index]
  step.state = 'failed'
  step.runId = typeof runId === 'string' && runId ? runId : step.runId || null
  step.summary = compactText(summary)
  state.currentStepId = null
  state.lastWorkflowSummary = step.summary
  return {
    template: currentWorkflow.template,
    state,
  }
}

function getWorkflowStepInstruction(stepKind) {
  if (stepKind === 'plan') {
    return 'Draft a short research plan with scope, evidence targets, and execution order. Do not produce the final user-facing output yet.'
  }
  if (stepKind === 'research') {
    return 'Execute the plan, gather evidence, note uncertainties, and prepare a concise handoff for synthesis. Do not produce the final user-facing output yet.'
  }
  return 'Use the session context from prior steps to produce the final user-facing synthesis now.'
}

export function buildAutomationWorkflowPrompt({
  workflow,
  basePrompt = '',
} = {}) {
  const currentWorkflow = initializeAutomationWorkflow(workflow)
  const prompt = typeof basePrompt === 'string' ? basePrompt.trim() : ''
  if (currentWorkflow.template !== 'research_synthesis' || !currentWorkflow.state) {
    return prompt
  }

  const currentIndex = findCurrentStepIndex(currentWorkflow.state)
  const currentStep = currentIndex >= 0 ? currentWorkflow.state.steps[currentIndex] : null
  if (!currentStep) return prompt

  return [
    `Workflow template: ${currentWorkflow.template}.`,
    `Current workflow step: ${currentStep.kind} (${currentIndex + 1}/${currentWorkflow.state.steps.length}).`,
    getWorkflowStepInstruction(currentStep.kind),
    '',
    prompt,
  ].filter(Boolean).join('\n').trim()
}
