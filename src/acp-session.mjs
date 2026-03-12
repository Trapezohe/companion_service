/**
 * ACP (Agent Client Protocol) session manager — P0 control-plane.
 *
 * Provides event normalization, forced terminal state semantics,
 * actor-queue serialization, and cancel-bypass for AI agent sessions.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { applyAcpSessionState, setAcpSessionTransitionHook } from './acp-lifecycle.mjs'
import { spawnAgentChild as spawnAgentChildFromProcess } from './acp-process.mjs'
import {
  parseAgentLine as parseAgentLineFromEvents,
  synthesizeTerminalEvent as synthesizeTerminalEventFromEvents,
} from './acp-events.mjs'
import {
  classifyNoOutputDiagnostic as classifyNoOutputDiagnosticFromModule,
  emitNoOutputDiagnosticIfNeeded as emitNoOutputDiagnosticIfNeededFromModule,
  emitSessionProbeIfNeeded as emitSessionProbeIfNeededFromModule,
} from './acp-diagnostics.mjs'
import {
  buildAgentPath as buildAgentPathFromAuth,
  normalizeClaudeAuthEnv as normalizeClaudeAuthEnvFromAuth,
  resolveAgentAuthCheck as resolveAgentAuthCheckFromAuth,
  resolveAgentDefaultCommand,
} from './acp-auth.mjs'

// ── Constants ──

const MAX_EVENTS_PER_SESSION = Number(process.env.TRAPEZOHE_ACP_MAX_EVENTS || 2000)
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const CANCEL_KILL_DELAY_MS = 3_000
const DEFAULT_NO_OUTPUT_HEARTBEAT_MS = Number(process.env.TRAPEZOHE_ACP_NO_OUTPUT_HEARTBEAT_MS || 30_000)
const DEFAULT_NO_OUTPUT_CHECK_INTERVAL_MS = Number(process.env.TRAPEZOHE_ACP_NO_OUTPUT_CHECK_INTERVAL_MS || 2_500)
const NO_OUTPUT_DIAGNOSTIC_HEARTBEAT_THRESHOLD = Number(process.env.TRAPEZOHE_ACP_NO_OUTPUT_DIAGNOSTIC_HEARTBEATS || 4)
const NO_OUTPUT_DIAGNOSTIC_REPEAT_HEARTBEATS = Number(process.env.TRAPEZOHE_ACP_NO_OUTPUT_DIAGNOSTIC_REPEAT_HEARTBEATS || 8)
const NO_OUTPUT_DIAGNOSTIC_EVENT_SCAN_LIMIT = Number(process.env.TRAPEZOHE_ACP_NO_OUTPUT_DIAGNOSTIC_EVENT_SCAN_LIMIT || 120)
/** TTL for terminal sessions before GC sweeps them (default: 10 minutes). */
const SESSION_TTL_MS = Number(process.env.TRAPEZOHE_ACP_SESSION_TTL_MS || 10 * 60 * 1000)
/** GC sweep interval (default: 60 seconds). */
const GC_INTERVAL_MS = Number(process.env.TRAPEZOHE_ACP_GC_INTERVAL_MS || 60_000)
const DEFAULT_SESSION_PROBE_HEARTBEATS = Number(process.env.TRAPEZOHE_ACP_SESSION_PROBE_HEARTBEATS || 2)

export { setAcpSessionTransitionHook }

// ── Module-level singletons ──

const acpSessions = new Map()
const acpEventBuffers = new Map()
let nextAcpEventCursor = 1
let sessionEventHook = null

// ── ACP Event types (5 canonical types) ──
// text_delta | tool_call | status | done | error

function now() {
  return Date.now()
}

function clonePermissionPolicy(policy) {
  return policy && typeof policy === 'object'
    ? JSON.parse(JSON.stringify(policy))
    : null
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function normalizeNoOutputHeartbeatMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_NO_OUTPUT_HEARTBEAT_MS
  if (parsed <= 0) return 0
  return Math.max(Math.round(parsed), 50)
}

