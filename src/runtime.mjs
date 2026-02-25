import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  normalizePermissionPolicy,
  isPathWithinRoots,
  PERMISSION_MODE_WORKSPACE,
} from './permission-policy.mjs'

const MAX_OUTPUT_CHARS = Number(process.env.TRAPEZOHE_MAX_OUTPUT || 200_000)
const DEFAULT_TIMEOUT_MS = Number(process.env.TRAPEZOHE_TIMEOUT_MS || 60_000)
const MAX_TIMEOUT_MS = 300_000
const SESSION_TTL_MS = Number(process.env.TRAPEZOHE_SESSION_TTL_MS || 1000 * 60 * 60)
const MAX_SESSION_COUNT = Number(process.env.TRAPEZOHE_MAX_SESSIONS || 200)

const sessions = new Map()
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

function trimOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return text.slice(text.length - MAX_OUTPUT_CHARS)
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
    cwd = process.cwd()
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

export async function runCommand({ command, cwd, timeoutMs }) {
  const startedAt = now()
  const shell = shellCommandForPlatform(command)

  return new Promise((resolve) => {
    const child = spawn(shell.bin, shell.args, {
      cwd,
      env: process.env,
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

export function startCommandSession({ id, command, cwd, timeoutMs }) {
  const startedAt = now()
  const shell = shellCommandForPlatform(command)
  const child = spawn(shell.bin, shell.args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
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
    if (session.timeoutRef) clearTimeout(session.timeoutRef)
    session.stderr = trimOutput(`${session.stderr}\n${error.message}`.trim())
    session.status = 'exited'
    session.exitCode = -1
    session.finishedAt = now()
  })

  child.on('close', (code) => {
    if (session.timeoutRef) clearTimeout(session.timeoutRef)
    session.status = 'exited'
    session.exitCode = typeof code === 'number' ? code : -1
    session.finishedAt = now()
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

export function cleanupAllSessions() {
  for (const [, session] of sessions) {
    if (session.status === 'running') {
      try { session.child.kill('SIGTERM') } catch { /* ignore */ }
    }
  }
  sessions.clear()
}
