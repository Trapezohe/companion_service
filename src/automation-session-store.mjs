import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'

const FILE_MODE = 0o600
const BLOCKED_REUSE_STATES = new Set(['error', 'timeout', 'cancelled'])

function STORE_FILE() {
  return path.join(getConfigDir(), 'automation-sessions.json')
}

function BACKUP_FILE() {
  return path.join(getConfigDir(), 'automation-sessions.json.bak')
}

/** @type {{ bindings: Record<string, string> }} */
let store = { bindings: {} }
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

function normalizeSessionId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
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
        .map(([key, sessionId]) => [normalizeSessionKey(key), normalizeSessionId(sessionId)])
        .filter(([key, sessionId]) => key && sessionId),
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
  const sessionId = normalizeSessionId(store.bindings[normalizedKey])
  if (!sessionId) return null
  return {
    key: normalizedKey,
    sessionId,
  }
}

export async function listAutomationSessionBindings() {
  await ensureLoaded()
  return Object.entries(store.bindings)
    .map(([key, sessionId]) => ({
      key,
      sessionId,
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

export async function setAutomationSessionBinding(sessionKey, sessionId) {
  await ensureLoaded()
  const normalizedKey = normalizeSessionKey(sessionKey)
  const normalizedSessionId = normalizeSessionId(sessionId)
  if (!normalizedKey || !normalizedSessionId) {
    throw new Error('persistent automation session key and sessionId are required')
  }
  store.bindings[normalizedKey] = normalizedSessionId
  await persistStore()
  return {
    key: normalizedKey,
    sessionId: normalizedSessionId,
  }
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

  await setAutomationSessionBinding(normalizedKey, sessionId)
  return {
    key: normalizedKey,
    sessionId,
    reused: false,
    created: true,
  }
}

export async function clearAutomationSessionStoreForTests() {
  store = { bindings: {} }
  loaded = true
  await ensureConfigDir()
  await writeStoreSnapshot(store)
}
