import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { prepareAgentSpawnEnvironment } from './acp-auth.mjs'

export function normalizeStatusText(text, maxChars = 800) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  if (raw.length <= maxChars) return raw
  return `${raw.slice(0, maxChars)}…`
}

export function isPermissionRelatedText(text) {
  if (!text) return false
  return (
    /\bpermission\b/i.test(text) ||
    /\bapprove\b/i.test(text) ||
    /\bapproval\b/i.test(text) ||
    /\btrust\b/i.test(text) ||
    /\bnon-interactive\b/i.test(text) ||
    /\bnot granted\b/i.test(text) ||
    /\bgrant(ed)?\b/i.test(text)
  )
}

export function classifyCodexStderr(text) {
  const line = String(text || '')
  if (!line) return null
  if (/failed to refresh available models: timeout waiting for child process to exit/i.test(line)) {
    return {
      statusCode: 'codex_models_refresh_warning',
      message: '[codex] model refresh timed out; continuing with existing model metadata.',
    }
  }
  if (
    /failed to open state db .*migration .*missing/i.test(line)
    || /state db record_discrepancy/i.test(line)
  ) {
    return {
      statusCode: 'codex_state_db_warning',
      message: '[codex] local state DB mismatch detected; continuing in fallback mode.',
    }
  }
  return null
}

