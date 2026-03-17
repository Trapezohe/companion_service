/**
 * Approval store (Phase B control-plane)
 *
 * Persists approval requests to ~/.trapezohe/approvals.json as a single source
 * of truth for the approval lifecycle. Extension mirrors locally for UI display.
 */

import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'
import { createFileBackedStore } from './file-backed-store.mjs'

const FILE_MODE = 0o600
const MAX_APPROVALS = 500
const RESOLVED_RETENTION_MS = 24 * 60 * 60 * 1000
const WRITE_DEBOUNCE_MS = 200

const VALID_STATUSES = new Set(['pending', 'approved', 'rejected', 'expired'])

function APPROVALS_FILE() {
  return path.join(getConfigDir(), 'approvals.json')
}

/**
 * @typedef {{
 *   requestId: string,
 *   conversationId: string,
 *   toolName: string,
 *   toolPreview: string,
 *   riskLevel: string,
 *   channels: string[],
 *   status: 'pending'|'approved'|'rejected'|'expired',
 *   createdAt: number,
 *   expiresAt: number,
 *   resolvedAt?: number,
 *   resolvedBy?: string,
 *   meta?: Record<string, unknown>,
 * }} ApprovalRecord
 */

/** @type {{ approvals: ApprovalRecord[] }} */
let store = { approvals: [] }
let loaded = false

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function resolveCanonicalApprovalRequestId(requestId, currentMeta, inputMeta) {
  if (hasNonEmptyString(requestId)) return requestId.trim()
  const existing = currentMeta && typeof currentMeta === 'object' ? currentMeta : {}
  const incoming = inputMeta && typeof inputMeta === 'object' ? inputMeta : {}
  if (hasNonEmptyString(existing.approvalRequestId)) return existing.approvalRequestId.trim()
  if (hasNonEmptyString(existing.requestId)) return existing.requestId.trim()
  if (hasNonEmptyString(incoming.approvalRequestId)) return incoming.approvalRequestId.trim()
  if (hasNonEmptyString(incoming.requestId)) return incoming.requestId.trim()
  return ''
}

function mergeMetaPreservingCanonical(requestId, currentMeta, inputMeta) {
  const incoming = inputMeta && typeof inputMeta === 'object' ? clone(inputMeta) : {}
  const existing = currentMeta && typeof currentMeta === 'object' ? clone(currentMeta) : {}
  const canonicalApprovalRequestId = resolveCanonicalApprovalRequestId(requestId, existing, incoming)
  const merged = {
    ...incoming,
    ...existing,
  }
  if (!canonicalApprovalRequestId) return merged
  return {
    ...merged,
    approvalRequestId: canonicalApprovalRequestId,
    requestId: canonicalApprovalRequestId,
  }
}

