import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'
import { createFileBackedStore } from './file-backed-store.mjs'

const FILE_MODE = 0o600

function STORE_FILE() {
  return path.join(getConfigDir(), 'automation-budgets.json')
}

function BACKUP_FILE() {
  return path.join(getConfigDir(), 'automation-budgets.json.bak')
}

let store = { ledgers: {} }
let loaded = false
let loadingPromise = null

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeSessionKey(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  if (!normalized.startsWith('persistent:')) return ''
  return normalized.length > 'persistent:'.length ? normalized : ''
}

function normalizeTimestamp(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}

function normalizeNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}

function normalizeHealth(value) {
  return value === 'warning' || value === 'critical' ? value : 'healthy'
}

function normalizeLedger(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return {
    approxInputTokens: normalizeNonNegativeInt(value.approxInputTokens),
    approxOutputTokens: normalizeNonNegativeInt(value.approxOutputTokens),
    compactionCount: normalizeNonNegativeInt(value.compactionCount),
    lastRollupAt: normalizeTimestamp(value.lastRollupAt),
    health: normalizeHealth(value.health),
  }
}

function normalizeStore(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ledgers: {} }
  }
  const rawLedgers = input.ledgers && typeof input.ledgers === 'object' && !Array.isArray(input.ledgers)
    ? input.ledgers
    : {}
  return {
    ledgers: Object.fromEntries(
      Object.entries(rawLedgers)
        .map(([key, value]) => [normalizeSessionKey(key), normalizeLedger(value)])
        .filter(([key, value]) => key && value),
    ),
  }
}

function buildPersistableSnapshot() {
  return { ledgers: store.ledgers }
}

const storage = createFileBackedStore({
  label: 'automation-budget-store',
  primaryPath: STORE_FILE,
  backupPath: BACKUP_FILE,
  fileMode: FILE_MODE,
  ensureDir: ensureConfigDir,
  fallbackState: () => ({ ledgers: {} }),
  parse: (raw) => normalizeStore(JSON.parse(raw)),
  serialize: (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`,
  logger: console,
  messages: {
    tmpCleanup: (err) => `Failed to clean orphan .tmp: ${err.message}`,
    primaryCorrupted: (err) => `Primary store corrupted: ${err.message}`,
    backupRecovered: 'Recovered from backup store',
    backupUnavailable: (err) => `Backup unavailable: ${err.message ?? 'unknown error'}`,
  },
})

export async function loadAutomationBudgetStore() {
  const loadedStore = await storage.load()
  store = loadedStore.state || { ledgers: {} }
  loaded = true
  return clone(store)
}

async function ensureLoaded() {
  if (loaded) return
  if (loadingPromise) return loadingPromise
  loadingPromise = loadAutomationBudgetStore().finally(() => {
    loadingPromise = null
  })
  return loadingPromise
}

async function saveStore() {
  await ensureLoaded()
  await storage.persistSnapshot(buildPersistableSnapshot())
}

export async function flushAutomationBudgetStore() {
  await ensureLoaded()
  await storage.flush()
}

export async function getAutomationBudgetLedger(sessionKey) {
  await ensureLoaded()
  const normalizedKey = normalizeSessionKey(sessionKey)
  if (!normalizedKey) return null
  return store.ledgers[normalizedKey] ? clone(store.ledgers[normalizedKey]) : null
}

export async function listAutomationBudgetLedgers() {
  await ensureLoaded()
  return Object.entries(store.ledgers)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, ledger]) => ({ key, ledger: clone(ledger) }))
}

export async function setAutomationBudgetLedger(sessionKey, ledger) {
  await ensureLoaded()
  const normalizedKey = normalizeSessionKey(sessionKey)
  const normalizedLedger = normalizeLedger(ledger)
  if (!normalizedKey || !normalizedLedger) {
    throw new Error('persistent automation session key and ledger are required')
  }
  store.ledgers[normalizedKey] = normalizedLedger
  await saveStore()
  return clone(normalizedLedger)
}

export async function clearAutomationBudgetLedger(sessionKey) {
  await ensureLoaded()
  const normalizedKey = normalizeSessionKey(sessionKey)
  if (!normalizedKey) return false
  if (!Object.prototype.hasOwnProperty.call(store.ledgers, normalizedKey)) return false
  delete store.ledgers[normalizedKey]
  await saveStore()
  return true
}

export async function clearAutomationBudgetStoreForTests() {
  await storage.flush()
  store = { ledgers: {} }
  loaded = true
  loadingPromise = null
  storage.reset()
  await storage.replaceSnapshot(buildPersistableSnapshot())
}
