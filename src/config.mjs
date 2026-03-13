import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { normalizePermissionPolicy } from './permission-policy.mjs'

const CONFIG_DIR = path.join(os.homedir(), '.trapezohe')
const CONFIG_FILE = path.join(CONFIG_DIR, 'companion.json')
const PID_FILE = path.join(CONFIG_DIR, 'companion.pid')
const CONFIG_DIR_MODE = 0o700
const CONFIG_FILE_MODE = 0o600
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 120_000
const MIN_MCP_REQUEST_TIMEOUT_MS = 1
const MAX_MCP_REQUEST_TIMEOUT_MS = 600_000

const DEFAULT_PERMISSION_POLICY = normalizePermissionPolicy({ mode: 'full' })
export const COMPANION_PROTOCOL_VERSION = '2026-03-07'
export const COMPANION_SUPPORTED_FEATURES = {
  acp: true,
  mcp: true,
  cronReplay: true,
  diagnostics: true,
  approvalStore: true,
  runLedger: true,
  browserLedger: true,
  browserEvents: true,
  mediaNormalization: true,
}

const DEFAULT_CONFIG = {
  port: 41591,
  token: '',
  mcpServers: {},
  permissionPolicy: DEFAULT_PERMISSION_POLICY,
}

export function getConfigDir() {
  return CONFIG_DIR
}

export function getConfigPath() {
  return CONFIG_FILE
}

export function getPidPath() {
  return PID_FILE
}

function coerceMcpRequestTimeoutMs(value, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback
  }
  return Math.min(MAX_MCP_REQUEST_TIMEOUT_MS, Math.max(MIN_MCP_REQUEST_TIMEOUT_MS, Math.round(numeric)))
}

export function getDefaultMcpRequestTimeoutMs() {
  return coerceMcpRequestTimeoutMs(
    process.env.TRAPEZOHE_MCP_REQUEST_TIMEOUT_MS,
    DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  )
}

export function normalizeMcpRequestTimeoutMs(value, fallback = getDefaultMcpRequestTimeoutMs()) {
  return coerceMcpRequestTimeoutMs(value, fallback)
}

function parseOptionalMcpRequestTimeoutOverride(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined

  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('MCP server config.requestTimeoutMs must be a positive number when provided.')
  }

  return normalizeMcpRequestTimeoutMs(numeric)
}

async function safeChmod(target, mode) {
  try {
    await fs.chmod(target, mode)
  } catch (err) {
    if (err.code === 'ENOSYS' || err.code === 'EPERM' || err.code === 'EINVAL') {
      return
    }
    throw err
  }
}

export async function ensureConfigDir() {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: CONFIG_DIR_MODE })
  await safeChmod(CONFIG_DIR, CONFIG_DIR_MODE)
}

export async function loadConfig() {
  await ensureConfigDir()

  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8')
    await safeChmod(CONFIG_FILE, CONFIG_FILE_MODE)
    const parsed = JSON.parse(raw)
    return {
      port: Number(parsed.port) || DEFAULT_CONFIG.port,
      token: typeof parsed.token === 'string' ? parsed.token.trim() : '',
      mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object'
        ? parsed.mcpServers
        : {},
      permissionPolicy: normalizePermissionPolicy(parsed.permissionPolicy),
      ...(Array.isArray(parsed.extensionIds) && parsed.extensionIds.length > 0
        ? {
            extensionIds: parsed.extensionIds
              .filter((id) => typeof id === 'string' && id.trim())
              .map((id) => id.trim()),
          }
        : {}),
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        ...DEFAULT_CONFIG,
        permissionPolicy: normalizePermissionPolicy(DEFAULT_PERMISSION_POLICY),
      }
    }
    throw err
  }
}

export async function saveConfig(config) {
  await ensureConfigDir()
  const normalized = {
    port: Number(config?.port) || DEFAULT_CONFIG.port,
    token: typeof config?.token === 'string' ? config.token.trim() : '',
    mcpServers: config?.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers
      : {},
    permissionPolicy: normalizePermissionPolicy(config?.permissionPolicy),
  }
  // Preserve extensionIds for native messaging host registration
  if (Array.isArray(config?.extensionIds) && config.extensionIds.length > 0) {
    normalized.extensionIds = config.extensionIds.filter((id) => typeof id === 'string' && id.trim())
  }
  const json = JSON.stringify(normalized, null, 2) + '\n'
  await fs.writeFile(CONFIG_FILE, json, { encoding: 'utf8', mode: CONFIG_FILE_MODE })
  await safeChmod(CONFIG_FILE, CONFIG_FILE_MODE)
}

function normalizeMcpServerConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MCP server config must be an object.')
  }
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (!command) {
    throw new Error('MCP server config.command is required.')
  }

  const args = Array.isArray(input.args)
    ? input.args
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
    : []

  // Backward-compatibility shim: historical docs/examples used a package name
  // that does not exist on npm. Rewrite it to the canonical package.
  for (let i = 0; i < args.length; i++) {
    if (/^@bnb-chain\/bnbchain-mcp(?:@.+)?$/i.test(args[i])) {
      args[i] = '@bnb-chain/mcp@latest'
    }
  }

  const env = {}
  if (input.env !== undefined) {
    if (!input.env || typeof input.env !== 'object' || Array.isArray(input.env)) {
      throw new Error('MCP server config.env must be an object when provided.')
    }
    for (const [key, value] of Object.entries(input.env)) {
      if (typeof value !== 'string') {
        throw new Error(`MCP server env "${key}" must be a string.`)
      }
      env[key] = value
    }
  }

  const cwd = typeof input.cwd === 'string' && input.cwd.trim()
    ? input.cwd.trim()
    : undefined
  const requestTimeoutMs = parseOptionalMcpRequestTimeoutOverride(input.requestTimeoutMs)

  return {
    command,
    args,
    env,
    ...(cwd ? { cwd } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(typeof input.restartable === 'boolean' ? { restartable: input.restartable } : {}),
    ...(typeof input.writeCapable === 'boolean' ? { writeCapable: input.writeCapable } : {}),
  }
}

export async function updateMcpServerConfig(name, serverConfig) {
  const serverName = typeof name === 'string' ? name.trim() : ''
  if (!serverName) {
    throw new Error('MCP server name is required.')
  }
  const normalizedServerConfig = normalizeMcpServerConfig(serverConfig)

  const config = await loadConfig()
  const nextMcpServers = {
    ...(config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}),
    [serverName]: normalizedServerConfig,
  }
  const nextConfig = {
    ...config,
    mcpServers: nextMcpServers,
  }
  await saveConfig(nextConfig)
  return nextConfig
}

export async function removeMcpServerConfig(name) {
  const serverName = typeof name === 'string' ? name.trim() : ''
  if (!serverName) {
    throw new Error('MCP server name is required.')
  }
  const config = await loadConfig()
  const currentServers = config.mcpServers && typeof config.mcpServers === 'object'
    ? { ...config.mcpServers }
    : {}
  const removed = Object.prototype.hasOwnProperty.call(currentServers, serverName)
  if (!removed) {
    return { config, removed: false }
  }
  delete currentServers[serverName]
  const nextConfig = {
    ...config,
    mcpServers: currentServers,
  }
  await saveConfig(nextConfig)
  return { config: nextConfig, removed: true }
}

export async function initConfig() {
  await ensureConfigDir()

  try {
    await fs.access(CONFIG_FILE)
    return { created: false, path: CONFIG_FILE }
  } catch {
    // File doesn't exist, create default
  }

  const token = randomBytes(24).toString('hex')
  const config = { ...DEFAULT_CONFIG, token }
  await saveConfig(config)
  return { created: true, path: CONFIG_FILE, token }
}

export async function repairConfigDefaults() {
  await ensureConfigDir()
  let existing
  try {
    existing = await loadConfig()
  } catch {
    existing = {
      ...DEFAULT_CONFIG,
      permissionPolicy: normalizePermissionPolicy(DEFAULT_PERMISSION_POLICY),
    }
  }

  const nextToken = existing.token || randomBytes(24).toString('hex')
  const nextConfig = {
    port: Number(existing?.port) || DEFAULT_CONFIG.port,
    token: nextToken,
    mcpServers: existing?.mcpServers && typeof existing.mcpServers === 'object'
      ? existing.mcpServers
      : {},
    permissionPolicy: normalizePermissionPolicy(existing?.permissionPolicy),
    ...(Array.isArray(existing?.extensionIds) && existing.extensionIds.length > 0
      ? { extensionIds: existing.extensionIds.filter((id) => typeof id === 'string' && id.trim()) }
      : {}),
  }

  await saveConfig(nextConfig)
  return {
    ok: true,
    path: CONFIG_FILE,
    token: nextToken,
    generatedToken: !existing?.token,
    mcpServerCount: Object.keys(nextConfig.mcpServers).length,
    extensionIds: Array.isArray(nextConfig.extensionIds) ? nextConfig.extensionIds : [],
  }
}

export function resolveToken(config) {
  if (config.token) return config.token
  // Auto-generate a temporary token for this session
  return randomBytes(24).toString('hex')
}

export async function writePid(pid = process.pid) {
  await ensureConfigDir()
  await fs.writeFile(PID_FILE, String(pid), { encoding: 'utf8', mode: CONFIG_FILE_MODE })
  await safeChmod(PID_FILE, CONFIG_FILE_MODE)
}

export async function readPid() {
  try {
    const raw = await fs.readFile(PID_FILE, 'utf8')
    await safeChmod(PID_FILE, CONFIG_FILE_MODE)
    return Number(raw.trim()) || null
  } catch {
    return null
  }
}

export async function removePid() {
  try {
    await fs.unlink(PID_FILE)
  } catch {
    // Ignore if already removed
  }
}
