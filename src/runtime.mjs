import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  normalizePermissionPolicy,
  isPathWithinRoots,
  PERMISSION_MODE_WORKSPACE,
} from './permission-policy.mjs'
import { getConfigDir } from './config.mjs'

const MAX_OUTPUT_CHARS = Number(process.env.TRAPEZOHE_MAX_OUTPUT || 200_000)
const DEFAULT_TIMEOUT_MS = Number(process.env.TRAPEZOHE_TIMEOUT_MS || 60_000)
const MAX_TIMEOUT_MS = 300_000
const SESSION_TTL_MS = Number(process.env.TRAPEZOHE_SESSION_TTL_MS || 1000 * 60 * 60)
const MAX_SESSION_COUNT = Number(process.env.TRAPEZOHE_MAX_SESSIONS || 200)
const DEFAULT_SESSION_LIST_LIMIT = 50
const MAX_SESSION_LIST_LIMIT = 500
const DEFAULT_LOG_SLICE_LIMIT = 4_000
const MAX_SESSION_EVENT_COUNT = Number(process.env.TRAPEZOHE_MAX_SESSION_EVENTS || 500)
const DEFAULT_EVENT_LIST_LIMIT = 50
const MAX_EVENT_LIST_LIMIT = 500

const sessions = new Map()
const sessionEvents = []
const sessionExitListeners = new Set()
let nextSessionEventCursor = 1
let pruneIntervalRef = null

const WORKSPACE_BLOCKED_COMMANDS = [
  { pattern: /\bsudo\b/i, reason: 'sudo is disabled in workspace mode' },
  { pattern: /\bsu\b/i, reason: 'user switching is disabled in workspace mode' },
  { pattern: /\bshutdown\b/i, reason: 'system shutdown commands are disabled in workspace mode' },
  { pattern: /\breboot\b/i, reason: 'system reboot commands are disabled in workspace mode' },
  { pattern: /\bhalt\b/i, reason: 'system halt commands are disabled in workspace mode' },
  { pattern: /\bpoweroff\b/i, reason: 'poweroff commands are disabled in workspace mode' },
  { pattern: /\brm\s+-rf\s+\/(?![\w.-])/i, reason: 'destructive root deletes are blocked in workspace mode' },
]

export class PermissionPolicyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PermissionPolicyError'
  }
}

function now() {
  return Date.now()
}

function clampInteger(input, { defaultValue, min, max }) {
  const value = Number.parseInt(input, 10)
  if (!Number.isFinite(value)) return defaultValue
  return Math.min(Math.max(value, min), max)
}

function trimOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(text.length - MAX_OUTPUT_CHARS)
}

function pushSessionEvent(event) {
  sessionEvents.push(event)
  if (sessionEvents.length > MAX_SESSION_EVENT_COUNT) {
    sessionEvents.splice(0, sessionEvents.length - MAX_SESSION_EVENT_COUNT)
  }
}

function emitSessionExited(session) {
  pushSessionEvent({
    cursor: nextSessionEventCursor++,
    type: 'session_exited',
    sessionId: session.id,
    command: session.command,
    cwd: session.cwd,
    timedOut: Boolean(session.timedOut),
    exitCode: typeof session.exitCode === 'number' ? session.exitCode : -1,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt || now(),
    durationMs: (session.finishedAt || now()) - session.startedAt,
  })
}

function notifySessionExited(session) {
  if (sessionExitListeners.size === 0) return
  const snapshot = makeSessionSnapshot(session)
  for (const listener of sessionExitListeners) {
    try {
      listener(snapshot)
    } catch {
      // Observers should not break session lifecycle.
    }
  }
}

function finalizeSessionExit(session, options = {}) {
  if (!session || session.status === 'exited') return false
  if (session.timeoutRef) clearTimeout(session.timeoutRef)

  if (options.stderrAppend) {
    session.stderr = trimOutput(`${session.stderr}\n${options.stderrAppend}`.trim())
  }
  session.status = 'exited'
  session.exitCode = typeof options.exitCode === 'number' ? options.exitCode : -1
  session.finishedAt = now()
  emitSessionExited(session)
  notifySessionExited(session)
  return true
}

