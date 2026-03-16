import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifySessionQuality,
  buildSessionQualityPreamble,
  summarizeSessionQualityDiagnostics,
} from './automation-session-quality.mjs'

test('classifySessionQuality returns healthy for normal sessions', () => {
  assert.equal(classifySessionQuality({ health: 'healthy', hasRollup: false, compactionCount: 0 }), 'healthy')
  assert.equal(classifySessionQuality({ health: 'healthy', hasRollup: true, compactionCount: 1 }), 'healthy')
})

test('classifySessionQuality returns degraded for warning health or high compaction count', () => {
  assert.equal(classifySessionQuality({ health: 'warning', hasRollup: true, compactionCount: 0 }), 'degraded')
  assert.equal(classifySessionQuality({ health: 'healthy', hasRollup: false, compactionCount: 3 }), 'degraded')
})

test('classifySessionQuality returns critical for critical health', () => {
  assert.equal(classifySessionQuality({ health: 'critical', hasRollup: true, compactionCount: 5 }), 'critical')
})

test('buildSessionQualityPreamble returns null for healthy sessions', () => {
  const result = buildSessionQualityPreamble({ quality: 'healthy' })
  assert.equal(result, null)
})

test('buildSessionQualityPreamble injects rollup for degraded sessions', () => {
  const result = buildSessionQualityPreamble({
    quality: 'degraded',
    rollup: {
      headline: 'BTC analysis complete',
      keyFindings: ['Price up 5%', 'Volume declining'],
      unresolved: ['Macro policy unclear'],
      nextAnchor: 'Watch Fed meeting',
    },
    lastWorkflowSummary: 'Synthesis delivered successfully',
    compactionCount: 2,
  })

  assert.match(result, /Session quality: DEGRADED/)
  assert.match(result, /primary context anchor/)
  assert.match(result, /compacted 2 times/)
  assert.match(result, /Headline: BTC analysis complete/)
  assert.match(result, /Price up 5%/)
  assert.match(result, /Macro policy unclear/)
  assert.match(result, /Next anchor: Watch Fed meeting/)
  assert.match(result, /Last workflow result: Synthesis delivered/)
})

test('buildSessionQualityPreamble injects critical guidance for critical sessions', () => {
  const result = buildSessionQualityPreamble({
    quality: 'critical',
    rollup: {
      headline: 'Market crash report',
      keyFindings: ['BTC down 20%'],
      unresolved: [],
      nextAnchor: null,
    },
    compactionCount: 5,
  })

  assert.match(result, /Session quality: CRITICAL/)
  assert.match(result, /Rely on the rollup summary/)
  assert.match(result, /concise outputs/)
  assert.match(result, /compacted 5 times/)
  assert.match(result, /Market crash report/)
})

test('buildSessionQualityPreamble handles missing rollup gracefully', () => {
  const result = buildSessionQualityPreamble({
    quality: 'degraded',
    rollup: null,
    compactionCount: 1,
  })

  assert.match(result, /Session quality: DEGRADED/)
  assert.match(result, /compacted 1 time\./)
  assert.ok(!result.includes('Day Rollup'))
})

test('summarizeSessionQualityDiagnostics counts session quality metrics', () => {
  const specs = [
    {
      sessionBudget: {
        ledger: { health: 'critical', compactionCount: 2, lastCompactedAt: 1000 },
      },
    },
    {
      sessionBudget: {
        ledger: { health: 'healthy', compactionCount: 1, lastCompactedAt: 2000 },
      },
    },
    {
      sessionBudget: {
        ledger: { health: 'warning', compactionCount: 0, lastCompactedAt: null },
      },
    },
    {
      sessionBudget: null,
    },
  ]

  const result = summarizeSessionQualityDiagnostics(specs)
  assert.equal(result.rollupBackedSessions, 2)
  assert.equal(result.criticalQualitySessions, 1)
  assert.equal(result.recentCompactions, 3)
})

test('summarizeSessionQualityDiagnostics returns zeros for empty array', () => {
  const result = summarizeSessionQualityDiagnostics([])
  assert.deepEqual(result, { rollupBackedSessions: 0, criticalQualitySessions: 0, recentCompactions: 0 })
})
