import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_OUTPUT_CHARS = Number(process.env.TRAPEZOHE_MAX_OUTPUT || 200_000)
const DEFAULT_TIMEOUT_MS = Number(process.env.TRAPEZOHE_TIMEOUT_MS || 60_000)
const MAX_TIMEOUT_MS = 300_000
const SESSION_TTL_MS = Number(process.env.TRAPEZOHE_SESSION_TTL_MS || 1000 * 60 * 60)
const MAX_SESSION_COUNT = Number(process.env.TRAPEZOHE_MAX_SESSIONS || 200)

const sessions = new Map()

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

export async function resolveCwd(inputCwd) {
  const cwd = inputCwd && typeof inputCwd === 'string' && inputCwd.trim()
    ? path.resolve(inputCwd.trim())
    : process.cwd()

  const stat = await fs.stat(cwd).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Working directory does not exist: ${cwd}`)
  }
  return cwd
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
      try { target.child.kill('SIGTERM') } catch { /* ignore */ }
    }
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
