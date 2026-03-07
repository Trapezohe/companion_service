function now() {
  return Date.now()
}

function normalizeStatusText(text, maxChars = 800) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(32, maxChars - 16)).trimEnd()}...[truncated]`
}

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function clipDiagnosticText(value, maxChars = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(16, maxChars - 16)).trimEnd()}...`
}

function shouldEmitToolResultDiagnostics() {
  const raw = String(
    process.env.TRAPEZOHE_ACP_DIAGNOSTIC_TOOL_RESULTS
    ?? process.env.TRAPEZOHE_ACP_TOOL_RESULT_DIAGNOSTICS
    ?? '',
  ).trim().toLowerCase()
  if (!raw) return true
  return !['0', 'false', 'no', 'off'].includes(raw)
}

function isPermissionRelatedText(text) {
  if (!text) return false
  return (
    /\bpermission\b/i.test(text)
    || /\bapprove\b/i.test(text)
    || /\bapproval\b/i.test(text)
    || /\btrust\b/i.test(text)
    || /\bnon-interactive\b/i.test(text)
    || /\bnot granted\b/i.test(text)
    || /\bgrant(ed)?\b/i.test(text)
  )
}

function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return ''
  const preferredKeys = ['path', 'file_path', 'url', 'query', 'command', 'cwd', 'symbol', 'address', 'contract', 'txHash']
  for (const key of preferredKeys) {
    const raw = input[key]
    if (typeof raw === 'string' && raw.trim()) {
      return `${key}=${clipDiagnosticText(raw, 72)}`
    }
  }
  const keys = Object.keys(input)
  if (keys.length === 0) return ''
  if (toolName === 'apply_patch') {
    return `keys=${keys.length}`
  }
  const preview = keys
    .slice(0, 3)
    .map((key) => `${key}=${clipDiagnosticText(String(input[key] ?? ''), 32)}`)
    .join(', ')
  return clipDiagnosticText(preview, 96)
}

function extractToolResultText(block) {
  if (!block || typeof block !== 'object') return ''
  if (typeof block.content === 'string') {
    return normalizeStatusText(block.content)
  }
  if (!Array.isArray(block.content)) return ''
  const chunks = []
  for (const part of block.content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      chunks.push(part.text.trim())
    }
  }
  return normalizeStatusText(chunks.join(' '))
}

function summarizeToolResult(block) {
  const text = extractToolResultText(block)
  if (!text) {
    return { chars: 0, lines: 0, preview: '', empty: true }
  }
  return {
    chars: text.length,
    lines: text.split(/\n+/).filter(Boolean).length || 1,
    preview: clipDiagnosticText(text, 80),
    empty: false,
  }
}

function extractToolResultErrorText(block) {
  if (!block || typeof block !== 'object') return ''
  if (typeof block.content === 'string') {
    return normalizeStatusText(block.content)
  }
  if (!Array.isArray(block.content)) return ''
  const chunks = []
  for (const part of block.content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      chunks.push(part.text.trim())
    }
  }
  return normalizeStatusText(chunks.join(' '))
}

function rememberToolCall(session, toolCallId, toolName, input) {
  if (!session || !hasNonEmptyString(toolCallId)) return
  if (!(session.toolCallsById instanceof Map)) {
    session.toolCallsById = new Map()
  }
  const normalizedTool = String(toolName || '').trim() || 'tool'
  const targetSummary = summarizeToolInput(normalizedTool, input)
  session.toolCallsById.set(String(toolCallId).trim(), {
    tool: normalizedTool,
    targetSummary,
    at: now(),
  })
  session.lastToolCallSummary = targetSummary
    ? `${normalizedTool} (${targetSummary})`
    : normalizedTool
  session.lastToolCallAt = now()

  while (session.toolCallsById.size > 128) {
    const oldestKey = session.toolCallsById.keys().next().value
    if (!oldestKey) break
    session.toolCallsById.delete(oldestKey)
  }
}

function rememberToolResult(session, payload = {}) {
  if (!session) return
  const { tool = 'tool', targetSummary = '', resultSummary = '' } = payload
  const label = targetSummary
    ? `${tool} (${targetSummary})`
    : String(tool || 'tool')
  session.lastToolResultSummary = resultSummary
    ? `${label} -> ${resultSummary}`
    : label
  session.lastToolResultAt = now()
}

