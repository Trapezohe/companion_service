/**
 * Run store (Phase A control-plane)
 *
 * Persists recent run envelopes to ~/.trapezohe/runs.json so run state remains
 * recoverable across extension service-worker suspend and companion restarts.
 */

import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'
import { createFileBackedStore } from './file-backed-store.mjs'
import {
  RUN_CONTRACT_VERSION,
  normalizeRun,
  normalizeState,
  normalizeTimestamp,
  normalizeType,
} from './run-envelope.mjs'

const FILE_MODE = 0o600
const MAX_RUNS = Math.max(1, Number(process.env.TRAPEZOHE_MAX_RUNS || 200) || 200)
const WRITE_DEBOUNCE_MS = Number(process.env.TRAPEZOHE_RUNS_WRITE_DEBOUNCE_MS || 300)

function RUNS_FILE() {
  return path.join(getConfigDir(), 'runs.json')
}

function RUNS_BACKUP_FILE() {
  return path.join(getConfigDir(), 'runs.json.bak')
}

/**
 * @typedef {{
 *   runId: string,
 *   type: 'exec'|'session'|'cron'|'heartbeat'|'acp'|'approval',
 *   state: 'queued'|'idle'|'running'|'waiting_approval'|'retrying'|'done'|'failed'|'cancelled',
 *   createdAt: number,
 *   updatedAt: number,
 *   startedAt?: number,
 *   finishedAt?: number,
 *   summary?: string,
 *   error?: string,
 *   meta?: Record<string, unknown>,
 *   deliveryState?: { channel?: string, attempts?: number, lastAttemptAt?: number }
 * }} RunEnvelope
 */

/**
 * @typedef {{
 *   runId: string,
 *   type?: string,
 *   conversationId?: string,
 *   sourceToolName?: string,
 *   sourceToolCallId?: string,
 *   approvalRequestId?: string,
 *   sessionId?: string,
 *   updatedAt?: number
 * }} BrowserRunLink
 */

/** @type {{ runs: RunEnvelope[], sessionLinks: Record<string, BrowserRunLink>, actionLinks: Record<string, BrowserRunLink> }} */
let store = { runs: [], sessionLinks: {}, actionLinks: {} }
let loaded = false

