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

const DEFAULT_PERMISSION_POLICY = normalizePermissionPolicy({ mode: 'full' })

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
