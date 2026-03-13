import { promises as fs } from 'node:fs'
import path from 'node:path'

import { ensureConfigDir, getConfigDir } from './config.mjs'
import {
  validateMemoryShadowContract,
  validateMemoryShadowStatus,
} from './memory-shadow-contract.mjs'

const FILE_MODE = 0o600
const WRITE_DEBOUNCE_MS = 150

function MEMORY_SHADOW_FILE() {
  return path.join(getConfigDir(), 'memory-shadow.json')
}

function MEMORY_SHADOW_BACKUP_FILE() {
  return path.join(getConfigDir(), 'memory-shadow.json.bak')
}

/** @type {{ envelope: ReturnType<typeof validateMemoryShadowContract> | null, shadowedAt: number | null }} */
let store = {
  envelope: null,
  shadowedAt: null,
}
let loaded = false
let loadingPromise = null
let persistTimer = null
let persistPromise = null

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeTimestamp(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Math.floor(numeric)
}

async function safeChmod(target, mode) {
  try {
    await fs.chmod(target, mode)
  } catch (err) {
    if (err.code === 'ENOSYS' || err.code === 'EPERM' || err.code === 'EINVAL') return
    throw err
  }
}

function buildEmptyStatus() {
  return validateMemoryShadowStatus({
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
}

function buildStatusFromStore() {
  if (!store.envelope) return buildEmptyStatus()
  return validateMemoryShadowStatus({
    version: 1,
    authority: 'extension_primary',
    mirroredGeneration: store.envelope.generation,
    mirroredCommittedAt: store.envelope.committedAt,
    verification: store.envelope.verification,
    freshness: {
      state: store.shadowedAt ? 'fresh' : store.envelope.freshness?.state || 'unknown',
      shadowedAt: store.shadowedAt ?? store.envelope.freshness?.shadowedAt ?? null,
    },
  })
}

function normalizePersistedStore(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      envelope: null,
      shadowedAt: null,
    }
  }

  const envelope = input.envelope === null || input.envelope === undefined
    ? null
    : validateMemoryShadowContract(input.envelope)
  const shadowedAt = normalizeTimestamp(input.shadowedAt)

  return {
    envelope,
    shadowedAt,
  }
}

async function readStoreFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  return normalizePersistedStore(JSON.parse(raw))
}

async function cleanOrphanTmp() {
  try {
    await fs.unlink(`${MEMORY_SHADOW_FILE()}.tmp`)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[memory-shadow-store] Failed to clean orphan .tmp: ${err.message}`)
    }
  }
}

async function writeStoreNow() {
  await ensureConfigDir()
  const payload = JSON.stringify({
    envelope: store.envelope,
    shadowedAt: store.shadowedAt,
  }, null, 2) + '\n'
  const target = MEMORY_SHADOW_FILE()
  const backup = MEMORY_SHADOW_BACKUP_FILE()
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
  }, WRITE_DEBOUNCE_MS)
  if (persistTimer.unref) persistTimer.unref()
}

async function ensureLoaded() {
  if (loaded) return
  if (loadingPromise) return loadingPromise
  loadingPromise = loadMemoryShadowStore().finally(() => {
    loadingPromise = null
  })
  return loadingPromise
}

export async function loadMemoryShadowStore() {
  await ensureConfigDir()
  await cleanOrphanTmp()
  try {
    store = await readStoreFile(MEMORY_SHADOW_FILE())
  } catch (err) {
    if (err.code === 'ENOENT') {
      store = { envelope: null, shadowedAt: null }
    } else {
      console.warn(`[memory-shadow-store] Primary memory-shadow.json corrupted: ${err.message}`)
      try {
        store = await readStoreFile(MEMORY_SHADOW_BACKUP_FILE())
        console.warn('[memory-shadow-store] Recovered from backup memory-shadow.json.bak')
      } catch (backupErr) {
        if (backupErr.code !== 'ENOENT') {
          console.warn(`[memory-shadow-store] Backup also unavailable: ${backupErr.message ?? 'unknown error'}`)
        }
        store = { envelope: null, shadowedAt: null }
      }
    }
  }
  loaded = true
}

export async function flushMemoryShadowStore() {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
    persistPromise = writeStoreNow().finally(() => {
      persistPromise = null
    })
  }
  if (persistPromise) {
    await persistPromise
  }
}

export async function ingestMemoryShadowEnvelope(input, options = {}) {
  await ensureLoaded()
  const envelope = validateMemoryShadowContract(input)
  store.envelope = envelope
  store.shadowedAt = normalizeTimestamp(options.shadowedAt) || Date.now()
  schedulePersist()
  return {
    envelope: clone(store.envelope),
    status: buildStatusFromStore(),
  }
}

export async function getMemoryShadowEnvelope() {
  await ensureLoaded()
  return store.envelope ? clone(store.envelope) : null
}

export async function getMemoryShadowStatus() {
  await ensureLoaded()
  return buildStatusFromStore()
}

export async function clearMemoryShadowStoreForTests() {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  persistPromise = null
  store = {
    envelope: null,
    shadowedAt: null,
  }
  loaded = true
  await ensureConfigDir().catch(() => undefined)
  await Promise.all([
    fs.rm(MEMORY_SHADOW_FILE(), { force: true }).catch(() => undefined),
    fs.rm(MEMORY_SHADOW_BACKUP_FILE(), { force: true }).catch(() => undefined),
    fs.rm(`${MEMORY_SHADOW_FILE()}.tmp`, { force: true }).catch(() => undefined),
  ])
}
