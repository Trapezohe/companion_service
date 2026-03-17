/**
 * Persistent session day rollup store.
 *
 * Stores day-level rollup summaries keyed by `persistent:<id>+YYYY-MM-DD`.
 * File layout mirrors automation-budget-store.mjs:
 *   primary:  <configDir>/automation-rollups.json
 *   backup:   <configDir>/automation-rollups.json.bak
 *   temp:     <configDir>/automation-rollups.json.tmp
 */

import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'
import { createFileBackedStore } from './file-backed-store.mjs'

const STORE_FILE = 'automation-rollups.json'
const STORE_BAK = 'automation-rollups.json.bak'
const STORE_TMP = 'automation-rollups.json.tmp'

let store = { rollups: {} }
let loaded = false
let loadingPromise = null

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeSessionKey(key) {
  return typeof key === 'string' && key.startsWith('persistent:') && key.length > 'persistent:'.length
    ? key
    : ''
}

function makeRollupKey(sessionKey, dateStr) {
  const normalizedKey = normalizeSessionKey(sessionKey)
  if (!normalizedKey) return ''
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return ''
  return `${normalizedKey}+${dateStr}`
}

function parseRollupKey(rollupKey) {
  if (typeof rollupKey !== 'string') return null
  const plusIndex = rollupKey.lastIndexOf('+')
  if (plusIndex < 0) return null
  const sessionKey = rollupKey.slice(0, plusIndex)
  const dateStr = rollupKey.slice(plusIndex + 1)
  if (!normalizeSessionKey(sessionKey)) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  return { sessionKey, dateStr }
}

const storage = createFileBackedStore({
  label: 'automation-rollup-store',
  primaryPath: () => path.join(getConfigDir(), STORE_FILE),
  backupPath: () => path.join(getConfigDir(), STORE_BAK),
  tmpPath: () => path.join(getConfigDir(), STORE_TMP),
  fileMode: 0o600,
  ensureDir: ensureConfigDir,
  fallbackState: () => ({ rollups: {} }),
  parse: (raw) => {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { rollups: parsed.rollups && typeof parsed.rollups === 'object' ? parsed.rollups : {} }
    }
    return { rollups: {} }
  },
  serialize: (snapshot) => JSON.stringify(snapshot, null, 2),
  logger: console,
})

function saveStore() {
  const snapshot = clone(store)
  return storage.persistSnapshot(snapshot)
}

async function ensureLoaded() {
  if (loaded) return
  if (!loadingPromise) {
    loadingPromise = (async () => {
      await ensureConfigDir()
      const loadedStore = await storage.load()
      store = loadedStore.state || { rollups: {} }
      loaded = true
    })().finally(() => {
      loadingPromise = null
    })
  }
  await loadingPromise
}

export async function loadAutomationRollupStore() {
  await ensureLoaded()
}

export async function flushAutomationRollupStore() {
  await storage.flush()
}

export async function getRollup(sessionKey, dateStr) {
  await ensureLoaded()
  const key = makeRollupKey(sessionKey, dateStr)
  if (!key) return null
  const rollup = store.rollups[key]
  return rollup ? clone(rollup) : null
}

export async function listRollups(sessionKey) {
  await ensureLoaded()
  const prefix = normalizeSessionKey(sessionKey)
  if (!prefix) return []
  return Object.entries(store.rollups)
    .filter(([key]) => key.startsWith(`${prefix}+`))
    .map(([key, rollup]) => {
      const parsed = parseRollupKey(key)
      return {
        key,
        sessionKey: parsed?.sessionKey || prefix,
        dateStr: parsed?.dateStr || '',
        rollup: clone(rollup),
      }
    })
    .sort((a, b) => a.dateStr.localeCompare(b.dateStr))
}

export async function setRollup(sessionKey, dateStr, rollup) {
  await ensureLoaded()
  const key = makeRollupKey(sessionKey, dateStr)
  if (!key || !rollup || typeof rollup !== 'object') return null
  store.rollups[key] = clone(rollup)
  await saveStore()
  return clone(store.rollups[key])
}

export async function sweepRollups(sessionKey, maxDays = 30) {
  await ensureLoaded()
  const prefix = normalizeSessionKey(sessionKey)
  if (!prefix) return 0

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - maxDays)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  let removed = 0
  for (const key of Object.keys(store.rollups)) {
    if (!key.startsWith(`${prefix}+`)) continue
    const parsed = parseRollupKey(key)
    if (parsed && parsed.dateStr < cutoffStr) {
      delete store.rollups[key]
      removed += 1
    }
  }

  if (removed > 0) await saveStore()
  return removed
}

export async function removeRollupsForSession(sessionKey) {
  await ensureLoaded()
  const prefix = normalizeSessionKey(sessionKey)
  if (!prefix) return 0

  let removed = 0
  for (const key of Object.keys(store.rollups)) {
    if (key.startsWith(`${prefix}+`)) {
      delete store.rollups[key]
      removed += 1
    }
  }

  if (removed > 0) await saveStore()
  return removed
}

export async function clearAutomationRollupStoreForTests() {
  await storage.flush()
  storage.reset()
  store = { rollups: {} }
  loaded = true
  loadingPromise = null
  await saveStore()
}
