function now() {
  return Date.now()
}

function clipDiagnosticText(value, maxChars = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(16, maxChars - 16)).trimEnd()}...`
}

function isAuthRelatedText(text) {
  if (!text) return false
  return (
    /\bunauthorized\b/i.test(text)
    || /\bforbidden\b/i.test(text)
    || /\binvalid[_\s-]?api[_\s-]?key\b/i.test(text)
    || /\binvalid[_\s-]?token\b/i.test(text)
    || /\bauth(?:entication|orization)?\b/i.test(text)
    || /\bpermission\b/i.test(text)
    || /\bapprove\b/i.test(text)
    || /\bapproval\b/i.test(text)
    || /\bnot granted\b/i.test(text)
    || /\bmissing\b.*\b(anthropic|openai|token|api key)\b/i.test(text)
    || /\b401\b/.test(text)
    || /\b403\b/.test(text)
  )
}

function isNetworkRelatedText(text) {
  if (!text) return false
  return (
    /\bfailed to fetch\b/i.test(text)
    || /\bnetwork(?:error)?\b/i.test(text)
    || /\beconn(?:refused|reset)\b/i.test(text)
    || /\betimedout\b/i.test(text)
    || /\btimed out\b/i.test(text)
    || /\bsocket hang up\b/i.test(text)
    || /\benotfound\b/i.test(text)
    || /\bdns\b/i.test(text)
    || /\b(connection|connect)\b.*\b(reset|refused|timeout)\b/i.test(text)
    || /\b(429|500|502|503|504)\b/.test(text)
  )
}

function isChildProcessAlive(child) {
  if (!child || typeof child !== 'object') return false
  const pid = Number(child.pid || 0)
  if (!pid || child.killed || child.exitCode !== null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function classifyNoOutputDiagnostic(input = {}) {
  const missingKeys = Array.isArray(input.missingKeys) ? input.missingKeys : []
  const recentEvents = Array.isArray(input.recentEvents) ? input.recentEvents : []

  if (missingKeys.length > 0) {
    return {
      kind: 'auth',
      statusCode: 'no_output_auth',
      summary: `possible auth/config issue: missing ${missingKeys.join(', ')}`,
    }
  }

  let sawNetworkSignal = false
  let sawAuthSignal = false
  let sawThinkingSignal = false
  let sawInitSignal = false
  let sawToolSignal = false
  let lastTextSignalIndex = -1
  let lastThinkingSignalIndex = -1
  let lastInitSignalIndex = -1
  let lastToolSignalIndex = -1

  for (const [index, event] of recentEvents.entries()) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'status' && event.statusCode === 'waiting_for_output') continue
    const text = String(event.text || '')
    const statusCode = String(event.statusCode || '')

    if (event.type === 'text_delta') {
      lastTextSignalIndex = index
    }

    if (statusCode === 'awaiting_approval' || statusCode === 'config_warning' || isAuthRelatedText(text)) {
      sawAuthSignal = true
    }
    if (statusCode === 'stderr' && isNetworkRelatedText(text)) {
      sawNetworkSignal = true
    }
    if (statusCode === 'model_thinking') {
      sawThinkingSignal = true
      lastThinkingSignalIndex = index
    }
    if (/\[(claude-code|codex)\]/i.test(text) && /(initialized|thread\.started|turn\.started)/i.test(text)) {
      sawInitSignal = true
      lastInitSignalIndex = index
    }
    if (
      event.type === 'tool_call'
      || statusCode === 'tool_error'
      || /\[(claude-code|codex)\]\[tool_error\]/i.test(text)
    ) {
      sawToolSignal = true
      lastToolSignalIndex = index
    }
    if (isNetworkRelatedText(text)) {
      sawNetworkSignal = true
    }
  }

  if (sawAuthSignal) {
    return {
      kind: 'auth',
      statusCode: 'no_output_auth',
      summary: 'possible auth/approval issue while waiting for model output',
    }
  }

  if (sawNetworkSignal) {
    return {
      kind: 'network',
      statusCode: 'no_output_network',
      summary: 'possible network/provider transport issue while waiting for model output',
    }
  }

  if (sawToolSignal && lastToolSignalIndex > Math.max(lastTextSignalIndex, lastThinkingSignalIndex, lastInitSignalIndex)) {
    return {
      kind: 'tool_wait',
      statusCode: 'no_output_tool_wait',
      summary: 'agent appears stalled after tool execution (possible tool/result wait)',
    }
  }

  if (sawThinkingSignal || sawInitSignal) {
    return {
      kind: 'model_queue',
      statusCode: 'no_output_model_queue',
      summary: 'model appears queued or upstream response is delayed',
    }
  }

  return {
    kind: 'cli_blocked',
    statusCode: 'no_output_cli_blocked',
    summary: 'agent CLI appears blocked before producing protocol events',
  }
}

export function emitNoOutputDiagnosticIfNeeded(session, silenceSeconds, options = {}) {
  const heartbeatCount = Number(session.noOutputHeartbeatCount || 0)
  const threshold = Math.max(1, Number(options.heartbeatThreshold || 1))
  if (heartbeatCount < threshold) return

  const recentEvents = typeof options.getRecentEvents === 'function'
    ? options.getRecentEvents(session.sessionId)
    : []
  const diagnostic = classifyNoOutputDiagnostic({
    agentType: session.agentType,
    missingKeys: session.authDiagnosticMissingKeys,
    recentEvents,
  })

  const lastKind = session.lastNoOutputDiagnosticKind || ''
  const lastHeartbeat = Number(session.lastNoOutputDiagnosticHeartbeat || 0)
  const repeatHeartbeats = Math.max(1, Number(options.repeatHeartbeats || 1))
  const canRepeat = (heartbeatCount - lastHeartbeat) >= repeatHeartbeats
  if (lastKind === diagnostic.kind && !canRepeat) return

  options.pushEvent?.(session.sessionId, {
    type: 'status',
    turnId: session.currentTurnId,
    text: `[agent][${diagnostic.kind}] ${diagnostic.summary} (${silenceSeconds}s no output)`,
    statusCode: diagnostic.statusCode,
  })
  session.lastNoOutputDiagnosticKind = diagnostic.kind
  session.lastNoOutputDiagnosticStatusCode = diagnostic.statusCode
  session.lastNoOutputDiagnosticSummary = diagnostic.summary
  session.lastNoOutputDiagnosticHeartbeat = heartbeatCount
}

export function emitSessionProbeIfNeeded(session, silenceSeconds, options = {}) {
  if (!options.shouldEmitSessionProbeDiagnostics) return
  const heartbeatCount = Number(session.noOutputHeartbeatCount || 0)
  const interval = Math.max(1, Number(options.sessionProbeHeartbeats || 2))
  const lastProbeHeartbeat = Number(session.lastSessionProbeHeartbeat || 0)
  if ((heartbeatCount - lastProbeHeartbeat) < interval) return

  const child = session.child
  const pid = child && Number(child.pid || 0) > 0 ? Number(child.pid) : null
  const alive = isChildProcessAlive(child)
  const lastToolCallAgeSec = session.lastToolCallAt
    ? Math.max(0, Math.floor((now() - Number(session.lastToolCallAt)) / 1000))
    : null
  const lastToolResultAgeSec = session.lastToolResultAt
    ? Math.max(0, Math.floor((now() - Number(session.lastToolResultAt)) / 1000))
    : null
  const lastTool = session.lastToolCallSummary || 'none'
  const lastResult = session.lastToolResultSummary || 'none'

  options.pushEvent?.(session.sessionId, {
    type: 'status',
    turnId: session.currentTurnId,
    statusCode: 'session_probe',
    text: [
      '[agent][session_probe]',
      `state=${session.state}`,
      `pid=${pid ?? 'none'}`,
      `alive=${alive}`,
      `child_killed=${Boolean(child?.killed)}`,
      `silence=${silenceSeconds}s`,
      `last_tool="${clipDiagnosticText(lastTool, 100) || 'none'}"`,
      `last_tool_age=${lastToolCallAgeSec ?? 'na'}s`,
      `last_result="${clipDiagnosticText(lastResult, 100) || 'none'}"`,
      `last_result_age=${lastToolResultAgeSec ?? 'na'}s`,
    ].join(' '),
  })
  session.lastSessionProbeHeartbeat = heartbeatCount
}
