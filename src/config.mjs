import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'

const CONFIG_DIR = path.join(os.homedir(), '.trapezohe')
const CONFIG_FILE = path.join(CONFIG_DIR, 'companion.json')
const PID_FILE = path.join(CONFIG_DIR, 'companion.pid')

const DEFAULT_CONFIG = {
  port: 41591,
  token: '',
  mcpServers: {},
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

export async function ensureConfigDir() {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
}

export async function loadConfig() {
  await ensureConfigDir()

  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      port: Number(parsed.port) || DEFAULT_CONFIG.port,
      token: typeof parsed.token === 'string' ? parsed.token.trim() : '',
      mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object'
        ? parsed.mcpServers
        : {},
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ...DEFAULT_CONFIG }
    }
    throw err
  }
}

export async function saveConfig(config) {
  await ensureConfigDir()
  const json = JSON.stringify(config, null, 2) + '\n'
  await fs.writeFile(CONFIG_FILE, json, 'utf8')
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

export async function writePid() {
  await ensureConfigDir()
  await fs.writeFile(PID_FILE, String(process.pid), 'utf8')
}

export async function readPid() {
  try {
    const raw = await fs.readFile(PID_FILE, 'utf8')
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
