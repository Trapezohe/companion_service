import test from 'node:test'
import assert from 'node:assert/strict'

import {
  validateMemoryShadowContract,
  validateMemoryShadowStatus,
} from './memory-shadow-contract.mjs'

function makeEnvelope() {
  const latestPointer = {
    version: 1,
    generation: '2026-03-13T00-00-00.000Z',
    committedAt: 1700000005000,
    manifestKey: 'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/manifest.json',
  }
  const history = {
    version: 1,
    generation: '2026-03-13T00-00-00.000Z',
    previousGeneration: '2026-03-12T00-00-00.000Z',
    coverageDay: '2026-03-13',
    committedAt: 1700000005000,
    manifestKey: 'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/manifest.json',
    artifactCount: 1,
    requiredArtifactCount: 1,
    lastHistoryKey: 'memory-checkpoints/history/2026-03-13T00-00-00.000Z.json',
  }
  const manifest = {
    version: 1,
    generatedAt: 1700000000000,
    committedAt: 1700000005000,
    generation: '2026-03-13T00-00-00.000Z',
    previousGeneration: '2026-03-12T00-00-00.000Z',
    latestPointerKey: 'memory-checkpoints/latest.json',
    overallHash: 'overall-hash',
    nodeCount: 1,
    coreDocCount: 1,
    dailyLogCount: 0,
    structuredContextCount: 1,
    artifacts: [
      {
        key: 'context-nodes.json',
        label: 'Context Snapshot',
        kind: 'context_snapshot',
        updatedAt: 1700000000000,
        checksum: 'ctx-checksum',
        count: 1,
        bytes: 128,
        storageKey: 'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/context-nodes.json',
        required: true,
      },
    ],
  }
  return {
    version: 1,
    authority: 'extension_primary',
    generation: '2026-03-13T00-00-00.000Z',
    previousGeneration: '2026-03-12T00-00-00.000Z',
    committedAt: 1700000005000,
    latestPointer,
    latestPointerPayload: JSON.stringify(latestPointer),
    history,
    historyPayload: JSON.stringify(history),
    manifest,
    manifestPayload: JSON.stringify(manifest),
    artifactPayloads: {
      'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/context-nodes.json': '{"nodes":true}',
    },
  }
}

test('validateMemoryShadowContract accepts a canonical extension-primary envelope', () => {
  const envelope = validateMemoryShadowContract(makeEnvelope())

  assert.equal(envelope.authority, 'extension_primary')
  assert.equal(envelope.generation, '2026-03-13T00-00-00.000Z')
  assert.equal(envelope.verification.state, 'unknown')
  assert.equal(envelope.freshness.shadowedAt, null)
})

test('validateMemoryShadowContract rejects non-primary authorities', () => {
  assert.throws(
    () => validateMemoryShadowContract({
      ...makeEnvelope(),
      authority: 'companion_shadow',
    }),
    /extension_primary/i,
  )
})

test('validateMemoryShadowContract rejects invalid artifact payload records', () => {
  assert.throws(
    () => validateMemoryShadowContract({
      ...makeEnvelope(),
      artifactPayloads: {
        'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/context-nodes.json': 42,
      },
    }),
    /artifactPayloads/i,
  )
})

test('validateMemoryShadowContract rejects malformed required manifest artifacts', () => {
  assert.throws(
    () => validateMemoryShadowContract({
      ...makeEnvelope(),
      manifest: {
        ...makeEnvelope().manifest,
        artifacts: [{
          ...makeEnvelope().manifest.artifacts[0],
          storageKey: undefined,
        }],
      },
    }),
    /storageKey/i,
  )
})

test('validateMemoryShadowContract rejects invalid manifest counters', () => {
  assert.throws(
    () => validateMemoryShadowContract({
      ...makeEnvelope(),
      manifest: {
        ...makeEnvelope().manifest,
        nodeCount: 'bad',
      },
    }),
    /nodeCount/i,
  )
})

test('validateMemoryShadowContract rejects mismatched raw manifest payloads', () => {
  assert.throws(
    () => validateMemoryShadowContract({
      ...makeEnvelope(),
      manifestPayload: JSON.stringify({
        ...makeEnvelope().manifest,
        generation: '2026-03-01T00-00-00.000Z',
      }),
    }),
    /manifestPayload/i,
  )
})

test('validateMemoryShadowContract rejects negative history counters', () => {
  assert.throws(
    () => validateMemoryShadowContract({
      ...makeEnvelope(),
      history: {
        ...makeEnvelope().history,
        artifactCount: -1,
      },
    }),
    /artifactCount/i,
  )
})

test('validateMemoryShadowContract rejects invalid verification timestamps', () => {
  assert.throws(
    () => validateMemoryShadowContract({
      ...makeEnvelope(),
      verification: {
        state: 'verified',
        verifiedAt: 'bad-timestamp',
      },
    }),
    /verification\.verifiedAt/i,
  )
})

test('validateMemoryShadowContract rejects empty required artifact payload strings', () => {
  assert.throws(
    () => validateMemoryShadowContract({
      ...makeEnvelope(),
      artifactPayloads: {
        'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/context-nodes.json': '',
      },
    }),
    /artifactPayloads value/i,
  )
})

test('validateMemoryShadowContract strips unknown manifest fields from normalized envelopes', () => {
  const envelope = validateMemoryShadowContract({
    ...makeEnvelope(),
    manifest: {
      ...makeEnvelope().manifest,
      extraField: 'ignored',
      artifacts: [{
        ...makeEnvelope().manifest.artifacts[0],
        unexpected: 'ignored',
      }],
    },
    manifestPayload: JSON.stringify({
      ...makeEnvelope().manifest,
      extraField: 'ignored',
      artifacts: [{
        ...makeEnvelope().manifest.artifacts[0],
        unexpected: 'ignored',
      }],
    }),
  })

  assert.equal('extraField' in envelope.manifest, false)
  assert.equal('unexpected' in envelope.manifest.artifacts[0], false)
})

test('validateMemoryShadowStatus normalizes placeholder proof state', () => {
  const status = validateMemoryShadowStatus({
    version: 1,
    authority: 'extension_primary',
    mirroredGeneration: '2026-03-13T00-00-00.000Z',
    mirroredCommittedAt: 1700000005000,
  })

  assert.deepEqual(status, {
    version: 1,
    authority: 'extension_primary',
    mirroredGeneration: '2026-03-13T00-00-00.000Z',
    mirroredCommittedAt: 1700000005000,
    verification: {
      state: 'unknown',
      verifiedAt: null,
    },
    freshness: {
      state: 'unknown',
      shadowedAt: null,
    },
  })
})