function normalizeNoOutputCheckIntervalMs(value, heartbeatMs) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.max(Math.round(parsed), 25)
  }
  if (heartbeatMs <= 0) return 0
  const derived = Math.max(Math.floor(heartbeatMs / 3), 50)
  return Math.min(derived, DEFAULT_NO_OUTPUT_CHECK_INTERVAL_MS)
}

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function parseOptionalBoolean(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function shouldEmitSessionProbeDiagnostics() {
  return parseOptionalBoolean(process.env.TRAPEZOHE_ACP_DIAGNOSTIC_SESSION_PROBE) !== false
}

export function buildAgentPath(basePath, opts = {}) {
  return buildAgentPathFromAuth(basePath, opts)
}

export function normalizeClaudeAuthEnv(env = {}) {
  return normalizeClaudeAuthEnvFromAuth(env)
}

export function resolveAgentAuthCheck(agentType, env = {}) {
  return resolveAgentAuthCheckFromAuth(agentType, env)
}

function getRecentSessionEvents(sessionId, limit = NO_OUTPUT_DIAGNOSTIC_EVENT_SCAN_LIMIT) {
  const buffer = acpEventBuffers.get(sessionId)
  if (!Array.isArray(buffer) || buffer.length === 0) return []
  const size = Math.max(1, Math.floor(limit))
  return buffer.slice(Math.max(0, buffer.length - size))
}

export function classifyNoOutputDiagnostic(input = {}) {
  return classifyNoOutputDiagnosticFromModule(input)
}

function emitNoOutputDiagnosticIfNeeded(session, silenceSeconds) {
  emitNoOutputDiagnosticIfNeededFromModule(session, silenceSeconds, {
    getRecentEvents: (sessionId) => getRecentSessionEvents(sessionId),
    pushEvent: (sessionId, event) => pushAcpEvent(sessionId, event),
    heartbeatThreshold: NO_OUTPUT_DIAGNOSTIC_HEARTBEAT_THRESHOLD,
    repeatHeartbeats: NO_OUTPUT_DIAGNOSTIC_REPEAT_HEARTBEATS,
  })
}

function emitSessionProbeIfNeeded(session, silenceSeconds) {
  emitSessionProbeIfNeededFromModule(session, silenceSeconds, {
    pushEvent: (sessionId, event) => pushAcpEvent(sessionId, event),
    shouldEmitSessionProbeDiagnostics: shouldEmitSessionProbeDiagnostics(),
    sessionProbeHeartbeats: DEFAULT_SESSION_PROBE_HEARTBEATS,
  })
}

function markOutputActivity(session) {
  const ts = now()
  session.lastOutputAt = ts
  session.noOutputHeartbeatCount = 0
}

function clearNoOutputWatchdog(session) {
  if (session.noOutputWatchdogRef) {
    clearInterval(session.noOutputWatchdogRef)
    session.noOutputWatchdogRef = undefined
  }
  session.lastNoOutputHeartbeatAt = undefined
}

function emitNoOutputHeartbeatIfNeeded(session) {
  if (session.state !== 'running') return
  const heartbeatMs = normalizeNoOutputHeartbeatMs(session.noOutputHeartbeatMs)
  if (heartbeatMs <= 0) return

  const current = now()
  const lastOutputAt = Number(session.lastOutputAt || session.startedAt || current)
  if ((current - lastOutputAt) < heartbeatMs) return

  const lastHeartbeatAt = Number(session.lastNoOutputHeartbeatAt || 0)
  if (lastHeartbeatAt > 0 && (current - lastHeartbeatAt) < heartbeatMs) return

  const silenceSeconds = Math.max(1, Math.floor((current - lastOutputAt) / 1000))
  pushAcpEvent(session.sessionId, {
    type: 'status',
    turnId: session.currentTurnId,
    text: `[agent] waiting for model response... (${silenceSeconds}s no output)`,
    statusCode: 'waiting_for_output',
  })
  session.noOutputHeartbeatCount = Number(session.noOutputHeartbeatCount || 0) + 1
  emitNoOutputDiagnosticIfNeeded(session, silenceSeconds)
  emitSessionProbeIfNeeded(session, silenceSeconds)
  session.lastNoOutputHeartbeatAt = current
}

function startNoOutputWatchdog(session) {
  clearNoOutputWatchdog(session)
  const heartbeatMs = normalizeNoOutputHeartbeatMs(session.noOutputHeartbeatMs)
  if (heartbeatMs <= 0) return

  const checkIntervalMs = normalizeNoOutputCheckIntervalMs(
    session.noOutputCheckIntervalMs,
    heartbeatMs,
  )
  if (checkIntervalMs <= 0) return

  const timer = setInterval(() => {
    emitNoOutputHeartbeatIfNeeded(session)
  }, checkIntervalMs)
  if (timer.unref) timer.unref()
  session.noOutputWatchdogRef = timer
}

function pushAcpEvent(sessionId, event) {
  let buffer = acpEventBuffers.get(sessionId)
  if (!buffer) {
    buffer = []
    acpEventBuffers.set(sessionId, buffer)
  }
  const full = {
    ...event,
    cursor: nextAcpEventCursor++,
    sessionId,
    emittedAt: now(),
  }
  buffer.push(full)
  if (buffer.length > MAX_EVENTS_PER_SESSION) {
    buffer.splice(0, buffer.length - MAX_EVENTS_PER_SESSION)
  }
  if (typeof sessionEventHook === 'function') {
    const session = acpSessions.get(sessionId)
    Promise.resolve(sessionEventHook({
      ...full,
      runId: session?.runId || null,
      agentType: session?.agentType,
      state: session?.state,
      origin: session?.origin || null,
      inputProvenance: session?.inputProvenance || null,
      runtimeSessionId: session?.runtimeSessionId || null,
    })).catch(() => undefined)
  }
  return full
}

// ── Event normalization (P0.1) ──

/**
 * Parse a single stdout line from an agent process and return
 * zero or more normalized ACP events.
 *
 * Dispatches to format-specific parsers based on session.agentType:
 *   'claude-api'  → raw Claude API streaming (content_block_delta etc.)
 *   'claude-code' → Claude Code CLI stream-json envelope
 *   'codex'       → Codex CLI --json JSONL envelope
 *   'raw'/'other' → tries claude-api first, falls through to status
 *
 * Non-JSON lines ALWAYS degrade to status (P0.1: never discard).
 */
export function parseAgentLine(line, session) {
  return parseAgentLineFromEvents(line, session)
}

// ACP event normalization now lives in acp-events.mjs.

// ── Forced terminal state (P0.2) ──

/**
 * Ensure every session emits exactly one terminal event (done or error).
 * Called when the child process exits, times out, or fails to spawn.
 */
export function synthesizeTerminalEvent(session, reason) {
  return synthesizeTerminalEventFromEvents(session, reason)
}

// ── Actor queue (serialization) ──

function enqueueOperation(session, op) {
  session.queueDepth += 1

  // Create a separate promise for the caller so errors propagate back,
  // while the queue chain itself catches and continues (no blocking).
  let resolveResult, rejectResult
  const callerPromise = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  session.queue = session.queue
    .then(() => {
      const result = op()
      // If op returns a promise, resolve caller with it
      resolveResult(result)
      return result
    })
    .catch((err) => {
      // Catch-then-continue: errors in one op don't block the next
      console.warn(`[acp-session] Queue op error for ${session.sessionId}: ${err.message}`)
      rejectResult(err)
    })
    .finally(() => {
      session.queueDepth -= 1
    })

  return callerPromise
}

// ── Public API ──

/**
 * Derive the default CLI command for a known agent type.
 * Returns null for 'raw' (caller must provide command explicitly).
 */
export function resolveDefaultCommand(agentType, prompt, agentSessionId, options = {}) {
  return resolveAgentDefaultCommand(agentType, prompt, agentSessionId, options)
}

export function createAcpSession(opts = {}) {
  const sessionId = opts.sessionId || randomBytes(16).toString('hex')
  const agentType = opts.agentType || 'raw'
  const session = {
    sessionId,
    agentType,
    state: null,
    cwd: opts.cwd || process.cwd(),
    command: opts.command || null, // resolved lazily in enqueuePrompt
    origin: typeof opts.origin === 'string' && opts.origin.trim() ? opts.origin.trim() : null,
    inputProvenance: opts.inputProvenance && typeof opts.inputProvenance === 'object' ? JSON.parse(JSON.stringify(opts.inputProvenance)) : null,
    env: opts.env || undefined,
    permissionPolicy: clonePermissionPolicy(opts.permissionPolicy),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    createdAt: now(),
    startedAt: undefined,
    finishedAt: undefined,
    currentTurnId: null,
    runId: opts.runId || null,
    queue: Promise.resolve(),
    queueDepth: 0,
    cancelPromise: null,
    child: null,
    terminalEmitted: false,
    timeoutRef: undefined,
    toolCallAccumulator: null,
    noOutputHeartbeatMs: opts.noOutputHeartbeatMs,
    noOutputCheckIntervalMs: opts.noOutputCheckIntervalMs,
    noOutputWatchdogRef: undefined,
    lastOutputAt: undefined,
    lastNoOutputHeartbeatAt: undefined,
    noOutputHeartbeatCount: 0,
    authDiagnosticMissingKeys: [],
    lastNoOutputDiagnosticKind: '',
    lastNoOutputDiagnosticHeartbeat: 0,
    lastSessionProbeHeartbeat: 0,
    lastThinkingStatusAt: 0,
    toolCallsById: new Map(),
    lastToolCallSummary: '',
    lastToolCallAt: 0,
    lastToolResultSummary: '',
    lastToolResultAt: 0,
    runtimeSessionId: null,
    agentSessionId:
      String(agentType || '').toLowerCase() === 'claude-code'
        ? randomUUID()
        : null,
  }
  acpSessions.set(sessionId, session)
  acpEventBuffers.set(sessionId, [])
  applyAcpSessionState(session, 'idle', { reason: 'create' })
  return getAcpSessionById(sessionId)
}

export function getAcpSessionById(sessionId) {
  const session = acpSessions.get(sessionId)
  if (!session) return null
  return {
    sessionId: session.sessionId,
    agentType: session.agentType,
    state: session.state,
    cwd: session.cwd,
    command: session.command,
    origin: session.origin || undefined,
    inputProvenance: session.inputProvenance || undefined,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    currentTurnId: session.currentTurnId,
    runId: session.runId,
    queueDepth: session.queueDepth,
    terminalEmitted: session.terminalEmitted,
    runtimeSessionId: session.runtimeSessionId || null,
  }
}

export function attachAcpSessionRunId(sessionId, runId) {
  const session = acpSessions.get(sessionId)
  if (!session) return null
  session.runId = runId || null
  return getAcpSessionById(sessionId)
}

export function setAcpSessionEventHook(hook) {
  sessionEventHook = typeof hook === 'function' ? hook : null
  return () => {
    if (sessionEventHook === hook) {
      sessionEventHook = null
    }
  }
}

export function listAcpSessions(options = {}) {
  const state = options.state || undefined
  const limit = clampInt(options.limit, 50, 1, 500)
  const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER)

  const filtered = Array.from(acpSessions.values())
    .filter((s) => !state || s.state === state)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

  const paged = filtered.slice(offset, offset + limit).map((s) => ({
    sessionId: s.sessionId,
    agentType: s.agentType,
    state: s.state,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    currentTurnId: s.currentTurnId,
    queueDepth: s.queueDepth,
    origin: s.origin || undefined,
    inputProvenance: s.inputProvenance || undefined,
  }))

  return {
    sessions: paged,
    total: filtered.length,
    offset,
    limit,
    hasMore: offset + paged.length < filtered.length,
  }
}

