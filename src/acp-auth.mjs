import { readdirSync, existsSync, mkdirSync, copyFileSync, cpSync, statSync } from 'node:fs'
import { join, dirname, delimiter as PATH_DELIMITER } from 'node:path'

const CLAUDE_HELP_PROBE_TIMEOUT_MS = Number(process.env.TRAPEZOHE_CLAUDE_HELP_PROBE_TIMEOUT_MS || 1_500)
const CODEX_SAFE_REASONING_EFFORT = 'high'
const CODEX_ISOLATED_HOME_DIRNAME = 'codex-home'
const CODEX_HOME_SYNC_FILES = ['auth.json', 'config.toml', 'models_cache.json', 'version.json', 'AGENTS.md']
const CODEX_HOME_SYNC_DIRS = ['skills', 'rules', 'vendor_imports']

let claudeSupportsNonInteractivePermissions = null

export const AGENT_AUTH_ENV_KEYS = {
  'claude-code': ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CRS_OAI_KEY'],
  codex: ['CRS_OAI_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
}

const AGENT_RUNTIME_MARKER_ENV_KEYS = {
  'claude-code': [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
    'CLAUDE_AGENT_SDK_VERSION',
  ],
  codex: [
    'CODEX_THREAD_ID',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'CODEX_SHELL',
  ],
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

function getNvmNodeBinDirs(homeDir) {
  if (!homeDir) return []
  const nodeVersionsRoot = join(homeDir, '.nvm', 'versions', 'node')
  try {
    return readdirSync(nodeVersionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => join(nodeVersionsRoot, version, 'bin'))
      .filter((binDir) => existsSync(binDir))
  } catch {
    return []
  }
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

export function normalizeClaudeAuthEnv(env = {}) {
  const normalized = env
  const currentApiKey = hasNonEmptyString(normalized.ANTHROPIC_API_KEY)
    ? normalized.ANTHROPIC_API_KEY.trim()
    : ''
  if (currentApiKey) {
    normalized.ANTHROPIC_API_KEY = currentApiKey
    return normalized
  }

  const crsKey = hasNonEmptyString(normalized.CRS_OAI_KEY)
    ? normalized.CRS_OAI_KEY.trim()
    : ''
  if (crsKey) {
    normalized.ANTHROPIC_API_KEY = crsKey
    return normalized
  }

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

function shouldIsolateCodexHome() {
  const override = parseOptionalBoolean(process.env.TRAPEZOHE_ACP_CODEX_ISOLATE_HOME)
  if (override !== null) return override
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
    syncFileIfMissingOrStale(join(sourceHome, fileName), join(runtimeHome, fileName))
  }
  for (const dirName of CODEX_HOME_SYNC_DIRS) {
    syncDirectoryIfMissing(join(sourceHome, dirName), join(runtimeHome, dirName))
  }
  return runtimeHome
}

function stripAgentRuntimeMarkers(env, agentType) {
  const keys = AGENT_RUNTIME_MARKER_ENV_KEYS[agentType] || []
  for (const key of keys) {
    delete env[key]
  }
}

export function prepareAgentEnvironment(baseEnv, agentType) {
  const agentEnv = { ...baseEnv }
  if (shouldSanitizeInheritedAgentEnv()) {
    stripAgentRuntimeMarkers(agentEnv, agentType)
    if (agentType === 'claude-code' && shouldUseLegacyAuthRewrite()) {
      if (hasNonEmptyString(agentEnv.CRS_OAI_KEY)) {
        agentEnv.ANTHROPIC_API_KEY = agentEnv.CRS_OAI_KEY
      }
      delete agentEnv.ANTHROPIC_AUTH_TOKEN
    }
  }
  if (agentType === 'claude-code') {
    normalizeClaudeAuthEnv(agentEnv)
  }
  if (agentType === 'codex') {
    const isolatedCodexHome = bootstrapCodexRuntimeHome(agentEnv)
    if (isolatedCodexHome) {
      agentEnv.CODEX_HOME = isolatedCodexHome
    }
  }
  return agentEnv
}

export function resolveAgentDefaultCommand(agentType, prompt, agentSessionId) {
  const type = String(agentType || '').toLowerCase()
  if (type === 'claude-code') {
    const command = [
      'claude',
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--disallowedTools', 'AskUserQuestion',
      ...(supportsClaudeNonInteractivePermissionsFlag() ? ['--non-interactive-permissions', 'fail'] : []),
      ...(agentSessionId ? ['--session-id', agentSessionId] : []),
      ...(prompt ? [prompt] : []),
    ]
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
  return null
}
