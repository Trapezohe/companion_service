/**
 * ACP (Agent Client Protocol) session manager — P0 control-plane.
 *
 * Provides event normalization, forced terminal state semantics,
 * actor-queue serialization, and cancel-bypass for AI agent sessions.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, existsSync, mkdirSync, copyFileSync, cpSync, statSync } from 'node:fs'
import { join, dirname, delimiter as PATH_DELIMITER } from 'node:path'

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
const CLAUDE_HELP_PROBE_TIMEOUT_MS = Number(process.env.TRAPEZOHE_CLAUDE_HELP_PROBE_TIMEOUT_MS || 1_500)
const CODEX_SAFE_REASONING_EFFORT = 'high'
const SHELL_ENV_IMPORT_TIMEOUT_MS = Number(process.env.TRAPEZOHE_ACP_SHELL_ENV_IMPORT_TIMEOUT_MS || 5_000)
const SHELL_ENV_IMPORT_CACHE_TTL_MS = Number(process.env.TRAPEZOHE_ACP_SHELL_ENV_CACHE_TTL_MS || 30_000)
/** TTL for terminal sessions before GC sweeps them (default: 10 minutes). */
const SESSION_TTL_MS = Number(process.env.TRAPEZOHE_ACP_SESSION_TTL_MS || 10 * 60 * 1000)
/** GC sweep interval (default: 60 seconds). */
const GC_INTERVAL_MS = Number(process.env.TRAPEZOHE_ACP_GC_INTERVAL_MS || 60_000)
const CODEX_ISOLATED_HOME_DIRNAME = 'codex-home'
const CODEX_HOME_SYNC_FILES = ['auth.json', 'config.toml', 'models_cache.json', 'version.json', 'AGENTS.md']
const CODEX_HOME_SYNC_DIRS = ['skills', 'rules', 'vendor_imports']
const DEFAULT_SESSION_PROBE_HEARTBEATS = Number(process.env.TRAPEZOHE_ACP_SESSION_PROBE_HEARTBEATS || 2)

// ── Module-level singletons ──

const acpSessions = new Map()
const acpEventBuffers = new Map()
let nextAcpEventCursor = 1
let claudeSupportsNonInteractivePermissions = null
let shellEnvCache = {
  expiresAt: 0,
  values: {},
}

