/**
 * Session quality assessment and prompt injection.
 *
 * Generates quality-aware preamble text for persistent automation sessions
 * based on budget health, day rollup availability, and workflow state.
 */

function compactText(raw, maxLength = 300) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!text) return null
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(32, maxLength - 16)).trimEnd()}...[truncated]`
}

/**
 * Classify session quality based on budget health and rollup state.
 *
 * @param {object} params
 * @param {string} params.health - Budget ledger health ('healthy'|'warning'|'critical')
 * @param {boolean} params.hasRollup - Whether a day rollup exists for this session
 * @param {number} params.compactionCount - Number of compactions so far
 * @returns {'healthy'|'degraded'|'critical'}
 */
export function classifySessionQuality({
  health = 'healthy',
  hasRollup = false,
  compactionCount = 0,
} = {}) {
  if (health === 'critical') return 'critical'
  if (health === 'warning' || compactionCount >= 3) return 'degraded'
  return 'healthy'
}

/**
 * Build a quality-aware preamble to inject into the automation prompt.
 *
 * @param {object} params
 * @param {'healthy'|'degraded'|'critical'} params.quality - Session quality level
 * @param {object|null} params.rollup - Most recent day rollup
 * @param {string|null} params.lastWorkflowSummary - Last workflow summary
 * @param {number} params.compactionCount - Number of compactions so far
 * @returns {string|null} The preamble text, or null if no injection needed
 */
export function buildSessionQualityPreamble({
  quality = 'healthy',
  rollup = null,
  lastWorkflowSummary = null,
  compactionCount = 0,
} = {}) {
  if (quality === 'healthy') {
    // Lightweight status — no injection needed
    return null
  }

  const lines = []

  if (quality === 'critical') {
    lines.push(
      'Session quality: CRITICAL — context budget is near or over capacity.',
      'Rely on the rollup summary below instead of raw conversation history.',
      'Produce concise outputs to preserve remaining capacity.',
    )
  } else {
    lines.push(
      'Session quality: DEGRADED — context budget is elevated.',
      'Use the rollup summary below as your primary context anchor.',
    )
  }

  if (compactionCount > 0) {
    lines.push(`This session has been compacted ${compactionCount} time${compactionCount === 1 ? '' : 's'}.`)
  }

  if (rollup && typeof rollup === 'object') {
    const rollupLines = []
    if (rollup.headline) {
      rollupLines.push(`Headline: ${compactText(rollup.headline)}`)
    }
    if (Array.isArray(rollup.keyFindings) && rollup.keyFindings.length > 0) {
      rollupLines.push(`Key findings: ${rollup.keyFindings.map((f) => compactText(f, 120)).filter(Boolean).join('; ')}`)
    }
    if (Array.isArray(rollup.unresolved) && rollup.unresolved.length > 0) {
      rollupLines.push(`Unresolved: ${rollup.unresolved.map((u) => compactText(u, 120)).filter(Boolean).join('; ')}`)
    }
    if (rollup.nextAnchor) {
      rollupLines.push(`Next anchor: ${compactText(rollup.nextAnchor)}`)
    }
    if (rollupLines.length > 0) {
      lines.push('')
      lines.push('--- Day Rollup ---')
      lines.push(...rollupLines)
      lines.push('--- End Rollup ---')
    }
  }

  if (lastWorkflowSummary) {
    lines.push('')
    lines.push(`Last workflow result: ${compactText(lastWorkflowSummary)}`)
  }

  return lines.join('\n')
}

/**
 * Build diagnostics counters for session quality across automation jobs.
 *
 * @param {Array} specs - Normalized automation spec array
 * @returns {{ rollupBackedSessions: number, criticalQualitySessions: number, recentCompactions: number }}
 */
export function summarizeSessionQualityDiagnostics(specs) {
  if (!Array.isArray(specs)) {
    return { rollupBackedSessions: 0, criticalQualitySessions: 0, recentCompactions: 0 }
  }

  let rollupBackedSessions = 0
  let criticalQualitySessions = 0
  let recentCompactions = 0

  for (const spec of specs) {
    const ledger = spec?.sessionBudget?.ledger
    if (!ledger) continue

    if (ledger.lastCompactedAt != null) {
      rollupBackedSessions += 1
    }
    if (ledger.health === 'critical') {
      criticalQualitySessions += 1
    }
    if (typeof ledger.compactionCount === 'number' && ledger.compactionCount > 0) {
      recentCompactions += ledger.compactionCount
    }
  }

  return { rollupBackedSessions, criticalQualitySessions, recentCompactions }
}
