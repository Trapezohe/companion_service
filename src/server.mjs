/**
 * Unified HTTP server — command runtime + MCP API.
 *
 * All endpoints require Bearer token auth + loopback-only access.
 * Backwards-compatible with existing /api/local-runtime/* paths.
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
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
  getRunById,
  getRunDiagnostics,
  listRuns,
  loadRunStore,
  updateRun,
  flushRunStore,
} from './run-store.mjs'
import {
  createApproval,
  resolveApproval,
  getApprovalById,
  listPendingApprovals,
  loadApprovalStore,
  flushApprovalStore,
} from './approval-store.mjs'

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

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  })
  res.end(JSON.stringify(payload))
}

function isLoopback(addr) {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

async function readJsonBody(req, maxSize = 1024 * 1024) {
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
  if (normalized !== 'exec' && normalized !== 'session' && normalized !== 'cron' && normalized !== 'heartbeat') {
    throw new Error('type must be one of: exec, session, cron, heartbeat')
  }
  return normalized
}

function parseRunState(rawState) {
  if (typeof rawState !== 'string' || !rawState.trim()) return undefined
  const normalized = rawState.trim().toLowerCase()
  if (
    normalized !== 'queued'
    && normalized !== 'running'
    && normalized !== 'waiting_approval'
    && normalized !== 'retrying'
    && normalized !== 'done'
    && normalized !== 'failed'
  ) {
    throw new Error('state must be one of: queued, running, waiting_approval, retrying, done, failed')
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
  getPermissionPolicy = () => normalizePermissionPolicy({ mode: 'full' }),
  setPermissionPolicy = async () => {
    throw new Error('Permission policy updates are not enabled.')
  },
}) {
  void loadRunStore().catch(() => undefined)
  void loadApprovalStore().catch(() => undefined)
  const sessionRunIndex = new Map()
  const detachSessionExitListener = addSessionExitListener((session) => {
    const runId = sessionRunIndex.get(session.sessionId || '')
    if (!runId) return
    const succeeded = !session.timedOut && session.exitCode === 0
    void updateRun(runId, {
      state: succeeded ? 'done' : 'failed',
      finishedAt: session.finishedAt || Date.now(),
      summary: succeeded ? 'Session completed' : 'Session failed',
      error: succeeded ? undefined : `exitCode=${session.exitCode}, timedOut=${Boolean(session.timedOut)}`,
      meta: {
        sessionId: session.sessionId,
        command: session.command?.slice(0, 500),
        cwd: session.cwd,
        exitCode: session.exitCode,
        timedOut: session.timedOut,
        durationMs: session.durationMs,
      },
    }).catch(() => undefined)
      .finally(() => {
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
    } catch {
      // createRun failure is non-fatal — session still runs, just no run record.
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const pathname = url.pathname

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return sendJson(res, 200, { ok: true })
    }

    // Health check (requires auth)
    if (req.method === 'GET' && pathname === '/healthz') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return sendJson(res, 200, {
        ok: true,
        ts: Date.now(),
        pid: process.pid,
        version: '0.1.0',
        mcpServers: mcpManager.getConnectedCount(),
        mcpTools: mcpManager.getAllTools().length,
        permissionPolicy: normalizePermissionPolicy(getPermissionPolicy()),
      })
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
        const record = await createApproval(body)
        return sendJson(res, 201, record)
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    // List pending approvals — GET /api/runtime/approvals/pending
    if (req.method === 'GET' && pathname === '/api/runtime/approvals/pending') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
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
        const taskIds = Array.isArray(body.taskIds) ? body.taskIds : []
        await ackPendingRuns(taskIds)
        return sendJson(res, 200, { ok: true, acked: taskIds.length })
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

    sendJson(res, 404, { error: `Not found: ${pathname}` })
  })

  // Start periodic session pruning
  startSessionPruner()

  // Cleanup on server close
  server.on('close', () => {
    detachSessionExitListener()
    sessionRunIndex.clear()
    stopSessionPruner()
    cleanupAllSessions()
    void flushRunStore().catch(() => undefined)
    void flushApprovalStore().catch(() => undefined)
  })

  return server
}
