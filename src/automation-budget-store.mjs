import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'

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
let persistPromise = null

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

async function safeChmod(target, mode) {
  try {
    await fs.chmod(target, mode)
  } catch (err) {
    if (err.code === 'ENOSYS' || err.code === 'EPERM' || err.code === 'EINVAL') return
    throw err
  }
}

async function readStoreFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  return normalizeStore(JSON.parse(raw))
}

async function writeStoreSnapshot(snapshot) {
  await ensureConfigDir()
  const payload = JSON.stringify(snapshot, null, 2) + '\n'
  const target = STORE_FILE()
  const backup = BACKUP_FILE()
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

export async function loadAutomationBudgetStore() {
  await ensureConfigDir()
  try {
    await fs.unlink(`${STORE_FILE()}.tmp`)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[automation-budget-store] Failed to clean orphan .tmp: ${err.message}`)
    }
  }

  try {
    store = await readStoreFile(STORE_FILE())
  } catch (err) {
    if (err.code === 'ENOENT') {
      store = { ledgers: {} }
    } else {
      console.warn(`[automation-budget-store] Primary store corrupted: ${err.message}`)
      try {
        store = await readStoreFile(BACKUP_FILE())
        console.warn('[automation-budget-store] Recovered from backup store')
      } catch (backupErr) {
        console.warn(`[automation-budget-store] Backup unavailable: ${backupErr.message ?? 'unknown error'}`)
        store = { ledgers: {} }
      }
    }
  }

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
  const snapshot = clone(store)
  const nextWrite = async () => writeStoreSnapshot(snapshot)
  persistPromise = (persistPromise || Promise.resolve())
    .catch(() => undefined)
    .then(nextWrite)
  await persistPromise
}

export async function flushAutomationBudgetStore() {
  await ensureLoaded()
  if (persistPromise) await persistPromise
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
  store = { ledgers: {} }
  loaded = true
  persistPromise = null
  await ensureConfigDir()
  await writeStoreSnapshot(store)
}
