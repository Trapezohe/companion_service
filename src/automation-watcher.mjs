/**
 * Watcher escalation decision logic.
 *
 * Decides whether a watcher-detected change should trigger a workflow
 * escalation investigation or just a standard notification delivery.
 *
 * ## Lag-one observation model
 *
 * Companion watcher escalation operates on a **lag-one** basis:
 *
 * 1. **Extension-side** (cron-scheduler.ts) computes the current observation
 *    hash and persists it into `watcher.state.lastObservationHash` before
 *    syncing the job to the companion.
 * 2. **Companion-side** (this module) compares `lastObservationHash` against
 *    `lastInvestigatedHash`. If they differ and the hash is non-empty,
 *    escalation is triggered.
 * 3. When escalation fires, the executor persists `watcherStatePatch`
 *    (including updated `lastInvestigatedHash`) back to the companion
 *    job store **before** the ACP run begins, so the next timer fire
 *    sees the updated state and does not re-escalate for the same hash.
 *
 * This means escalation reacts to the PREVIOUS observation — the one the
 * extension already computed — not the output of the current ACP run.
 * The trade-off is a one-cycle delay in exchange for a simpler execution
 * model that avoids mid-run workflow switching.
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
