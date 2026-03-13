import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

import {
  clearMemoryShadowStoreForTests,
  flushMemoryShadowStore,
  getMemoryShadowStatus,
  ingestMemoryShadowEnvelope,
} from './memory-shadow-store.mjs'
import { getConfigDir } from './config.mjs'

function makeShadowEnvelope() {
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
    manifestKey: latestPointer.manifestKey,
    artifactCount: 2,
    requiredArtifactCount: 2,
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
    coreDocCount: 0,
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
      {
        key: 'memory-index.json',
        label: 'memory-index.json',
        kind: 'derived_meta',
        updatedAt: 1700000005000,
        checksum: 'memory-index-checksum',
        bytes: 32,
        storageKey: 'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/indexes/memory-index.json',
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
      'memory-checkpoints/generations/2026-03-13T00-00-00.000Z/artifacts/indexes/memory-index.json': '[{"id":"mem-1"}]',
    },
  }
}

test('memory shadow store persists mirrored committed envelopes and derived status across reload', async (t) => {
  await clearMemoryShadowStoreForTests()
  t.after(async () => {
    await clearMemoryShadowStoreForTests()
  })

  const ingest = await ingestMemoryShadowEnvelope(makeShadowEnvelope(), { shadowedAt: 1700000009000 })
  assert.equal(ingest.status.mirroredGeneration, '2026-03-13T00-00-00.000Z')
  assert.equal(ingest.status.mirroredCommittedAt, 1700000005000)
  assert.equal(ingest.status.freshness.state, 'fresh')
  assert.equal(ingest.status.freshness.shadowedAt, 1700000009000)
  assert.equal(ingest.status.verification.state, 'unknown')
  await flushMemoryShadowStore()

  const reloaded = await import(`./memory-shadow-store.mjs?bust=${Date.now()}-${Math.random()}`)
  await reloaded.loadMemoryShadowStore()
  const envelope = await reloaded.getMemoryShadowEnvelope()
  const status = await reloaded.getMemoryShadowStatus()

  assert.equal(envelope?.generation, '2026-03-13T00-00-00.000Z')
  assert.equal(envelope?.history.lastHistoryKey, 'memory-checkpoints/history/2026-03-13T00-00-00.000Z.json')
  assert.equal(status.mirroredGeneration, '2026-03-13T00-00-00.000Z')
  assert.equal(status.freshness.shadowedAt, 1700000009000)
})

test('memory shadow store falls back to backup file when the primary file is corrupted', async (t) => {
  await clearMemoryShadowStoreForTests()
  t.after(async () => {
    await clearMemoryShadowStoreForTests()
  })

  await ingestMemoryShadowEnvelope(makeShadowEnvelope(), { shadowedAt: 1700000009000 })
  await flushMemoryShadowStore()

  const configDir = getConfigDir()
  const primary = path.join(configDir, 'memory-shadow.json')
  const backup = path.join(configDir, 'memory-shadow.json.bak')
  const payload = await readFile(primary, 'utf8')
  await writeFile(backup, payload, 'utf8')
  await writeFile(primary, '{ invalid json', 'utf8')

  const reloaded = await import(`./memory-shadow-store.mjs?bust=${Date.now()}-${Math.random()}`)
  await reloaded.loadMemoryShadowStore()
  const status = await reloaded.getMemoryShadowStatus()
  assert.equal(status.mirroredGeneration, '2026-03-13T00-00-00.000Z')
  assert.equal(status.freshness.shadowedAt, 1700000009000)
})

test('memory shadow store exposes an empty placeholder status before any ingest', async (t) => {
  await clearMemoryShadowStoreForTests()
  t.after(async () => {
    await clearMemoryShadowStoreForTests()
  })

  const status = await getMemoryShadowStatus()
  assert.deepEqual(status, {
    version: 1,
    authority: 'extension_primary',
    mirroredGeneration: null,
    mirroredCommittedAt: null,
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
