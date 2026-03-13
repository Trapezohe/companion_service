const MEMORY_CHECKPOINT_SHADOW_VERSION = 1
const MEMORY_CHECKPOINT_SHADOW_AUTHORITY = 'extension_primary'
const MEMORY_CHECKPOINTS_LATEST_KEY = 'memory-checkpoints/latest.json'

function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

function asNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`)
  }
  return value.trim()
}

function asOptionalString(value) {
  if (value === null || value === undefined) return null
  return asNonEmptyString(value, 'value')
}

function asTimestamp(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive timestamp.`)
  }
  return value
}

function asNonNegativeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number.`)
  }
  return Math.floor(value)
}

function normalizeVerificationMeta(value) {
  const record = asRecord(value) || {}
  const state = record.state
  const normalizedState = state === 'verified' || state === 'failed' || state === 'unknown'
    ? state
    : 'unknown'
  const verifiedAt = record.verifiedAt === null || record.verifiedAt === undefined
    ? null
    : asTimestamp(record.verifiedAt, 'verification.verifiedAt')
  return {
    state: normalizedState,
    verifiedAt,
  }
}

function normalizeFreshnessMeta(value) {
  const record = asRecord(value) || {}
  const state = record.state
  const normalizedState = state === 'fresh' || state === 'stale' || state === 'unknown'
    ? state
    : 'unknown'
  const shadowedAt = record.shadowedAt === null || record.shadowedAt === undefined
    ? null
    : asTimestamp(record.shadowedAt, 'freshness.shadowedAt')
  return {
    state: normalizedState,
    shadowedAt,
  }
}

function normalizeLatestPointer(value) {
  const record = asRecord(value)
  if (!record || record.version !== 1) {
    throw new Error('latestPointer.version must equal 1.')
  }
  return {
    version: 1,
    generation: asNonEmptyString(record.generation, 'latestPointer.generation'),
    committedAt: asTimestamp(record.committedAt, 'latestPointer.committedAt'),
    manifestKey: asNonEmptyString(record.manifestKey, 'latestPointer.manifestKey'),
  }
}

function normalizeHistory(value) {
  const record = asRecord(value)
  if (!record || record.version !== 1) {
    throw new Error('history.version must equal 1.')
  }
  if (!Number.isFinite(record.artifactCount) || record.artifactCount < 0) {
    throw new Error('history.artifactCount must be a non-negative number.')
  }
  if (!Number.isFinite(record.requiredArtifactCount) || record.requiredArtifactCount < 0) {
    throw new Error('history.requiredArtifactCount must be a non-negative number.')
  }
  return {
    version: 1,
    generation: asNonEmptyString(record.generation, 'history.generation'),
    previousGeneration: asOptionalString(record.previousGeneration),
    coverageDay: asNonEmptyString(record.coverageDay, 'history.coverageDay'),
    committedAt: asTimestamp(record.committedAt, 'history.committedAt'),
    manifestKey: asNonEmptyString(record.manifestKey, 'history.manifestKey'),
    artifactCount: Math.floor(record.artifactCount),
    requiredArtifactCount: Math.floor(record.requiredArtifactCount),
    lastHistoryKey: asNonEmptyString(record.lastHistoryKey, 'history.lastHistoryKey'),
  }
}

function normalizeManifest(value) {
  const record = asRecord(value)
  if (!record || record.version !== 1 || !Array.isArray(record.artifacts)) {
    throw new Error('manifest must be a v1 object with artifacts.')
  }
  const artifacts = record.artifacts.map((artifact, index) => normalizeManifestArtifact(artifact, index))
  return {
    version: 1,
    generation: asNonEmptyString(record.generation, 'manifest.generation'),
    previousGeneration: asOptionalString(record.previousGeneration),
    generatedAt: asTimestamp(record.generatedAt, 'manifest.generatedAt'),
    committedAt: asTimestamp(record.committedAt, 'manifest.committedAt'),
    latestPointerKey: asNonEmptyString(record.latestPointerKey, 'manifest.latestPointerKey'),
    overallHash: asNonEmptyString(record.overallHash, 'manifest.overallHash'),
    nodeCount: asNonNegativeInteger(record.nodeCount, 'manifest.nodeCount'),
    coreDocCount: asNonNegativeInteger(record.coreDocCount, 'manifest.coreDocCount'),
    dailyLogCount: asNonNegativeInteger(record.dailyLogCount, 'manifest.dailyLogCount'),
    structuredContextCount: asNonNegativeInteger(
      record.structuredContextCount,
      'manifest.structuredContextCount',
    ),
    artifacts,
  }
}

function normalizeManifestArtifact(value, index) {
  const record = asRecord(value)
  if (!record) {
    throw new Error(`manifest.artifacts[${index}] must be an object.`)
  }
  const kind = asNonEmptyString(record.kind, `manifest.artifacts[${index}].kind`)
  if (!['context_snapshot', 'core_doc', 'daily_log', 'derived_meta'].includes(kind)) {
    throw new Error(`manifest.artifacts[${index}].kind is not supported.`)
  }

  const normalized = {
    key: asNonEmptyString(record.key, `manifest.artifacts[${index}].key`),
    label: asNonEmptyString(record.label, `manifest.artifacts[${index}].label`),
    kind,
    updatedAt: asNonNegativeInteger(record.updatedAt, `manifest.artifacts[${index}].updatedAt`),
    checksum: asNonEmptyString(record.checksum, `manifest.artifacts[${index}].checksum`),
    storageKey: asNonEmptyString(record.storageKey, `manifest.artifacts[${index}].storageKey`),
  }

  if (typeof record.required !== 'boolean') {
    throw new Error(`manifest.artifacts[${index}].required must be a boolean.`)
  }
  normalized.required = record.required

  if (record.count !== undefined) {
    normalized.count = asNonNegativeInteger(record.count, `manifest.artifacts[${index}].count`)
  }
  if (record.bytes !== undefined) {
    normalized.bytes = asNonNegativeInteger(record.bytes, `manifest.artifacts[${index}].bytes`)
  }
  if (record.shardIndex !== undefined) {
    normalized.shardIndex = asNonNegativeInteger(
      record.shardIndex,
      `manifest.artifacts[${index}].shardIndex`,
    )
  }
  if (record.shardCount !== undefined) {
    normalized.shardCount = asNonNegativeInteger(
      record.shardCount,
      `manifest.artifacts[${index}].shardCount`,
    )
  }
  if (record.groupChecksum !== undefined) {
    normalized.groupChecksum = asNonEmptyString(
      record.groupChecksum,
      `manifest.artifacts[${index}].groupChecksum`,
    )
  }

  return normalized
}

function normalizeArtifactPayloads(value, manifest) {
  const record = asRecord(value)
  if (!record) {
    throw new Error('artifactPayloads must be an object.')
  }
  const normalized = {}
  for (const [storageKey, payload] of Object.entries(record)) {
    normalized[asNonEmptyString(storageKey, 'artifactPayloads key')] = asNonEmptyString(
      payload,
      'artifactPayloads value',
    )
  }
  for (const artifact of manifest.artifacts) {
    if (artifact.required !== true) continue
    if (normalized[artifact.storageKey] !== undefined) continue
    if (typeof artifact.storageKey === 'string' && artifact.storageKey.startsWith('session-archives/')) continue
    throw new Error(`artifactPayloads missing required payload for ${artifact.storageKey || artifact.key}.`)
  }
  return normalized
}

function normalizeParsedJson(raw, normalize, label) {
  try {
    return normalize(JSON.parse(raw))
  } catch {
    throw new Error(`${label} must be valid JSON matching the normalized payload.`)
  }
}

function sameNormalizedValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function validateMemoryShadowContract(input) {
  const record = asRecord(input)
  if (!record || record.version !== MEMORY_CHECKPOINT_SHADOW_VERSION) {
    throw new Error('Shadow envelope version must equal 1.')
  }
  if (record.authority !== MEMORY_CHECKPOINT_SHADOW_AUTHORITY) {
    throw new Error('Shadow envelope authority must be extension_primary.')
  }

  const generation = asNonEmptyString(record.generation, 'generation')
  const previousGeneration = asOptionalString(record.previousGeneration)
  const committedAt = asTimestamp(record.committedAt, 'committedAt')
  const latestPointer = normalizeLatestPointer(record.latestPointer)
  const history = normalizeHistory(record.history)
  const manifest = normalizeManifest(record.manifest)
  const latestPointerPayload = asNonEmptyString(record.latestPointerPayload, 'latestPointerPayload')
  const historyPayload = asNonEmptyString(record.historyPayload, 'historyPayload')
  const manifestPayload = asNonEmptyString(record.manifestPayload, 'manifestPayload')
  const latestPointerFromPayload = normalizeParsedJson(
    latestPointerPayload,
    normalizeLatestPointer,
    'latestPointerPayload',
  )
  const historyFromPayload = normalizeParsedJson(historyPayload, normalizeHistory, 'historyPayload')
  const manifestFromPayload = normalizeParsedJson(manifestPayload, normalizeManifest, 'manifestPayload')

  if (latestPointer.generation !== generation || latestPointer.committedAt !== committedAt) {
    throw new Error('latestPointer must match envelope generation and committedAt.')
  }
  if (
    history.generation !== generation
    || history.previousGeneration !== previousGeneration
    || history.committedAt !== committedAt
    || history.manifestKey !== latestPointer.manifestKey
  ) {
    throw new Error('history must match the committed checkpoint chain.')
  }
  if (
    manifest.generation !== generation
    || manifest.previousGeneration !== previousGeneration
    || manifest.committedAt !== committedAt
    || manifest.latestPointerKey !== MEMORY_CHECKPOINTS_LATEST_KEY
  ) {
    throw new Error('manifest must match the committed checkpoint chain.')
  }
  if (
    !sameNormalizedValue(latestPointerFromPayload, latestPointer)
    || !sameNormalizedValue(historyFromPayload, history)
    || !sameNormalizedValue(manifestFromPayload, manifest)
  ) {
    throw new Error('manifestPayload/historyPayload/latestPointerPayload must match the normalized chain.')
  }

  return {
    version: MEMORY_CHECKPOINT_SHADOW_VERSION,
    authority: MEMORY_CHECKPOINT_SHADOW_AUTHORITY,
    generation,
    previousGeneration,
    committedAt,
    latestPointer,
    latestPointerPayload,
    history,
    historyPayload,
    manifest,
    manifestPayload,
    artifactPayloads: normalizeArtifactPayloads(record.artifactPayloads, manifest),
    verification: normalizeVerificationMeta(record.verification),
    freshness: normalizeFreshnessMeta(record.freshness),
  }
}

export function validateMemoryShadowStatus(input) {
  const record = asRecord(input)
  if (!record || record.version !== MEMORY_CHECKPOINT_SHADOW_VERSION) {
    throw new Error('Shadow status version must equal 1.')
  }
  if (record.authority !== MEMORY_CHECKPOINT_SHADOW_AUTHORITY) {
    throw new Error('Shadow status authority must be extension_primary.')
  }

  const mirroredGeneration = record.mirroredGeneration === null || record.mirroredGeneration === undefined
    ? null
    : asNonEmptyString(record.mirroredGeneration, 'mirroredGeneration')
  const mirroredCommittedAt = record.mirroredCommittedAt === null || record.mirroredCommittedAt === undefined
    ? null
    : asTimestamp(record.mirroredCommittedAt, 'mirroredCommittedAt')

  if (mirroredGeneration && mirroredCommittedAt === null) {
    throw new Error('mirroredCommittedAt is required when mirroredGeneration is present.')
  }
  if (mirroredCommittedAt !== null && !mirroredGeneration) {
    throw new Error('mirroredGeneration is required when mirroredCommittedAt is present.')
  }

  return {
    version: MEMORY_CHECKPOINT_SHADOW_VERSION,
    authority: MEMORY_CHECKPOINT_SHADOW_AUTHORITY,
    mirroredGeneration,
    mirroredCommittedAt,
    verification: normalizeVerificationMeta(record.verification),
    freshness: normalizeFreshnessMeta(record.freshness),
  }
}