/**
 * Enqueue a prompt operation: spawns agent child with command and writes
 * prompt to stdin. Returns a promise that resolves when spawn completes.
 */
export function enqueuePrompt(sessionId, opts = {}) {
  const session = acpSessions.get(sessionId)
  if (!session) throw new Error(`ACP session not found: ${sessionId}`)

  const restartableTerminalStates = new Set(['done'])
  if (typeof opts.origin === 'string' && opts.origin.trim()) {
    session.origin = opts.origin.trim()
  }
  if (opts.inputProvenance && typeof opts.inputProvenance === 'object') {
    session.inputProvenance = JSON.parse(JSON.stringify(opts.inputProvenance))
  }
  if (opts.permissionPolicy && typeof opts.permissionPolicy === 'object') {
    session.permissionPolicy = clonePermissionPolicy(opts.permissionPolicy)
  }

  const blockedTerminalStates = new Set(['error', 'timeout', 'cancelled'])
  const previousState = session.state
  if (blockedTerminalStates.has(session.state)) {
    throw new Error(
      `ACP session "${sessionId}" is in terminal state "${session.state}". ` +
      'Create a new session or reset explicitly before sending another prompt.',
    )
  }
  if (restartableTerminalStates.has(session.state)) {
    // Re-open the same session envelope for a follow-up turn.
    // This keeps sessionId stable for long-lived assistant workflows.
    if (session.timeoutRef) {
      clearTimeout(session.timeoutRef)
      session.timeoutRef = undefined
    }
    clearNoOutputWatchdog(session)
    applyAcpSessionState(session, 'idle', { reason: 'reuse_reset', previousState })
    session.startedAt = undefined
    session.finishedAt = undefined
    session.currentTurnId = null
    session.terminalEmitted = false
    session.cancelPromise = null
    session.lastOutputAt = undefined
    session.lastNoOutputHeartbeatAt = undefined
    session.noOutputHeartbeatCount = 0
    session.lastNoOutputDiagnosticKind = ''
    session.lastNoOutputDiagnosticHeartbeat = 0
    session.lastSessionProbeHeartbeat = 0
    session.lastThinkingStatusAt = 0
    session.toolCallsById = new Map()
    session.lastToolCallSummary = ''
    session.lastToolCallAt = 0
    session.lastToolResultSummary = ''
    session.lastToolResultAt = 0
    acpEventBuffers.set(sessionId, [])

    // If last turn did not complete cleanly, rotate Claude runtime session id.
    // This avoids "Session ID ... is already in use" after cancel/timeout/error.
    if (
      String(session.agentType || '').toLowerCase() === 'claude-code'
      && previousState !== 'done'
    ) {
      session.agentSessionId = randomUUID()
    }
  }

  const turnId = opts.turnId || randomBytes(8).toString('hex')
  return enqueueOperation(session, () => {
    // Resolve command: explicit > session-level > auto-derived from agentType
    const command = opts.command || session.command
      || resolveDefaultCommand(session.agentType, opts.prompt, session.agentSessionId, {
        permissionPolicy: session.permissionPolicy,
      })
    if (!command) {
      throw new Error(
        `No command specified for ACP session "${sessionId}" (agentType="${session.agentType}"). ` +
        'Provide a command in createAcpSession or enqueuePrompt.',
      )
    }

    // Prevent spawning a second child while one is still running
    if (session.child && !session.child.killed && session.child.exitCode === null) {
      throw new Error(
        `Session "${sessionId}" already has a running child process (pid=${session.child.pid}). ` +
        'Cancel or wait for it to exit before sending another prompt.',
      )
    }

    session.currentTurnId = turnId
    session.terminalEmitted = false
    session.toolCallAccumulator = null
    session.lastNoOutputHeartbeatAt = undefined
    session.noOutputHeartbeatCount = 0
    session.lastNoOutputDiagnosticKind = ''
    session.lastNoOutputDiagnosticHeartbeat = 0
    session.lastSessionProbeHeartbeat = 0
    session.lastThinkingStatusAt = 0
    session.toolCallsById = new Map()
    session.lastToolCallSummary = ''
    session.lastToolCallAt = 0
    session.lastToolResultSummary = ''
    session.lastToolResultAt = 0

    // For agentType-derived commands that embed the prompt, don't pipe via stdin
    const promptForStdin = (opts.command || session.command) ? opts.prompt : undefined

    spawnAgentChildFromProcess(session, {
      command,
      cwd: opts.cwd || session.cwd,
      env: opts.env || session.env,
      timeoutMs: opts.timeoutMs ?? session.timeoutMs,
      prompt: promptForStdin,
    }, {
      now,
      applySessionState: (target, nextState, meta) => applyAcpSessionState(target, nextState, meta),
      pushEvent: (sessionId, event) => pushAcpEvent(sessionId, event),
      markOutputActivity,
      startNoOutputWatchdog,
      clearNoOutputWatchdog,
      parseAgentLine: (line, target) => parseAgentLine(line, target),
      synthesizeTerminalEvent: (target, reason) => synthesizeTerminalEvent(target, reason),
      cancelKillDelayMs: CANCEL_KILL_DELAY_MS,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      maxTimeoutMs: MAX_TIMEOUT_MS,
    })
    return { ok: true, turnId, sessionId }
  })
}

