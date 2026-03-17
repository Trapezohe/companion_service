import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'
import { createFileBackedStore } from './file-backed-store.mjs'

const FILE_MODE = 0o600

function OUTBOX_FILE() {
  return path.join(getConfigDir(), 'automation-outbox.json')
}

function OUTBOX_BACKUP_FILE() {
  return path.join(getConfigDir(), 'automation-outbox.json.bak')
}

/**
 * @typedef {{
 *   id: string,
 *   runId: string,
 *   taskId: string,
 *   taskName: string,
 *   mode: 'chat' | 'remote_channel',
 *   text: string,
 *   target: Record<string, unknown> | null,
 *   createdAt: number,
 * }} AutomationOutboxItem
 */

/** @type {{ items: AutomationOutboxItem[] }} */
let store = { items: [] }
let loaded = false
let loadingPromise = null

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return clone(value)
}

function normalizeTimestamp(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now()
  return Math.floor(parsed)
}

function normalizeItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const id = normalizeText(input.id || input.runId)
  const runId = normalizeText(input.runId)
  const taskId = normalizeText(input.taskId)
  const taskName = normalizeText(input.taskName)
  const mode = input.mode === 'remote_channel' ? 'remote_channel' : input.mode === 'chat' ? 'chat' : ''
  const text = typeof input.text === 'string' ? input.text : ''

  if (!id || !runId || !taskId || !taskName || !mode || !text.trim()) {
    return null
  }

  return {
    id,
    runId,
    taskId,
    taskName,
    mode,
    text,
    target: normalizeTarget(input.target),
    createdAt: normalizeTimestamp(input.createdAt),
  }
}

function sortNewestFirst(items) {
  return items.slice().sort((left, right) => {
    if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt
    return left.id.localeCompare(right.id)
  })
}

function parseStoreSnapshot(raw) {
  const parsed = JSON.parse(raw)
  const items = Array.isArray(parsed.items)
    ? parsed.items.map(normalizeItem).filter(Boolean)
    : []
  return { items: sortNewestFirst(items) }
}

const storage = createFileBackedStore({
  label: 'automation-outbox',
  primaryPath: OUTBOX_FILE,
  backupPath: OUTBOX_BACKUP_FILE,
  fileMode: FILE_MODE,
  ensureDir: ensureConfigDir,
  fallbackState: () => ({ items: [] }),
  parse: parseStoreSnapshot,
  serialize: (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`,
  logger: console,
  messages: {
    tmpCleanup: (err) => `Failed to clean orphan .tmp: ${err.message}`,
    primaryCorrupted: (err) => `Primary store corrupted: ${err.message}`,
    backupRecovered: 'Recovered from backup store',
    backupUnavailable: (err) => `Backup unavailable: ${err.message ?? 'unknown error'}`,
  },
})

export async function loadAutomationOutboxStore() {
  const loadedStore = await storage.load()
  store = loadedStore.state || { items: [] }
  loaded = true
  return clone(store)
}

async function ensureLoaded() {
  if (loaded) return
  if (loadingPromise) return loadingPromise
  loadingPromise = loadAutomationOutboxStore().finally(() => {
    loadingPromise = null
  })
  return loadingPromise
}

async function saveStore() {
  await ensureLoaded()
  store.items = sortNewestFirst(store.items)
  const snapshot = clone(store)
  await storage.persistSnapshot(snapshot)
}

export async function enqueueAutomationOutboxItem(input) {
  await ensureLoaded()
  const normalized = normalizeItem(input)
  if (!normalized) {
    throw new Error('invalid automation outbox item')
  }
  store.items = store.items.filter((item) => item.id !== normalized.id)
  store.items.unshift(normalized)
  await saveStore()
  return clone(normalized)
}

export async function listAutomationOutboxItems(options = {}) {
  await ensureLoaded()
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.floor(Number(options.limit)))
    : 100
  const offset = Number.isFinite(Number(options.offset))
    ? Math.max(0, Math.floor(Number(options.offset)))
    : 0
  const items = sortNewestFirst(store.items)
  const paged = items.slice(offset, offset + limit)
  return {
    items: clone(paged),
    total: items.length,
    limit,
    offset,
    hasMore: offset + paged.length < items.length,
  }
}

export async function ackAutomationOutboxItems(ids = []) {
  await ensureLoaded()
  const idSet = new Set(
    (Array.isArray(ids) ? ids : [])
      .map((value) => normalizeText(value))
      .filter(Boolean),
  )
  if (idSet.size === 0) {
    return { ok: true, acked: 0 }
  }

  const before = store.items.length
  store.items = store.items.filter((item) => !idSet.has(item.id))
  const acked = before - store.items.length
  if (acked > 0) {
    await saveStore()
  }
  return { ok: true, acked }
}

export async function clearAutomationOutboxForTests() {
  await storage.flush()
  storage.reset()
  store = { items: [] }
  loaded = true
  loadingPromise = null
  await storage.persistSnapshot(clone(store))
}