function parseClaudeCodeLine(parsed, session) {
  const events = []
  const type = parsed.type || ''

  if (type === 'system') {
    const subtype = parsed.subtype || ''
    if (subtype === 'init') {
      events.push({
        type: 'status',
        turnId: session.currentTurnId,
        text: `[claude-code] initialized (model=${parsed.model || 'unknown'})`,
      })
      if (hasNonEmptyString(parsed.session_id)) {
        const runtimeSessionId = String(parsed.session_id).trim()
        session.runtimeSessionId = runtimeSessionId
        events.push({
          type: 'status',
          turnId: session.currentTurnId,
          statusCode: 'runtime_session_id',
          text: `[claude-code] session_id=${runtimeSessionId}`,
        })
      }
    } else if (subtype !== 'hook_started' && subtype !== 'hook_response') {
      events.push({
        type: 'status',
        turnId: session.currentTurnId,
        text: `[claude-code] ${subtype || 'system'}`,
      })
    }
    return events
  }

  if (type === 'assistant' && parsed.message?.content) {
    const content = parsed.message.content
    let sawThinking = false
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === 'text' && block.text) {
        events.push({
          type: 'text_delta',
          turnId: session.currentTurnId,
          text: block.text,
        })
      } else if (block.type === 'tool_use') {
        rememberToolCall(session, block.id || '', block.name || '', block.input || {})
        events.push({
          type: 'tool_call',
          turnId: session.currentTurnId,
          toolCallId: block.id || '',
          tool: block.name || '',
          input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
        })
      } else if (block.type === 'thinking') {
        sawThinking = true
      }
    }
    if (events.length === 0 && sawThinking) {
      const nowTs = now()
      const lastThinkingAt = Number(session.lastThinkingStatusAt || 0)
      if (!lastThinkingAt || (nowTs - lastThinkingAt) >= 10_000) {
        events.push({
          type: 'status',
          turnId: session.currentTurnId,
          text: '[claude-code] thinking...',
          statusCode: 'model_thinking',
        })
        session.lastThinkingStatusAt = nowTs
      }
    }
    return events
  }

  if (type === 'result') {
    if (parsed.is_error || parsed.subtype === 'error') {
      events.push({
        type: 'error',
        turnId: session.currentTurnId,
        code: 'agent_error',
        message: parsed.error || parsed.result || 'Claude Code returned error',
      })
      session.terminalEmitted = true
    } else {
      events.push({
        type: 'done',
        turnId: session.currentTurnId,
        stopReason: parsed.stop_reason || 'end_turn',
        result: parsed.result || undefined,
      })
      session.terminalEmitted = true
    }
    return events
  }

  if (type === 'user') {
    const blocks = Array.isArray(parsed.message?.content) ? parsed.message.content : []
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue
      const toolUseId = hasNonEmptyString(block.tool_use_id)
        ? String(block.tool_use_id).trim()
        : ''
      const meta = (session.toolCallsById instanceof Map)
        ? session.toolCallsById.get(toolUseId)
        : null
      const toolName = String(meta?.tool || 'tool')
      const targetSummary = String(meta?.targetSummary || '')

      if (block.is_error) {
        const detail = extractToolResultErrorText(block)
        if (!detail) continue
        rememberToolResult(session, {
          tool: toolName,
          targetSummary,
          resultSummary: `error ${clipDiagnosticText(detail, 80)}`,
        })
        const permissionRelated = isPermissionRelatedText(detail)
        events.push({
          type: 'status',
          turnId: session.currentTurnId,
          text: permissionRelated
            ? `[claude-code][awaiting_approval] ${detail}`
            : `[claude-code][tool_error] ${detail}`,
          statusCode: permissionRelated ? 'awaiting_approval' : 'tool_error',
        })
        continue
      }

      if (!shouldEmitToolResultDiagnostics()) continue
      const result = summarizeToolResult(block)
      const resultSummary = result.empty
        ? 'ok empty_result'
        : `ok chars=${result.chars} lines=${result.lines}`
      rememberToolResult(session, {
        tool: toolName,
        targetSummary,
        resultSummary,
      })
      const suffix = targetSummary ? ` ${targetSummary}` : ''
      events.push({
        type: 'status',
        turnId: session.currentTurnId,
        statusCode: 'tool_result_ok',
        text: `[claude-code][tool_result] ${toolName}${suffix} ${resultSummary}`.trim(),
      })
    }
    return events
  }

  const summary = parsed.subtype || parsed.event || type || 'update'
  events.push({
    type: 'status',
    turnId: session.currentTurnId,
    text: `[claude-code] ${summary}`,
  })
  return events
}

function parseCodexLine(parsed, session) {
  const events = []
  const type = parsed.type || ''

  if (type === 'item.completed' && parsed.item) {
    const itemType = parsed.item.type || ''
    if (itemType === 'agent_message' || itemType === 'message') {
      events.push({
        type: 'text_delta',
        turnId: session.currentTurnId,
        text: parsed.item.text || parsed.item.content || '',
      })
      return events
    }
    if (itemType === 'function_call' || itemType === 'tool_call') {
      events.push({
        type: 'tool_call',
        turnId: session.currentTurnId,
        toolCallId: parsed.item.id || parsed.item.call_id || '',
        tool: parsed.item.name || '',
        input: (() => {
          const raw = parsed.item.arguments || parsed.item.input
          return typeof raw === 'string' ? raw : JSON.stringify(raw || {})
        })(),
      })
      return events
    }
    if (itemType === 'reasoning') {
      events.push({
        type: 'status',
        turnId: session.currentTurnId,
        text: '[codex] thinking...',
      })
      return events
    }
    if (itemType === 'function_call_output' || itemType === 'tool_result') {
      return events
    }
    events.push({
      type: 'status',
      turnId: session.currentTurnId,
      text: `[codex] ${itemType || 'update'}`,
    })
    return events
  }

  if (type === 'turn.completed') {
    events.push({
      type: 'done',
      turnId: session.currentTurnId,
      stopReason: 'end_turn',
      usage: parsed.usage || undefined,
    })
    session.terminalEmitted = true
    return events
  }

  if (type === 'error') {
    events.push({
      type: 'error',
      turnId: session.currentTurnId,
      code: 'agent_error',
      message: parsed.message || parsed.error || JSON.stringify(parsed),
    })
    session.terminalEmitted = true
    return events
  }

  events.push({
    type: 'status',
    turnId: session.currentTurnId,
    text: `[codex] ${type || 'update'}`,
  })
  return events
}

