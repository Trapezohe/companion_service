/**
 * Cron task persistent storage for the companion daemon.
 *
 * Stores jobs and pending (missed) runs in ~/.trapezohe/cron-jobs.json.
 * The extension is the source of truth — companion stores a mirror
 * to enable missed-task detection when the browser is closed.
 */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { getConfigDir, ensureConfigDir } from './config.mjs'

const CRON_FILE = () => path.join(getConfigDir(), 'cron-jobs.json')
const CRON_BACKUP_FILE = () => path.join(getConfigDir(), 'cron-jobs.json.bak')
const FILE_MODE = 0o600

async function safeChmod(target, mode) {
  try {
    await fs.chmod(target, mode)
  } catch (err) {
    if (err.code === 'ENOSYS' || err.code === 'EPERM' || err.code === 'EINVAL') return
    throw err
  }
}

/** @typedef {{ pendingId: string, taskId: string, missedAt: number }} PendingCronRun */
/** @typedef {{ jobs: Array<Object>, pending: Array<PendingCronRun> }} CronStore */

/** @type {CronStore} */
let store = { jobs: [], pending: [] }
let persistPromise = null

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

export async function loadCronStore() {
  await ensureConfigDir()
  try {
    await fs.unlink(`${CRON_FILE()}.tmp`)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[cron-store] Failed to clean orphan .tmp: ${err.message}`)
    }
  }

  try {
    store = await readStoreFile(CRON_FILE())
    if (store.__migrated) {
      delete store.__migrated
      await saveStore()
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      store = { jobs: [], pending: [] }
    } else {
      console.warn(`[cron-store] Primary cron-jobs.json corrupted: ${err.message}`)
      try {
        store = await readStoreFile(CRON_BACKUP_FILE())
        if (store.__migrated) {
          delete store.__migrated
        }
        console.warn('[cron-store] Recovered from backup cron-jobs.json.bak')
        await saveStore()
      } catch (backupErr) {
        console.warn(`[cron-store] Backup also unavailable: ${backupErr.message ?? 'unknown error'}`)
        store = { jobs: [], pending: [] }
      }
    }
  }
  return clone(store)
}

async function readStoreFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
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

async function writeStoreSnapshot(snapshot) {
  await ensureConfigDir()
  const json = JSON.stringify(snapshot, null, 2) + '\n'
  const target = CRON_FILE()
  const backup = CRON_BACKUP_FILE()
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, json, { encoding: 'utf8', mode: FILE_MODE })
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

async function saveStore() {
  const snapshot = clone(store)
  const nextWrite = async () => writeStoreSnapshot(snapshot)
  persistPromise = (persistPromise || Promise.resolve())
    .catch(() => undefined)
    .then(nextWrite)
  await persistPromise
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

export async function clearCronStoreForTests() {
  store = { jobs: [], pending: [] }
  await saveStore()
}
