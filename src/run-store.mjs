/**
 * Run store (Phase A control-plane)
 *
 * Persists recent run envelopes to ~/.trapezohe/runs.json so run state remains
 * recoverable across extension service-worker suspend and companion restarts.
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'

const FILE_MODE = 0o600
const MAX_RUNS = Math.max(1, Number(process.env.TRAPEZOHE_MAX_RUNS || 200) || 200)
const WRITE_DEBOUNCE_MS = Number(process.env.TRAPEZOHE_RUNS_WRITE_DEBOUNCE_MS || 300)

const RUN_TYPES = new Set(['exec', 'session', 'cron', 'heartbeat'])
const RUN_STATES = new Set(['queued', 'running', 'waiting_approval', 'retrying', 'done', 'failed'])

function RUNS_FILE() {
  return path.join(getConfigDir(), 'runs.json')
}

function RUNS_BACKUP_FILE() {
  return path.join(getConfigDir(), 'runs.json.bak')
}

/**
 * @typedef {{
 *   runId: string,
 *   type: 'exec'|'session'|'cron'|'heartbeat',
 *   state: 'queued'|'running'|'waiting_approval'|'retrying'|'done'|'failed',
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

/** @type {{ runs: RunEnvelope[] }} */
let store = { runs: [] }
let loaded = false
let persistTimer = null
let persistPromise = null

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

async function safeChmod(target, mode) {
  try {
    await fs.chmod(target, mode)
  } catch (err) {
    if (err.code === 'ENOSYS' || err.code === 'EPERM' || err.code === 'EINVAL') return
    throw err
  }
}

function trimText(text, maxChars = 500) {
  const normalized = String(text || '').trim()
  if (!normalized) return undefined
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(32, maxChars - 16)).trimEnd()}...[truncated]`
}

function normalizeType(value, fallback = 'exec') {
  const normalized = String(value || '').trim().toLowerCase()
  return RUN_TYPES.has(normalized) ? normalized : fallback
}

function normalizeState(value, fallback = 'queued') {
  const normalized = String(value || '').trim().toLowerCase()
  return RUN_STATES.has(normalized) ? normalized : fallback
}

function normalizeTimestamp(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return Math.max(0, Math.floor(n))
}

function normalizeDeliveryState(input) {
  if (!input || typeof input !== 'object') return undefined
  const attemptsRaw = Number(input.attempts)
  const attempts = Number.isFinite(attemptsRaw) ? Math.max(0, Math.floor(attemptsRaw)) : undefined
  const lastAttemptAt = normalizeTimestamp(input.lastAttemptAt)
  const channel = typeof input.channel === 'string' ? input.channel.trim() : ''
  if (!channel && attempts === undefined && lastAttemptAt === undefined) {
    return undefined
  }
  return {
    ...(channel ? { channel } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(lastAttemptAt !== undefined ? { lastAttemptAt } : {}),
  }
}

function normalizeRun(input) {
  if (!input || typeof input !== 'object') return null
  const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
  if (!runId) return null

  const createdAt = normalizeTimestamp(input.createdAt) || now()
  const updatedAt = normalizeTimestamp(input.updatedAt) || createdAt
  const startedAt = normalizeTimestamp(input.startedAt)
  const finishedAt = normalizeTimestamp(input.finishedAt)
  const stateFallback = finishedAt !== undefined
    ? (finishedAt && startedAt !== undefined ? 'done' : 'failed')
    : 'queued'

  return {
    runId,
    type: normalizeType(input.type, 'exec'),
    state: normalizeState(input.state, stateFallback),
    createdAt,
    updatedAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(trimText(input.summary, 500) ? { summary: trimText(input.summary, 500) } : {}),
    ...(trimText(input.error, 500) ? { error: trimText(input.error, 500) } : {}),
    ...(input.meta && typeof input.meta === 'object' ? { meta: clone(input.meta) } : {}),
    ...(normalizeDeliveryState(input.deliveryState) ? { deliveryState: normalizeDeliveryState(input.deliveryState) } : {}),
  }
}

async function readStoreFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw)
  const runs = Array.isArray(parsed.runs) ? parsed.runs.map(normalizeRun).filter(Boolean) : []
  return { runs }
}

function trimStoreRuns() {
  if (store.runs.length <= MAX_RUNS) return
  store.runs = store.runs.slice(store.runs.length - MAX_RUNS)
}

async function writeStoreNow() {
  await ensureConfigDir()
  trimStoreRuns()
  const payload = JSON.stringify({ runs: store.runs }, null, 2) + '\n'
  const target = RUNS_FILE()
  const backup = RUNS_BACKUP_FILE()
  const tmp = `${target}.tmp`

  await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: FILE_MODE })
  await safeChmod(tmp, FILE_MODE)

  try {
    await fs.copyFile(target, backup)
    await safeChmod(backup, FILE_MODE)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  await fs.rename(tmp, target)
  await safeChmod(target, FILE_MODE)
}

function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistPromise = writeStoreNow().finally(() => {
      persistPromise = null
    })
  }, Math.max(50, WRITE_DEBOUNCE_MS))
  if (persistTimer.unref) persistTimer.unref()
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

async function cleanOrphanTmp() {
  try {
    await fs.unlink(`${RUNS_FILE()}.tmp`)
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[run-store] Failed to clean orphan .tmp: ${err.message}`)
  }
}

export async function loadRunStore() {
  await ensureConfigDir()
  await cleanOrphanTmp()
  try {
    store = await readStoreFile(RUNS_FILE())
  } catch (err) {
    if (err.code === 'ENOENT') {
      store = { runs: [] }
    } else {
      console.warn(`[run-store] Primary runs.json corrupted: ${err.message}`)
      try {
        store = await readStoreFile(RUNS_BACKUP_FILE())
        console.warn('[run-store] Recovered from backup runs.json.bak')
      } catch (backupErr) {
        console.warn(`[run-store] Backup also unavailable: ${backupErr.message ?? 'unknown error'}`)
        store = { runs: [] }
      }
    }
  }
  trimStoreRuns()
  loaded = true
  return clone(store)
}

export async function flushRunStore() {
  await ensureLoaded()
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
    await writeStoreNow()
  }
  if (persistPromise) {
    await persistPromise
  }
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
  store = { runs: [] }
  loaded = true
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  persistPromise = null
  await flushRunStore()
}
