import { promises as fs } from 'node:fs'
import path from 'node:path'

import { ensureConfigDir, getConfigDir } from './config.mjs'

const FILE_MODE = 0o600
const MEMORY_CHECKPOINTS_LATEST_KEY = 'memory-checkpoints/latest.json'
const SHADOW_REFRESH_PUBLISH_SOURCE = 'shadow_refresh'
const DEFAULT_STATE_VERSION = 1

function MEMORY_SHADOW_REFRESH_FILE() {
  return path.join(getConfigDir(), 'memory-shadow-refresh.json')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function asTimestamp(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Math.floor(numeric)
}

function asString(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeOutcome(value) {
  return value === 'skipped' || value === 'published' || value === 'failed' ? value : null
}

function normalizePublishSource(value) {
  return value === SHADOW_REFRESH_PUBLISH_SOURCE ? value : null
}

function normalizePersistedState(input) {
  const record = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return {
    version: DEFAULT_STATE_VERSION,
    state: asString(record.state) || 'empty',
    freshnessOwner: asString(record.freshnessOwner) || 'none',
    lastAttemptAt: asTimestamp(record.lastAttemptAt),
    lastOutcome: normalizeOutcome(record.lastOutcome),
    lastError: asString(record.lastError),
    lastSourceGeneration: asString(record.lastSourceGeneration),
    lastSourceCommittedAt: asTimestamp(record.lastSourceCommittedAt),
    lastPublishedGeneration: asString(record.lastPublishedGeneration),
    lastPublishedAt: asTimestamp(record.lastPublishedAt),
    lastPublishSource: normalizePublishSource(record.lastPublishSource),
  }
}

function buildInitialState() {
  return normalizePersistedState({})
}

function buildMemoryCheckpointGeneration(timestamp) {
  return new Date(timestamp).toISOString().replace(/:/g, '-')
}

function rewriteGenerationScopedStorageKey(storageKey, sourceGeneration, nextGeneration) {
  const sourcePrefix = `memory-checkpoints/generations/${sourceGeneration}/`
  if (!String(storageKey || '').startsWith(sourcePrefix)) return storageKey
  return `memory-checkpoints/generations/${nextGeneration}/${storageKey.slice(sourcePrefix.length)}`
}

function isShadowRefreshFresh(state, envelope, nowTs, freshnessSlaHours) {
  if (!state.lastPublishedAt || state.lastPublishSource !== SHADOW_REFRESH_PUBLISH_SOURCE) return false
  if (state.lastSourceGeneration !== envelope.generation) return false
  return nowTs - state.lastPublishedAt < freshnessSlaHours * 60 * 60 * 1000
}

function isPrimaryFresh(envelope, nowTs, freshnessSlaHours) {
  return nowTs - envelope.committedAt < freshnessSlaHours * 60 * 60 * 1000
}

function deriveState({ envelope, persistedState, available, nowTs, freshnessSlaHours }) {
  const base = {
    available,
    freshnessSlaHours,
    lastAttemptAt: persistedState.lastAttemptAt,
    lastOutcome: persistedState.lastOutcome,
    lastError: persistedState.lastError,
    lastSourceGeneration: persistedState.lastSourceGeneration,
    lastSourceCommittedAt: persistedState.lastSourceCommittedAt,
    lastPublishedGeneration: persistedState.lastPublishedGeneration,
    lastPublishedAt: persistedState.lastPublishedAt,
    lastPublishSource: persistedState.lastPublishSource,
  }

  if (!envelope) {
    return {
      ...base,
      state: 'empty',
      freshnessOwner: 'none',
    }
  }

  if (isShadowRefreshFresh(persistedState, envelope, nowTs, freshnessSlaHours)) {
    return {
      ...base,
      state: 'shadow_refresh_fresh',
      freshnessOwner: 'shadow_refresh',
    }
  }

  if (isPrimaryFresh(envelope, nowTs, freshnessSlaHours)) {
    return {
      ...base,
      state: 'primary_fresh',
      freshnessOwner: 'extension_primary',
    }
  }

  if (!available) {
    return {
      ...base,
      state: 'publisher_unavailable',
      freshnessOwner: 'none',
    }
  }

  if (
    persistedState.lastOutcome === 'failed'
    && persistedState.lastSourceGeneration
    && persistedState.lastSourceGeneration === envelope.generation
  ) {
    return {
      ...base,
      state: 'failed',
      freshnessOwner: 'none',
    }
  }

  return {
    ...base,
    state: 'stale',
    freshnessOwner: 'none',
  }
}

function buildRefreshBundle(envelope, nowTs) {
  const sourceGeneration = envelope.generation
  let generation = buildMemoryCheckpointGeneration(nowTs)
  if (generation === sourceGeneration) {
    generation = buildMemoryCheckpointGeneration(nowTs + 1)
  }

  const manifestKey = `memory-checkpoints/generations/${generation}/manifest.json`
  const historyKey = `memory-checkpoints/history/${generation}.json`

  const artifacts = envelope.manifest.artifacts.map((artifact) => ({
    ...artifact,
    storageKey: rewriteGenerationScopedStorageKey(artifact.storageKey, sourceGeneration, generation),
  }))

  const latestPointer = {
    version: 1,
    generation,
    committedAt: nowTs,
    manifestKey,
  }

  const history = {
    ...envelope.history,
    generation,
    previousGeneration: sourceGeneration,
    committedAt: nowTs,
    manifestKey,
    lastHistoryKey: historyKey,
  }

  const manifest = {
    ...envelope.manifest,
    generation,
    previousGeneration: sourceGeneration,
    generatedAt: nowTs,
    committedAt: nowTs,
    latestPointerKey: MEMORY_CHECKPOINTS_LATEST_KEY,
    artifacts,
  }

  const artifactPayloads = {}
  for (const [storageKey, payload] of Object.entries(envelope.artifactPayloads || {})) {
    artifactPayloads[rewriteGenerationScopedStorageKey(storageKey, sourceGeneration, generation)] = payload
  }

  return {
    publishSource: SHADOW_REFRESH_PUBLISH_SOURCE,
    generation,
    committedAt: nowTs,
    sourceGeneration,
    sourceCommittedAt: envelope.committedAt,
    latestPointer,
    latestPointerPayload: JSON.stringify(latestPointer),
    history,
    historyPayload: JSON.stringify(history),
    manifest,
    manifestPayload: JSON.stringify(manifest),
    artifactPayloads,
  }
}

let fileStateLoaded = false
let fileState = buildInitialState()

async function loadFileState() {
  if (fileStateLoaded) return clone(fileState)
  await ensureConfigDir()
  try {
    const raw = await fs.readFile(MEMORY_SHADOW_REFRESH_FILE(), 'utf8')
    fileState = normalizePersistedState(JSON.parse(raw))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[memory-shadow-publisher] Failed to load refresh state: ${error.message}`)
    }
    fileState = buildInitialState()
  }
  fileStateLoaded = true
  return clone(fileState)
}

async function saveFileState(nextState) {
  await ensureConfigDir()
  fileState = normalizePersistedState(nextState)
  fileStateLoaded = true
  const payload = JSON.stringify(fileState, null, 2) + '\n'
  const target = MEMORY_SHADOW_REFRESH_FILE()
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: FILE_MODE })
  await fs.rename(tmp, target)
}

export function createInMemoryMemoryShadowRefreshStateStore(initialState = null) {
  let state = normalizePersistedState(initialState || {})
  return {
    load: async () => clone(state),
    save: async (nextState) => {
      state = normalizePersistedState(nextState)
    },
  }
}

export function createFileBackedMemoryShadowRefreshStateStore() {
  return {
    load: loadFileState,
    save: saveFileState,
  }
}

export async function clearMemoryShadowRefreshStateForTests() {
  fileState = buildInitialState()
  fileStateLoaded = true
  await ensureConfigDir().catch(() => undefined)
  await Promise.all([
    fs.rm(MEMORY_SHADOW_REFRESH_FILE(), { force: true }).catch(() => undefined),
    fs.rm(`${MEMORY_SHADOW_REFRESH_FILE()}.tmp`, { force: true }).catch(() => undefined),
  ])
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'shadow_refresh_failed')
}

export function createMemoryShadowPublisher({
  getShadowEnvelope,
  publishShadowRefresh,
  now = () => Date.now(),
  freshnessSlaHours = 30,
  stateStore = createInMemoryMemoryShadowRefreshStateStore(),
}) {
  if (typeof getShadowEnvelope !== 'function') {
    throw new Error('createMemoryShadowPublisher requires getShadowEnvelope().')
  }

  const available = typeof publishShadowRefresh === 'function'

  async function loadDerivedState(envelopeOverride) {
    const [persistedState, envelope] = await Promise.all([
      stateStore.load(),
      envelopeOverride !== undefined ? Promise.resolve(envelopeOverride) : getShadowEnvelope(),
    ])
    return deriveState({
      envelope,
      persistedState: normalizePersistedState(persistedState),
      available,
      nowTs: now(),
      freshnessSlaHours,
    })
  }

  async function patchPersistedState(patch) {
    const current = normalizePersistedState(await stateStore.load())
    const nextState = normalizePersistedState({
      ...current,
      ...patch,
    })
    await stateStore.save(nextState)
    return nextState
  }

  return {
    async getState() {
      return loadDerivedState()
    },
    async refresh(options = {}) {
      const force = options?.force === true
      const attemptAt = now()
      const envelope = await getShadowEnvelope()
      const currentState = deriveState({
        envelope,
        persistedState: normalizePersistedState(await stateStore.load()),
        available,
        nowTs: attemptAt,
        freshnessSlaHours,
      })

      if (!envelope) {
        await patchPersistedState({
          state: 'empty',
          freshnessOwner: 'none',
          lastAttemptAt: attemptAt,
          lastOutcome: 'skipped',
          lastError: null,
          lastSourceGeneration: null,
          lastSourceCommittedAt: null,
        })
        return {
          published: false,
          reason: 'no_shadow_checkpoint',
          publishSource: null,
          state: await loadDerivedState(null),
        }
      }

      if (!force && currentState.state === 'shadow_refresh_fresh') {
        await patchPersistedState({
          lastAttemptAt: attemptAt,
          lastOutcome: 'skipped',
          lastError: null,
        })
        return {
          published: false,
          reason: 'shadow_refresh_fresh',
          publishSource: null,
          state: await loadDerivedState(envelope),
        }
      }

      if (!force && currentState.state === 'primary_fresh') {
        await patchPersistedState({
          lastAttemptAt: attemptAt,
          lastOutcome: 'skipped',
          lastError: null,
          lastSourceGeneration: envelope.generation,
          lastSourceCommittedAt: envelope.committedAt,
        })
        return {
          published: false,
          reason: 'primary_fresh',
          publishSource: null,
          state: await loadDerivedState(envelope),
        }
      }

      if (!available) {
        await patchPersistedState({
          state: 'publisher_unavailable',
          freshnessOwner: 'none',
          lastAttemptAt: attemptAt,
          lastOutcome: 'failed',
          lastError: 'shadow_refresh_publisher_unavailable',
          lastSourceGeneration: envelope.generation,
          lastSourceCommittedAt: envelope.committedAt,
        })
        return {
          published: false,
          reason: 'publisher_unavailable',
          publishSource: null,
          state: await loadDerivedState(envelope),
        }
      }

      const bundle = buildRefreshBundle(envelope, attemptAt)

      try {
        const publishResult = await publishShadowRefresh(bundle)
        await patchPersistedState({
          state: 'shadow_refresh_fresh',
          freshnessOwner: 'shadow_refresh',
          lastAttemptAt: attemptAt,
          lastOutcome: 'published',
          lastError: null,
          lastSourceGeneration: envelope.generation,
          lastSourceCommittedAt: envelope.committedAt,
          lastPublishedGeneration: bundle.generation,
          lastPublishedAt: attemptAt,
          lastPublishSource: SHADOW_REFRESH_PUBLISH_SOURCE,
        })
        return {
          published: true,
          publishSource: SHADOW_REFRESH_PUBLISH_SOURCE,
          generation: bundle.generation,
          sourceGeneration: envelope.generation,
          sourceCommittedAt: envelope.committedAt,
          state: await loadDerivedState(envelope),
          ...(publishResult && typeof publishResult === 'object' ? publishResult : {}),
        }
      } catch (error) {
        await patchPersistedState({
          state: 'failed',
          freshnessOwner: 'none',
          lastAttemptAt: attemptAt,
          lastOutcome: 'failed',
          lastError: errorMessage(error),
          lastSourceGeneration: envelope.generation,
          lastSourceCommittedAt: envelope.committedAt,
        })
        return {
          published: false,
          reason: 'publish_failed',
          publishSource: null,
          error: errorMessage(error),
          state: await loadDerivedState(envelope),
        }
      }
    },
  }
}
