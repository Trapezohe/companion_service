import { isMultiTurnTemplate, buildInitialSteps } from './automation-workflow-templates.mjs'
import { buildRecipeGuidance } from './automation-recipe-pack.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function compactText(raw, maxLength = 320) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!text) return null
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(32, maxLength - 16)).trimEnd()}...[truncated]`
}

function normalizeTemplate(raw) {
  if (typeof raw === 'string' && isMultiTurnTemplate(raw)) return raw
  return 'single_turn'
}

function findCurrentStepIndex(state) {
  if (!state || !Array.isArray(state.steps) || state.steps.length === 0) return -1
  const byCurrentId = typeof state.currentStepId === 'string'
    ? state.steps.findIndex((step) => step?.id === state.currentStepId)
    : -1
  if (byCurrentId >= 0) return byCurrentId
  return state.steps.findIndex((step) => step?.state === 'running' || step?.state === 'queued' || step?.state === 'needs_retry')
}

function normalizePolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const maxStepAttempts = Number.isFinite(raw.maxStepAttempts) && raw.maxStepAttempts > 0
    ? Math.floor(raw.maxStepAttempts)
    : null
  const retryBackoffMinutes = Number.isFinite(raw.retryBackoffMinutes) && raw.retryBackoffMinutes > 0
    ? Math.floor(raw.retryBackoffMinutes)
    : null
  if (maxStepAttempts === null && retryBackoffMinutes === null) return null
  return { maxStepAttempts, retryBackoffMinutes }
}

export function initializeAutomationWorkflow(workflow) {
  const template = normalizeTemplate(workflow?.template)
  const policy = normalizePolicy(workflow?.policy)

  if (!isMultiTurnTemplate(template)) {
    return { template: 'single_turn', policy: null, state: null }
  }

  if (workflow?.state && typeof workflow.state === 'object' && !Array.isArray(workflow.state)) {
    return { template, policy, state: clone(workflow.state) }
  }

  const steps = buildInitialSteps(template)
  return {
    template,
    policy,
    state: {
      currentStepId: steps[0]?.id || null,
      steps,
      lastWorkflowSummary: null,
      lastContinuationAt: null,
      terminalState: null,
    },
  }
}

function makeResult(template, policy, state, overrides) {
  return {
    workflow: { template, policy, state },
    currentStep: null,
    nextStep: null,
    continued: false,
    completed: true,
    failed: false,
    needsRetry: false,
    ...overrides,
  }
}

export function advanceAutomationWorkflow(workflow, {
  runId = null,
  terminalState = '',
  stepSummary = '',
  handoffSummary = '',
} = {}) {
  const currentWorkflow = initializeAutomationWorkflow(workflow)
  const { template, policy } = currentWorkflow
  if (!isMultiTurnTemplate(template) || !currentWorkflow.state) {
    return makeResult(template, policy, currentWorkflow.state, {
      failed: Boolean(terminalState) && terminalState !== 'done',
    })
  }

  const state = clone(currentWorkflow.state)
  const currentIndex = findCurrentStepIndex(state)
  if (currentIndex < 0) {
    state.terminalState = state.terminalState || 'done'
    return makeResult(template, policy, state, {
      failed: Boolean(terminalState) && terminalState !== 'done',
    })
  }

  const now = Date.now()
  const currentStep = state.steps[currentIndex]
  const normalizedSummary = compactText(stepSummary)
  const normalizedHandoff = compactText(handoffSummary)
  currentStep.runId = typeof runId === 'string' && runId ? runId : currentStep.runId || null
  currentStep.summary = normalizedSummary
  currentStep.finishedAt = now
  if (!currentStep.startedAt) currentStep.startedAt = now
  state.lastWorkflowSummary = normalizedSummary

  // Step failed
  if (terminalState && terminalState !== 'done') {
    const maxAttempts = policy?.maxStepAttempts || 0
    const retryBackoff = policy?.retryBackoffMinutes || 5
    const currentAttempt = currentStep.retry?.attempt || 0

    if (maxAttempts > 0 && currentAttempt + 1 < maxAttempts) {
      // Enter needs_retry — will be resumed on next cron trigger
      currentStep.state = 'needs_retry'
      currentStep.retry = {
        attempt: currentAttempt + 1,
        lastError: normalizedSummary || 'step failed',
        nextRetryAt: now + Math.min(retryBackoff * 60_000 * Math.pow(2, currentAttempt), 60 * 60_000),
      }
      return makeResult(template, policy, state, {
        currentStep: clone(currentStep),
        completed: false,
        failed: false,
        needsRetry: true,
      })
    }

    // No more retries — terminal failure
    currentStep.state = 'failed'
    if (currentStep.retry) {
      currentStep.retry.lastError = normalizedSummary || currentStep.retry.lastError
      currentStep.retry.nextRetryAt = null
    }
    state.currentStepId = null
    state.terminalState = 'failed'
    return makeResult(template, policy, state, {
      currentStep: clone(currentStep),
      failed: true,
    })
  }

  // Step succeeded
  currentStep.state = 'done'
  if (normalizedHandoff) {
    currentStep.handoffSummary = normalizedHandoff
  }

  const nextStep = state.steps[currentIndex + 1] || null
  if (!nextStep) {
    state.currentStepId = null
    state.terminalState = 'done'
    return makeResult(template, policy, state, {
      currentStep: clone(currentStep),
      failed: false,
    })
  }

  nextStep.state = 'running'
  nextStep.runId = typeof runId === 'string' && runId ? runId : nextStep.runId || null
  nextStep.startedAt = now
  state.currentStepId = nextStep.id
  state.lastContinuationAt = now
  return makeResult(template, policy, state, {
    currentStep: clone(currentStep),
    nextStep: clone(nextStep),
    continued: true,
    completed: false,
    failed: false,
  })
}

export function resumeAutomationWorkflowRetry(workflow, { runId = null } = {}) {
  const currentWorkflow = initializeAutomationWorkflow(workflow)
  if (!isMultiTurnTemplate(currentWorkflow.template) || !currentWorkflow.state) {
    return { workflow: currentWorkflow, resumed: false, step: null }
  }

  const state = clone(currentWorkflow.state)
  const now = Date.now()

  // Find step in needs_retry state whose nextRetryAt has passed
  const retryIndex = state.steps.findIndex(
    (step) => step.state === 'needs_retry'
      && step.retry?.nextRetryAt != null
      && now >= step.retry.nextRetryAt,
  )

  if (retryIndex < 0) {
    return { workflow: { ...currentWorkflow, state }, resumed: false, step: null }
  }

  const step = state.steps[retryIndex]
  step.state = 'running'
  step.startedAt = now
  step.finishedAt = null
  step.retry.nextRetryAt = null
  step.runId = typeof runId === 'string' && runId ? runId : step.runId
  state.currentStepId = step.id

  return {
    workflow: { template: currentWorkflow.template, policy: currentWorkflow.policy, state },
    resumed: true,
    step: clone(step),
  }
}

export function failAutomationWorkflowStep(workflow, {
  stepId = null,
  runId = null,
  summary = '',
} = {}) {
  const currentWorkflow = initializeAutomationWorkflow(workflow)
  if (!isMultiTurnTemplate(currentWorkflow.template) || !currentWorkflow.state) {
    return currentWorkflow
  }

  const state = clone(currentWorkflow.state)
  const index = typeof stepId === 'string' && stepId
    ? state.steps.findIndex((step) => step.id === stepId)
    : findCurrentStepIndex(state)
  if (index < 0) {
    state.currentStepId = null
    state.terminalState = 'failed'
    return { template: currentWorkflow.template, policy: currentWorkflow.policy, state }
  }

  const step = state.steps[index]
  step.state = 'failed'
  step.runId = typeof runId === 'string' && runId ? runId : step.runId || null
  step.summary = compactText(summary)
  step.finishedAt = Date.now()
  state.currentStepId = null
  state.lastWorkflowSummary = step.summary
  state.terminalState = 'failed'
  return { template: currentWorkflow.template, policy: currentWorkflow.policy, state }
}

const STEP_INSTRUCTIONS = {
  plan: 'Draft a short research plan with scope, evidence targets, and execution order. Do not produce the final user-facing output yet.',
  research: 'Execute the plan, gather evidence, note uncertainties, and prepare a concise handoff for synthesis. Do not produce the final user-facing output yet.',
  compare: 'You have gathered research from the previous step. Now compare the findings side by side. For each dimension of comparison, list what each source says. Highlight contradictions and areas of agreement. Output a structured comparison table.',
  decide: 'Based on the comparison above, produce an explicit recommendation. Include: (1) a tradeoff matrix of options, (2) the recommended choice with rationale, (3) risks and mitigations, (4) confidence level (high/medium/low) with justification.',
  synthesize: 'Use the session context from prior steps to produce the final user-facing synthesis now.',
  write: 'Use the session context from prior steps to produce the final user-facing output now.',
}

function getWorkflowStepInstruction(stepKind) {
  return STEP_INSTRUCTIONS[stepKind] || STEP_INSTRUCTIONS.synthesize
}

export function buildAutomationWorkflowPrompt({
  workflow,
  basePrompt = '',
} = {}) {
  const currentWorkflow = initializeAutomationWorkflow(workflow)
  const prompt = typeof basePrompt === 'string' ? basePrompt.trim() : ''
  if (!isMultiTurnTemplate(currentWorkflow.template) || !currentWorkflow.state) {
    return prompt
  }

  const currentIndex = findCurrentStepIndex(currentWorkflow.state)
  const currentStep = currentIndex >= 0 ? currentWorkflow.state.steps[currentIndex] : null
  if (!currentStep) return prompt

  // Include handoff from previous step if available
  const prevStep = currentIndex > 0 ? currentWorkflow.state.steps[currentIndex - 1] : null
  const handoff = prevStep?.handoffSummary
    ? `Previous step handoff: ${prevStep.handoffSummary}`
    : null

  // Include retry context if this is a retry attempt
  const retryContext = currentStep.retry?.lastError
    ? `This is retry attempt ${currentStep.retry.attempt}. Previous error: ${currentStep.retry.lastError}. Adjust your approach accordingly.`
    : null

  // Include recipe guidance for the current step kind
  const recipe = buildRecipeGuidance({ stepKind: currentStep.kind })
  const recipeSections = recipe
    ? `Use section headings in this order: ${recipe.sections.join(', ')}.`
    : null
  const recipeGuidanceLines = recipe
    ? recipe.guidance.map((line) => `- ${line}`)
    : []

  return [
    `Workflow template: ${currentWorkflow.template}.`,
    `Current workflow step: ${currentStep.kind} (${currentIndex + 1}/${currentWorkflow.state.steps.length}).`,
    getWorkflowStepInstruction(currentStep.kind),
    recipeSections,
    ...recipeGuidanceLines,
    handoff,
    retryContext,
    '',
    prompt,
  ].filter(Boolean).join('\n').trim()
}
