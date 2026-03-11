/**
 * Unified HTTP server — command runtime + MCP API.
 *
 * All endpoints require Bearer token auth + loopback-only access.
 * Backwards-compatible with existing /api/local-runtime/* paths.
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  COMPANION_PROTOCOL_VERSION,
  COMPANION_SUPPORTED_FEATURES,
  repairConfigDefaults,
} from './config.mjs'
import { COMPANION_VERSION } from './version.mjs'
import {
  runCommand,
  resolveCwd,
  clampTimeout,
  enforceCommandPolicy,
  PermissionPolicyError,
  startCommandSession,
  addSessionExitListener,
  getSessionById,
  makeSessionSnapshot,
  listSessions,
  getSessionLog,
  pruneSessions,
  stopSession,
  writeToSession,
  sendKeysToSession,
  listSessionEvents,
  cleanupAllSessions,
  startSessionPruner,
  stopSessionPruner,
} from './runtime.mjs'
import { normalizePermissionPolicy } from './permission-policy.mjs'
import {
  getJobs,
  upsertJob,
  removeJob,
  getPendingRuns,
  ackPendingRuns,
} from './cron-store.mjs'
import { rescheduleJob, unscheduleJob } from './cron-scheduler.mjs'
import { extractSkillAssets, removeSkillAssets } from './skill-assets.mjs'
import {
  createRun,
  clearSessionRunLink,
  getRunById,
  getRunDiagnostics,
  getSessionRunLink,
  listRuns,
  listSessionRunLinks,
  loadRunStore,
  setSessionRunLink,
  updateRun,
  flushRunStore,
} from './run-store.mjs'
import {
  createApproval,
  expireOverdueApprovals,
  resolveApproval,
  getApprovalById,
  listPendingApprovals,
  loadApprovalStore,
  flushApprovalStore,
  relinkApprovalRun,
} from './approval-store.mjs'
import { handleAcpRequest } from './acp-routes.mjs'
import {
  cleanupAllAcpSessions,
  listAcpSessions,
  setAcpSessionEventHook,
  setAcpSessionTransitionHook,
} from './acp-session.mjs'
import { buildDiagnosticsPayload, runCompanionSelfCheck } from './diagnostics.mjs'
import { getMediaNormalizationSupport, normalizeImagePayload } from './media-normalize.mjs'
import { isChromeExtensionOrigin, normalizeExtensionOrigin } from './native-host.mjs'

// ── Auth rate limiter ──

const AUTH_WINDOW_MS = 60_000
const AUTH_MAX_FAILURES = 20
const authFailures = [] // timestamps of recent failures

function isAuthRateLimited() {
  const cutoff = Date.now() - AUTH_WINDOW_MS
  // Remove expired entries
  while (authFailures.length > 0 && authFailures[0] < cutoff) {
    authFailures.shift()
  }
  return authFailures.length >= AUTH_MAX_FAILURES
}

function recordAuthFailure() {
  authFailures.push(Date.now())
}

// ── Helpers ──

const BASE_CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
}

export function buildCorsHeaders({
  origin,
  allowedOrigins = [],
  allowUnpairedExtensionOrigin = false,
} = {}) {
  const headers = { ...BASE_CORS_HEADERS }
  const requestedOrigin = typeof origin === 'string' ? origin.trim() : ''
  const normalizedOrigin = normalizeExtensionOrigin(requestedOrigin)
  if (!normalizedOrigin) return headers

  const allowedOriginSet = new Set(
    (Array.isArray(allowedOrigins) ? allowedOrigins : [])
      .map((value) => normalizeExtensionOrigin(value))
      .filter(Boolean),
  )

  const allowEnrollmentOrigin =
    allowUnpairedExtensionOrigin &&
    allowedOriginSet.size === 0 &&
    isChromeExtensionOrigin(normalizedOrigin)

  if (allowedOriginSet.has(normalizedOrigin) || allowEnrollmentOrigin) {
    headers['Access-Control-Allow-Origin'] = requestedOrigin
    headers.Vary = 'Origin'
  }

  return headers
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function buildCompanionCapabilitiesPayload() {
  return {
    protocolVersion: `trapezohe-companion/${COMPANION_PROTOCOL_VERSION}`,
    version: COMPANION_VERSION,
    supportedFeatures: {
      ...COMPANION_SUPPORTED_FEATURES,
    },
  }
}

const RECOVERABLE_SESSION_RUN_TYPES = new Set(['session', 'acp'])
const RECOVERABLE_ACTIVE_STATES = new Set(['queued', 'idle', 'running', 'waiting_approval', 'retrying'])

function getRunSessionId(run) {
  const sessionId = typeof run?.meta?.sessionId === 'string' ? run.meta.sessionId.trim() : ''
  return sessionId || ''
}

function trimApprovalText(value, maxChars = 500) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(32, maxChars - 16)).trimEnd()}...[truncated]`
}

function mergeRunMeta(run, extra = {}) {
  return {
    ...(run?.meta && typeof run.meta === 'object' ? run.meta : {}),
    ...(extra && typeof extra === 'object' ? extra : {}),
  }
}

function buildAcpApprovalRequestId(event) {
  const sessionId = String(event?.sessionId || '').trim() || 'session'
  const turnId = String(event?.turnId || '').trim() || 'turn'
  return `acp-approval-${sessionId}-${turnId}`
}

function createKeyedSerializer() {
  const chains = new Map()
  return async function runSerialized(key, fn) {
    const normalizedKey = String(key || '').trim()
    if (!normalizedKey) return fn()

    const previous = chains.get(normalizedKey) || Promise.resolve()
    let releaseCurrent
    const current = new Promise((resolve) => {
      releaseCurrent = resolve
    })
    const chain = previous.catch(() => undefined).then(() => current)
    chains.set(normalizedKey, chain)

    await previous.catch(() => undefined)
    try {
      return await fn()
    } finally {
      releaseCurrent()
      if (chains.get(normalizedKey) === chain) {
        chains.delete(normalizedKey)
      }
    }
  }
}

async function restoreSessionRunStateOnStartup(sessionRunIndex) {
  const snapshot = await listRuns({ limit: 500, offset: 0 }).catch(() => ({ runs: [] }))
  const persistedLinks = await listSessionRunLinks().catch(() => ({}))
  const liveRuntimeSessions = new Set(
    listSessions({ status: 'running', limit: 500, offset: 0 }).sessions
      .map((session) => String(session.sessionId || '').trim())
      .filter(Boolean),
  )
  const liveAcpSessions = new Set(
    listAcpSessions({ limit: 500, offset: 0 }).sessions
      .map((session) => String(session.sessionId || '').trim())
      .filter(Boolean),
  )

  const runsById = new Map(snapshot.runs.map((run) => [run.runId, run]))

  for (const [sessionId, link] of Object.entries(persistedLinks)) {
    const run = runsById.get(link.runId)
    if (!run) {
      await clearSessionRunLink(sessionId).catch(() => undefined)
      continue
    }
    if (!RECOVERABLE_SESSION_RUN_TYPES.has(run.type) || !RECOVERABLE_ACTIVE_STATES.has(run.state)) {
      await clearSessionRunLink(sessionId).catch(() => undefined)
      continue
    }

    sessionRunIndex.set(sessionId, run.runId)
    const liveSessionExists = run.type === 'acp'
      ? liveAcpSessions.has(sessionId)
      : liveRuntimeSessions.has(sessionId)
    if (liveSessionExists) continue

    await updateRun(run.runId, {
      state: 'failed',
      finishedAt: Date.now(),
      summary: run.type === 'acp'
        ? 'ACP session orphaned after companion restart'
        : 'Session orphaned after companion restart',
      error: 'companion_restart_recovery',
      meta: {
        ...(run.meta && typeof run.meta === 'object' ? run.meta : {}),
        recoveredAfterRestart: true,
        recoveryReason: 'missing_session',
      },
    }).catch(() => undefined)

    await clearSessionRunLink(sessionId).catch(() => undefined)
    sessionRunIndex.delete(sessionId)
  }

  // Backfill persisted links for older stores that only had run.meta.sessionId.
  for (const run of snapshot.runs) {
    if (!RECOVERABLE_SESSION_RUN_TYPES.has(run.type)) continue
    if (!RECOVERABLE_ACTIVE_STATES.has(run.state)) continue
    const sessionId = getRunSessionId(run)
    if (!sessionId || sessionRunIndex.has(sessionId)) continue
    await setSessionRunLink(sessionId, run.runId, { type: run.type }).catch(() => undefined)
    sessionRunIndex.set(sessionId, run.runId)
    const liveSessionExists = run.type === 'acp'
      ? liveAcpSessions.has(sessionId)
      : liveRuntimeSessions.has(sessionId)
    if (liveSessionExists) continue

    await updateRun(run.runId, {
      state: 'failed',
      finishedAt: Date.now(),
      summary: run.type === 'acp'
        ? 'ACP session orphaned after companion restart'
        : 'Session orphaned after companion restart',
      error: 'companion_restart_recovery',
      meta: {
        ...(run.meta && typeof run.meta === 'object' ? run.meta : {}),
        recoveredAfterRestart: true,
        recoveryReason: 'missing_session',
      },
    }).catch(() => undefined)
    await clearSessionRunLink(sessionId).catch(() => undefined)
    sessionRunIndex.delete(sessionId)
  }
}

async function runCompanionRepairAction(input, context) {
  const action = String(input?.action || '').trim()
  if (action === 'repair_config') {
    const result = await repairConfigDefaults()
    const selfCheck = await runCompanionSelfCheck({
      getPermissionPolicy: context.getPermissionPolicy,
    })
    return {
      ok: true,
      action: 'repair_config',
      message: 'Config defaults repaired.',
      result,
      selfCheck,
    }
  }

  if (action === 'register_native_host') {
    const extensionIds = Array.isArray(input?.extensionIds)
      ? input.extensionIds.map((item) => String(item || '').trim()).filter(Boolean)
      : []
    const cliEntry = String(process.argv[1] || '').trim()
    if (!cliEntry) {
      throw new Error('Companion CLI entrypoint unavailable for native host repair.')
    }
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const args = [cliEntry, 'repair', 'register_native_host']
    for (const extensionId of extensionIds) {
      args.push('--ext-id', extensionId)
    }
    const result = await execFileAsync(process.execPath, args)
    const selfCheck = await runCompanionSelfCheck({
      getPermissionPolicy: context.getPermissionPolicy,
    })
    return {
      ok: true,
      action: 'register_native_host',
      message: 'Native host registration repaired.',
      result: {
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
      },
      selfCheck,
    }
  }

  throw new Error('Unsupported repair action.')
}

function isLoopback(addr) {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024
const MEDIA_NORMALIZE_MAX_RAW_BYTES = 8 * 1024 * 1024
const MEDIA_NORMALIZE_JSON_BODY_MAX_BYTES = Math.ceil((MEDIA_NORMALIZE_MAX_RAW_BYTES * 4) / 3) + 64 * 1024

async function readJsonBody(req, maxSize = DEFAULT_JSON_BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxSize) {
        reject(new Error('Request body too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('Invalid JSON body.'))
      }
    })
  })
}

function safeTokenCompare(a, b) {
  if (!a || !b) return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function authorize(req, token) {
  if (!isLoopback(req.socket.remoteAddress)) {
    return { ok: false, error: 'Only loopback clients are allowed.' }
  }
  if (isAuthRateLimited()) {
    return { ok: false, error: 'Too many failed authentication attempts. Try again later.' }
  }
  const auth = String(req.headers.authorization || '')
  const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
  if (!safeTokenCompare(provided, token)) {
    recordAuthFailure()
    return { ok: false, error: 'Unauthorized: invalid token.' }
  }
  return { ok: true }
}

// ── Command execution handler ──

async function handleExec(req, res, getPermissionPolicy) {
  const body = await readJsonBody(req)
  const command = typeof body.command === 'string' ? body.command.trim() : ''
  if (!command) return sendJson(res, 400, { error: 'command is required.' })
  if (command.length > 10_000) return sendJson(res, 400, { error: 'command exceeds max length (10000).' })

  const permissionPolicy = normalizePermissionPolicy(getPermissionPolicy())
  const cwd = await resolveCwd(body.cwd, permissionPolicy)
  enforceCommandPolicy({ command, cwd, permissionPolicy })
  const timeoutMs = clampTimeout(body.timeoutMs)
  const env = body.env && typeof body.env === 'object' ? body.env : undefined

  const run = await createRun({
    type: 'exec',
    state: 'running',
    startedAt: Date.now(),
    summary: 'Executing local command',
    meta: {
      command: command.slice(0, 500),
      cwd,
      timeoutMs,
    },
  }).catch(() => null)

  let result
  try {
    result = await runCommand({ command, cwd, timeoutMs, env })
  } catch (err) {
    // Mark run as failed on unexpected errors so it doesn't stay stuck in 'running'.
    if (run?.runId) {
      await updateRun(run.runId, {
        state: 'failed',
        finishedAt: Date.now(),
        summary: 'Local command failed (unexpected error)',
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined)
    }
    throw err
  }
  if (run?.runId) {
    await updateRun(run.runId, {
      state: result.ok ? 'done' : 'failed',
      finishedAt: Date.now(),
      summary: result.ok ? 'Local command completed' : 'Local command failed',
      error: result.ok ? undefined : result.stderr,
      meta: {
        command: command.slice(0, 500),
        cwd,
        timeoutMs,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      },
    }).catch(() => undefined)
  }
  sendJson(res, 200, { ...result, command, cwd })
}

async function handleSessionStart(req, res, getPermissionPolicy, registerSessionRun) {
  const body = await readJsonBody(req)
  const command = typeof body.command === 'string' ? body.command.trim() : ''
  if (!command) return sendJson(res, 400, { error: 'command is required.' })
  if (command.length > 10_000) return sendJson(res, 400, { error: 'command exceeds max length (10000).' })

  const permissionPolicy = normalizePermissionPolicy(getPermissionPolicy())
  const cwd = await resolveCwd(body.cwd, permissionPolicy)
  enforceCommandPolicy({ command, cwd, permissionPolicy })
  const timeoutMs = clampTimeout(body.timeoutMs)
  const env = body.env && typeof body.env === 'object' ? body.env : undefined
  pruneSessions()
  const id = randomBytes(16).toString('hex')

  // Pre-register run BEFORE starting the session so that the exit listener
  // can always find the runId, even if the process exits immediately.
  await registerSessionRun({ id, command, cwd, timeoutMs })

  const session = startCommandSession({ id, command, cwd, timeoutMs, env })
  sendJson(res, 200, makeSessionSnapshot(session))
}

function handleSessionStatus(sessionId, res) {
  const session = getSessionById(sessionId)
  if (!session) return sendJson(res, 404, { error: 'Session not found.' })
  sendJson(res, 200, makeSessionSnapshot(session))
}

async function handleSessionStop(sessionId, req, res) {
  const body = await readJsonBody(req)
  const force = Boolean(body.force)
  const session = stopSession(sessionId, force)
  if (!session) return sendJson(res, 404, { error: 'Session not found.' })
  sendJson(res, 200, makeSessionSnapshot(session))
}

async function handleSessionWrite(sessionId, req, res) {
  const body = await readJsonBody(req)
  const text = typeof body.text === 'string' ? body.text : String(body.text || '')
  if (!text && !body.submit) {
    return sendJson(res, 400, { error: 'text is required unless submit=true.' })
  }
  const result = writeToSession(sessionId, text, Boolean(body.submit))
  sendJson(res, 200, result)
}

async function handleSessionSendKeys(sessionId, req, res) {
  const body = await readJsonBody(req)
  const keys = typeof body.keys === 'string' ? body.keys.trim() : ''
  if (!keys) {
    return sendJson(res, 400, { error: 'keys is required.' })
  }
  const result = sendKeysToSession(sessionId, keys)
  sendJson(res, 200, result)
}

function parseSessionStatusFilter(rawStatus) {
  if (typeof rawStatus !== 'string' || !rawStatus.trim()) return undefined
  const status = rawStatus.trim().toLowerCase()
  if (status !== 'running' && status !== 'exited') {
    throw new Error('status must be one of: running, exited')
  }
  return status
}

function handleSessionList(url, res) {
  const status = parseSessionStatusFilter(url.searchParams.get('status'))
  const result = listSessions({
    status,
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
  })
  sendJson(res, 200, { ok: true, ...result })
}

function handleSessionLog(sessionId, url, res) {
  const result = getSessionLog(sessionId, {
    stream: url.searchParams.get('stream') || 'both',
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
  })
  if (!result) return sendJson(res, 404, { error: 'Session not found.' })
  sendJson(res, 200, result)
}

function handleSessionEvents(url, res) {
  const result = listSessionEvents({
    after: url.searchParams.get('after'),
    limit: url.searchParams.get('limit'),
  })
  sendJson(res, 200, result)
}

function parseRunType(rawType) {
  if (typeof rawType !== 'string' || !rawType.trim()) return undefined
  const normalized = rawType.trim().toLowerCase()
  if (
    normalized !== 'exec'
    && normalized !== 'session'
    && normalized !== 'cron'
    && normalized !== 'heartbeat'
    && normalized !== 'acp'
    && normalized !== 'approval'
  ) {
    throw new Error('type must be one of: exec, session, cron, heartbeat, acp, approval')
  }
  return normalized
}

function parseRunState(rawState) {
  if (typeof rawState !== 'string' || !rawState.trim()) return undefined
  const normalized = rawState.trim().toLowerCase()
  if (
    normalized !== 'queued'
    && normalized !== 'idle'
    && normalized !== 'running'
    && normalized !== 'waiting_approval'
    && normalized !== 'retrying'
    && normalized !== 'done'
    && normalized !== 'failed'
    && normalized !== 'cancelled'
  ) {
    throw new Error('state must be one of: queued, idle, running, waiting_approval, retrying, done, failed, cancelled')
  }
  return normalized
}

async function handleRunList(url, res) {
  const result = await listRuns({
    type: parseRunType(url.searchParams.get('type')),
    state: parseRunState(url.searchParams.get('state')),
    limit: url.searchParams.get('limit'),
    offset: url.searchParams.get('offset'),
  })
  sendJson(res, 200, { ok: true, ...result })
}

async function handleRunById(runId, res) {
  const run = await getRunById(runId)
  if (!run) {
    return sendJson(res, 404, { error: 'Run not found.' })
  }
  sendJson(res, 200, { ok: true, run })
}

async function handleRunDiagnostics(url, res) {
  const diagnostics = await getRunDiagnostics({
    limit: url.searchParams.get('limit'),
  })
  sendJson(res, 200, diagnostics)
}

// ── Server factory ──

export function createCompanionServer({
  token,
  mcpManager,
  getAllowedOrigins = async () => [],
  getPermissionPolicy = () => normalizePermissionPolicy({ mode: 'full' }),
  setPermissionPolicy = async () => {
    throw new Error('Permission policy updates are not enabled.')
  },
  setMcpServerConfig = async () => {
    throw new Error('MCP server config updates are not enabled.')
  },
  removeMcpServerConfig = async () => {
    throw new Error('MCP server config removal is not enabled.')
  },
  shutdownFn = null,
  cleanupFn = null,
  normalizeMediaImage = normalizeImagePayload,
  getMediaSupport = getMediaNormalizationSupport,
}) {
  const sessionRunIndex = new Map()
  let lastKnownOriginPolicy = {
    allowedOrigins: [],
    allowUnpairedExtensionOrigin: false,
  }
  const serializeApprovalMutation = createKeyedSerializer()
  const initStoresPromise = Promise.all([
    loadRunStore().catch(() => undefined),
    loadApprovalStore().catch(() => undefined),
  ]).then(async () => {
    await restoreSessionRunStateOnStartup(sessionRunIndex).catch(() => undefined)
  })
  const detachAcpTransitionHook = setAcpSessionTransitionHook(async (event) => {
    const runId = event.runId || sessionRunIndex.get(event.sessionId)
    if (!runId) return
    const currentRun = await getRunById(runId).catch(() => null)
    const mappedState =
      event.toState === 'idle'
        ? 'idle'
        : event.toState === 'running'
          ? 'running'
          : event.toState === 'done'
            ? 'done'
            : event.toState === 'cancelled'
              ? 'cancelled'
              : 'failed'
    await updateRun(runId, {
      state: mappedState,
      ...(mappedState === 'running'
        ? { startedAt: Date.now() }
        : { finishedAt: Date.now() }),
      summary: `ACP session ${event.toState}`,
      ...(mappedState === 'failed' ? { error: String(event.meta?.reason || 'acp_error') } : {}),
      meta: mergeRunMeta(currentRun, {
        sessionId: event.sessionId,
        agentType: event.agentType,
        ...(event.origin ? { origin: event.origin } : {}),
        ...(event.inputProvenance ? { inputProvenance: event.inputProvenance } : {}),
        ...(event.inputProvenance?.conversationId ? { conversationId: event.inputProvenance.conversationId } : {}),
        ...(event.meta && typeof event.meta === 'object' ? event.meta : {}),
      }),
    }).catch(() => undefined)
    if (mappedState === 'done' || mappedState === 'failed' || mappedState === 'cancelled') {
      await clearSessionRunLink(event.sessionId).catch(() => undefined)
      sessionRunIndex.delete(event.sessionId)
    }
  })
  const detachAcpEventHook = setAcpSessionEventHook(async (event) => {
    if (event.type !== 'status' || event.statusCode !== 'awaiting_approval') return
    const runId = String(event.runId || sessionRunIndex.get(event.sessionId) || '').trim()
    if (!runId) return

    const currentRun = await getRunById(runId).catch(() => null)
    const approval = await createApproval({
      requestId: buildAcpApprovalRequestId(event),
      conversationId: String(currentRun?.meta?.conversationId || ''),
      toolName: 'acp_permission',
      toolPreview: trimApprovalText(event.text || 'ACP session requires approval'),
      riskLevel: 'high',
      channels: ['sidepanel'],
      expiresAt: Date.now() + 120_000,
      meta: mergeRunMeta(currentRun, {
        runId,
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.agentType ? { agentType: event.agentType } : {}),
        ...(event.origin ? { origin: event.origin } : {}),
        ...(event.inputProvenance ? { inputProvenance: event.inputProvenance } : {}),
        ...(event.inputProvenance?.conversationId ? { conversationId: event.inputProvenance.conversationId } : {}),
        approvalSource: 'acp',
        approvalSignal: 'awaiting_approval',
      }),
    }).catch(() => null)
    if (!approval) return

    await updateRun(runId, {
      state: 'waiting_approval',
      summary: 'ACP awaiting approval',
      meta: mergeRunMeta(currentRun, {
        requestId: approval.requestId,
        sessionId: event.sessionId,
        approvalStatus: approval.status,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.origin ? { origin: event.origin } : {}),
        ...(event.inputProvenance ? { inputProvenance: event.inputProvenance } : {}),
        ...(event.inputProvenance?.conversationId ? { conversationId: event.inputProvenance.conversationId } : {}),
        approvalSource: 'acp',
      }),
    }).catch(() => undefined)
  })
  const detachSessionExitListener = addSessionExitListener((session) => {
    const runId = sessionRunIndex.get(session.sessionId || '')
    if (!runId) return
    const succeeded = !session.timedOut && session.exitCode === 0
    void getRunById(runId).catch(() => null).then((currentRun) => updateRun(runId, {
      state: succeeded ? 'done' : 'failed',
      finishedAt: session.finishedAt || Date.now(),
      summary: succeeded ? 'Session completed' : 'Session failed',
      error: succeeded ? undefined : `exitCode=${session.exitCode}, timedOut=${Boolean(session.timedOut)}`,
      meta: mergeRunMeta(currentRun, {
        sessionId: session.sessionId,
        command: session.command?.slice(0, 500),
        cwd: session.cwd,
        exitCode: session.exitCode,
        timedOut: session.timedOut,
        durationMs: session.durationMs,
      }),
    }).catch(() => undefined))
      .finally(() => {
        void clearSessionRunLink(session.sessionId || '').catch(() => undefined)
        sessionRunIndex.delete(session.sessionId || '')
      })
  })

  /** Register a run for a session. Must be awaited before the session starts
   *  so that sessionRunIndex is populated before a fast-exiting process can
   *  trigger the exit listener. */
  const registerSessionRun = async (session) => {
    try {
      const run = await createRun({
        type: 'session',
        state: 'running',
        startedAt: Date.now(),
        summary: 'Session started',
        meta: {
          sessionId: session.id,
          command: session.command?.slice(0, 500),
          cwd: session.cwd,
          timeoutMs: session.timeoutMs,
        },
      })
      sessionRunIndex.set(session.id, run.runId)
      await setSessionRunLink(session.id, run.runId, { type: 'session' }).catch(() => undefined)
    } catch {
      // createRun failure is non-fatal — session still runs, just no run record.
    }
  }

  const createAcpRun = async (session) => {
    try {
      const run = await createRun({
        type: 'acp',
        state: 'idle',
        summary: 'ACP session created',
        meta: {
          sessionId: session.sessionId,
          agentType: session.agentType,
          cwd: session.cwd,
          ...(session.origin ? { origin: session.origin } : {}),
          ...(session.inputProvenance ? { inputProvenance: session.inputProvenance } : {}),
          ...(session.inputProvenance?.conversationId ? { conversationId: session.inputProvenance.conversationId } : {}),
        },
      })
      sessionRunIndex.set(session.sessionId, run.runId)
      await setSessionRunLink(session.sessionId, run.runId, { type: 'acp' }).catch(() => undefined)
      return run
    } catch {
      return null
    }
  }

  const syncAcpRunIngress = async (session, turnId) => {
    const sessionId = String(session?.sessionId || '').trim()
    if (!sessionId) return
    const runId = String(session?.runId || sessionRunIndex.get(sessionId) || '').trim()
    if (!runId) return
    const currentRun = await getRunById(runId).catch(() => null)
    await updateRun(runId, {
      meta: mergeRunMeta(currentRun, {
        sessionId,
        ...(turnId ? { turnId } : {}),
        ...(session?.agentType ? { agentType: session.agentType } : {}),
        ...(session?.origin ? { origin: session.origin } : {}),
        ...(session?.inputProvenance ? { inputProvenance: session.inputProvenance } : {}),
        ...(session?.inputProvenance?.conversationId ? { conversationId: session.inputProvenance.conversationId } : {}),
      }),
    }).catch(() => undefined)
  }

  const server = createServer(async (req, res) => {
    await initStoresPromise
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const pathname = url.pathname
    try {
      const resolvedAllowedOrigins = await getAllowedOrigins()
      if (Array.isArray(resolvedAllowedOrigins)) {
        lastKnownOriginPolicy = {
          allowedOrigins: resolvedAllowedOrigins,
          allowUnpairedExtensionOrigin: resolvedAllowedOrigins.length === 0,
        }
      }
    } catch {
      // Keep serving with the last known good origin policy when config reads fail.
    }
    const corsHeaders = buildCorsHeaders({
      origin: req.headers.origin,
      allowedOrigins: lastKnownOriginPolicy.allowedOrigins,
      allowUnpairedExtensionOrigin: lastKnownOriginPolicy.allowUnpairedExtensionOrigin,
    })
    for (const [header, value] of Object.entries(corsHeaders)) {
      res.setHeader(header, value)
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return sendJson(res, 200, { ok: true })
    }

    // Health check (requires auth)
    if (req.method === 'GET' && pathname === '/healthz') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      const capabilities = buildCompanionCapabilitiesPayload()
      return sendJson(res, 200, {
        ok: true,
        ts: Date.now(),
        pid: process.pid,
        version: capabilities.version,
        protocolVersion: capabilities.protocolVersion,
        supportedFeatures: capabilities.supportedFeatures,
        mcpServers: mcpManager.getConnectedCount(),
        mcpTools: mcpManager.getAllTools().length,
        permissionPolicy: normalizePermissionPolicy(getPermissionPolicy()),
      })
    }

    // ── System management endpoints ──

    if (req.method === 'POST' && pathname === '/api/system/shutdown') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      if (typeof shutdownFn !== 'function') {
        return sendJson(res, 501, { error: 'Shutdown not available.' })
      }
      sendJson(res, 200, { ok: true })
      setTimeout(() => shutdownFn(), 200)
      return
    }

    if (req.method === 'POST' && pathname === '/api/system/restart') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      if (typeof shutdownFn !== 'function') {
        return sendJson(res, 501, { error: 'Restart not available.' })
      }
      // Spawn a detached replacement daemon, then shut down current process.
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [process.argv[1], 'start', '-d'], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      sendJson(res, 200, { ok: true, message: 'restarting' })
      setTimeout(() => shutdownFn(), 500)
      return
    }

    if (req.method === 'POST' && pathname === '/api/system/cleanup') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      const errors = []
      if (typeof cleanupFn === 'function') {
        try { await cleanupFn() } catch (err) { errors.push(err.message || String(err)) }
      }
      sendJson(res, 200, { ok: true, errors: errors.length > 0 ? errors : undefined })
      if (typeof shutdownFn === 'function') {
        setTimeout(() => shutdownFn(), 200)
      }
      return
    }

    if (req.method === 'GET' && pathname === '/api/system/capabilities') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return sendJson(res, 200, buildCompanionCapabilitiesPayload())
    }

    if (req.method === 'GET' && pathname === '/api/system/diagnostics') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      const capabilities = buildCompanionCapabilitiesPayload()
      const diagnostics = await buildDiagnosticsPayload({
        protocolVersion: capabilities.protocolVersion,
        version: capabilities.version,
        supportedFeatures: capabilities.supportedFeatures,
        getPermissionPolicy,
        getMediaSupport,
        mcpManager,
      })
      return sendJson(res, 200, diagnostics)
    }

    if (req.method === 'GET' && pathname === '/api/system/self-check') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      const result = await runCompanionSelfCheck({
        getPermissionPolicy,
      })
      return sendJson(res, 200, result)
    }

    if (req.method === 'POST' && pathname === '/api/media/normalize') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const body = await readJsonBody(req, MEDIA_NORMALIZE_JSON_BODY_MAX_BYTES)
        const payload = await normalizeMediaImage(body, {
          support: await getMediaSupport(),
        })
        return sendJson(res, 200, payload)
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    if (req.method === 'POST' && pathname === '/api/system/repair') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const body = await readJsonBody(req)
        const result = await runCompanionRepairAction(body, { getPermissionPolicy })
        return sendJson(res, 200, result)
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    // ── Command Runtime endpoints ──
    // Support both /api/local-runtime/* (legacy) and /api/runtime/* (new)

    const isExec = (
      req.method === 'POST' &&
      (pathname === '/api/local-runtime/exec' || pathname === '/api/runtime/exec')
    )
    if (isExec) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return await handleExec(req, res, getPermissionPolicy) }
      catch (err) {
        if (err instanceof PermissionPolicyError) {
          return sendJson(res, 403, { error: err.message, code: 'permission_policy_violation' })
        }
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    const isSessionStart = (
      req.method === 'POST' &&
      (pathname === '/api/local-runtime/session/start' || pathname === '/api/runtime/session/start')
    )
    if (isSessionStart) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return await handleSessionStart(req, res, getPermissionPolicy, registerSessionRun) }
      catch (err) {
        if (err instanceof PermissionPolicyError) {
          return sendJson(res, 403, { error: err.message, code: 'permission_policy_violation' })
        }
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    const isSessionList = (
      req.method === 'GET' &&
      (pathname === '/api/local-runtime/sessions' || pathname === '/api/runtime/sessions')
    )
    if (isSessionList) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return handleSessionList(url, res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    const sessionLogMatch = pathname.match(
      /^\/api\/(?:local-runtime|runtime)\/sessions\/([^/]+)\/log$/
    )
    if (req.method === 'GET' && sessionLogMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return handleSessionLog(decodeURIComponent(sessionLogMatch[1]), url, res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    // Session status — GET /api/(local-runtime|runtime)/session/:id
    const sessionStatusMatch = pathname.match(
      /^\/api\/(?:local-runtime|runtime)\/session\/([^/]+)$/
    )
    if (req.method === 'GET' && sessionStatusMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return handleSessionStatus(decodeURIComponent(sessionStatusMatch[1]), res)
    }

    // Session stop — POST /api/(local-runtime|runtime)/session/:id/stop
    const sessionStopMatch = pathname.match(
      /^\/api\/(?:local-runtime|runtime)\/session\/([^/]+)\/stop$/
    )
    if (req.method === 'POST' && sessionStopMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return await handleSessionStop(decodeURIComponent(sessionStopMatch[1]), req, res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    // Session stdin write — POST /api/(local-runtime|runtime)/session/:id/write
    const sessionWriteMatch = pathname.match(
      /^\/api\/(?:local-runtime|runtime)\/session\/([^/]+)\/write$/,
    )
    if (req.method === 'POST' && sessionWriteMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return await handleSessionWrite(decodeURIComponent(sessionWriteMatch[1]), req, res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    // Session send keys — POST /api/(local-runtime|runtime)/session/:id/send-keys
    const sessionSendKeysMatch = pathname.match(
      /^\/api\/(?:local-runtime|runtime)\/session\/([^/]+)\/send-keys$/,
    )
    if (req.method === 'POST' && sessionSendKeysMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return await handleSessionSendKeys(decodeURIComponent(sessionSendKeysMatch[1]), req, res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    // Session events — GET /api/(local-runtime|runtime)/session-events
    const isSessionEvents = (
      req.method === 'GET'
      && (pathname === '/api/local-runtime/session-events' || pathname === '/api/runtime/session-events')
    )
    if (isSessionEvents) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return handleSessionEvents(url, res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    // Runs diagnostics — GET /api/(local-runtime|runtime)/runs/diagnostics
    const isRunDiagnostics = (
      req.method === 'GET'
      && (pathname === '/api/local-runtime/runs/diagnostics' || pathname === '/api/runtime/runs/diagnostics')
    )
    if (isRunDiagnostics) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return await handleRunDiagnostics(url, res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    // Runs list — GET /api/(local-runtime|runtime)/runs
    const isRunList = (
      req.method === 'GET'
      && (pathname === '/api/local-runtime/runs' || pathname === '/api/runtime/runs')
    )
    if (isRunList) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return await handleRunList(url, res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    // Run by id — GET /api/(local-runtime|runtime)/runs/:id
    const runByIdMatch = pathname.match(/^\/api\/(?:local-runtime|runtime)\/runs\/([^/]+)$/)
    if (req.method === 'GET' && runByIdMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return await handleRunById(decodeURIComponent(runByIdMatch[1]), res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    // ── Approval endpoints (Phase B SoT) ──

    // Create approval — POST /api/runtime/approvals
    if (req.method === 'POST' && pathname === '/api/runtime/approvals') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const body = await readJsonBody(req)
        const requestId = String(body.requestId || '').trim()
        const result = await serializeApprovalMutation(requestId, async () => {
          const existing = requestId ? await getApprovalById(requestId).catch(() => null) : null
          const existingRunId = String(existing?.meta?.runId || '').trim()
          let run = existingRunId ? await getRunById(existingRunId).catch(() => null) : null
          if (!run) {
            run = await createRun({
              type: 'approval',
              state: 'waiting_approval',
              startedAt: Date.now(),
              summary: 'Awaiting approval',
              meta: {
                requestId,
                conversationId: String(body.conversationId || ''),
                toolName: String(body.toolName || ''),
                toolPreview: String(body.toolPreview || '').slice(0, 500),
                riskLevel: String(body.riskLevel || 'medium'),
                channels: Array.isArray(body.channels) ? body.channels.map(String) : [],
                ...(body.meta && typeof body.meta === 'object' ? body.meta : {}),
              },
            }).catch(() => null)
          }
          let record = await createApproval({
            ...body,
            meta: {
              ...(body.meta && typeof body.meta === 'object' ? body.meta : {}),
              ...(run?.runId ? { runId: run.runId } : {}),
            },
          })
          if (run?.runId && String(record.meta?.runId || '').trim() !== run.runId) {
            record = await relinkApprovalRun(record.requestId, run.runId).catch(() => null) || record
          }
          if (run?.runId) {
            const desiredState = record.status === 'approved'
              ? 'done'
              : record.status === 'pending'
                ? 'waiting_approval'
                : 'cancelled'
            await updateRun(run.runId, {
              state: desiredState,
              ...(desiredState === 'waiting_approval'
                ? {}
                : { finishedAt: Number(run.finishedAt) || Date.now() }),
              summary: record.status === 'approved'
                ? 'Approval approved'
                : record.status === 'expired'
                  ? 'Approval expired'
                  : record.status === 'rejected'
                    ? 'Approval rejected'
                    : 'Awaiting approval',
              meta: mergeRunMeta(run, {
                requestId: record.requestId,
                conversationId: record.conversationId,
                toolName: record.toolName,
                toolPreview: record.toolPreview,
                riskLevel: record.riskLevel,
                channels: record.channels,
                toolCallId: record.meta?.toolCallId,
                correlationId: record.meta?.correlationId,
                approvalStatus: record.status,
                ...(record.resolvedBy ? { resolvedBy: record.resolvedBy } : {}),
              }),
            }).catch(() => undefined)
          }
          return {
            statusCode: existing ? 200 : 201,
            record,
          }
        })
        return sendJson(res, result.statusCode, result.record)
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    // List pending approvals — GET /api/runtime/approvals/pending
    if (req.method === 'GET' && pathname === '/api/runtime/approvals/pending') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const expired = await expireOverdueApprovals()
        for (const record of expired) {
          const runId = String(record.meta?.runId || '').trim()
          if (!runId) continue
          await updateRun(runId, {
            state: 'cancelled',
            finishedAt: Date.now(),
            summary: 'Approval expired',
            meta: {
              ...(record.meta && typeof record.meta === 'object' ? record.meta : {}),
              approvalStatus: 'expired',
            },
          }).catch(() => undefined)
        }
        const pending = await listPendingApprovals()
        return sendJson(res, 200, { approvals: pending })
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    // Resolve approval — POST /api/runtime/approvals/:id/resolve
    const approvalResolveMatch = pathname.match(/^\/api\/runtime\/approvals\/([^/]+)\/resolve$/)
    if (req.method === 'POST' && approvalResolveMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const body = await readJsonBody(req)
        const requestId = decodeURIComponent(approvalResolveMatch[1])
        const resolution = String(body.resolution || 'rejected')
        const resolvedBy = body.resolvedBy || undefined
        const record = await resolveApproval(requestId, resolution, resolvedBy)
        if (!record) return sendJson(res, 404, { error: 'Approval not found.' })
        const runId = String(record.meta?.runId || '').trim()
        if (runId) {
          const state = record.status === 'approved'
            ? 'done'
            : record.status === 'pending'
              ? 'waiting_approval'
              : 'cancelled'
          await updateRun(runId, {
            state,
            ...(state === 'waiting_approval'
              ? {}
              : { finishedAt: Date.now() }),
            summary: record.status === 'approved'
              ? 'Approval approved'
              : record.status === 'expired'
                ? 'Approval expired'
                : 'Approval rejected',
            meta: {
              ...(record.meta && typeof record.meta === 'object' ? record.meta : {}),
              requestId: record.requestId,
              conversationId: record.conversationId,
              approvalStatus: record.status,
              ...(record.resolvedBy ? { resolvedBy: record.resolvedBy } : {}),
            },
          }).catch(() => undefined)
        }
        return sendJson(res, 200, record)
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    // Get approval by id — GET /api/runtime/approvals/:id
    const approvalByIdMatch = pathname.match(/^\/api\/runtime\/approvals\/([^/]+)$/)
    if (req.method === 'GET' && approvalByIdMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const expired = await expireOverdueApprovals()
        for (const item of expired) {
          const runId = String(item.meta?.runId || '').trim()
          if (!runId) continue
          await updateRun(runId, {
            state: 'cancelled',
            finishedAt: Date.now(),
            summary: 'Approval expired',
            meta: {
              ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
              approvalStatus: 'expired',
            },
          }).catch(() => undefined)
        }
        const requestId = decodeURIComponent(approvalByIdMatch[1])
        const record = await getApprovalById(requestId)
        if (!record) return sendJson(res, 404, { error: 'Approval not found.' })
        return sendJson(res, 200, record)
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    // ── MCP endpoints ──

    // List MCP servers
    if (req.method === 'GET' && pathname === '/api/mcp/servers') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return sendJson(res, 200, { servers: mcpManager.getServers() })
    }

    // List all MCP tools
    if (req.method === 'GET' && pathname === '/api/mcp/tools') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return sendJson(res, 200, { tools: mcpManager.getAllTools() })
    }

    // Call an MCP tool
    if (req.method === 'POST' && pathname === '/api/mcp/tools/call') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const body = await readJsonBody(req)
        const { server, tool, arguments: toolArgs } = body
        if (!server || !tool) {
          return sendJson(res, 400, { error: '"server" and "tool" are required.' })
        }
        const result = await mcpManager.callTool(server, tool, toolArgs || {})
        return sendJson(res, 200, result)
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    // Upsert MCP server config and hot-reload that server
    if (req.method === 'POST' && pathname === '/api/mcp/servers/upsert') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const body = await readJsonBody(req)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) {
          return sendJson(res, 400, { error: '"name" is required.' })
        }
        const config = body.config
        await setMcpServerConfig(name, config)
        const server = mcpManager.getServers().find((item) => item.name === name)
        return sendJson(res, 200, { ok: true, name, server })
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message || 'Invalid request.' })
      }
    }

    // Remove MCP server config and stop that server
    const serverDeleteMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)$/)
    if (req.method === 'DELETE' && serverDeleteMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      const name = decodeURIComponent(serverDeleteMatch[1])
      try {
        const result = await removeMcpServerConfig(name)
        return sendJson(res, 200, {
          ok: true,
          name,
          removed: Boolean(result?.removed ?? true),
        })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message || 'Failed to remove MCP server.' })
      }
    }

    // Restart an MCP server
    const serverRestartMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/restart$/)
    if (req.method === 'POST' && serverRestartMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      const name = decodeURIComponent(serverRestartMatch[1])
      try {
        await mcpManager.restartServer(name)
        return sendJson(res, 200, { ok: true, name })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message })
      }
    }

    // Get permission policy
    if (req.method === 'GET' && pathname === '/api/security/policy') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return sendJson(res, 200, { policy: normalizePermissionPolicy(getPermissionPolicy()) })
    }

    // Update permission policy
    if (req.method === 'POST' && pathname === '/api/security/policy') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const body = await readJsonBody(req)
        const nextPolicy = normalizePermissionPolicy(body.policy || body, { strict: true })
        await setPermissionPolicy(nextPolicy)
        return sendJson(res, 200, { ok: true, policy: nextPolicy })
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message || 'Invalid request.' })
      }
    }

    // ── Cron endpoints ──

    // List all cron jobs
    if (req.method === 'GET' && pathname === '/api/cron/jobs') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return sendJson(res, 200, { jobs: getJobs() })
    }

    // Upsert a cron job (sync from extension)
    if (req.method === 'POST' && pathname === '/api/cron/jobs') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const body = await readJsonBody(req)
        if (!body.id) return sendJson(res, 400, { error: '"id" is required.' })
        await upsertJob(body)
        rescheduleJob(body)
        return sendJson(res, 200, { ok: true, id: body.id })
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    // Delete a cron job
    const cronJobDeleteMatch = pathname.match(/^\/api\/cron\/jobs\/([^/]+)$/)
    if (req.method === 'DELETE' && cronJobDeleteMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      const taskId = decodeURIComponent(cronJobDeleteMatch[1])
      unscheduleJob(taskId)
      const removed = await removeJob(taskId)
      return sendJson(res, 200, { ok: true, removed })
    }

    // Get pending (missed) runs
    if (req.method === 'GET' && pathname === '/api/cron/pending') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return sendJson(res, 200, { pending: getPendingRuns() })
    }

    // Acknowledge pending runs
    if (req.method === 'POST' && pathname === '/api/cron/pending/ack') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const body = await readJsonBody(req)
        const acked = await ackPendingRuns(body)
        return sendJson(res, 200, { ok: true, acked })
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    // ── Skill asset endpoints ──

    // Extract skill assets to disk
    if (req.method === 'POST' && pathname === '/api/skills/extract') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const body = await readJsonBody(req, 6 * 1024 * 1024)
        const { skillName, assets, skillMd } = body
        if (!skillName || typeof skillName !== 'string') {
          return sendJson(res, 400, { error: '"skillName" is required.' })
        }
        if (!Array.isArray(assets)) {
          return sendJson(res, 400, { error: '"assets" must be an array.' })
        }
        const result = await extractSkillAssets(skillName, assets, skillMd)
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Failed to extract skill assets.' })
      }
    }

    // Remove skill assets from disk — DELETE /api/skills/:name
    const skillDeleteMatch = pathname.match(/^\/api\/skills\/([^/]+)$/)
    if (req.method === 'DELETE' && skillDeleteMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      const skillName = decodeURIComponent(skillDeleteMatch[1])
      try {
        const result = await removeSkillAssets(skillName)
        return sendJson(res, 200, { ok: true, ...result })
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Failed to remove skill assets.' })
      }
    }

    // ── ACP endpoints ──
    const acpHandled = await handleAcpRequest(req, res, url, pathname, {
      token,
      authorize: (r) => authorize(r, token),
      sendJson,
      readJsonBody,
      createAcpRun,
      syncAcpRunIngress,
    })
    if (acpHandled) return

    sendJson(res, 404, { error: `Not found: ${pathname}` })
  })

  // Start periodic session pruning
  startSessionPruner()

  // Cleanup on server close
  server.on('close', () => {
    detachSessionExitListener()
    detachAcpTransitionHook()
    detachAcpEventHook()
    sessionRunIndex.clear()
    stopSessionPruner()
    cleanupAllSessions()
    cleanupAllAcpSessions()
    void flushRunStore().catch(() => undefined)
    void flushApprovalStore().catch(() => undefined)
  })

  return server
}