export function addSessionExitListener(listener) {
  if (typeof listener !== 'function') return () => {}
  sessionExitListeners.add(listener)
  return () => {
    sessionExitListeners.delete(listener)
  }
}

function shellCommandForPlatform(command) {
  if (process.platform === 'win32') {
    return { bin: 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  const shell = process.env.SHELL && process.env.SHELL.trim()
    ? process.env.SHELL.trim()
    : '/bin/bash'
  return { bin: shell, args: ['-lc', command] }
}

export async function resolveCwd(inputCwd, permissionPolicy) {
  const policy = normalizePermissionPolicy(permissionPolicy)
  let cwd

  if (inputCwd && typeof inputCwd === 'string' && inputCwd.trim()) {
    cwd = path.resolve(inputCwd.trim())
  } else if (policy.mode === PERMISSION_MODE_WORKSPACE && policy.workspaceRoots[0]) {
    cwd = policy.workspaceRoots[0]
  } else {
    // In full mode, default to Companion home so relative paths like
    // "skills/..." resolve to ~/.trapezohe/skills by default.
    const companionHome = getConfigDir()
    const companionHomeStat = await fs.stat(companionHome).catch(() => null)
    cwd = companionHomeStat?.isDirectory() ? companionHome : process.cwd()
  }

  const stat = await fs.stat(cwd).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Working directory does not exist: ${cwd}`)
  }

  if (policy.mode === PERMISSION_MODE_WORKSPACE) {
    if (policy.workspaceRoots.length === 0) {
      throw new PermissionPolicyError('Workspace mode is enabled, but no workspace root is configured.')
    }
    // Resolve symlinks to prevent symlink-based workspace boundary escape
    let realCwd
    try {
      realCwd = await fs.realpath(cwd)
    } catch {
      realCwd = cwd
    }
    const workspaceRoots = await Promise.all(
      policy.workspaceRoots.map(async (root) => {
        try {
          return await fs.realpath(root)
        } catch {
          return path.resolve(root)
        }
      }),
    )
    if (!isPathWithinRoots(realCwd, workspaceRoots)) {
      throw new PermissionPolicyError(`Working directory is outside allowed workspace roots: ${cwd}`)
    }
  }

  return cwd
}

function shellTokenize(command) {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) || []
}

function stripQuotes(token) {
  if (!token) return token
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1)
  }
  return token
}

function maybePathCandidates(token) {
  const clean = stripQuotes(token)
  if (!clean) return []
  if (clean.includes('://')) return []

  const candidates = []
  const eqIdx = clean.indexOf('=')
  if (eqIdx > 0 && eqIdx < clean.length - 1) {
    candidates.push(clean.slice(eqIdx + 1))
  }
  candidates.push(clean)
  return candidates
}

function looksLikePath(value) {
  if (!value) return false
  if (value.startsWith('-')) return false
  if (value === '.' || value === '..') return true
  if (value.startsWith('./') || value.startsWith('../')) return true
  if (value.startsWith('~/')) return true
  if (value.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  return value.includes('/') || value.includes('\\')
}

function normalizeCandidateToAbsolute(candidate, cwd) {
  if (!looksLikePath(candidate)) return null
  if (candidate.startsWith('~/')) return path.resolve(os.homedir(), candidate.slice(2))
  if (path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
    return path.resolve(candidate)
  }
  return path.resolve(cwd, candidate)
}

// Shell metacharacters that could bypass path-based policy checks via
// command substitution, process substitution, or globbing.
const DANGEROUS_SHELL_PATTERNS = [
  { pattern: /\$\(/, reason: 'command substitution $(...) is not allowed in workspace mode' },
  { pattern: /`[^`]*`/, reason: 'backtick command substitution is not allowed in workspace mode' },
  { pattern: /\$\{/, reason: 'parameter expansion ${...} is not allowed in workspace mode' },
  { pattern: /<\(/, reason: 'process substitution <(...) is not allowed in workspace mode' },
  { pattern: />\(/, reason: 'process substitution >(...) is not allowed in workspace mode' },
]

export function enforceCommandPolicy({ command, cwd, permissionPolicy }) {
  const policy = normalizePermissionPolicy(permissionPolicy)
  if (policy.mode !== PERMISSION_MODE_WORKSPACE) return

  for (const rule of WORKSPACE_BLOCKED_COMMANDS) {
    if (rule.pattern.test(command)) {
      throw new PermissionPolicyError(`Command blocked by workspace policy: ${rule.reason}.`)
    }
  }

  // Block shell metacharacters that can bypass path analysis
  for (const rule of DANGEROUS_SHELL_PATTERNS) {
    if (rule.pattern.test(command)) {
      throw new PermissionPolicyError(`Command blocked by workspace policy: ${rule.reason}.`)
    }
  }

  // Split by pipe / semicolon / && / || and analyze each sub-command
  const subCommands = command.split(/\s*(?:\|{1,2}|&&|;)\s*/)
  for (const sub of subCommands) {
    const tokens = shellTokenize(sub)
    for (const token of tokens) {
      for (const candidate of maybePathCandidates(token)) {
        const absPath = normalizeCandidateToAbsolute(candidate, cwd)
        if (!absPath) continue
        if (!isPathWithinRoots(absPath, policy.workspaceRoots)) {
          throw new PermissionPolicyError(`Path escapes workspace boundary: ${candidate}`)
        }
      }
    }
  }
}

export function clampTimeout(input) {
  const value = Number(input)
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(value, 1000), MAX_TIMEOUT_MS)
}

export async function runCommand({ command, cwd, timeoutMs, env }) {
  const startedAt = now()
  const shell = shellCommandForPlatform(command)
  const mergedEnv = env && typeof env === 'object' && Object.keys(env).length > 0
    ? { ...process.env, ...env }
    : process.env

  return new Promise((resolve) => {
    const child = spawn(shell.bin, shell.args, {
      cwd,
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout.on('data', (chunk) => {
      stdout = trimOutput(stdout + String(chunk))
    })

    child.stderr.on('data', (chunk) => {
      stderr = trimOutput(stderr + String(chunk))
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 3000)
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        timedOut,
        durationMs: now() - startedAt,
      })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: !timedOut && code === 0,
        exitCode: typeof code === 'number' ? code : -1,
        stdout,
        stderr,
        timedOut,
        durationMs: now() - startedAt,
      })
    })
  })
}

export function makeSessionSnapshot(session) {
  const finishedAt = session.finishedAt || undefined
  return {
    ok: true,
    sessionId: session.id,
    status: session.status,
    command: session.command,
    cwd: session.cwd,
    stdout: session.stdout,
    stderr: session.stderr,
    timedOut: Boolean(session.timedOut),
    exitCode: typeof session.exitCode === 'number' ? session.exitCode : undefined,
    startedAt: session.startedAt,
    finishedAt,
    durationMs: (finishedAt || now()) - session.startedAt,
  }
}

function makeSessionListItem(session) {
  const finishedAt = session.finishedAt || undefined
  return {
    sessionId: session.id,
    status: session.status,
    command: session.command,
    cwd: session.cwd,
    startedAt: session.startedAt,
    finishedAt,
    timedOut: Boolean(session.timedOut),
    exitCode: typeof session.exitCode === 'number' ? session.exitCode : undefined,
    durationMs: (finishedAt || now()) - session.startedAt,
  }
}

export function listSessions(options = {}) {
  const status = typeof options.status === 'string' && options.status.trim()
    ? options.status.trim().toLowerCase()
    : undefined
  const offset = clampInteger(options.offset, {
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  })
  const limit = clampInteger(options.limit, {
    defaultValue: DEFAULT_SESSION_LIST_LIMIT,
    min: 1,
    max: MAX_SESSION_LIST_LIMIT,
  })

  const filtered = Array.from(sessions.values())
    .filter((session) => !status || session.status === status)
    .sort((a, b) => {
      const aTime = a.finishedAt || a.startedAt
      const bTime = b.finishedAt || b.startedAt
      return bTime - aTime
    })

  const paged = filtered.slice(offset, offset + limit).map(makeSessionListItem)

  return {
    sessions: paged,
    total: filtered.length,
    offset,
    limit,
    hasMore: offset + paged.length < filtered.length,
  }
}

function makeLogSlice(text, offset, limit) {
  const total = text.length
  const start = Math.min(Math.max(offset, 0), total)
  const end = Math.min(start + limit, total)
  return {
    output: text.slice(start, end),
    total,
    offset: start,
    limit,
    nextOffset: end,
    hasMore: end < total,
  }
}

export function getSessionLog(sessionId, options = {}) {
  const session = getSessionById(sessionId)
  if (!session) return null

  const stream = typeof options.stream === 'string' && options.stream.trim()
    ? options.stream.trim().toLowerCase()
    : 'both'
  if (stream !== 'stdout' && stream !== 'stderr' && stream !== 'both') {
    throw new Error('stream must be one of: stdout, stderr, both')
  }

  const offset = clampInteger(options.offset, {
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  })
  const limit = clampInteger(options.limit, {
    defaultValue: DEFAULT_LOG_SLICE_LIMIT,
    min: 1,
    max: MAX_OUTPUT_CHARS,
  })

  if (stream === 'stdout' || stream === 'stderr') {
    return {
      ok: true,
      sessionId: session.id,
      status: session.status,
      stream,
      ...makeLogSlice(session[stream] || '', offset, limit),
    }
  }

  return {
    ok: true,
    sessionId: session.id,
    status: session.status,
    stream,
    offset,
    limit,
    stdout: makeLogSlice(session.stdout || '', offset, limit),
    stderr: makeLogSlice(session.stderr || '', offset, limit),
  }
}

export function startCommandSession({ id, command, cwd, timeoutMs, env }) {
  const startedAt = now()
  const shell = shellCommandForPlatform(command)
  const mergedEnv = env && typeof env === 'object' && Object.keys(env).length > 0
    ? { ...process.env, ...env }
    : process.env
  const child = spawn(shell.bin, shell.args, {
    cwd,
    env: mergedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const session = {
    id,
    command,
    cwd,
    timeoutMs,
    child,
    status: 'running',
    stdout: '',
    stderr: '',
    timedOut: false,
    exitCode: undefined,
    startedAt,
    finishedAt: undefined,
    timeoutRef: undefined,
  }

  child.stdout.on('data', (chunk) => {
    session.stdout = trimOutput(session.stdout + String(chunk))
  })

  child.stderr.on('data', (chunk) => {
    session.stderr = trimOutput(session.stderr + String(chunk))
  })

  session.timeoutRef = setTimeout(() => {
    if (session.status !== 'running') return
    session.timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => {
      if (session.status === 'running') child.kill('SIGKILL')
    }, 3000)
  }, timeoutMs)

  child.on('error', (error) => {
    finalizeSessionExit(session, {
      exitCode: -1,
      stderrAppend: error.message,
    })
  })

  child.on('close', (code) => {
    finalizeSessionExit(session, {
      exitCode: typeof code === 'number' ? code : -1,
    })
  })

  sessions.set(id, session)
  return session
}

export function getSessionById(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null
  return sessions.get(sessionId) || null
}

export function pruneSessions() {
  const cutoff = now() - SESSION_TTL_MS

  for (const [id, session] of sessions) {
    if (session.status === 'exited' && (session.finishedAt || 0) < cutoff) {
      sessions.delete(id)
    }
  }

  if (sessions.size <= MAX_SESSION_COUNT) return

  const sorted = Array.from(sessions.values()).sort((a, b) => {
    const aTime = a.finishedAt || a.startedAt
    const bTime = b.finishedAt || b.startedAt
    return aTime - bTime
  })

  const removeCount = Math.max(0, sessions.size - MAX_SESSION_COUNT)
  for (let i = 0; i < removeCount; i += 1) {
    const target = sorted[i]
    if (!target) continue
    sessions.delete(target.id)
    if (target.status === 'running') {
      if (target.timeoutRef) clearTimeout(target.timeoutRef)
      try { target.child.kill('SIGTERM') } catch { /* ignore */ }
    }
  }
}

const PRUNE_INTERVAL_MS = 60_000

export function startSessionPruner() {
  if (pruneIntervalRef) return
  pruneIntervalRef = setInterval(() => pruneSessions(), PRUNE_INTERVAL_MS)
  if (pruneIntervalRef.unref) pruneIntervalRef.unref()
}

export function stopSessionPruner() {
  if (pruneIntervalRef) {
    clearInterval(pruneIntervalRef)
    pruneIntervalRef = null
  }
}

export function stopSession(sessionId, force = false) {
  const session = getSessionById(sessionId)
  if (!session) return null

  if (session.status === 'running') {
    try {
      session.child.kill(force ? 'SIGKILL' : 'SIGTERM')
      if (!force) {
        setTimeout(() => {
          if (session.status === 'running') {
            try { session.child.kill('SIGKILL') } catch { /* ignore */ }
          }
        }, 3000)
      }
    } catch { /* ignore */ }
  }

  return session
}

export function writeToSession(sessionId, text, submit = false) {
  const session = getSessionById(sessionId)
  if (!session) {
    throw new Error('Session not found.')
  }
  if (session.status !== 'running') {
    throw new Error('Session is not running.')
  }
  if (!session.child?.stdin || session.child.stdin.destroyed || session.child.stdin.writableEnded) {
    throw new Error('Session stdin is not writable.')
  }

  const normalizedText = typeof text === 'string' ? text : String(text ?? '')
  const payload = submit ? `${normalizedText}\n` : normalizedText
  session.child.stdin.write(payload)
  return { ok: true, written: Buffer.byteLength(payload) }
}

export function sendKeysToSession(sessionId, keys) {
  const session = getSessionById(sessionId)
  if (!session) {
    throw new Error('Session not found.')
  }
  if (session.status !== 'running') {
    throw new Error('Session is not running.')
  }

  const normalized = String(keys || '').trim().toLowerCase()
  switch (normalized) {
    case 'ctrl-c':
      session.child.kill('SIGINT')
      return { ok: true, action: 'signal', key: normalized }
    case 'ctrl-z':
      session.child.kill('SIGTSTP')
      return { ok: true, action: 'signal', key: normalized }
    case 'ctrl-d':
      if (!session.child?.stdin || session.child.stdin.destroyed || session.child.stdin.writableEnded) {
        throw new Error('Session stdin is not writable.')
      }
      session.child.stdin.end()
      return { ok: true, action: 'stdin', key: normalized }
    case 'enter':
      return writeToSession(sessionId, '', true)
    case 'tab':
      return writeToSession(sessionId, '\t', false)
    case 'escape':
    case 'esc':
      return writeToSession(sessionId, '\u001b', false)
    default:
      throw new Error('Unsupported key. Use one of: ctrl-c, ctrl-d, ctrl-z, enter, tab, escape')
  }
}

export function listSessionEvents(options = {}) {
  const after = clampInteger(options.after, {
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  })
  const limit = clampInteger(options.limit, {
    defaultValue: DEFAULT_EVENT_LIST_LIMIT,
    min: 1,
    max: MAX_EVENT_LIST_LIMIT,
  })

  const events = sessionEvents
    .filter((event) => event.cursor > after)
    .sort((a, b) => a.cursor - b.cursor)
    .slice(0, limit)

  const nextCursor = events.length > 0
    ? events[events.length - 1].cursor
    : Math.max(after, nextSessionEventCursor - 1)

  return {
    ok: true,
    events,
    nextCursor,
    hasMore: sessionEvents.some((event) => event.cursor > nextCursor),
  }
}

export function cleanupAllSessions() {
  for (const [, session] of sessions) {
    if (session.status === 'running') {
      try { session.child.kill('SIGTERM') } catch { /* ignore */ }
    }
  }
  sessions.clear()
  sessionEvents.splice(0, sessionEvents.length)
  nextSessionEventCursor = 1
}
