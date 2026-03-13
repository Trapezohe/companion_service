import test from 'node:test'
import assert from 'node:assert/strict'

function makeShadowEnvelope(overrides = {}) {
  const generation = overrides.generation || '2026-03-13T00-00-00.000Z'
  const previousGeneration = overrides.previousGeneration || '2026-03-12T00-00-00.000Z'
  const committedAt = overrides.committedAt || 1700000005000
  const latestPointer = {
    version: 1,
    generation,
    committedAt,
    manifestKey: `memory-checkpoints/generations/${generation}/manifest.json`,
  }
  const history = {
    version: 1,
    generation,
    previousGeneration,
    coverageDay: '2026-03-13',
    committedAt,
    manifestKey: latestPointer.manifestKey,
    artifactCount: 3,
    requiredArtifactCount: 3,
    lastHistoryKey: `memory-checkpoints/history/${generation}.json`,
  }
  const manifest = {
    version: 1,
    generatedAt: committedAt - 5000,
    committedAt,
    generation,
    previousGeneration,
    latestPointerKey: 'memory-checkpoints/latest.json',
    overallHash: 'overall-hash',
    nodeCount: 1,
    coreDocCount: 0,
    dailyLogCount: 0,
    structuredContextCount: 1,
    artifacts: [
      {
        key: 'context-nodes.json',
        label: 'Context Snapshot',
        kind: 'context_snapshot',
        updatedAt: committedAt - 5000,
        checksum: 'ctx-checksum',
        count: 1,
        bytes: 128,
        storageKey: `memory-checkpoints/generations/${generation}/artifacts/context-nodes.json`,
        required: true,
      },
      {
        key: 'memory-index.json',
        label: 'memory-index.json',
        kind: 'derived_meta',
        updatedAt: committedAt,
        checksum: 'memory-index-checksum',
        bytes: 32,
        storageKey: `memory-checkpoints/generations/${generation}/artifacts/indexes/memory-index.json`,
        required: true,
      },
      {
        key: 'session-archives/conv-1/archive_001/messages.jsonl',
        label: 'Session Archive archive_001',
        kind: 'derived_meta',
        updatedAt: committedAt,
        checksum: 'archive-checksum',
        bytes: 64,
        storageKey: 'session-archives/conv-1/archive_001/messages.jsonl',
        required: true,
      },
    ],
  }
  return {
    version: 1,
    authority: 'extension_primary',
    generation,
    previousGeneration,
    committedAt,
    latestPointer,
    latestPointerPayload: JSON.stringify(latestPointer),
    history,
    historyPayload: JSON.stringify(history),
    manifest,
    manifestPayload: JSON.stringify(manifest),
    artifactPayloads: {
      [`memory-checkpoints/generations/${generation}/artifacts/context-nodes.json`]: '{"nodes":true}',
      [`memory-checkpoints/generations/${generation}/artifacts/indexes/memory-index.json`]: '[{"id":"mem-1"}]',
    },
  }
}

test('shadow publisher refuses to publish when no mirrored committed checkpoint exists', async () => {
  const { createMemoryShadowPublisher } = await import('./memory-shadow-publisher.mjs')
  const publisher = createMemoryShadowPublisher({
    getShadowEnvelope: async () => null,
    publishShadowRefresh: async () => {
      throw new Error('should_not_run')
    },
    now: () => Date.UTC(2026, 2, 13, 12, 0, 0),
    freshnessSlaHours: 30,
  })

  const result = await publisher.refresh()
  assert.equal(result.published, false)
  assert.equal(result.reason, 'no_shadow_checkpoint')
  assert.equal(result.publishSource, null)
})

test('shadow publisher skips refresh while extension-primary checkpoint is still fresh', async () => {
  const { createMemoryShadowPublisher } = await import('./memory-shadow-publisher.mjs')
  const publishShadowRefresh = async () => {
    throw new Error('should_not_run')
  }
  const committedAt = Date.UTC(2026, 2, 13, 10, 0, 0)
  const publisher = createMemoryShadowPublisher({
    getShadowEnvelope: async () => makeShadowEnvelope({ committedAt }),
    publishShadowRefresh,
    now: () => Date.UTC(2026, 2, 13, 12, 0, 0),
    freshnessSlaHours: 30,
  })

  const result = await publisher.refresh()
  assert.equal(result.published, false)
  assert.equal(result.reason, 'primary_fresh')
  assert.equal(result.state.state, 'primary_fresh')
})

test('shadow publisher republishes only mirrored committed state when primary freshness SLA is breached', async () => {
  const { createMemoryShadowPublisher } = await import('./memory-shadow-publisher.mjs')
  const committedAt = Date.UTC(2026, 2, 10, 0, 0, 0)
  const calls = []
  const publisher = createMemoryShadowPublisher({
    getShadowEnvelope: async () => makeShadowEnvelope({ committedAt }),
    publishShadowRefresh: async (bundle) => {
      calls.push(bundle)
      return {
        txHash: '0xtx',
        rootHash: '0xroot',
      }
    },
    now: () => Date.UTC(2026, 2, 13, 12, 0, 0),
    freshnessSlaHours: 30,
  })

  const result = await publisher.refresh()

  assert.equal(result.published, true)
  assert.equal(result.publishSource, 'shadow_refresh')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sourceGeneration, '2026-03-13T00-00-00.000Z')
  assert.equal(calls[0].manifest.previousGeneration, '2026-03-13T00-00-00.000Z')
  assert.equal(calls[0].history.previousGeneration, '2026-03-13T00-00-00.000Z')
  assert.equal(calls[0].manifest.generation, calls[0].generation)
  assert.equal(calls[0].latestPointer.generation, calls[0].generation)
  assert.equal(calls[0].manifest.artifacts[0].storageKey.includes(calls[0].generation), true)
  assert.equal(calls[0].manifest.artifacts[2].storageKey, 'session-archives/conv-1/archive_001/messages.jsonl')
  assert.equal(calls[0].artifactPayloads[`memory-checkpoints/generations/${calls[0].generation}/artifacts/context-nodes.json`], '{"nodes":true}')
  assert.equal(result.state.state, 'shadow_refresh_fresh')
  assert.equal(result.state.lastPublishSource, 'shadow_refresh')
})

test('shadow publisher does not create another refresh generation while the previous shadow refresh is still fresh', async () => {
  const { createMemoryShadowPublisher } = await import('./memory-shadow-publisher.mjs')
  let publishCount = 0
  const committedAt = Date.UTC(2026, 2, 10, 0, 0, 0)
  const publisher = createMemoryShadowPublisher({
    getShadowEnvelope: async () => makeShadowEnvelope({ committedAt }),
    publishShadowRefresh: async () => {
      publishCount += 1
      return {
        txHash: '0xtx',
        rootHash: '0xroot',
      }
    },
    now: () => Date.UTC(2026, 2, 13, 12, 0, 0),
    freshnessSlaHours: 30,
  })

  const first = await publisher.refresh()
  const second = await publisher.refresh()

  assert.equal(first.published, true)
  assert.equal(second.published, false)
  assert.equal(second.reason, 'shadow_refresh_fresh')
  assert.equal(publishCount, 1)
})