function now() {
  return Date.now()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function normalizeBrowserRunLink(input, fallback = {}) {
  if (!input || typeof input !== 'object') return null
  const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
  if (!runId) return null
  return {
    runId,
    ...(typeof input.type === 'string' && input.type.trim() ? { type: input.type.trim() } : {}),
    ...(typeof input.conversationId === 'string' && input.conversationId.trim()
      ? { conversationId: input.conversationId.trim() }
      : typeof fallback.conversationId === 'string' && fallback.conversationId.trim()
        ? { conversationId: fallback.conversationId.trim() }
        : {}),
    ...(typeof input.sourceToolName === 'string' && input.sourceToolName.trim()
      ? { sourceToolName: input.sourceToolName.trim() }
      : typeof fallback.sourceToolName === 'string' && fallback.sourceToolName.trim()
        ? { sourceToolName: fallback.sourceToolName.trim() }
        : {}),
    ...(typeof input.sourceToolCallId === 'string' && input.sourceToolCallId.trim()
      ? { sourceToolCallId: input.sourceToolCallId.trim() }
      : typeof fallback.sourceToolCallId === 'string' && fallback.sourceToolCallId.trim()
        ? { sourceToolCallId: fallback.sourceToolCallId.trim() }
        : {}),
    ...(typeof input.approvalRequestId === 'string' && input.approvalRequestId.trim()
      ? { approvalRequestId: input.approvalRequestId.trim() }
      : typeof fallback.approvalRequestId === 'string' && fallback.approvalRequestId.trim()
        ? { approvalRequestId: fallback.approvalRequestId.trim() }
        : {}),
    ...(normalizeTimestamp(input.updatedAt) !== undefined
      ? { updatedAt: normalizeTimestamp(input.updatedAt) }
      : normalizeTimestamp(fallback.updatedAt) !== undefined
        ? { updatedAt: normalizeTimestamp(fallback.updatedAt) }
        : {}),
  }
}

function normalizeStoreSnapshot(input) {
  const parsed = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const runs = Array.isArray(parsed.runs) ? parsed.runs.map(normalizeRun).filter(Boolean) : []
  const sessionLinks = parsed.sessionLinks && typeof parsed.sessionLinks === 'object' && !Array.isArray(parsed.sessionLinks)
    ? Object.fromEntries(
        Object.entries(parsed.sessionLinks)
          .filter(([sessionId, value]) =>
            typeof sessionId === 'string'
            && sessionId.trim()
            && value
            && typeof value === 'object'
            && typeof value.runId === 'string'
            && value.runId.trim(),
          )
          .map(([sessionId, value]) => [sessionId.trim(), normalizeBrowserRunLink(value)])
          .filter((entry) => Boolean(entry[1])),
      )
    : {}
  const actionLinks = parsed.actionLinks && typeof parsed.actionLinks === 'object' && !Array.isArray(parsed.actionLinks)
    ? Object.fromEntries(
        Object.entries(parsed.actionLinks)
          .filter(([actionId, value]) =>
            typeof actionId === 'string'
            && actionId.trim()
            && value
            && typeof value === 'object'
            && typeof value.runId === 'string'
            && value.runId.trim(),
          )
          .map(([actionId, value]) => [actionId.trim(), normalizeBrowserRunLink(value)])
          .filter((entry) => Boolean(entry[1])),
      )
    : {}
  return { runs, sessionLinks, actionLinks }
}

const storage = createFileBackedStore({
  label: 'run-store',
  primaryPath: RUNS_FILE,
  backupPath: RUNS_BACKUP_FILE,
  debounceMs: Math.max(50, WRITE_DEBOUNCE_MS),
  fileMode: FILE_MODE,
  ensureDir: ensureConfigDir,
  fallbackState: () => ({ runs: [], sessionLinks: {}, actionLinks: {} }),
  parse: (raw) => normalizeStoreSnapshot(JSON.parse(raw)),
  serialize: (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`,
  logger: console,
  messages: {
    tmpCleanup: (err) => `Failed to clean orphan .tmp: ${err.message}`,
    primaryCorrupted: (err) => `Primary runs.json corrupted: ${err.message}`,
    backupRecovered: 'Recovered from backup runs.json.bak',
    backupUnavailable: (err) => `Backup also unavailable: ${err.message ?? 'unknown error'}`,
  },
})

function trimStoreRuns() {
  if (store.runs.length <= MAX_RUNS) return
  store.runs = store.runs.slice(store.runs.length - MAX_RUNS)
}

function buildPersistableSnapshot() {
  trimStoreRuns()
  return {
    runs: store.runs,
    sessionLinks: store.sessionLinks,
    actionLinks: store.actionLinks,
  }
}

function schedulePersist() {
  storage.schedulePersist(buildPersistableSnapshot)
}

let loadingPromise = null

async function ensureLoaded() {
  if (loaded) return
  if (loadingPromise) return loadingPromise
  loadingPromise = loadRunStore().finally(() => {
    loadingPromise = null
  })
  return loadingPromise
}

export async function loadRunStore() {
  const loadedStore = await storage.load()
  store = loadedStore.state || { runs: [], sessionLinks: {}, actionLinks: {} }
  trimStoreRuns()
  if (!store.sessionLinks || typeof store.sessionLinks !== 'object') {
    store.sessionLinks = {}
  }
  if (!store.actionLinks || typeof store.actionLinks !== 'object') {
    store.actionLinks = {}
  }
  loaded = true
  return clone(store)
}

export async function flushRunStore() {
  await ensureLoaded()
  await storage.flush()
}

export async function createRun(input) {
  await ensureLoaded()
  const createdAt = now()
  const normalized = normalizeRun({
    runId: input?.runId || randomBytes(16).toString('hex'),
    type: input?.type || 'exec',
    state: input?.state || 'queued',
    createdAt,
    updatedAt: createdAt,
    startedAt: input?.startedAt,
    finishedAt: input?.finishedAt,
    sessionId: input?.sessionId,
    attemptId: input?.attemptId,
    laneId: input?.laneId,
    source: input?.source,
    parentRunId: input?.parentRunId,
    contractVersion: input?.contractVersion ?? RUN_CONTRACT_VERSION,
    summary: input?.summary,
    error: input?.error,
    meta: input?.meta,
    deliveryState: input?.deliveryState,
  })
  if (!normalized) {
    throw new Error('Failed to create run: invalid input.')
  }
  store.runs.push(normalized)
  trimStoreRuns()
  schedulePersist()
  return clone(normalized)
}

export async function updateRun(runId, patch = {}) {
  await ensureLoaded()
  const normalizedId = typeof runId === 'string' ? runId.trim() : ''
  if (!normalizedId) return null

  const index = store.runs.findIndex((run) => run.runId === normalizedId)
  if (index < 0) return null

  const current = store.runs[index]
  const updatedAt = now()
  const next = normalizeRun({
    ...current,
    ...patch,
    runId: current.runId,
    createdAt: current.createdAt,
    updatedAt,
  })
  if (!next) return null

  const final = { ...next }
  if (
    (final.state === 'done' || final.state === 'failed')
    && final.finishedAt === undefined
  ) {
    final.finishedAt = updatedAt
  }
  if (
    (final.state === 'running' || final.state === 'retrying')
    && final.startedAt === undefined
  ) {
    final.startedAt = updatedAt
  }

  store.runs[index] = final
  schedulePersist()
  return clone(final)
}

function withComputedDuration(run) {
  const startedAt = normalizeTimestamp(run.startedAt)
  const finishedAt = normalizeTimestamp(run.finishedAt)
  const durationMs = startedAt !== undefined && finishedAt !== undefined
    ? Math.max(0, finishedAt - startedAt)
    : null
  return { ...run, durationMs }
}

function sortByMostRecent(a, b) {
  const aTime = a.finishedAt || a.updatedAt || a.createdAt
  const bTime = b.finishedAt || b.updatedAt || b.createdAt
  return bTime - aTime
}

export async function listRuns(options = {}) {
  await ensureLoaded()
  const type = options.type ? normalizeType(options.type, '') : ''
  const state = options.state ? normalizeState(options.state, '') : ''
  const limit = clampInt(options.limit, 50, 1, 500)
  const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER)

  const filtered = store.runs
    .filter((run) => (!type || run.type === type) && (!state || run.state === state))
    .slice()
    .sort(sortByMostRecent)
    .map(withComputedDuration)

  const paged = filtered.slice(offset, offset + limit)
  return {
    runs: clone(paged),
    total: filtered.length,
    offset,
    limit,
    hasMore: offset + paged.length < filtered.length,
  }
}

export async function getRunById(runId) {
  await ensureLoaded()
  const normalizedId = typeof runId === 'string' ? runId.trim() : ''
  if (!normalizedId) return null
  const found = store.runs.find((run) => run.runId === normalizedId)
  if (!found) return null
  return clone(withComputedDuration(found))
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  const index = Math.max(0, Math.min(sorted.length - 1, rank))
  return sorted[index]
}

function summarizeByType(runs) {
  /** @type {Record<string, { total: number, done: number, failed: number, active: number }> } */
  const out = {}
  for (const run of runs) {
    if (!out[run.type]) {
      out[run.type] = { total: 0, done: 0, failed: 0, active: 0 }
    }
    out[run.type].total += 1
    if (run.state === 'done') out[run.type].done += 1
    else if (run.state === 'failed') out[run.type].failed += 1
    else out[run.type].active += 1
  }
  return out
}

function summarizeTimeWindow(runs, windowMs) {
  const cutoff = now() - windowMs
  const inWindow = runs.filter((r) => (r.finishedAt || r.updatedAt || r.createdAt) >= cutoff)
  const completed = inWindow.filter((r) => r.state === 'done' || r.state === 'failed')
  const failed = inWindow.filter((r) => r.state === 'failed')
  const durations = inWindow
    .filter((r) => r.durationMs !== null && (r.state === 'done' || r.state === 'failed'))
    .map((r) => r.durationMs)
  return {
    total: inWindow.length,
    completed: completed.length,
    failed: failed.length,
    completionRate: completed.length > 0
      ? Number(((completed.length - failed.length) / completed.length).toFixed(4))
      : null,
    avgDurationMs: durations.length > 0
      ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length)
      : null,
  }
}

export async function getRunDiagnostics(options = {}) {
  await ensureLoaded()
  const limit = clampInt(options.limit, 100, 1, 500)
  const recentDetailCount = clampInt(options.recentDetailCount, 10, 0, 50)

  const sorted = store.runs
    .slice()
    .sort(sortByMostRecent)
    .slice(0, limit)
    .map(withComputedDuration)

  const durations = sorted
    .filter((run) => run.durationMs !== null && (run.state === 'done' || run.state === 'failed'))
    .map((run) => run.durationMs)
  const completed = sorted.filter((run) => run.state === 'done' || run.state === 'failed')
  const failed = sorted.filter((run) => run.state === 'failed')

  // Tiered output: recent detail + history summary
  const recentDetail = sorted.slice(0, recentDetailCount)
  const historySummary = sorted.length > recentDetailCount
    ? sorted.slice(recentDetailCount).map((r) => ({
        runId: r.runId,
        type: r.type,
        state: r.state,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
        error: r.error ? r.error.slice(0, 80) : undefined,
      }))
    : []

  return {
    ok: true,
    sampled: sorted.length,
    totalRuns: store.runs.length,
    completionRate: completed.length > 0
      ? Number(((completed.length - failed.length) / completed.length).toFixed(4))
      : null,
    avgDurationMs: durations.length > 0
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : null,
    p95DurationMs: percentile(durations, 95),
    byType: summarizeByType(sorted),
    windows: {
      '1h': summarizeTimeWindow(sorted, 3_600_000),
      '6h': summarizeTimeWindow(sorted, 21_600_000),
      '24h': summarizeTimeWindow(sorted, 86_400_000),
    },
    recent: clone(recentDetail),
    historySummary: clone(historySummary),
    generatedAt: now(),
  }
}

export async function clearRunStoreForTests() {
  await storage.flush()
  store = { runs: [], sessionLinks: {}, actionLinks: {} }
  loaded = true
  loadingPromise = null
  storage.reset()
  await storage.replaceSnapshot(buildPersistableSnapshot())
}

export async function setSessionRunLink(sessionId, runId, meta = {}) {
  await ensureLoaded()
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : ''
  if (!normalizedSessionId || !normalizedRunId) return null
  store.sessionLinks[normalizedSessionId] = {
    runId: normalizedRunId,
    ...(typeof meta.type === 'string' && meta.type.trim() ? { type: meta.type.trim() } : {}),
    ...(typeof meta.conversationId === 'string' && meta.conversationId.trim()
      ? { conversationId: meta.conversationId.trim() }
      : {}),
    ...(typeof meta.sourceToolName === 'string' && meta.sourceToolName.trim()
      ? { sourceToolName: meta.sourceToolName.trim() }
      : {}),
    ...(typeof meta.sourceToolCallId === 'string' && meta.sourceToolCallId.trim()
      ? { sourceToolCallId: meta.sourceToolCallId.trim() }
      : {}),
    ...(typeof meta.approvalRequestId === 'string' && meta.approvalRequestId.trim()
      ? { approvalRequestId: meta.approvalRequestId.trim() }
      : {}),
    updatedAt: now(),
  }
  schedulePersist()
  return clone(store.sessionLinks[normalizedSessionId])
}

export async function getSessionRunLink(sessionId) {
  await ensureLoaded()
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalizedSessionId) return null
  const link = store.sessionLinks[normalizedSessionId]
  return link ? clone(link) : null
}

export async function listSessionRunLinks() {
  await ensureLoaded()
  return clone(store.sessionLinks)
}

export async function clearSessionRunLink(sessionId) {
  await ensureLoaded()
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalizedSessionId) return false
  if (!Object.prototype.hasOwnProperty.call(store.sessionLinks, normalizedSessionId)) return false
  delete store.sessionLinks[normalizedSessionId]
  schedulePersist()
  return true
}

export async function linkRunToBrowserSession(sessionId, input = {}) {
  const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
  if (!runId) return null
  return setSessionRunLink(sessionId, runId, {
    ...(typeof input.type === 'string' ? { type: input.type } : {}),
    ...(typeof input.conversationId === 'string' ? { conversationId: input.conversationId } : {}),
    ...(typeof input.sourceToolName === 'string' ? { sourceToolName: input.sourceToolName } : {}),
    ...(typeof input.sourceToolCallId === 'string' ? { sourceToolCallId: input.sourceToolCallId } : {}),
    ...(typeof input.approvalRequestId === 'string' ? { approvalRequestId: input.approvalRequestId } : {}),
  })
}

export async function getBrowserSessionLink(sessionId) {
  return getSessionRunLink(sessionId)
}

export async function linkRunToBrowserAction(actionId, input = {}) {
  await ensureLoaded()
  const normalizedActionId = typeof actionId === 'string' ? actionId.trim() : ''
  const normalizedRunId = typeof input.runId === 'string' ? input.runId.trim() : ''
  if (!normalizedActionId || !normalizedRunId) return null
  store.actionLinks[normalizedActionId] = normalizeBrowserRunLink({
    runId: normalizedRunId,
    ...(typeof input.type === 'string' ? { type: input.type } : {}),
    ...(typeof input.conversationId === 'string' ? { conversationId: input.conversationId } : {}),
    ...(typeof input.sourceToolName === 'string' ? { sourceToolName: input.sourceToolName } : {}),
    ...(typeof input.sourceToolCallId === 'string' ? { sourceToolCallId: input.sourceToolCallId } : {}),
    ...(typeof input.approvalRequestId === 'string' ? { approvalRequestId: input.approvalRequestId } : {}),
    ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}),
    updatedAt: now(),
  })
  schedulePersist()
  return clone(store.actionLinks[normalizedActionId])
}

export async function getBrowserActionLink(actionId) {
  await ensureLoaded()
  const normalizedActionId = typeof actionId === 'string' ? actionId.trim() : ''
  if (!normalizedActionId) return null
  const link = store.actionLinks[normalizedActionId]
  return link ? clone(link) : null
}
