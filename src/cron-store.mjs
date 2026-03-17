/**
 * Cron task persistent storage for the companion daemon.
 *
 * Stores jobs and pending (missed) runs in ~/.trapezohe/cron-jobs.json.
 * The extension is the source of truth — companion stores a mirror
 * to enable missed-task detection when the browser is closed.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { getConfigDir, ensureConfigDir } from './config.mjs'
import { createFileBackedStore } from './file-backed-store.mjs'

const CRON_FILE = () => path.join(getConfigDir(), 'cron-jobs.json')
const CRON_BACKUP_FILE = () => path.join(getConfigDir(), 'cron-jobs.json.bak')
const FILE_MODE = 0o600

/** @typedef {{ pendingId: string, taskId: string, missedAt: number }} PendingCronRun */
/** @typedef {{ jobs: Array<Object>, pending: Array<PendingCronRun> }} CronStore */

/** @type {CronStore} */
let store = { jobs: [], pending: [] }

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizePendingRun(input) {
  const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : ''
  if (!taskId) return null

  const rawPendingId = typeof input?.pendingId === 'string' ? input.pendingId.trim() : ''
  const missedAt = Number(input?.missedAt)
  return {
    pendingId: rawPendingId || randomUUID(),
    taskId,
    missedAt: Number.isFinite(missedAt) && missedAt > 0 ? missedAt : Date.now(),
  }
}

function parseStoreSnapshot(raw) {
  const parsed = JSON.parse(raw)
  let migrated = false
  const pending = Array.isArray(parsed.pending)
    ? parsed.pending
      .map((entry) => {
        const normalized = normalizePendingRun(entry)
        if (!normalized) {
          migrated = true
          return null
        }
        if (
          normalized.pendingId !== entry?.pendingId
          || normalized.taskId !== entry?.taskId
          || normalized.missedAt !== entry?.missedAt
        ) {
          migrated = true
        }
        return normalized
      })
      .filter(Boolean)
    : []

  return {
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    pending,
    ...(migrated ? { __migrated: true } : {}),
  }
}

const storage = createFileBackedStore({
  label: 'cron-store',
  primaryPath: CRON_FILE,
  backupPath: CRON_BACKUP_FILE,
  fileMode: FILE_MODE,
  ensureDir: ensureConfigDir,
  fallbackState: () => ({ jobs: [], pending: [] }),
  parse: parseStoreSnapshot,
  serialize: (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`,
  logger: console,
  messages: {
    tmpCleanup: (err) => `Failed to clean orphan .tmp: ${err.message}`,
    primaryCorrupted: (err) => `Primary cron-jobs.json corrupted: ${err.message}`,
    backupRecovered: 'Recovered from backup cron-jobs.json.bak',
    backupUnavailable: (err) => `Backup also unavailable: ${err.message ?? 'unknown error'}`,
  },
})

export async function loadCronStore() {
  const loadedStore = await storage.load()
  store = loadedStore.state || { jobs: [], pending: [] }
  if (store.__migrated) {
    delete store.__migrated
    await saveStore()
  } else if (loadedStore.recoveredFromBackup) {
    await saveStore()
  }
  return clone(store)
}

async function saveStore() {
  const snapshot = clone(store)
  await storage.persistSnapshot(snapshot)
}

export function getJobs() {
  return store.jobs
}

export async function upsertJob(job) {
  if (!job || !job.id) return
  const idx = store.jobs.findIndex((j) => j.id === job.id)
  if (idx >= 0) {
    store.jobs[idx] = job
  } else {
    store.jobs.push(job)
  }
  await saveStore()
}

export async function removeJob(taskId) {
  const before = store.jobs.length
  store.jobs = store.jobs.filter((j) => j.id !== taskId)
  if (store.jobs.length !== before) {
    await saveStore()
    return true
  }
  return false
}

export function getPendingRuns() {
  return store.pending
}

export async function addPendingRun(taskId) {
  const pending = normalizePendingRun({
    pendingId: randomUUID(),
    taskId,
    missedAt: Date.now(),
  })
  if (!pending) {
    throw new Error('taskId is required')
  }
  store.pending.push(pending)
  await saveStore()
  return pending
}

function normalizeAckRequest(input) {
  if (Array.isArray(input)) {
    return {
      pendingIds: [],
      taskIds: input
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean),
    }
  }

  const pendingIds = Array.isArray(input?.pendingIds)
    ? input.pendingIds
    : (typeof input?.pendingId === 'string' ? [input.pendingId] : [])
  const taskIds = Array.isArray(input?.taskIds)
    ? input.taskIds
    : (typeof input?.taskId === 'string' ? [input.taskId] : [])

  return {
    pendingIds: pendingIds
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean),
    taskIds: taskIds
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean),
  }
}

export async function ackPendingRuns(input) {
  const { pendingIds, taskIds } = normalizeAckRequest(input)
  if (pendingIds.length === 0 && taskIds.length === 0) return 0

  const pendingIdSet = new Set(pendingIds)
  const taskIdSet = new Set(taskIds)
  let removed = 0
  store.pending = store.pending.filter((pending) => {
    const match = pendingIdSet.has(pending.pendingId) || taskIdSet.has(pending.taskId)
    if (match) removed += 1
    return !match
  })

  if (removed > 0) {
    await saveStore()
  }
  return removed
}

/**
 * Merge a partial watcher state patch into a job's watcher.state.
 * Used by the executor to persist escalation decisions (lastInvestigatedHash,
 * lastEscalationRunId, lastEscalationAt) back to the job store so subsequent
 * timer fires see updated state and skip duplicate escalation.
 *
 * @param {string} taskId
 * @param {object} statePatch
 * @returns {Promise<boolean>}
 */
export async function patchJobWatcherState(taskId, statePatch) {
  if (!taskId || !statePatch || typeof statePatch !== 'object') return false
  const idx = store.jobs.findIndex((j) => j.id === taskId)
  if (idx < 0) return false

  const job = store.jobs[idx]
  if (!job.watcher || typeof job.watcher !== 'object') job.watcher = {}
  if (!job.watcher.state || typeof job.watcher.state !== 'object') job.watcher.state = {}

  Object.assign(job.watcher.state, statePatch)
  await saveStore()
  return true
}

export async function clearCronStoreForTests() {
  await storage.flush()
  storage.reset()
  store = { jobs: [], pending: [] }
  await saveStore()
}