export function spawnAgentChild(session, opts, deps) {
  const now = deps.now
  const applySessionState = deps.applySessionState
  const pushEvent = deps.pushEvent
  const markOutputActivity = deps.markOutputActivity
  const startNoOutputWatchdog = deps.startNoOutputWatchdog
  const clearNoOutputWatchdog = deps.clearNoOutputWatchdog
  const parseAgentLine = deps.parseAgentLine
  const synthesizeTerminalEvent = deps.synthesizeTerminalEvent
  const prepareEnvironment = deps.prepareEnvironment || prepareAgentSpawnEnvironment
  const spawnImpl = deps.spawnImpl || spawn
  const createInterfaceImpl = deps.createInterfaceImpl || createInterface
  const cancelKillDelayMs = Number(deps.cancelKillDelayMs || 3_000)
  const defaultTimeoutMs = Number(deps.defaultTimeoutMs || 120_000)
  const maxTimeoutMs = Number(deps.maxTimeoutMs || 600_000)

  const { command, cwd, env, timeoutMs, prompt } = opts
  const startedAt = now()
  session.startedAt = startedAt
  applySessionState(session, 'running', { reason: 'spawn', cwd: cwd || process.cwd() })

  let args
  let bin
  if (Array.isArray(command)) {
    bin = command[0]
    args = command.slice(1)
  } else {
    const shell = process.platform === 'win32'
      ? { bin: 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { bin: process.env.SHELL?.trim() || '/bin/bash', args: ['-lc', command] }
    bin = shell.bin
    args = shell.args
  }

  const explicitEnv =
    env && typeof env === 'object' && Object.keys(env).length > 0
      ? { ...env }
      : null

  const agentType = (session.agentType || '').toLowerCase()
  const { env: mergedEnv, authCheck } = prepareEnvironment({
    baseEnv: process.env,
    agentType,
    explicitEnv,
    alwaysStripRuntimeMarkers: true,
  })
  session.authDiagnosticMissingKeys = authCheck.missingKeys

  const stdinMode = prompt ? 'pipe' : 'ignore'

  if (authCheck.blocking) {
    pushEvent(session.sessionId, {
      type: 'error',
      turnId: session.currentTurnId,
      code: 'missing_auth_env',
      message: authCheck.message || 'Missing auth env for agent process.',
    })
    session.terminalEmitted = true
    applySessionState(session, 'error', { reason: 'missing_auth_env' })
    session.finishedAt = now()
    return
  }

  let child
  try {
    child = spawnImpl(bin, args, {
      cwd: cwd || process.cwd(),
      env: mergedEnv,
      stdio: [stdinMode, 'pipe', 'pipe'],
    })
  } catch (err) {
    const termEvent = synthesizeTerminalEvent(session, {
      type: 'spawn_failed',
      message: err.message,
    })
    if (termEvent) pushEvent(session.sessionId, termEvent)
    applySessionState(session, 'error', { reason: 'spawn_failed' })
    session.finishedAt = now()
    return
  }

  session.child = child
  markOutputActivity(session)
  startNoOutputWatchdog(session)

  const rl = createInterfaceImpl({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    markOutputActivity(session)
    const events = parseAgentLine(line, session)
    for (const event of events) {
      pushEvent(session.sessionId, event)
    }
  })

  child.stderr.on('data', (chunk) => {
    markOutputActivity(session)
    const lines = String(chunk)
      .split(/\r?\n/g)
      .map((line) => normalizeStatusText(line))
      .filter(Boolean)
    for (const text of lines) {
      if (agentType === 'codex') {
        const codexWarning = classifyCodexStderr(text)
        if (codexWarning) {
          if (!session.codexWarningCodes) {
            session.codexWarningCodes = new Set()
          }
          if (!session.codexWarningCodes.has(codexWarning.statusCode)) {
            session.codexWarningCodes.add(codexWarning.statusCode)
            pushEvent(session.sessionId, {
              type: 'status',
              turnId: session.currentTurnId,
              text: codexWarning.message,
              statusCode: codexWarning.statusCode,
            })
          }
          continue
        }
      }
      const permissionRelated = isPermissionRelatedText(text)
      pushEvent(session.sessionId, {
        type: 'status',
        turnId: session.currentTurnId,
        text: permissionRelated
          ? `[claude-code][awaiting_approval] ${text}`
          : `[stderr] ${text}`,
        statusCode: permissionRelated ? 'awaiting_approval' : 'stderr',
      })
    }
  })

  const rawTimeout = Number.isFinite(timeoutMs) ? Number(timeoutMs) : defaultTimeoutMs
  const timeoutDisabled = rawTimeout <= 0
  const effectiveTimeout = timeoutDisabled
    ? null
    : Math.min(Math.max(rawTimeout, 1000), maxTimeoutMs)

  if (effectiveTimeout !== null) {
    session.timeoutRef = setTimeout(() => {
      if (session.state !== 'running') return
      const termEvent = synthesizeTerminalEvent(session, {
        type: 'timeout',
        timeoutMs: effectiveTimeout,
      })
      if (termEvent) pushEvent(session.sessionId, termEvent)
      applySessionState(session, 'timeout', { reason: 'timeout', timeoutMs: effectiveTimeout })
      session.finishedAt = now()
      clearNoOutputWatchdog(session)
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL') } catch {}
      }, cancelKillDelayMs)
    }, effectiveTimeout)
    if (session.timeoutRef.unref) session.timeoutRef.unref()
  }

  child.on('error', (err) => {
    if (session.timeoutRef) clearTimeout(session.timeoutRef)
    clearNoOutputWatchdog(session)
    const termEvent = synthesizeTerminalEvent(session, {
      type: 'spawn_failed',
      message: err.message,
    })
    if (termEvent) pushEvent(session.sessionId, termEvent)
    if (session.state === 'running') {
      applySessionState(session, 'error', { reason: 'child_error' })
      session.finishedAt = now()
    }
  })

  child.on('close', (code) => {
    if (session.timeoutRef) clearTimeout(session.timeoutRef)
    clearNoOutputWatchdog(session)
    rl.close()
    const exitCode = typeof code === 'number' ? code : -1
    const termEvent = synthesizeTerminalEvent(session, {
      type: 'process_exit',
      exitCode,
    })
    if (termEvent) pushEvent(session.sessionId, termEvent)
    if (session.state === 'running') {
      applySessionState(session, exitCode === 0 ? 'done' : 'error', {
        reason: 'process_exit',
        exitCode,
      })
      session.finishedAt = now()
    }
  })

  if (prompt && child.stdin && !child.stdin.destroyed) {
    child.stdin.write(prompt + '\n')
  }
}