function now() {
  return Date.now()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function APPROVALS_BACKUP_FILE() {
  return path.join(getConfigDir(), 'approvals.json.bak')
}

const storage = createFileBackedStore({
  label: 'approval-store',
  primaryPath: APPROVALS_FILE,
  backupPath: APPROVALS_BACKUP_FILE,
  debounceMs: WRITE_DEBOUNCE_MS,
  fileMode: FILE_MODE,
  ensureDir: ensureConfigDir,
  fallbackState: () => ({ approvals: [] }),
  parse: (raw) => {
    const parsed = JSON.parse(raw)
    return { approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [] }
  },
  serialize: (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`,
  logger: console,
  messages: {
    primaryCorrupted: (err) => `Failed to load: ${err.message}`,
  },
})

function buildPersistableSnapshot() {
  pruneExpired()
  return { approvals: store.approvals }
}

function schedulePersist() {
  storage.schedulePersist(buildPersistableSnapshot)
}

function pruneExpired() {
  const cutoff = now() - RESOLVED_RETENTION_MS
  store.approvals = store.approvals
    .filter((a) => a.status === 'pending' || (a.resolvedAt || a.createdAt) > cutoff)
    .slice(-MAX_APPROVALS)
}

let loadingPromise = null

async function ensureLoaded() {
  if (loaded) return
  if (loadingPromise) return loadingPromise
  loadingPromise = loadApprovalStore().finally(() => {
    loadingPromise = null
  })
  return loadingPromise
}

export async function loadApprovalStore() {
  const loadedStore = await storage.load()
  store = loadedStore.state || { approvals: [] }
  loaded = true
}

export async function flushApprovalStore() {
  await storage.flush()
}

export async function createApproval(input) {
  await ensureLoaded()
  const requestId = input?.requestId || randomBytes(16).toString('hex')
  const existingIndex = store.approvals.findLastIndex
    ? store.approvals.findLastIndex((approval) => approval.requestId === requestId)
    : store.approvals.findIndex((approval) => approval.requestId === requestId)
  if (existingIndex >= 0) {
    const current = store.approvals[existingIndex]
    const next = {
      ...current,
      requestId,
      conversationId: hasNonEmptyString(current.conversationId)
        ? current.conversationId
        : String(input?.conversationId || ''),
      toolName: hasNonEmptyString(current.toolName)
        ? current.toolName
        : String(input?.toolName || ''),
      toolPreview: (
        hasNonEmptyString(current.toolPreview)
          ? current.toolPreview
          : String(input?.toolPreview || '')
      ).slice(0, 500),
      riskLevel: hasNonEmptyString(current.riskLevel)
        ? current.riskLevel
        : String(input?.riskLevel || 'medium'),
      channels: Array.isArray(current.channels) && current.channels.length > 0
        ? current.channels
        : (Array.isArray(input?.channels) ? input.channels.map(String) : ['sidepanel']),
      status: current.status,
      createdAt: Number(current.createdAt) || now(),
      expiresAt: Number(current.expiresAt) || Number(input?.expiresAt) || now() + 120_000,
      ...(current.resolvedAt ? { resolvedAt: current.resolvedAt } : {}),
      ...(current.resolvedBy ? { resolvedBy: current.resolvedBy } : {}),
      ...(Object.keys(mergeMetaPreservingCanonical(requestId, current.meta, input?.meta)).length > 0
        ? { meta: mergeMetaPreservingCanonical(requestId, current.meta, input?.meta) }
        : {}),
    }
    store.approvals[existingIndex] = next
    schedulePersist()
    return clone(next)
  }
  const record = {
    requestId,
    conversationId: String(input?.conversationId || ''),
    toolName: String(input?.toolName || ''),
    toolPreview: String(input?.toolPreview || '').slice(0, 500),
    riskLevel: String(input?.riskLevel || 'medium'),
    channels: Array.isArray(input?.channels) ? input.channels.map(String) : ['sidepanel'],
    status: 'pending',
    createdAt: now(),
    expiresAt: Number(input?.expiresAt) || now() + 120_000,
    ...(Object.keys(mergeMetaPreservingCanonical(requestId, null, input?.meta)).length > 0
      ? { meta: mergeMetaPreservingCanonical(requestId, null, input?.meta) }
      : {}),
  }
  store.approvals.push(record)
  pruneExpired()
  schedulePersist()
  return clone(record)
}

export async function relinkApprovalRun(requestId, runId) {
  await ensureLoaded()
  const id = String(requestId || '').trim()
  const nextRunId = String(runId || '').trim()
  if (!id || !nextRunId) return null

  const index = store.approvals.findLastIndex
    ? store.approvals.findLastIndex((approval) => approval.requestId === id)
    : store.approvals.findIndex((approval) => approval.requestId === id)
  if (index < 0) return null

  const current = store.approvals[index]
  const nextMeta = {
    ...mergeMetaPreservingCanonical(id, current.meta, {
      runId: nextRunId,
    }),
    runId: nextRunId,
  }
  store.approvals[index] = {
    ...current,
    meta: nextMeta,
  }
  schedulePersist()
  return clone(store.approvals[index])
}

export async function resolveApproval(requestId, resolution, resolvedBy) {
  await ensureLoaded()
  const id = String(requestId || '').trim()
  if (!id) return null

  const index = store.approvals.findLastIndex
    ? store.approvals.findLastIndex((a) => a.requestId === id)
    : (() => {
        for (let i = store.approvals.length - 1; i >= 0; i -= 1) {
          if (store.approvals[i].requestId === id) return i
        }
        return -1
      })()
  if (index < 0) return null

  const current = store.approvals[index]
  if (current.status !== 'pending') {
    return clone(current)
  }

  const status = VALID_STATUSES.has(resolution) ? resolution : 'rejected'
  store.approvals[index] = {
    ...current,
    status,
    resolvedAt: now(),
    ...(resolvedBy ? { resolvedBy: String(resolvedBy).slice(0, 100) } : {}),
  }
  schedulePersist()
  return clone(store.approvals[index])
}

export async function getApprovalById(requestId) {
  await ensureLoaded()
  const id = String(requestId || '').trim()
  if (!id) return null
  const found = store.approvals
    .slice()
    .reverse()
    .find((a) => a.requestId === id)
  return found ? clone(found) : null
}

export async function listPendingApprovals() {
  await ensureLoaded()
  const cutoff = now()
  const pending = store.approvals.filter((a) => a.status === 'pending' && a.expiresAt > cutoff)
  return clone(pending)
}

export async function expireOverdueApprovals() {
  await ensureLoaded()
  const cutoff = now()
  let changed = false
  const expired = []
  for (let i = 0; i < store.approvals.length; i++) {
    const a = store.approvals[i]
    if (a.status === 'pending' && a.expiresAt <= cutoff) {
      store.approvals[i] = { ...a, status: 'expired', resolvedAt: cutoff }
      expired.push(clone(store.approvals[i]))
      changed = true
    }
  }
  if (changed) schedulePersist()
  return expired
}

export async function clearApprovalStoreForTests() {
  await storage.flush()
  store = { approvals: [] }
  loaded = true
  loadingPromise = null
  storage.reset()
  await storage.persistSnapshot(buildPersistableSnapshot())
}
