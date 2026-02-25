/**
 * Cron task persistent storage for the companion daemon.
 *
 * Stores jobs and pending (missed) runs in ~/.trapezohe/cron-jobs.json.
 * The extension is the source of truth — companion stores a mirror
 * to enable missed-task detection when the browser is closed.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getConfigDir, ensureConfigDir } from './config.mjs'

const CRON_FILE = () => path.join(getConfigDir(), 'cron-jobs.json')
const FILE_MODE = 0o600

async function safeChmod(target, mode) {
  try {
    await fs.chmod(target, mode)
  } catch (err) {
    if (err.code === 'ENOSYS' || err.code === 'EPERM' || err.code === 'EINVAL') return
    throw err
  }
}

/** @typedef {{ jobs: Array<Object>, pending: Array<{ taskId: string, missedAt: number }> }} CronStore */

/** @type {CronStore} */
let store = { jobs: [], pending: [] }

export async function loadCronStore() {
  await ensureConfigDir()
  try {
    const raw = await fs.readFile(CRON_FILE(), 'utf8')
    const parsed = JSON.parse(raw)
    store = {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      store = { jobs: [], pending: [] }
    } else {
      throw err
    }
  }
  return store
}

async function saveStore() {
  await ensureConfigDir()
  const json = JSON.stringify(store, null, 2) + '\n'
  await fs.writeFile(CRON_FILE(), json, { encoding: 'utf8', mode: FILE_MODE })
  await safeChmod(CRON_FILE(), FILE_MODE)
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
  store.pending.push({ taskId, missedAt: Date.now() })
  await saveStore()
}

export async function ackPendingRuns(taskIds) {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return
  const idSet = new Set(taskIds)
  store.pending = store.pending.filter((p) => !idSet.has(p.taskId))
  await saveStore()
}
