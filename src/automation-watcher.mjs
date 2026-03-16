/**
 * Watcher escalation decision logic.
 *
 * Decides whether a watcher-detected change should trigger a workflow
 * escalation investigation or just a standard notification delivery.
 *
 * Extension-side (cron-scheduler.ts) handles:
 *   - hash comparison, baseline recording, interval checking
 *   - passing escalation intent via watcher policy in the job spec
 *
 * This module handles companion-side:
 *   - deciding escalate vs notify based on policy + state
 *   - tracking lastEscalationRunId / lastEscalationAt / lastInvestigatedHash
 */

/**
 * Evaluate whether a watcher change should escalate to a workflow investigation.
 *
 * @param {object} params
 * @param {object} params.watcherPolicy - The watcher policy from the job spec
 * @param {object|null} params.watcherState - Current watcher state
 * @param {string} params.currentHash - The observation hash from this run
 * @param {string} params.runId - The current run ID
 * @param {number} [params.now] - Current timestamp (for testing)
 * @returns {{ shouldEscalate: boolean, escalationTemplate: string|null, watcherStatePatch: object|null, reason: string }}
 */
export function evaluateWatcherEscalation({
  watcherPolicy = null,
  watcherState = null,
  currentHash = '',
  runId = '',
  now = Date.now(),
} = {}) {
  // No escalation configured
  if (!watcherPolicy || watcherPolicy.escalateWithWorkflow !== true) {
    return {
      shouldEscalate: false,
      escalationTemplate: null,
      watcherStatePatch: null,
      reason: 'escalation_not_configured',
    }
  }

  const template = watcherPolicy.escalationTemplate
  if (!template || typeof template !== 'string') {
    return {
      shouldEscalate: false,
      escalationTemplate: null,
      watcherStatePatch: null,
      reason: 'escalation_template_missing',
    }
  }

  // Same hash as last investigated — no re-escalation
  const lastInvestigated = typeof watcherState?.lastInvestigatedHash === 'string'
    ? watcherState.lastInvestigatedHash
    : null
  if (lastInvestigated && currentHash && lastInvestigated === currentHash) {
    return {
      shouldEscalate: false,
      escalationTemplate: template,
      watcherStatePatch: null,
      reason: 'already_investigated',
    }
  }

  // Escalate: new change detected
  return {
    shouldEscalate: true,
    escalationTemplate: template,
    watcherStatePatch: {
      lastEscalationRunId: typeof runId === 'string' && runId ? runId : null,
      lastEscalationAt: now,
      lastInvestigatedHash: typeof currentHash === 'string' && currentHash ? currentHash : null,
    },
    reason: 'change_detected',
  }
}
