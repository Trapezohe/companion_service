import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'

const FILE_MODE = 0o600
const BLOCKED_REUSE_STATES = new Set(['error', 'timeout', 'cancelled'])
const DAY_MS = 24 * 60 * 60 * 1000

function STORE_FILE() {
  return path.join(getConfigDir(), 'automation-sessions.json')
}

function BACKUP_FILE() {
  return path.join(getConfigDir(), 'automation-sessions.json.bak')
}

/** @type {{ bindings: Record<string, { sessionId: string, updatedAt: number, lastRunAt: number | null }> }} */
let store = { bindings: {} }
let loaded = false
let loadingPromise = null
let lastSweepSummary = {
  sweptAt: null,
  scanned: 0,
  removed: 0,
  kept: 0,
  reasons: {
    missing_session: 0,
    run_meta_expired: 0,
    retention_max_age: 0,
  },
  removedBindings: [],
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeTimestamp(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.floor(parsed)
}

function normalizeSessionKey(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  if (!normalized.startsWith('persistent:')) return ''
  return normalized.length > 'persistent:'.length ? normalized : ''
}

function normalizeSessionId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function normalizeBindingRecord(value) {
  if (typeof value === 'string') {
    const sessionId = normalizeSessionId(value)
    if (!sessionId) return null
    const now = Date.now()
    return {
      sessionId,
      updatedAt: now,
      lastRunAt: now,
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const sessionId = normalizeSessionId(value.sessionId)
  if (!sessionId) return null
  const updatedAt = normalizeTimestamp(value.updatedAt) ?? Date.now()
  const lastRunAt = normalizeTimestamp(value.lastRunAt)
  return {
    sessionId,
    updatedAt,
    lastRunAt,
  }
}

function normalizeStore(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { bindings: {} }
  }

  const rawBindings = input.bindings && typeof input.bindings === 'object' && !Array.isArray(input.bindings)
    ? input.bindings
    : {}

  return {
    bindings: Object.fromEntries(
      Object.entries(rawBindings)
        .map(([key, value]) => [normalizeSessionKey(key), normalizeBindingRecord(value)])
        .filter(([key, value]) => key && value)
        .map(([key, value]) => [key, value]),
    ),
  }
}

function normalizeBindingMeta(meta = {}) {
  return {
    updatedAt: normalizeTimestamp(meta.updatedAt) ?? Date.now(),
    lastRunAt: normalizeTimestamp(meta.lastRunAt),
  }
}

function normalizeRetention(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const maxAgeDays = normalizeTimestamp(value.maxAgeDays)
  const maxRuns = normalizeTimestamp(value.maxRuns)
  if (maxAgeDays === null && maxRuns === null) return null
  return {
    maxAgeDays,
    maxRuns,
  }
}

function formatBinding(key, value) {
  return {
    key,
    sessionId: value.sessionId,
    updatedAt: value.updatedAt,
    lastRunAt: value.lastRunAt ?? null,
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

export async function loadAutomationSessionStore() {
  await ensureConfigDir()

  try {
    await fs.unlink(`${STORE_FILE()}.tmp`)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[automation-session-store] Failed to clean orphan .tmp: ${err.message}`)
    }
  }

  try {
    store = await readStoreFile(STORE_FILE())
  } catch (err) {
    if (err.code === 'ENOENT') {
      store = { bindings: {} }
    } else {
      console.warn(`[automation-session-store] Primary store corrupted: ${err.message}`)
      try {
        store = await readStoreFile(BACKUP_FILE())
        console.warn('[automation-session-store] Recovered from backup store')
      } catch (backupErr) {
        console.warn(`[automation-session-store] Backup unavailable: ${backupErr.message ?? 'unknown error'}`)
        store = { bindings: {} }
      }
    }
  }

  loaded = true
  return clone(store)
}

async function ensureLoaded() {
  if (loaded) return
  if (loadingPromise) return loadingPromise
  loadingPromise = loadAutomationSessionStore().finally(() => {
    loadingPromise = null
  })
  return loadingPromise
}

async function persistStore() {
  await ensureLoaded()
  await writeStoreSnapshot(store)
}

export async function getAutomationSessionBinding(sessionKey) {
  await ensureLoaded()
  const normalizedKey = normalizeSessionKey(sessionKey)
  if (!normalizedKey) return null
  const binding = store.bindings[normalizedKey]
  if (!binding) return null
  return formatBinding(normalizedKey, binding)
}

export async function listAutomationSessionBindings() {
  await ensureLoaded()
  return Object.entries(store.bindings)
    .map(([key, value]) => formatBinding(key, value))
    .sort((a, b) => a.key.localeCompare(b.key))
}

export async function setAutomationSessionBinding(sessionKey, sessionId, meta = {}) {
  await ensureLoaded()
  const normalizedKey = normalizeSessionKey(sessionKey)
  const normalizedSessionId = normalizeSessionId(sessionId)
  if (!normalizedKey || !normalizedSessionId) {
    throw new Error('persistent automation session key and sessionId are required')
  }
  const normalizedMeta = normalizeBindingMeta(meta)
  store.bindings[normalizedKey] = {
    sessionId: normalizedSessionId,
    updatedAt: normalizedMeta.updatedAt,
    lastRunAt: normalizedMeta.lastRunAt,
  }
  await persistStore()
  return formatBinding(normalizedKey, store.bindings[normalizedKey])
}

export async function clearAutomationSessionBinding(sessionKey) {
  await ensureLoaded()
  const normalizedKey = normalizeSessionKey(sessionKey)
  if (!normalizedKey) return false
  if (!Object.prototype.hasOwnProperty.call(store.bindings, normalizedKey)) return false
  delete store.bindings[normalizedKey]
  await persistStore()
  return true
}

function canReuseSession(session) {
  if (!session || typeof session !== 'object') return false
  const sessionId = normalizeSessionId(session.sessionId)
  if (!sessionId) return false
  const state = typeof session.state === 'string' ? session.state.trim() : ''
  return !BLOCKED_REUSE_STATES.has(state)
}

function hasRunReference(binding, runs) {
  return runs.some((run) => {
    const meta = run?.meta && typeof run.meta === 'object' ? run.meta : {}
    return meta.sessionTarget === binding.key
      || meta.acpSessionId === binding.sessionId
      || meta.sessionId === binding.sessionId
  })
}

export async function sweepAutomationSessionBindings(input = {}) {
  await ensureLoaded()
  const sweptAt = normalizeTimestamp(input.now) ?? Date.now()
  const retentionByKey = input.retentionByKey && typeof input.retentionByKey === 'object' && !Array.isArray(input.retentionByKey)
    ? input.retentionByKey
    : {}
  const getSessionById = typeof input.getSessionById === 'function'
    ? input.getSessionById
    : async () => null
  const listRuns = typeof input.listRuns === 'function'
    ? input.listRuns
    : async () => ({ runs: [] })
  const listedRuns = await listRuns()
  const runs = Array.isArray(listedRuns?.runs)
    ? listedRuns.runs
    : Array.isArray(listedRuns)
      ? listedRuns
      : []

  const reasons = {
    missing_session: 0,
    run_meta_expired: 0,
    retention_max_age: 0,
  }
  const removedBindings = []

  for (const [key, binding] of Object.entries(store.bindings)) {
    const session = await getSessionById(binding.sessionId)
    let reason = null

    if (!canReuseSession(session)) {
      reason = 'missing_session'
    } else {
      const retention = normalizeRetention(retentionByKey[key])
      const cutoff = retention?.maxAgeDays ? sweptAt - (retention.maxAgeDays * DAY_MS) : null
      if (cutoff !== null && binding.updatedAt < cutoff) {
        reason = 'retention_max_age'
      } else if (!hasRunReference({ key, sessionId: binding.sessionId }, runs)) {
        reason = 'run_meta_expired'
      }
    }

    if (!reason) continue

    reasons[reason] += 1
    removedBindings.push({ key, sessionId: binding.sessionId, reason })
    delete store.bindings[key]
  }

  if (removedBindings.length > 0) {
    await persistStore()
  }

  lastSweepSummary = {
    sweptAt,
    scanned: Object.keys(store.bindings).length + removedBindings.length,
    removed: removedBindings.length,
    kept: Object.keys(store.bindings).length,
    reasons,
    removedBindings,
  }

  return clone(lastSweepSummary)
}

export function getAutomationSessionSweepSummary() {
  return clone(lastSweepSummary)
}

export async function resolvePersistentAutomationSession(sessionKey, deps = {}) {
  const normalizedKey = normalizeSessionKey(sessionKey)
  if (!normalizedKey) {
    throw new Error('resolvePersistentAutomationSession requires a persistent:<id> session key')
  }
  if (typeof deps.getSessionById !== 'function') {
    throw new Error('resolvePersistentAutomationSession requires getSessionById(sessionId)')
  }
  if (typeof deps.createSession !== 'function') {
    throw new Error('resolvePersistentAutomationSession requires createSession()')
  }

  const existing = await getAutomationSessionBinding(normalizedKey)
  if (existing?.sessionId) {
    const session = await deps.getSessionById(existing.sessionId)
    if (canReuseSession(session)) {
      await setAutomationSessionBinding(normalizedKey, existing.sessionId, {
        updatedAt: Date.now(),
        lastRunAt: Date.now(),
      })
      return {
        key: normalizedKey,
        sessionId: existing.sessionId,
        reused: true,
        created: false,
      }
    }
  }

  const createdSession = await deps.createSession()
  const sessionId = normalizeSessionId(createdSession?.sessionId)
  if (!sessionId) {
    throw new Error('createSession() must return an ACP session with a sessionId')
  }

  await setAutomationSessionBinding(normalizedKey, sessionId, {
    updatedAt: Date.now(),
    lastRunAt: Date.now(),
  })
  return {
    key: normalizedKey,
    sessionId,
    reused: false,
    created: true,
  }
}

export async function clearAutomationSessionStoreForTests() {
  store = { bindings: {} }
  lastSweepSummary = {
    sweptAt: null,
    scanned: 0,
    removed: 0,
    kept: 0,
    reasons: {
      missing_session: 0,
      run_meta_expired: 0,
      retention_max_age: 0,
    },
    removedBindings: [],
  }
  loaded = true
  await ensureConfigDir()
  await writeStoreSnapshot(store)
}