const AGENT_AUTH_ENV_KEYS = {
  // Import auth config from shell as a fallback when the host process env does
  // not include these keys (common for GUI-launched daemons).
  'claude-code': ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CRS_OAI_KEY'],
  codex: ['CRS_OAI_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
}

const AGENT_RUNTIME_MARKER_ENV_KEYS = {
  'claude-code': [
    // Nested Claude Code runtime/session markers from IDE/agent hosts.
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
    'CLAUDE_AGENT_SDK_VERSION',
  ],
  codex: [
    // Nested Codex runtime markers from Codex Desktop/CLI host sessions.
    'CODEX_THREAD_ID',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'CODEX_SHELL',
  ],
}

// ── ACP Event types (5 canonical types) ──
// text_delta | tool_call | status | done | error

function now() {
  return Date.now()
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

function normalizeStatusText(text, maxChars = 800) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  if (raw.length <= maxChars) return raw
  return `${raw.slice(0, maxChars)}…`
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

function splitPathEntries(pathValue) {
  if (typeof pathValue !== 'string' || !pathValue.trim()) return []
  return pathValue
    .split(PATH_DELIMITER)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function shouldEmitToolResultDiagnostics() {
  return parseOptionalBoolean(process.env.TRAPEZOHE_ACP_DIAGNOSTIC_TOOL_RESULTS) !== false
}

function shouldEmitSessionProbeDiagnostics() {
  return parseOptionalBoolean(process.env.TRAPEZOHE_ACP_DIAGNOSTIC_SESSION_PROBE) !== false
}

function clipDiagnosticText(value, maxChars = 120) {
  const raw = normalizeStatusText(value, 400)
  if (!raw) return ''
  if (raw.length <= maxChars) return raw
  return `${raw.slice(0, maxChars)}…`
}

function summarizeToolInput(toolName, input) {
  const normalizedTool = String(toolName || '').trim()
  if (!normalizedTool) return ''

  if (input && typeof input === 'object') {
    if (normalizedTool === 'Read' && hasNonEmptyString(input.file_path)) {
      return `file=${clipDiagnosticText(input.file_path, 90)}`
    }
    if (normalizedTool === 'Bash' && hasNonEmptyString(input.command)) {
      return `cmd=${clipDiagnosticText(input.command, 90)}`
    }
    if (normalizedTool === 'Glob' && hasNonEmptyString(input.pattern)) {
      return `pattern=${clipDiagnosticText(input.pattern, 90)}`
    }
  }

  try {
    return `input=${clipDiagnosticText(JSON.stringify(input || {}), 90)}`
  } catch {
    return ''
  }
}

function extractToolResultText(block) {
  if (!block || typeof block !== 'object') return ''
  if (typeof block.content === 'string') return block.content
  if (!Array.isArray(block.content)) return ''
  const chunks = []
  for (const part of block.content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      chunks.push(part.text)
    }
  }
  return chunks.join('\n')
}

function summarizeToolResult(block) {
  const raw = String(extractToolResultText(block) || '').replace(/\r\n/g, '\n')
  const trimmed = raw.trim()
  if (!trimmed) {
    return { empty: true, chars: 0, lines: 0 }
  }
  return {
    empty: false,
    chars: trimmed.length,
    lines: trimmed.split('\n').length,
  }
}

function isChildProcessAlive(child) {
  if (!child || typeof child !== 'object') return false
  const pid = Number(child.pid || 0)
  if (!pid || child.killed) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function shouldIsolateCodexHome() {
  const override = parseOptionalBoolean(process.env.TRAPEZOHE_ACP_CODEX_ISOLATE_HOME)
  if (override !== null) return override
  // Default ON: isolates ACP Codex runs from interactive ~/.codex state DB.
  return true
}

function resolveCodexSourceHome(baseEnv = {}) {
  if (hasNonEmptyString(baseEnv.CODEX_HOME)) {
    return String(baseEnv.CODEX_HOME).trim()
  }
  if (hasNonEmptyString(baseEnv.HOME)) {
    return join(String(baseEnv.HOME).trim(), '.codex')
  }
  if (hasNonEmptyString(process.env.HOME)) {
    return join(String(process.env.HOME).trim(), '.codex')
  }
  return ''
}

function resolveCodexRuntimeHome(baseEnv = {}) {
  if (hasNonEmptyString(process.env.TRAPEZOHE_ACP_CODEX_RUNTIME_HOME)) {
    return String(process.env.TRAPEZOHE_ACP_CODEX_RUNTIME_HOME).trim()
  }
  if (hasNonEmptyString(baseEnv.HOME)) {
    return join(String(baseEnv.HOME).trim(), '.trapezohe', CODEX_ISOLATED_HOME_DIRNAME)
  }
  if (hasNonEmptyString(process.env.HOME)) {
    return join(String(process.env.HOME).trim(), '.trapezohe', CODEX_ISOLATED_HOME_DIRNAME)
  }
  return ''
}

function syncFileIfMissingOrStale(sourcePath, targetPath) {
  if (!existsSync(sourcePath)) return
  let shouldCopy = false
  if (!existsSync(targetPath)) {
    shouldCopy = true
  } else {
    try {
      const sourceMtime = statSync(sourcePath).mtimeMs
      const targetMtime = statSync(targetPath).mtimeMs
      shouldCopy = sourceMtime > targetMtime
    } catch {
      shouldCopy = true
    }
  }
  if (!shouldCopy) return
  mkdirSync(dirname(targetPath), { recursive: true })
  copyFileSync(sourcePath, targetPath)
}

function syncDirectoryIfMissing(sourceDir, targetDir) {
  if (!existsSync(sourceDir) || existsSync(targetDir)) return
  mkdirSync(dirname(targetDir), { recursive: true })
  cpSync(sourceDir, targetDir, { recursive: true })
}

function bootstrapCodexRuntimeHome(baseEnv = {}) {
  if (!shouldIsolateCodexHome()) return null
  const runtimeHome = resolveCodexRuntimeHome(baseEnv)
  if (!runtimeHome) return null

  mkdirSync(runtimeHome, { recursive: true })
  const sourceHome = resolveCodexSourceHome(baseEnv)
  if (!sourceHome || sourceHome === runtimeHome) {
    return runtimeHome
  }

  for (const fileName of CODEX_HOME_SYNC_FILES) {
    syncFileIfMissingOrStale(
      join(sourceHome, fileName),
      join(runtimeHome, fileName),
    )
  }
  for (const dirName of CODEX_HOME_SYNC_DIRS) {
    syncDirectoryIfMissing(
      join(sourceHome, dirName),
      join(runtimeHome, dirName),
    )
  }
  return runtimeHome
}

function readShellEnvMap() {
  const shell = hasNonEmptyString(process.env.SHELL) ? process.env.SHELL.trim() : '/bin/zsh'
  const shellName = shell.split('/').pop()?.toLowerCase() || ''
  // `-i` is required on many setups where auth exports live in ~/.zshrc or ~/.bashrc.
  const shellArgs =
    shellName.includes('zsh') || shellName.includes('bash')
      ? ['-lic', 'env']
      : ['-lc', 'env']
  try {
    const probe = spawnSync(shell, shellArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SHELL_ENV_IMPORT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    const stdout = String(probe.stdout || '')
    if (!stdout.trim()) return {}
    const values = {}
    for (const line of stdout.split(/\r?\n/)) {
      const idx = line.indexOf('=')
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      if (!key) continue
      values[key] = line.slice(idx + 1)
    }
    return values
  } catch {
    return {}
  }
}

function getShellEnvValues(keys) {
  const enabledOverride = parseOptionalBoolean(process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV)
  if (enabledOverride === false) return {}
  if (!Array.isArray(keys) || keys.length === 0) return {}

  const ts = now()
  if (shellEnvCache.expiresAt <= ts) {
    const values = readShellEnvMap()
    const hasValues = Object.keys(values).length > 0
    shellEnvCache = {
      // If shell env import fails/returns empty, retry quickly instead of
      // caching the empty map for the full TTL.
      expiresAt: ts + (hasValues ? Math.max(1_000, SHELL_ENV_IMPORT_CACHE_TTL_MS) : 1_000),
      values,
    }
  }

  const result = {}
  for (const key of keys) {
    const value = shellEnvCache.values[key]
    if (!hasNonEmptyString(value)) continue
    result[key] = String(value).trim()
  }
  return result
}

function getNvmNodeBinDirs(homeDir) {
  if (!homeDir) return []
  const nodeVersionsRoot = join(homeDir, '.nvm', 'versions', 'node')
  try {
    const dirs = readdirSync(nodeVersionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => join(nodeVersionsRoot, version, 'bin'))
      .filter((binDir) => existsSync(binDir))
    return dirs
  } catch {
    return []
  }
}

export function buildAgentPath(basePath, opts = {}) {
  const homeDir = opts.homeDir !== undefined ? opts.homeDir : process.env.HOME
  const execDir = opts.execDir || dirname(process.execPath)
  const entries = [
    ...splitPathEntries(basePath),
    execDir,
    ...(homeDir ? [join(homeDir, 'bin'), join(homeDir, '.local', 'bin')] : []),
    ...getNvmNodeBinDirs(homeDir),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean)

  const deduped = []
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry)) continue
    seen.add(entry)
    deduped.push(entry)
  }
  return deduped.join(PATH_DELIMITER)
}

function looksLikeApiKeyToken(value) {
  const token = String(value || '').trim()
  if (!token) return false
  return /^(sk-|ak-|xai-|pk-)/i.test(token)
}

function shouldUseLegacyAuthRewrite() {
  return parseOptionalBoolean(process.env.TRAPEZOHE_ACP_LEGACY_AUTH_REWRITE) === true
}

function shouldSanitizeInheritedAgentEnv() {
  return parseOptionalBoolean(process.env.TRAPEZOHE_ACP_SANITIZE_AGENT_ENV) === true
}

function stripAgentRuntimeMarkers(env, agentType) {
  const keys = AGENT_RUNTIME_MARKER_ENV_KEYS[agentType] || []
  for (const key of keys) {
    delete env[key]
  }
}


export function normalizeClaudeAuthEnv(env = {}) {
  const normalized = env

  // 1. Explicit ANTHROPIC_API_KEY takes highest priority
  const currentApiKey = hasNonEmptyString(normalized.ANTHROPIC_API_KEY)
    ? normalized.ANTHROPIC_API_KEY.trim()
    : ''
  if (currentApiKey) {
    normalized.ANTHROPIC_API_KEY = currentApiKey
    return normalized
  }

  // 2. CRS_OAI_KEY → ANTHROPIC_API_KEY (x-api-key header for CRS proxy).
  //    Using API_KEY path bypasses Claude Code's OAuth validation, which would
  //    fail because cr_ tokens are not valid Anthropic OAuth tokens.
  //    Caller is responsible for clearing ANTHROPIC_AUTH_TOKEN when appropriate.
  const crsKey = hasNonEmptyString(normalized.CRS_OAI_KEY)
    ? normalized.CRS_OAI_KEY.trim()
    : ''
  if (crsKey) {
    normalized.ANTHROPIC_API_KEY = crsKey
    return normalized
  }

  // 3. ANTHROPIC_AUTH_TOKEN that looks like a real API key → promote to ANTHROPIC_API_KEY
  const authToken = hasNonEmptyString(normalized.ANTHROPIC_AUTH_TOKEN)
    ? normalized.ANTHROPIC_AUTH_TOKEN.trim()
    : ''
  if (looksLikeApiKeyToken(authToken)) {
    normalized.ANTHROPIC_API_KEY = authToken
  }
  return normalized
}

export function resolveAgentAuthCheck(agentType, env = {}) {
  const normalizedType = String(agentType || '').toLowerCase()
  if (normalizedType !== 'claude-code') {
    return { blocking: false, missingKeys: [] }
  }
  const enforceAuthEnv = parseOptionalBoolean(process.env.TRAPEZOHE_ACP_ENFORCE_CLAUDE_AUTH_ENV) === true
  const normalizedEnv = normalizeClaudeAuthEnv({ ...env })

  const token = hasNonEmptyString(normalizedEnv.ANTHROPIC_API_KEY)
    ? normalizedEnv.ANTHROPIC_API_KEY.trim()
    : hasNonEmptyString(normalizedEnv.CRS_OAI_KEY)
      ? normalizedEnv.CRS_OAI_KEY.trim()
      : hasNonEmptyString(normalizedEnv.ANTHROPIC_AUTH_TOKEN)
        ? normalizedEnv.ANTHROPIC_AUTH_TOKEN.trim()
        : ''
  const authToken = hasNonEmptyString(normalizedEnv.ANTHROPIC_AUTH_TOKEN)
    ? normalizedEnv.ANTHROPIC_AUTH_TOKEN.trim()
    : hasNonEmptyString(normalizedEnv.ANTHROPIC_API_KEY)
      ? normalizedEnv.ANTHROPIC_API_KEY.trim()
      : ''

  if (!token) {
    if (enforceAuthEnv) {
      return {
        blocking: true,
        missingKeys: ['ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY'],
        message:
          'Missing Claude auth env. Configure ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) in extension Environment Variables.',
      }
    }
    // Default behavior: allow Claude Code local credentials (~/.claude) without env vars.
    return { blocking: false, missingKeys: [] }
  }

  const missingKeys = []
  if (
    (token.startsWith('cr_') || authToken.startsWith('cr_'))
    && !hasNonEmptyString(normalizedEnv.ANTHROPIC_BASE_URL)
  ) {
    missingKeys.push('ANTHROPIC_BASE_URL')
  }

  return { blocking: false, missingKeys }
}

function supportsClaudeNonInteractivePermissionsFlag() {
  const override = parseOptionalBoolean(process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS)
  if (override !== null) return override
  if (claudeSupportsNonInteractivePermissions !== null) return claudeSupportsNonInteractivePermissions

  try {
    const probe = spawnSync('claude', ['--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLAUDE_HELP_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    const output = `${probe.stdout || ''}\n${probe.stderr || ''}`
    claudeSupportsNonInteractivePermissions = /--non-interactive-permissions\b/.test(output)
  } catch {
    claudeSupportsNonInteractivePermissions = false
  }
  return claudeSupportsNonInteractivePermissions
}

function isPermissionRelatedText(text) {
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

function isAuthRelatedText(text) {
  if (!text) return false
  return (
    /\bunauthorized\b/i.test(text) ||
    /\bforbidden\b/i.test(text) ||
    /\binvalid[_\s-]?api[_\s-]?key\b/i.test(text) ||
    /\binvalid[_\s-]?token\b/i.test(text) ||
    /\bauth(?:entication|orization)?\b/i.test(text) ||
    /\bpermission\b/i.test(text) ||
    /\bapprove\b/i.test(text) ||
    /\bapproval\b/i.test(text) ||
    /\bnot granted\b/i.test(text) ||
    /\bmissing\b.*\b(anthropic|openai|token|api key)\b/i.test(text) ||
    /\b401\b/.test(text) ||
    /\b403\b/.test(text)
  )
}

function isNetworkRelatedText(text) {
  if (!text) return false
  return (
    /\bfailed to fetch\b/i.test(text) ||
    /\bnetwork(?:error)?\b/i.test(text) ||
    /\beconn(?:refused|reset)\b/i.test(text) ||
    /\betimedout\b/i.test(text) ||
    /\btimed out\b/i.test(text) ||
    /\bsocket hang up\b/i.test(text) ||
    /\benotfound\b/i.test(text) ||
    /\bdns\b/i.test(text) ||
    /\b(connection|connect)\b.*\b(reset|refused|timeout)\b/i.test(text) ||
    /\b(429|500|502|503|504)\b/.test(text)
  )
}

function classifyCodexStderr(text) {
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

function getRecentSessionEvents(sessionId, limit = NO_OUTPUT_DIAGNOSTIC_EVENT_SCAN_LIMIT) {
  const buffer = acpEventBuffers.get(sessionId)
  if (!Array.isArray(buffer) || buffer.length === 0) return []
  const size = Math.max(1, Math.floor(limit))
  return buffer.slice(Math.max(0, buffer.length - size))
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
    if (
      /\[(claude-code|codex)\]/i.test(text) &&
      /(initialized|thread\.started|turn\.started)/i.test(text)
    ) {
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

function emitNoOutputDiagnosticIfNeeded(session, silenceSeconds) {
  const heartbeatCount = Number(session.noOutputHeartbeatCount || 0)
  if (heartbeatCount < Math.max(1, NO_OUTPUT_DIAGNOSTIC_HEARTBEAT_THRESHOLD)) return

  const recentEvents = getRecentSessionEvents(session.sessionId)
  const diagnostic = classifyNoOutputDiagnostic({
    agentType: session.agentType,
    missingKeys: session.authDiagnosticMissingKeys,
    recentEvents,
  })

  const lastKind = session.lastNoOutputDiagnosticKind || ''
  const lastHeartbeat = Number(session.lastNoOutputDiagnosticHeartbeat || 0)
  const canRepeat = (heartbeatCount - lastHeartbeat) >= Math.max(1, NO_OUTPUT_DIAGNOSTIC_REPEAT_HEARTBEATS)
  if (lastKind === diagnostic.kind && !canRepeat) return

  pushAcpEvent(session.sessionId, {
    type: 'status',
    turnId: session.currentTurnId,
    text: `[agent][${diagnostic.kind}] ${diagnostic.summary} (${silenceSeconds}s no output)`,
    statusCode: diagnostic.statusCode,
  })
  session.lastNoOutputDiagnosticKind = diagnostic.kind
  session.lastNoOutputDiagnosticHeartbeat = heartbeatCount
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

  // Keep memory bounded in long-lived sessions.
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

function emitSessionProbeIfNeeded(session, silenceSeconds) {
  if (!shouldEmitSessionProbeDiagnostics()) return
  const heartbeatCount = Number(session.noOutputHeartbeatCount || 0)
  const interval = Math.max(1, Number.isFinite(DEFAULT_SESSION_PROBE_HEARTBEATS)
    ? Math.floor(DEFAULT_SESSION_PROBE_HEARTBEATS)
    : 2)
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

  pushAcpEvent(session.sessionId, {
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
  const trimmed = line.trim()
  if (!trimmed) return []

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Non-JSON line → degrade to status event (P0.1: never discard)
    return [{
      type: 'status',
      turnId: session.currentTurnId,
      text: trimmed,
    }]
  }

  const agentType = (session.agentType || 'raw').toLowerCase()

  if (agentType === 'claude-code') {
    return parseClaudeCodeLine(parsed, session)
  }
  if (agentType === 'codex') {
    return parseCodexLine(parsed, session)
  }

  // 'claude-api', 'raw', or any other → try Claude API format
  return parseClaudeApiLine(parsed, session, trimmed)
}

// ── Claude Code CLI stream-json format ──
// Events: system, assistant, result
function parseClaudeCodeLine(parsed, session) {
  const events = []
  const type = parsed.type || ''

  // system events (hooks, init) → status
  if (type === 'system') {
    const subtype = parsed.subtype || ''
    // Skip verbose hook payloads, just emit a short status
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
    } else if (subtype === 'hook_started' || subtype === 'hook_response') {
      // Suppress hook noise — they add no user value
    } else {
      events.push({
        type: 'status',
        turnId: session.currentTurnId,
        text: `[claude-code] ${subtype || 'system'}`,
      })
    }
    return events
  }

  // assistant message → extract content blocks
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

  // result → done or error (terminal event)
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

  // user messages (tool results) → suppress protocol noise
  if (type === 'user') {
    // Keep protocol noise filtered, but surface tool_result error text so
    // permission/approval failures are visible in the UI.
    const blocks = Array.isArray(parsed.message?.content) ? parsed.message.content : []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type !== 'tool_result') continue
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
      const suffix = targetSummary
        ? ` ${targetSummary}`
        : ''
      events.push({
        type: 'status',
        turnId: session.currentTurnId,
        statusCode: 'tool_result_ok',
        text: `[claude-code][tool_result] ${toolName}${suffix} ${resultSummary}`.trim(),
      })
    }
    return events
  }

  // Any other JSON → short status (never dump raw protocol JSON)
  const summary = parsed.subtype || parsed.event || type || 'update'
  events.push({
    type: 'status',
    turnId: session.currentTurnId,
    text: `[claude-code] ${summary}`,
  })
  return events
}

// ── Codex CLI --json JSONL format ──
// Actual Codex events observed:
//   thread.started, turn.started → status
//   item.completed + item.type=agent_message → text_delta
//   item.completed + item.type=reasoning → status
//   item.completed + item.type=function_call → tool_call
//   turn.completed → done
//   error → error
function parseCodexLine(parsed, session) {
  const events = []
  const type = parsed.type || ''

  // item.completed — the main content carrier in Codex
  if (type === 'item.completed' && parsed.item) {
    const itemType = parsed.item.type || ''

    // Agent text message
    if (itemType === 'agent_message' || itemType === 'message') {
      events.push({
        type: 'text_delta',
        turnId: session.currentTurnId,
        text: parsed.item.text || parsed.item.content || '',
      })
      return events
    }

    // Tool/function call
    if (itemType === 'function_call' || itemType === 'tool_call') {
      events.push({
        type: 'tool_call',
        turnId: session.currentTurnId,
        toolCallId: parsed.item.id || parsed.item.call_id || '',
        tool: parsed.item.name || '',
        input: (() => { const raw = parsed.item.arguments || parsed.item.input; return typeof raw === 'string' ? raw : JSON.stringify(raw || {}); })(),
      })
      return events
    }

    // Reasoning → short status (thinking indicator, not raw content)
    if (itemType === 'reasoning') {
      events.push({
        type: 'status',
        turnId: session.currentTurnId,
        text: '[codex] thinking...',
      })
      return events
    }

    // Function call output / tool result → suppress (too noisy)
    if (itemType === 'function_call_output' || itemType === 'tool_result') {
      return events
    }

    // Unknown item type → short status
    events.push({
      type: 'status',
      turnId: session.currentTurnId,
      text: `[codex] ${itemType || 'update'}`,
    })
    return events
  }

  // turn.completed → done (terminal event)
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

  // Codex error
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

  // thread.started, turn.started, and other lifecycle → short status
  const lifecycle = type || 'update'
  events.push({
    type: 'status',
    turnId: session.currentTurnId,
    text: `[codex] ${lifecycle}`,
  })
  return events
}

// ── Claude API raw streaming format ──
function parseClaudeApiLine(parsed, session, rawLine) {
  const events = []
  const type = parsed.type || ''

  // content_block_delta with text_delta
  if (type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
    events.push({
      type: 'text_delta',
      turnId: session.currentTurnId,
      text: parsed.delta.text || '',
    })
    return events
  }

  // content_block_start with tool_use → begin accumulating
  if (type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
    session.toolCallAccumulator = {
      toolCallId: parsed.content_block.id || '',
      tool: parsed.content_block.name || '',
      inputJson: '',
    }
    return events
  }

  // input_json_delta → accumulate
  if (type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
    if (session.toolCallAccumulator) {
      session.toolCallAccumulator.inputJson += parsed.delta.partial_json || ''
    }
    return events
  }

  // content_block_stop → flush tool_call
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

  // message_stop → done
  if (type === 'message_stop') {
    const stopReason = parsed.message?.stop_reason || 'end_turn'
    events.push({
      type: 'done',
      turnId: session.currentTurnId,
      stopReason,
    })
    session.terminalEmitted = true
    return events
  }

  // error
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

  // Claude Code CLI events in 'raw' mode — auto-detect
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

  // Any other JSON → status
  events.push({
    type: 'status',
    turnId: session.currentTurnId,
    text: rawLine,
  })
  return events
}

// ── Forced terminal state (P0.2) ──

/**
 * Ensure every session emits exactly one terminal event (done or error).
 * Called when the child process exits, times out, or fails to spawn.
 */
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

// ── Child process management ──

function spawnAgentChild(session, opts) {
  const { command, cwd, env, timeoutMs, prompt } = opts
  const startedAt = now()
  session.startedAt = startedAt
  session.state = 'running'

  let args
  let bin
  if (Array.isArray(command)) {
    bin = command[0]
    args = command.slice(1)
  } else {
    // Shell command string
    const shell = process.platform === 'win32'
      ? { bin: 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { bin: process.env.SHELL?.trim() || '/bin/bash', args: ['-lc', command] }
    bin = shell.bin
    args = shell.args
  }

  // Build environment from host process env (preserve local CLI auth/config by default),
  // then apply optional shell-import values and explicit per-request overrides.
  let baseEnv = { ...process.env }
  const explicitEnv =
    env && typeof env === 'object' && Object.keys(env).length > 0
      ? { ...env }
      : null

  const agentType = (session.agentType || '').toLowerCase()

  // Optional compatibility mode: sanitize ALL inherited CLI env before spawn.
  // Default is OFF to honor local host CLI auth/config as-is.
  if (
    shouldSanitizeInheritedAgentEnv()
    && (agentType === 'claude-code' || agentType === 'codex' || agentType === 'raw')
  ) {
    for (const key of Object.keys(baseEnv)) {
      if (key.startsWith('CLAUDE') || key.startsWith('CODEX')) {
        delete baseEnv[key]
      }
    }
    delete baseEnv.ANTHROPIC_AUTH_TOKEN
  }

  // Always strip runtime nesting markers for managed ACP child processes.
  // This prevents "nested session" rejections while still preserving auth/config env.
  stripAgentRuntimeMarkers(baseEnv, agentType)

  const shellAuthEnv = getShellEnvValues(AGENT_AUTH_ENV_KEYS[agentType] || [])
  for (const [key, value] of Object.entries(shellAuthEnv)) {
    if (hasNonEmptyString(baseEnv[key])) continue
    baseEnv[key] = value
  }

  if (explicitEnv) {
    for (const [key, value] of Object.entries(explicitEnv)) {
      if (value == null) continue
      baseEnv[key] = String(value)
    }
  }

  if (agentType === 'codex') {
    try {
      const runtimeHome = bootstrapCodexRuntimeHome(baseEnv)
      if (hasNonEmptyString(runtimeHome)) {
        baseEnv.CODEX_HOME = runtimeHome
      }
    } catch (error) {
      const message = normalizeStatusText(
        error instanceof Error ? error.message : String(error),
      )
      pushAcpEvent(session.sessionId, {
        type: 'status',
        turnId: session.currentTurnId,
        statusCode: 'codex_home_bootstrap_warning',
        text: `[codex] runtime home bootstrap failed; falling back to host CODEX_HOME (${message || 'unknown error'}).`,
      })
    }
  }

  const mergedEnv = baseEnv
  mergedEnv.PATH = buildAgentPath(baseEnv.PATH)
  if (agentType === 'claude-code' && shouldUseLegacyAuthRewrite()) {
    // Compatibility mode for legacy deployments that require CRS/OAuth remapping.
    if (!explicitEnv?.ANTHROPIC_AUTH_TOKEN) {
      delete mergedEnv.ANTHROPIC_AUTH_TOKEN
    }
    normalizeClaudeAuthEnv(mergedEnv)
  }
  const authCheck = resolveAgentAuthCheck(agentType, mergedEnv)
  session.authDiagnosticMissingKeys = authCheck.missingKeys

  // Use 'ignore' for stdin when no prompt will be written (e.g. CLI args carry the prompt)
  const stdinMode = prompt ? 'pipe' : 'ignore'

  if (authCheck.blocking) {
    pushAcpEvent(session.sessionId, {
      type: 'error',
      turnId: session.currentTurnId,
      code: 'missing_auth_env',
      message: authCheck.message || 'Missing auth env for agent process.',
    })
    session.terminalEmitted = true
    session.state = 'error'
    session.finishedAt = now()
    return
  }

  let child
  try {
    child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env: mergedEnv,
      stdio: [stdinMode, 'pipe', 'pipe'],
    })
  } catch (err) {
    const termEvent = synthesizeTerminalEvent(session, {
      type: 'spawn_failed',
      message: err.message,
    })
    if (termEvent) pushAcpEvent(session.sessionId, termEvent)
    session.state = 'error'
    session.finishedAt = now()
    return
  }

  session.child = child
  markOutputActivity(session)
  startNoOutputWatchdog(session)

  // readline for line-by-line stdout parsing
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    markOutputActivity(session)
    const events = parseAgentLine(line, session)
    for (const event of events) {
      pushAcpEvent(session.sessionId, event)
    }
  })

  // Capture stderr as status events
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
            pushAcpEvent(session.sessionId, {
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
      pushAcpEvent(session.sessionId, {
        type: 'status',
        turnId: session.currentTurnId,
        text: permissionRelated
          ? `[claude-code][awaiting_approval] ${text}`
          : `[stderr] ${text}`,
        statusCode: permissionRelated ? 'awaiting_approval' : 'stderr',
      })
    }
  })

  // Timeout handling.
  // timeoutMs <= 0 means "no hard timeout" for long-running agent jobs.
  const rawTimeout = Number.isFinite(timeoutMs) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS
  const timeoutDisabled = rawTimeout <= 0
  const effectiveTimeout = timeoutDisabled
    ? null
    : Math.min(Math.max(rawTimeout, 1000), MAX_TIMEOUT_MS)
  if (effectiveTimeout !== null) {
    session.timeoutRef = setTimeout(() => {
      if (session.state !== 'running') return
      const termEvent = synthesizeTerminalEvent(session, {
        type: 'timeout',
        timeoutMs: effectiveTimeout,
      })
      if (termEvent) pushAcpEvent(session.sessionId, termEvent)
      session.state = 'timeout'
      session.finishedAt = now()
      clearNoOutputWatchdog(session)
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL') } catch { /* ignore */ }
      }, CANCEL_KILL_DELAY_MS)
    }, effectiveTimeout)
    if (session.timeoutRef.unref) session.timeoutRef.unref()
  }

  // Spawn error
  child.on('error', (err) => {
    if (session.timeoutRef) clearTimeout(session.timeoutRef)
    clearNoOutputWatchdog(session)
    const termEvent = synthesizeTerminalEvent(session, {
      type: 'spawn_failed',
      message: err.message,
    })
    if (termEvent) pushAcpEvent(session.sessionId, termEvent)
    if (session.state === 'running') {
      session.state = 'error'
      session.finishedAt = now()
    }
  })

  // Process close
  child.on('close', (code) => {
    if (session.timeoutRef) clearTimeout(session.timeoutRef)
    clearNoOutputWatchdog(session)
    rl.close()
    const exitCode = typeof code === 'number' ? code : -1
    const termEvent = synthesizeTerminalEvent(session, {
      type: 'process_exit',
      exitCode,
    })
    if (termEvent) pushAcpEvent(session.sessionId, termEvent)
    if (session.state === 'running') {
      session.state = exitCode === 0 ? 'done' : 'error'
      session.finishedAt = now()
    }
  })

  // Write prompt to stdin if provided
  if (prompt && child.stdin && !child.stdin.destroyed) {
    child.stdin.write(prompt + '\n')
  }
}

