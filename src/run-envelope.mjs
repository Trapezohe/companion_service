export const LEGACY_RUN_CONTRACT_VERSION = 1
export const RUN_CONTRACT_VERSION = 2

export const RUN_TYPES = new Set(['exec', 'session', 'cron', 'heartbeat', 'acp', 'approval'])
export const RUN_STATES = new Set(['queued', 'idle', 'running', 'waiting_approval', 'retrying', 'done', 'failed', 'cancelled'])
export const RUN_SOURCES = new Set(['chat', 'cron', 'heartbeat', 'remote', 'replay'])

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeOptionalId(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function normalizeOptionalText(value, maxChars = 500) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(32, maxChars - 16)).trimEnd()}...[truncated]`
}

export function normalizeTimestamp(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  return Math.max(0, Math.floor(numeric))
}

export function normalizeType(value, fallback = 'exec') {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  return RUN_TYPES.has(normalized) ? normalized : fallback
}

export function normalizeState(value, fallback = 'queued') {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  return RUN_STATES.has(normalized) ? normalized : fallback
}

export function normalizeRunSource(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return RUN_SOURCES.has(normalized) ? normalized : undefined
}

function normalizeContractVersion(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  return numeric >= RUN_CONTRACT_VERSION
    ? RUN_CONTRACT_VERSION
    : numeric >= LEGACY_RUN_CONTRACT_VERSION
      ? LEGACY_RUN_CONTRACT_VERSION
      : undefined
}

export function normalizeDeliveryState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const channel = normalizeOptionalId(input.channel)
  const attemptsRaw = Number(input.attempts)
  const attempts = Number.isFinite(attemptsRaw) ? Math.max(0, Math.floor(attemptsRaw)) : undefined
  const lastAttemptAt = normalizeTimestamp(input.lastAttemptAt)
  if (!channel && attempts === undefined && lastAttemptAt === undefined) {
    return undefined
  }
  return {
    ...(channel ? { channel } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(lastAttemptAt !== undefined ? { lastAttemptAt } : {}),
  }
}

function normalizeRunMeta(input, sessionId) {
  const base = input && typeof input === 'object' && !Array.isArray(input)
    ? cloneJson(input)
    : {}
  if (sessionId && typeof base.sessionId !== 'string') {
    base.sessionId = sessionId
  }
  return Object.keys(base).length > 0 ? base : undefined
}

function hasExplicitV2Fields(input) {
  return Boolean(
    normalizeOptionalId(input.sessionId)
    || normalizeOptionalId(input.attemptId)
    || normalizeOptionalId(input.laneId)
    || normalizeRunSource(input.source)
    || normalizeOptionalId(input.parentRunId)
    || normalizeContractVersion(input.contractVersion) === RUN_CONTRACT_VERSION,
  )
}

export function createRunAttemptId(runId) {
  return `${runId}:attempt-1`
}

export function resolveRunContractVersion(input) {
  return normalizeContractVersion(input?.runContractVersion) ?? LEGACY_RUN_CONTRACT_VERSION
}

export function normalizeRun(input) {
  if (!input || typeof input !== 'object') return null
  const runId = normalizeOptionalId(input.runId)
  if (!runId) return null

  const createdAt = normalizeTimestamp(input.createdAt) ?? Date.now()
  const updatedAt = normalizeTimestamp(input.updatedAt) ?? createdAt
  const startedAt = normalizeTimestamp(input.startedAt)
  const finishedAt = normalizeTimestamp(input.finishedAt)
  const sessionId = normalizeOptionalId(input.sessionId)
    || normalizeOptionalId(input.meta?.sessionId)
  const explicitContractVersion = normalizeContractVersion(input.contractVersion)
  const contractVersion = explicitContractVersion
    || (hasExplicitV2Fields(input) ? RUN_CONTRACT_VERSION : LEGACY_RUN_CONTRACT_VERSION)
  const attemptId = normalizeOptionalId(input.attemptId)
    || (contractVersion === RUN_CONTRACT_VERSION ? createRunAttemptId(runId) : undefined)
  const laneId = normalizeOptionalId(input.laneId)
  const source = normalizeRunSource(input.source)
  const parentRunId = normalizeOptionalId(input.parentRunId)
  const stateFallback = finishedAt !== undefined
    ? (finishedAt && startedAt !== undefined ? 'done' : 'failed')
    : 'queued'
  const meta = normalizeRunMeta(input.meta, sessionId)
  const deliveryState = normalizeDeliveryState(input.deliveryState)
  const summary = normalizeOptionalText(input.summary, 500)
  const error = normalizeOptionalText(input.error, 500)

  return {
    runId,
    type: normalizeType(input.type, 'exec'),
    state: normalizeState(input.state, stateFallback),
    createdAt,
    updatedAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
    ...(meta ? { meta } : {}),
    ...(deliveryState ? { deliveryState } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(laneId ? { laneId } : {}),
    ...(source ? { source } : {}),
    ...(parentRunId ? { parentRunId } : {}),
    contractVersion,
  }
}
