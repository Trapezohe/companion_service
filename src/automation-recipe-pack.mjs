/**
 * Automation recipe pack — per-step guidance for multi-turn workflows.
 *
 * Recipes provide step-specific section headings, evidence requirements,
 * handoff schema, and tool routing bias. The executor reads the active
 * recipe stage to inject context-appropriate guidance into workflow prompts.
 *
 * MIRROR: Keep in sync with extension-side utils/ai/automation-recipe-pack.ts
 */

const RECIPE_STEPS = {
  plan: {
    sections: ['Scope', 'Evidence Targets', 'Execution Order'],
    guidance: [
      'Define the research scope and key questions to answer.',
      'List concrete evidence targets (URLs, data sources, tool calls).',
      'Order execution steps by dependency, not by importance.',
    ],
    toolBias: { boosted: ['web_search', 'memory_search'], dampened: ['browser_navigate'] },
    handoffSchema: ['scope', 'targets', 'executionOrder'],
  },
  research: {
    sections: ['Sources', 'Evidence', 'Gaps'],
    guidance: [
      'Gather evidence from multiple independent sources.',
      'Cite concrete URLs or tool outputs for each factual claim.',
      'Flag gaps and contradictions explicitly.',
    ],
    toolBias: { boosted: ['web_search', 'fetch_url', 'browser_navigate'], dampened: [] },
    handoffSchema: ['sources', 'evidence', 'gaps'],
  },
  compare: {
    sections: ['Comparison Matrix', 'Agreements', 'Contradictions'],
    guidance: [
      'Compare findings side by side across dimensions.',
      'Highlight areas where sources agree and contradict.',
      'Output a structured comparison table.',
    ],
    toolBias: { boosted: ['memory_search', 'fetch_url'], dampened: ['browser_navigate'] },
    handoffSchema: ['comparisonMatrix', 'agreements', 'contradictions'],
  },
  decide: {
    sections: ['Tradeoff Matrix', 'Recommendation', 'Risks', 'Confidence'],
    guidance: [
      'Produce a tradeoff matrix of options with pros/cons.',
      'State a single explicit recommendation with rationale.',
      'List risks and mitigations for the recommended choice.',
      'Rate confidence as high/medium/low with justification.',
    ],
    toolBias: { boosted: ['memory_search'], dampened: ['browser_navigate', 'web_search'] },
    handoffSchema: ['tradeoffMatrix', 'recommendation', 'risks', 'confidence'],
  },
  synthesize: {
    sections: ['Decision', 'Evidence', 'Tradeoffs', 'Next Steps'],
    guidance: [
      'Synthesize across all prior findings into a coherent narrative.',
      'Make tradeoffs explicit and cite evidence for each claim.',
      'Produce the final user-facing output.',
    ],
    toolBias: { boosted: ['memory_search'], dampened: ['web_search', 'browser_navigate'] },
    handoffSchema: ['decision', 'evidence', 'tradeoffs', 'nextSteps'],
  },
  write: {
    sections: ['Objective', 'Draft', 'Open Risks'],
    guidance: [
      'Use the decision and evidence from prior steps to produce the final output.',
      'Optimize for structure, clarity, and traceable claims.',
      'Flag any remaining open risks or uncertainties.',
    ],
    toolBias: { boosted: ['memory_search'], dampened: ['web_search', 'browser_navigate'] },
    handoffSchema: ['objective', 'draft', 'openRisks'],
  },
}

/**
 * Get the recipe step definition for a given step kind.
 * @param {string} stepKind
 * @returns {object|null}
 */
export function getRecipeStep(stepKind) {
  return RECIPE_STEPS[stepKind] || null
}

/**
 * Get all registered recipe step kinds.
 * @returns {string[]}
 */
export function listRecipeSteps() {
  return Object.keys(RECIPE_STEPS)
}

/**
 * Build recipe-enhanced guidance for a workflow step.
 *
 * @param {object} params
 * @param {string} params.stepKind - The workflow step kind
 * @returns {{ sections: string[], guidance: string[], toolBias: object, handoffSchema: string[] }|null}
 */
export function buildRecipeGuidance({ stepKind } = {}) {
  const recipe = getRecipeStep(stepKind)
  if (!recipe) return null
  return {
    sections: [...recipe.sections],
    guidance: [...recipe.guidance],
    toolBias: { ...recipe.toolBias },
    handoffSchema: [...recipe.handoffSchema],
  }
}