/**
 * Enqueue a steer operation: writes text to agent stdin.
 */
export function enqueueSteer(sessionId, opts = {}) {
  const session = acpSessions.get(sessionId)
  if (!session) throw new Error(`ACP session not found: ${sessionId}`)
  if (session.state !== 'running') {
    throw new Error(`Cannot steer: session state is "${session.state}", expected "running"`)
  }

  return enqueueOperation(session, () => {
    if (!session.child?.stdin || session.child.stdin.destroyed || session.child.stdin.writableEnded) {
      throw new Error('Agent stdin is not writable')
    }
    const turnId = opts.turnId || session.currentTurnId
    session.currentTurnId = turnId
    const text = typeof opts.text === 'string' ? opts.text : String(opts.text || '')
    const payload = opts.submit !== false ? `${text}\n` : text
    session.child.stdin.write(payload)
    return { ok: true, turnId, written: Buffer.byteLength(payload) }
  })
}

/**
 * Cancel an ACP session — bypasses actor queue (P0.3).
 * Sends SIGTERM immediately, escalates to SIGKILL after 3s.
 * Idempotent: subsequent calls return the same promise.
 */
const ACP_TERMINAL_STATES = new Set(['done', 'error', 'cancelled', 'timeout'])

export function cancelAcpSession(sessionId) {
  const session = acpSessions.get(sessionId)
  if (!session) throw new Error(`ACP session not found: ${sessionId}`)

  // Idempotent: return cached promise
  if (session.cancelPromise) return session.cancelPromise

  // If session is already in a terminal state, return immediately without overwriting
  if (ACP_TERMINAL_STATES.has(session.state)) {
    session.cancelPromise = Promise.resolve({ ok: true, sessionId, state: session.state, alreadyTerminal: true })
    return session.cancelPromise
  }

  session.cancelPromise = new Promise((resolve) => {
    if (session.timeoutRef) {
      clearTimeout(session.timeoutRef)
      session.timeoutRef = undefined
    }
    clearNoOutputWatchdog(session)

    // Synthesize terminal event if not already emitted
    const termEvent = synthesizeTerminalEvent(session, {
      type: 'process_exit',
      exitCode: -1,
    })
    if (termEvent) {
      termEvent.code = 'cancelled'
      termEvent.message = 'Session cancelled by user'
      pushAcpEvent(session.sessionId, termEvent)
    }

    applyAcpSessionState(session, 'cancelled', { reason: 'cancel' })
    session.finishedAt = session.finishedAt || now()

    if (!session.child) {
      resolve({ ok: true, sessionId, state: 'cancelled' })
      return
    }

    try { session.child.kill('SIGTERM') } catch { /* ignore */ }
    const killTimer = setTimeout(() => {
      try { if (!session.child.killed) session.child.kill('SIGKILL') } catch { /* ignore */ }
    }, CANCEL_KILL_DELAY_MS)
    if (killTimer.unref) killTimer.unref()

    // Wait for close or timeout
    const onClose = () => {
      clearTimeout(killTimer)
      resolve({ ok: true, sessionId, state: 'cancelled' })
    }

    if (session.child.exitCode !== null) {
      clearTimeout(killTimer)
      resolve({ ok: true, sessionId, state: 'cancelled' })
    } else {
      session.child.once('close', onClose)
    }
  })

  return session.cancelPromise
}

