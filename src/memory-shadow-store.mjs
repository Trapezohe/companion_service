import { promises as fs } from 'node:fs'
import path from 'node:path'

import { ensureConfigDir, getConfigDir } from './config.mjs'
import { createFileBackedStore } from './file-backed-store.mjs'
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

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeTimestamp(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Math.floor(numeric)
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

const storage = createFileBackedStore({
  label: 'memory-shadow-store',
  primaryPath: MEMORY_SHADOW_FILE,
  backupPath: MEMORY_SHADOW_BACKUP_FILE,
  debounceMs: WRITE_DEBOUNCE_MS,
  fileMode: FILE_MODE,
  ensureDir: ensureConfigDir,
  fallbackState: () => ({ envelope: null, shadowedAt: null }),
  parse: (raw) => normalizePersistedStore(JSON.parse(raw)),
  serialize: (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`,
  logger: console,
  messages: {
    tmpCleanup: (err) => `Failed to clean orphan .tmp: ${err.message}`,
    primaryCorrupted: (err) => `Primary memory-shadow.json corrupted: ${err.message}`,
    backupRecovered: 'Recovered from backup memory-shadow.json.bak',
    backupUnavailable: (err) => `Backup also unavailable: ${err.message ?? 'unknown error'}`,
  },
})

function buildPersistableSnapshot() {
  return {
    envelope: store.envelope,
    shadowedAt: store.shadowedAt,
  }
}

function schedulePersist() {
  storage.schedulePersist(buildPersistableSnapshot)
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
  const loadedStore = await storage.load()
  store = loadedStore.state || { envelope: null, shadowedAt: null }
  loaded = true
}

export async function flushMemoryShadowStore() {
  await storage.flush()
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
  await storage.flush()
  storage.reset()
  store = {
    envelope: null,
    shadowedAt: null,
  }
  loaded = true
  loadingPromise = null
  await ensureConfigDir().catch(() => undefined)
  await Promise.all([
    fs.rm(MEMORY_SHADOW_FILE(), { force: true }).catch(() => undefined),
    fs.rm(MEMORY_SHADOW_BACKUP_FILE(), { force: true }).catch(() => undefined),
    fs.rm(`${MEMORY_SHADOW_FILE()}.tmp`, { force: true }).catch(() => undefined),
  ])
}
