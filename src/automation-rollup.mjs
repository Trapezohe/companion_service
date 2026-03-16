/**
 * Day rollup logic for persistent automation sessions.
 *
 * Merges multiple run summaries into a single day-level rollup artifact.
 * Also decides when a compaction should be triggered based on budget health
 * or run threshold.
 */

function compactText(raw, maxLength = 500) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!text) return null
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(32, maxLength - 16)).trimEnd()}...[truncated]`
}

/**
 * Merge a run summary into an existing day rollup.
 *
 * @param {object|null} existingRollup - The current day rollup (may be null)
 * @param {object} runInput - The run data to merge
 * @param {string} runInput.summary - The run's lifecycle summary
 * @param {string|null} [runInput.workflowSummary] - Workflow-level summary if any
 * @param {string|null} [runInput.deliverySummary] - Delivery outcome summary
 * @param {number} [runInput.timestamp] - When this run completed
 * @returns {object} The updated rollup
 */
export function mergeRunIntoRollup(existingRollup, {
  summary = '',
  workflowSummary = null,
  deliverySummary = null,
  timestamp = Date.now(),
} = {}) {
  const rollup = existingRollup && typeof existingRollup === 'object'
    ? { ...existingRollup }
    : {
      headline: null,
      keyFindings: [],
      unresolved: [],
      nextAnchor: null,
      runCount: 0,
      firstRunAt: null,
      lastRunAt: null,
    }

  rollup.runCount = (typeof rollup.runCount === 'number' ? rollup.runCount : 0) + 1
  if (!rollup.firstRunAt) rollup.firstRunAt = timestamp
  rollup.lastRunAt = timestamp

  const compactedSummary = compactText(summary)
  const compactedWorkflow = compactText(workflowSummary)
  const compactedDelivery = compactText(deliverySummary)

  // Update headline to most recent summary
  if (compactedSummary) {
    rollup.headline = compactedSummary
  }

  // Accumulate key findings from workflow summaries
  if (compactedWorkflow && !rollup.keyFindings?.includes(compactedWorkflow)) {
    rollup.keyFindings = [...(rollup.keyFindings || []), compactedWorkflow].slice(-10)
  }

  // Track delivery results
  if (compactedDelivery) {
    rollup.nextAnchor = compactedDelivery
  }

  return rollup
}

/**
 * Decide whether a compaction should be triggered.
 *
 * @param {object} params
 * @param {object|null} params.budgetPolicy - Session budget policy
 * @param {object|null} params.budgetLedger - Current budget ledger
 * @param {number} params.runsSinceLastCompaction - Runs since last compaction
 * @returns {{ shouldCompact: boolean, reason: string|null }}
 */
export function evaluateCompactionDecision({
  budgetPolicy = null,
  budgetLedger = null,
  runsSinceLastCompaction = 0,
} = {}) {
  if (!budgetPolicy || typeof budgetPolicy !== 'object') {
    return { shouldCompact: false, reason: null }
  }

  // Critical health → always compact
  if (budgetLedger?.health === 'critical') {
    return { shouldCompact: true, reason: 'budget_critical' }
  }

  // Run threshold → compact when reached
  const threshold = typeof budgetPolicy.compactAfterRuns === 'number' && budgetPolicy.compactAfterRuns > 0
    ? budgetPolicy.compactAfterRuns
    : 0
  if (threshold > 0 && runsSinceLastCompaction >= threshold) {
    return { shouldCompact: true, reason: 'run_threshold' }
  }

  return { shouldCompact: false, reason: null }
}

/**
 * Produce a day rollup date string for a given timestamp.
 */
export function rollupDateStr(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10)
}
