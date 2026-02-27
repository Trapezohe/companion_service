/**
 * Approval store (Phase B control-plane)
 *
 * Persists approval requests to ~/.trapezohe/approvals.json as a single source
 * of truth for the approval lifecycle. Extension mirrors locally for UI display.
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'

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
let persistTimer = null

function now() {
  return Date.now()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function safeChmod(target, mode) {
  try {
    await fs.chmod(target, mode)
  } catch (err) {
    if (err.code === 'ENOSYS' || err.code === 'EPERM' || err.code === 'EINVAL') return
    throw err
  }
}

async function writeStoreNow() {
  await ensureConfigDir()
  pruneExpired()
  const payload = JSON.stringify({ approvals: store.approvals }, null, 2) + '\n'
  const target = APPROVALS_FILE()
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: FILE_MODE })
  await safeChmod(tmp, FILE_MODE)
  await fs.rename(tmp, target)
  await safeChmod(target, FILE_MODE)
}

function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    writeStoreNow().catch((err) => {
      console.error(`[approval-store] Persist failed: ${err.message}`)
    })
  }, WRITE_DEBOUNCE_MS)
  if (persistTimer.unref) persistTimer.unref()
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
  await ensureConfigDir()
  try {
    const raw = await fs.readFile(APPROVALS_FILE(), 'utf8')
    const parsed = JSON.parse(raw)
    store = { approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [] }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[approval-store] Failed to load: ${err.message}`)
    }
    store = { approvals: [] }
  }
  loaded = true
}

export async function flushApprovalStore() {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
    await writeStoreNow()
  }
}

export async function createApproval(input) {
  await ensureLoaded()
  const requestId = input?.requestId || randomBytes(16).toString('hex')
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
    ...(input?.meta && typeof input.meta === 'object' ? { meta: clone(input.meta) } : {}),
  }
  store.approvals.push(record)
  pruneExpired()
  schedulePersist()
  return clone(record)
}

export async function resolveApproval(requestId, resolution, resolvedBy) {
  await ensureLoaded()
  const id = String(requestId || '').trim()
  if (!id) return null

  const index = store.approvals.findIndex((a) => a.requestId === id)
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
  const found = store.approvals.find((a) => a.requestId === id)
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
  for (let i = 0; i < store.approvals.length; i++) {
    const a = store.approvals[i]
    if (a.status === 'pending' && a.expiresAt <= cutoff) {
      store.approvals[i] = { ...a, status: 'expired', resolvedAt: cutoff }
      changed = true
    }
  }
  if (changed) schedulePersist()
}

export async function clearApprovalStoreForTests() {
  store = { approvals: [] }
  loaded = true
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
}