// ── Public API ──

/**
 * Derive the default CLI command for a known agent type.
 * Returns null for 'raw' (caller must provide command explicitly).
 */
export function resolveDefaultCommand(agentType, prompt, agentSessionId) {
  const type = (agentType || '').toLowerCase()
  if (type === 'claude-code') {
    // claude --print streams JSON to stdout; prompt is a positional arg
    const command = [
      'claude', '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      // ACP runs are non-interactive; avoid tool-induced deadlocks that require
      // a human to answer questions in a non-tty context.
      '--disallowedTools', 'AskUserQuestion',
    ]
    if (hasNonEmptyString(agentSessionId)) {
      command.push('--session-id', String(agentSessionId).trim())
    }
    if (supportsClaudeNonInteractivePermissionsFlag()) {
      command.push('--non-interactive-permissions', 'fail')
    }
    if (prompt) command.push(prompt)
    return command
  }
  if (type === 'codex') {
    return [
      'codex', 'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c', `model_reasoning_effort=${CODEX_SAFE_REASONING_EFFORT}`,
      ...(prompt ? [prompt] : []),
    ]
  }
  return null // 'raw' — caller supplies command
}

export function createAcpSession(opts = {}) {
  const sessionId = opts.sessionId || randomBytes(16).toString('hex')
  const agentType = opts.agentType || 'raw'
  const session = {
    sessionId,
    agentType,
    state: 'idle',
    cwd: opts.cwd || process.cwd(),
    command: opts.command || null, // resolved lazily in enqueuePrompt
    env: opts.env || undefined,
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
  return { sessionId, state: session.state }
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

  const restartableTerminalStates = new Set(['done', 'error', 'timeout', 'cancelled'])
  const previousState = session.state
  if (restartableTerminalStates.has(session.state)) {
    // Re-open the same session envelope for a follow-up turn.
    // This keeps sessionId stable for long-lived assistant workflows.
    if (session.timeoutRef) {
      clearTimeout(session.timeoutRef)
      session.timeoutRef = undefined
    }
    clearNoOutputWatchdog(session)
    session.state = 'idle'
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
      || resolveDefaultCommand(session.agentType, opts.prompt, session.agentSessionId)
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

    spawnAgentChild(session, {
      command,
      cwd: opts.cwd || session.cwd,
      env: opts.env || session.env,
      timeoutMs: opts.timeoutMs ?? session.timeoutMs,
      prompt: promptForStdin,
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

    session.state = 'cancelled'
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
