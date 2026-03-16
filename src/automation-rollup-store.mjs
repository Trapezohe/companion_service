/**
 * Persistent session day rollup store.
 *
 * Stores day-level rollup summaries keyed by `persistent:<id>+YYYY-MM-DD`.
 * File layout mirrors automation-budget-store.mjs:
 *   primary:  <configDir>/automation-rollups.json
 *   backup:   <configDir>/automation-rollups.json.bak
 *   temp:     <configDir>/automation-rollups.json.tmp
 */

import { readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises'
import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'

const STORE_FILE = 'automation-rollups.json'
const STORE_BAK = 'automation-rollups.json.bak'
const STORE_TMP = 'automation-rollups.json.tmp'

let store = { rollups: {} }
let loaded = false
let loadingPromise = null
let persistPromise = null

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function safeChmod(filePath) {
  return chmod(filePath, 0o600).catch(() => undefined)
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

async function readStoreFile() {
  const dir = getConfigDir()
  const primaryPath = path.join(dir, STORE_FILE)
  const bakPath = path.join(dir, STORE_BAK)
  const tmpPath = path.join(dir, STORE_TMP)

  await unlink(tmpPath).catch(() => undefined)

  try {
    const raw = await readFile(primaryPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { rollups: parsed.rollups && typeof parsed.rollups === 'object' ? parsed.rollups : {} }
    }
  } catch {
    // fall through to backup
  }

  try {
    const raw = await readFile(bakPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { rollups: parsed.rollups && typeof parsed.rollups === 'object' ? parsed.rollups : {} }
    }
  } catch {
    // fall through to empty
  }

  return { rollups: {} }
}

async function writeStoreSnapshot(snapshot) {
  const dir = getConfigDir()
  const primaryPath = path.join(dir, STORE_FILE)
  const bakPath = path.join(dir, STORE_BAK)
  const tmpPath = path.join(dir, STORE_TMP)

  const json = JSON.stringify(snapshot, null, 2)
  await writeFile(tmpPath, json, { mode: 0o600 })
  await safeChmod(tmpPath)

  await readFile(primaryPath).then(() =>
    writeFile(bakPath, '', { flag: 'wx' }).catch(() => undefined).then(() =>
      rename(primaryPath, bakPath).then(() => safeChmod(bakPath)),
    ),
  ).catch(() => undefined)

  await rename(tmpPath, primaryPath)
  await safeChmod(primaryPath)
}

function saveStore() {
  const snapshot = clone(store)
  persistPromise = (persistPromise || Promise.resolve())
    .catch(() => undefined)
    .then(() => writeStoreSnapshot(snapshot))
  return persistPromise
}

async function ensureLoaded() {
  if (loaded) return
  if (!loadingPromise) {
    loadingPromise = (async () => {
      await ensureConfigDir()
      store = await readStoreFile()
      loaded = true
    })()
  }
  await loadingPromise
}

export async function loadAutomationRollupStore() {
  await ensureLoaded()
}

export async function flushAutomationRollupStore() {
  if (persistPromise) await persistPromise
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
  store = { rollups: {} }
  loaded = true
  loadingPromise = null
  persistPromise = null
  await saveStore()
}