function parseClaudeApiLine(parsed, session, rawLine) {
  const events = []
  const type = parsed.type || ''

  if (type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
    events.push({
      type: 'text_delta',
      turnId: session.currentTurnId,
      text: parsed.delta.text || '',
    })
    return events
  }

  if (type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
    session.toolCallAccumulator = {
      toolCallId: parsed.content_block.id || '',
      tool: parsed.content_block.name || '',
      inputJson: '',
    }
    return events
  }

  if (type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
    if (session.toolCallAccumulator) {
      session.toolCallAccumulator.inputJson += parsed.delta.partial_json || ''
    }
    return events
  }

  if (type === 'content_block_stop') {
    if (session.toolCallAccumulator) {
      let input
      try {
        input = JSON.parse(session.toolCallAccumulator.inputJson)
      } catch {
        input = session.toolCallAccumulator.inputJson || null
      }
      events.push({
        type: 'tool_call',
        turnId: session.currentTurnId,
        toolCallId: session.toolCallAccumulator.toolCallId,
        tool: session.toolCallAccumulator.tool,
        input,
      })
      session.toolCallAccumulator = null
    }
    return events
  }

  if (type === 'message_stop') {
    events.push({
      type: 'done',
      turnId: session.currentTurnId,
      stopReason: parsed.message?.stop_reason || 'end_turn',
    })
    session.terminalEmitted = true
    return events
  }

  if (type === 'error') {
    events.push({
      type: 'error',
      turnId: session.currentTurnId,
      code: 'agent_error',
      message: parsed.error?.message || parsed.message || JSON.stringify(parsed),
    })
    session.terminalEmitted = true
    return events
  }

  if (type === 'result') {
    if (parsed.is_error || parsed.subtype === 'error') {
      events.push({
        type: 'error',
        turnId: session.currentTurnId,
        code: 'agent_error',
        message: parsed.error || parsed.result || 'Agent returned error',
      })
      session.terminalEmitted = true
    } else {
      events.push({
        type: 'done',
        turnId: session.currentTurnId,
        stopReason: parsed.stop_reason || 'end_turn',
        result: parsed.result || undefined,
      })
      session.terminalEmitted = true
    }
    return events
  }

  if (type === 'assistant' && parsed.message?.content) {
    for (const block of Array.isArray(parsed.message.content) ? parsed.message.content : []) {
      if (block.type === 'text' && block.text) {
        events.push({ type: 'text_delta', turnId: session.currentTurnId, text: block.text })
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool_call',
          turnId: session.currentTurnId,
          toolCallId: block.id || '',
          tool: block.name || '',
          input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
        })
      }
    }
    if (events.length > 0) return events
  }

  events.push({
    type: 'status',
    turnId: session.currentTurnId,
    text: rawLine,
  })
  return events
}

export function parseAgentLine(line, session) {
  const trimmed = line.trim()
  if (!trimmed) return []

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return [{
      type: 'status',
      turnId: session.currentTurnId,
      text: trimmed,
    }]
  }

  const agentType = (session.agentType || 'raw').toLowerCase()
  if (agentType === 'claude-code') return parseClaudeCodeLine(parsed, session)
  if (agentType === 'codex') return parseCodexLine(parsed, session)
  return parseClaudeApiLine(parsed, session, trimmed)
}

export function synthesizeTerminalEvent(session, reason) {
  if (session.terminalEmitted) return null

  session.terminalEmitted = true
  const turnId = session.currentTurnId

  switch (reason.type) {
    case 'timeout':
      return {
        type: 'error',
        turnId,
        code: 'timeout',
        message: `Session timed out after ${reason.timeoutMs || 0}ms`,
      }
    case 'spawn_failed':
      return {
        type: 'error',
        turnId,
        code: 'spawn_failed',
        message: reason.message || 'Failed to spawn agent process',
      }
    case 'process_exit': {
      const exitCode = reason.exitCode
      if (exitCode === 0) {
        return {
          type: 'done',
          turnId,
          stopReason: 'process_exit',
        }
      }
      return {
        type: 'error',
        turnId,
        code: 'process_exit',
        exitCode,
        message: `Agent process exited with code ${exitCode}`,
      }
    }
    default:
      return {
        type: 'error',
        turnId,
        code: 'unknown',
        message: reason.message || 'Unknown terminal reason',
      }
  }
}