/**
 * List events for a session with cursor-based pagination.
 */
export function listAcpEvents(sessionId, options = {}) {
  const buffer = acpEventBuffers.get(sessionId)
  if (!buffer) {
    return { events: [], nextCursor: 0, hasMore: false }
  }

  const after = clampInt(options.after, 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = clampInt(options.limit, 50, 1, 500)

  const filtered = buffer
    .filter((e) => e.cursor > after)
    .slice(0, limit)

  const nextCursor = filtered.length > 0
    ? filtered[filtered.length - 1].cursor
    : Math.max(after, nextAcpEventCursor - 1)

  return {
    events: filtered,
    nextCursor,
    hasMore: buffer.some((e) => e.cursor > nextCursor),
  }
}

/**
 * Cleanup all ACP sessions and event buffers (for testing).
 */
export function cleanupAllAcpSessions() {
  if (gcTimer) { clearInterval(gcTimer); gcTimer = null }
  for (const [, session] of acpSessions) {
    if (session.timeoutRef) clearTimeout(session.timeoutRef)
    clearNoOutputWatchdog(session)
    if (session.child && session.child.exitCode === null) {
      try { session.child.kill('SIGTERM') } catch { /* ignore */ }
    }
  }
  acpSessions.clear()
  acpEventBuffers.clear()
  nextAcpEventCursor = 1
}

/**
 * Garbage-collect terminal sessions whose finishedAt exceeds SESSION_TTL_MS.
 * Returns the number of sessions reaped.
 */
export function gcTerminalSessions() {
  const cutoff = now() - SESSION_TTL_MS
  let reaped = 0
  for (const [id, session] of acpSessions) {
    if (!ACP_TERMINAL_STATES.has(session.state)) continue
    if ((session.finishedAt || 0) > cutoff) continue
    // Terminal and past TTL → remove
    acpSessions.delete(id)
    acpEventBuffers.delete(id)
    reaped++
  }
  if (reaped > 0) {
    console.log(`[acp-session] GC reaped ${reaped} terminal session(s)`)
  }
  return reaped
}

// Auto-start GC sweep interval
let gcTimer = setInterval(gcTerminalSessions, GC_INTERVAL_MS)
if (gcTimer.unref) gcTimer.unref()
