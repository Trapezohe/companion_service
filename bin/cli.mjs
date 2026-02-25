#!/usr/bin/env node

/**
 * Trapezohe Companion CLI
 *
 * Usage:
 *   trapezohe-companion start [-d]          Start the companion daemon
 *   trapezohe-companion stop [--force]      Stop the daemon
 *   trapezohe-companion status              Show daemon status
 *   trapezohe-companion init                Create default config
 *   trapezohe-companion config              Print config file path
 *   trapezohe-companion token               Show current access token
 *   trapezohe-companion register [ext-id]  Register Chrome Native Messaging host
 *   trapezohe-companion unregister         Remove Native Messaging host registration
 *   trapezohe-companion bootstrap          One-shot setup for non-technical users
 */

import { fork, execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  loadConfig,
  saveConfig,
  initConfig,
  resolveToken,
  getConfigPath,
  writePid,
  readPid,
  removePid,
} from '../src/config.mjs'
import { createCompanionServer } from '../src/server.mjs'
import { McpManager } from '../src/mcp-manager.mjs'
import {
  normalizePermissionPolicy,
  PERMISSION_MODE_WORKSPACE,
  PERMISSION_MODE_FULL,
} from '../src/permission-policy.mjs'
import { loadCronStore } from '../src/cron-store.mjs'
import { startCronScheduler, stopCronScheduler } from '../src/cron-scheduler.mjs'

const __filename = fileURLToPath(import.meta.url)
const execFileAsync = promisify(execFile)

const command = process.argv[2]
const flags = process.argv.slice(3)

const DAEMON_START_TIMEOUT_MS = 4000
const STOP_GRACE_MS = 5000
const STOP_POLL_MS = 200

function hasFlag(name) {
  return flags.includes(name)
}

function getFlagValue(name) {
  const index = flags.findIndex((item) => item === name)
  if (index < 0 || index + 1 >= flags.length) return null
  const value = flags[index + 1]
  if (!value || value.startsWith('--')) return null
  return value
}

function getMultiFlagValues(name) {
  const values = []
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] !== name) continue
    const value = flags[i + 1]
    if (value && !value.startsWith('--')) {
      values.push(value)
      i += 1
    }
  }
  return values
}

async function main() {
  switch (command) {
    case 'start':
      return handleStart()
    case 'stop':
      return handleStop()
    case 'status':
      return handleStatus()
    case 'init':
      return handleInit()
    case 'config':
      return handleConfig()
    case 'token':
      return handleToken()
    case 'policy':
      return handlePolicy()
    case 'register':
      return handleRegister()
    case 'unregister':
      return handleUnregister()
    case 'bootstrap':
      return handleBootstrap()
    default:
      printHelp()
      process.exit(command === '--help' || command === '-h' ? 0 : 1)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (err.code === 'ESRCH') return false
    if (err.code === 'EPERM') return true
    throw err
  }
}

async function readProcessCommand(pid) {
  if (process.platform === 'win32') return ''
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='])
    return String(stdout || '').trim()
  } catch {
    return ''
  }
}

function looksLikeCompanionProcess(commandLine) {
  if (!commandLine) return false
  const normalized = commandLine.toLowerCase()
  return (
    normalized.includes('trapezohe-companion') ||
    (normalized.includes('bin/cli.mjs') && normalized.includes(' start'))
  )
}

async function fetchHealth(config, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/healthz`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data && data.ok ? data : null
  } catch {
    return null
  }
}

async function inspectDaemonState(config, token) {
  const pid = await readPid()
  if (!pid) return { state: 'stopped' }

  if (!(await processExists(pid))) {
    await removePid()
    return { state: 'stopped', cleaned: `stale pid ${pid}` }
  }

  const health = await fetchHealth(config, token)
  const healthPid = Number(health?.pid)
  if (Number.isFinite(healthPid) && healthPid > 0) {
    if (healthPid !== pid) {
      await writePid(healthPid)
      return { state: 'running', pid: healthPid, health, correctedFrom: pid }
    }
    return { state: 'running', pid, health }
  }

  const commandLine = await readProcessCommand(pid)
  if (looksLikeCompanionProcess(commandLine)) {
    return { state: 'running', pid }
  }

  return { state: 'unknown', pid }
}

async function waitForDaemonHealthy(config, token, expectedPid) {
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const health = await fetchHealth(config, token)
    if (health && (!expectedPid || health.pid === expectedPid)) {
      return health
    }
    if (expectedPid && !(await processExists(expectedPid))) {
      return null
    }
    await sleep(150)
  }
  return null
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await processExists(pid))) return true
    await sleep(STOP_POLL_MS)
  }
  return !(await processExists(pid))
}

async function handleStart() {
  const daemon = flags.includes('-d') || flags.includes('--daemon')
  const config = await loadConfig()
  const token = resolveToken(config)

  // Persist token before daemonizing so parent/child can share the same auth.
  if (!config.token && token) {
    await saveConfig({ ...config, token })
    config.token = token
  }

  const state = await inspectDaemonState(config, token)
  if (state.state === 'running') {
    const note = state.correctedFrom ? ` (repaired stale PID ${state.correctedFrom})` : ''
    console.log(`[trapezohe-companion] Already running (PID: ${state.pid})${note}`)
    return
  }

  if (state.state === 'unknown') {
    console.log(`[trapezohe-companion] Ignoring unverified stale PID file (${state.pid}).`)
    await removePid()
  }

  if (daemon) {
    const child = fork(__filename, ['start'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    const health = await waitForDaemonHealthy(config, token, child.pid)
    if (health) {
      console.log(`[trapezohe-companion] Daemon started (PID: ${health.pid})`)
      process.exit(0)
      return
    }

    const latest = await inspectDaemonState(config, token)
    if (latest.state === 'running') {
      console.log(`[trapezohe-companion] Daemon started (PID: ${latest.pid})`)
      process.exit(0)
      return
    }

    console.error('[trapezohe-companion] Daemon failed to become healthy. Run "trapezohe-companion start" to inspect logs.')
    process.exit(1)
    return
  }

  const mcpManager = new McpManager(config.mcpServers)
  let currentPermissionPolicy = normalizePermissionPolicy(config.permissionPolicy)
  const server = createCompanionServer({
    token,
    mcpManager,
    getPermissionPolicy: () => currentPermissionPolicy,
    setPermissionPolicy: async (nextPolicy) => {
      currentPermissionPolicy = normalizePermissionPolicy(nextPolicy)
      config.permissionPolicy = currentPermissionPolicy
      await saveConfig(config)
    },
  })

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\n[trapezohe-companion] Shutting down...')
    stopCronScheduler()
    try {
      await mcpManager.stopAll()
    } catch (err) {
      console.error(`[trapezohe-companion] Error stopping MCP servers: ${err.message}`)
    }
    server.close()
    try {
      await removePid()
    } catch (err) {
      console.error(`[trapezohe-companion] Error removing PID file: ${err.message}`)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => {
    shutdown().catch((err) => {
      console.error('[trapezohe-companion] Shutdown error:', err.message)
      process.exit(1)
    })
  })
  process.on('SIGTERM', () => {
    shutdown().catch((err) => {
      console.error('[trapezohe-companion] Shutdown error:', err.message)
      process.exit(1)
    })
  })

  server.once('error', async (err) => {
    console.error(`[trapezohe-companion] Failed to start: ${err.message}`)
    await mcpManager.stopAll()
    await removePid()
    process.exit(1)
  })

  server.listen(config.port, '127.0.0.1', async () => {
    await writePid()

    console.log('')
    console.log('  ╔══════════════════════════════════════════════╗')
    console.log('  ║        Trapezohe Companion v0.1.0            ║')
    console.log('  ╚══════════════════════════════════════════════╝')
    console.log('')
    console.log(`  Listening:  http://127.0.0.1:${config.port}`)
    console.log(`  Token:      ${token}`)
    console.log(`  Config:     ${getConfigPath()}`)
    console.log(`  Mode:       ${currentPermissionPolicy.mode}`)
    if (currentPermissionPolicy.mode === PERMISSION_MODE_WORKSPACE) {
      if (currentPermissionPolicy.workspaceRoots.length > 0) {
        console.log(`  Workspace:  ${currentPermissionPolicy.workspaceRoots.join(', ')}`)
      } else {
        console.log('  Workspace:  (not configured)')
      }
    }
    console.log('')

    const serverCount = mcpManager.getServerCount()
    if (serverCount > 0) {
      console.log(`  Starting ${serverCount} MCP server(s)...`)
      await mcpManager.startAll()
      const connected = mcpManager.getConnectedCount()
      const tools = mcpManager.getAllTools()
      console.log(`  MCP:        ${connected}/${serverCount} connected, ${tools.length} tool(s)`)
      console.log('')

      if (tools.length > 0) {
        console.log('  Available MCP tools:')
        for (const tool of tools) {
          console.log(`    [${tool.server}] ${tool.name} — ${tool.description.slice(0, 60)}`)
        }
        console.log('')
      }
    } else {
      console.log('  MCP:        No servers configured')
      console.log('')
    }

    // Start cron scheduler
    try {
      await loadCronStore()
      startCronScheduler()
    } catch (err) {
      console.error(`  Cron:       Failed to start scheduler: ${err.message}`)
    }

    console.log('  Save the token in your Trapezohe extension:')
    console.log('    Settings → Local Command Runtime → Access Token')
    console.log('')
    console.log('  Press Ctrl+C to stop')
    console.log('')
  })
}

async function handleStop() {
  const force = flags.includes('-f') || flags.includes('--force')
  const config = await loadConfig()
  const token = resolveToken(config)
  const state = await inspectDaemonState(config, token)

  if (state.state === 'stopped') {
    console.log('[trapezohe-companion] No running daemon found.')
    return
  }

  if (state.state === 'unknown') {
    console.log(`[trapezohe-companion] Refusing to stop unverified PID ${state.pid}.`)
    console.log('  Remove ~/.trapezohe/companion.pid manually if this is stale.')
    return
  }

  const pid = state.pid
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`[trapezohe-companion] Sent SIGTERM to PID ${pid}`)
  } catch (err) {
    if (err.code === 'ESRCH') {
      await removePid()
      console.log(`[trapezohe-companion] Process ${pid} not found (already stopped).`)
      return
    }
    console.error(`[trapezohe-companion] Failed to stop: ${err.message}`)
    return
  }

  let exited = await waitForExit(pid, STOP_GRACE_MS)
  if (!exited && force) {
    console.log(`[trapezohe-companion] PID ${pid} did not exit after ${STOP_GRACE_MS}ms, sending SIGKILL...`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch (err) {
      if (err.code !== 'ESRCH') {
        console.error(`[trapezohe-companion] Failed to SIGKILL PID ${pid}: ${err.message}`)
      }
    }
    exited = await waitForExit(pid, 2000)
  }

  if (exited) {
    await removePid()
    console.log('[trapezohe-companion] Daemon stopped.')
    return
  }

  console.log('[trapezohe-companion] Daemon is still shutting down.')
  console.log('  Re-run "trapezohe-companion stop --force" if needed.')
}

async function handleStatus() {
  const config = await loadConfig()
  const token = resolveToken(config)
  const policy = normalizePermissionPolicy(config.permissionPolicy)
  const state = await inspectDaemonState(config, token)

  if (state.state === 'stopped') {
    const suffix = state.cleaned ? ` (${state.cleaned})` : ''
    console.log(`[trapezohe-companion] Status: stopped${suffix}`)
    return
  }

  if (state.state === 'unknown') {
    console.log(`[trapezohe-companion] Status: unknown (PID file points to ${state.pid})`)
    console.log('  PID exists but does not look like a running companion service.')
    return
  }

  const health = state.health || await fetchHealth(config, token)
  const correction = state.correctedFrom ? ` (repaired stale PID ${state.correctedFrom})` : ''
  console.log(`[trapezohe-companion] Status: running (PID: ${state.pid})${correction}`)
  console.log(`  Port:       ${config.port}`)
  console.log(`  Mode:       ${policy.mode}`)
  if (policy.mode === PERMISSION_MODE_WORKSPACE) {
    console.log(`  Workspace:  ${policy.workspaceRoots.join(', ') || '(not configured)'}`)
  }

  if (health) {
    console.log(`  MCP:        ${health.mcpServers} server(s), ${health.mcpTools} tool(s)`)
  } else {
    console.log('  MCP:        health check failed (token mismatch or service degraded)')
  }
}

async function handleInit() {
  const result = await initConfig()
  if (result.created) {
    console.log('[trapezohe-companion] Config created:')
    console.log(`  Path:   ${result.path}`)
    console.log(`  Token:  ${result.token}`)
    console.log('')
    console.log('  Edit the config file to add MCP servers:')
    console.log(`    ${result.path}`)
  } else {
    console.log(`[trapezohe-companion] Config already exists: ${result.path}`)
  }
}

async function handleConfig() {
  console.log(getConfigPath())
}

async function handleToken() {
  const config = await loadConfig()
  if (config.token) {
    console.log(config.token)
  } else {
    console.log('[trapezohe-companion] No token configured. Run "trapezohe-companion init" first.')
  }
}

async function handlePolicy() {
  const config = await loadConfig()
  const current = normalizePermissionPolicy(config.permissionPolicy)

  if (flags.length === 0) {
    console.log(JSON.stringify(current, null, 2))
    return
  }

  const requestedMode = String(flags[0] || '').trim().toLowerCase()
  if (requestedMode !== PERMISSION_MODE_FULL && requestedMode !== PERMISSION_MODE_WORKSPACE) {
    console.error('[trapezohe-companion] Invalid mode. Use: full | workspace')
    process.exit(1)
    return
  }

  const requestedRoots = requestedMode === PERMISSION_MODE_WORKSPACE ? flags.slice(1) : []
  const nextPolicy = normalizePermissionPolicy({
    mode: requestedMode,
    workspaceRoots: requestedRoots,
  })

  if (nextPolicy.mode === PERMISSION_MODE_WORKSPACE && nextPolicy.workspaceRoots.length === 0) {
    console.error('[trapezohe-companion] Workspace mode requires at least one workspace root.')
    console.error('  Example: trapezohe-companion policy workspace ~/trapezohe-workspace')
    process.exit(1)
    return
  }

  config.permissionPolicy = nextPolicy
  await saveConfig(config)

  console.log(`[trapezohe-companion] Permission mode updated: ${nextPolicy.mode}`)
  if (nextPolicy.mode === PERMISSION_MODE_WORKSPACE) {
    console.log(`  Workspace roots: ${nextPolicy.workspaceRoots.join(', ')}`)
  }
}

// ── Native Messaging Host Registration ──

const NATIVE_HOST_NAME = 'com.trapezohe.companion'
const AUTOSTART_SERVICE_NAME = 'trapezohe-companion'
const AUTOSTART_WIN_TASK_NAME = 'TrapezoheCompanion'

function getNativeHostManifestDir() {
  const platform = process.platform
  const home = os.homedir()

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
  }
  if (platform === 'linux') {
    return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts')
  }
  if (platform === 'win32') {
    return path.join(home, '.trapezohe')
  }
  throw new Error(`Unsupported platform: ${platform}`)
}

function getNativeHostManifestPath() {
  return path.join(getNativeHostManifestDir(), `${NATIVE_HOST_NAME}.json`)
}

async function registerNativeHost(
  cliExtensionIds = [],
  { allowConfigIds = true, failIfMissing = true, quiet = false } = {},
) {
  // Resolve native-host.mjs absolute path (sibling of this script)
  const __dirname = path.dirname(__filename)
  const nativeHostScript = path.join(__dirname, 'native-host.mjs')

  // Verify the script exists
  try {
    await fs.access(nativeHostScript)
  } catch {
    console.error(`[trapezohe-companion] Native host script not found: ${nativeHostScript}`)
    process.exit(1)
    return
  }

  // Ensure execute permission on Unix
  if (process.platform !== 'win32') {
    await fs.chmod(nativeHostScript, 0o755)
  }

  // Collect extension IDs from CLI args + config
  const config = await loadConfig()
  const extraIds = allowConfigIds && Array.isArray(config.extensionIds) ? config.extensionIds : []
  const cliIds = cliExtensionIds
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
  const allIds = Array.from(new Set([...extraIds, ...cliIds]))

  if (allIds.length === 0) {
    if (!failIfMissing) {
      return null
    }
    throw new Error(
      'At least one extension ID is required. Use "trapezohe-companion register <extension-id>" or set extensionIds in companion config.',
    )
  }

  const allowedOrigins = allIds.map((id) => `chrome-extension://${id}/`)

  // Build manifest
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Trapezohe Companion — local runtime bridge for the Trapezohe browser extension',
    path: nativeHostScript,
    type: 'stdio',
    allowed_origins: allowedOrigins,
  }

  // Write manifest to OS-specific location
  const manifestDir = getNativeHostManifestDir()
  const manifestPath = getNativeHostManifestPath()
  await fs.mkdir(manifestDir, { recursive: true })
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  if (!quiet) {
    console.log('[trapezohe-companion] Native messaging host registered.')
    console.log(`  Manifest: ${manifestPath}`)
    console.log(`  Host:     ${nativeHostScript}`)
    console.log(`  Origins:  ${allowedOrigins.join(', ')}`)
  }

  // Windows: also register in Windows Registry
  if (process.platform === 'win32') {
    const regKey = `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
    try {
      await execFileAsync('reg', ['add', regKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'])
      if (!quiet) {
        console.log(`  Registry: ${regKey}`)
      }
    } catch (err) {
      if (!quiet) {
        console.error(`  Warning: Failed to register Windows registry key: ${err.message}`)
        console.error(`  You may need to manually add: ${regKey} → ${manifestPath}`)
      }
    }
  }

  // Persist extension IDs to config for future use
  if (JSON.stringify(allIds) !== JSON.stringify(extraIds)) {
    config.extensionIds = allIds
    await saveConfig(config)
    if (!quiet) {
      console.log('  Extension IDs saved to config.')
    }
  }

  if (!quiet) {
    console.log('')
    console.log('  Restart Chrome for changes to take effect.')
  }

  return {
    manifestPath,
    nativeHostScript,
    allowedOrigins,
    extensionIds: allIds,
  }
}

async function installAutostart() {
  if (process.platform === 'darwin') {
    const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
    const plistPath = path.join(plistDir, 'ai.trapezohe.companion.plist')
    await fs.mkdir(plistDir, { recursive: true })

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.trapezohe.companion</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${__filename}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(os.homedir(), '.trapezohe', 'companion.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(os.homedir(), '.trapezohe', 'companion.error.log')}</string>
</dict>
</plist>
`

    await fs.writeFile(plistPath, plist, 'utf8')
    await execFileAsync('launchctl', ['unload', plistPath]).catch(() => undefined)
    await execFileAsync('launchctl', ['load', plistPath]).catch(() => undefined)
    return { ok: true, strategy: 'launchd', target: plistPath }
  }

  if (process.platform === 'linux') {
    const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user')
    const servicePath = path.join(serviceDir, `${AUTOSTART_SERVICE_NAME}.service`)
    await fs.mkdir(serviceDir, { recursive: true })

    const service = `[Unit]
Description=Trapezohe Companion - Local MCP Server Host
After=network.target

[Service]
ExecStart=${process.execPath} ${__filename} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
    await fs.writeFile(servicePath, service, 'utf8')
    await execFileAsync('systemctl', ['--user', 'daemon-reload']).catch(() => undefined)
    await execFileAsync('systemctl', ['--user', 'enable', `${AUTOSTART_SERVICE_NAME}.service`]).catch(() => undefined)
    await execFileAsync('systemctl', ['--user', 'restart', `${AUTOSTART_SERVICE_NAME}.service`]).catch(() => undefined)
    return { ok: true, strategy: 'systemd', target: servicePath }
  }

  if (process.platform === 'win32') {
    const taskCommand = `"${process.execPath}" "${__filename}" start`
    await execFileAsync('schtasks', [
      '/Create',
      '/TN',
      AUTOSTART_WIN_TASK_NAME,
      '/SC',
      'ONLOGON',
      '/TR',
      taskCommand,
      '/F',
    ])
    await execFileAsync('schtasks', ['/Run', '/TN', AUTOSTART_WIN_TASK_NAME]).catch(() => undefined)
    return { ok: true, strategy: 'schtasks', target: AUTOSTART_WIN_TASK_NAME }
  }

  return { ok: false, strategy: 'unsupported', target: process.platform }
}

async function startDaemonDetached() {
  await execFileAsync(process.execPath, [__filename, 'start', '-d'])
}

async function handleRegister() {
  try {
    const cliIds = flags.filter((f) => !f.startsWith('-'))
    await registerNativeHost(cliIds, { allowConfigIds: true, failIfMissing: true, quiet: false })
  } catch (err) {
    console.error(`[trapezohe-companion] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

async function handleBootstrap() {
  const jsonMode = hasFlag('--json')
  const disableAutostart = hasFlag('--no-autostart')
  const disableStart = hasFlag('--no-start')
  const modeRaw = String(getFlagValue('--mode') || PERMISSION_MODE_WORKSPACE).trim().toLowerCase()
  const mode = modeRaw === PERMISSION_MODE_FULL ? PERMISSION_MODE_FULL : PERMISSION_MODE_WORKSPACE
  const workspaceRoots = getMultiFlagValues('--workspace')
  const extensionIds = [
    ...getMultiFlagValues('--ext-id'),
    ...getMultiFlagValues('--extension-id'),
  ]

  const defaultWorkspace = path.join(os.homedir(), 'ghast-workspace')
  const normalizedWorkspaceRoots = mode === PERMISSION_MODE_WORKSPACE
    ? (workspaceRoots.length > 0 ? workspaceRoots : [defaultWorkspace])
    : []

  if (mode === PERMISSION_MODE_WORKSPACE) {
    for (const root of normalizedWorkspaceRoots) {
      await fs.mkdir(path.resolve(root), { recursive: true })
    }
  }

  const init = await initConfig()
  const config = await loadConfig()
  const token = resolveToken(config)
  const nextConfig = {
    ...config,
    token,
    permissionPolicy: normalizePermissionPolicy({
      mode,
      workspaceRoots: normalizedWorkspaceRoots,
    }),
  }
  await saveConfig(nextConfig)

  let registerResult = null
  if (extensionIds.length > 0) {
    registerResult = await registerNativeHost(extensionIds, {
      allowConfigIds: true,
      failIfMissing: false,
      quiet: true,
    })
  }

  let autostartResult = { ok: false, strategy: 'disabled', target: '' }
  if (!disableAutostart) {
    autostartResult = await installAutostart()
  }

  let startResult = { ok: false, message: 'skipped' }
  if (!disableStart) {
    try {
      await startDaemonDetached()
      startResult = { ok: true, message: 'started' }
    } catch (err) {
      startResult = { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  const output = {
    ok: true,
    createdConfig: init.created,
    configPath: getConfigPath(),
    token,
    mode,
    workspaceRoots: nextConfig.permissionPolicy.workspaceRoots,
    nativeHostRegistered: Boolean(registerResult),
    extensionIds: registerResult?.extensionIds || [],
    autostart: autostartResult,
    daemon: startResult,
  }

  if (jsonMode) {
    console.log(JSON.stringify(output))
    return
  }

  console.log('[trapezohe-companion] Bootstrap complete.')
  console.log(`  Config:      ${output.configPath}`)
  console.log(`  Mode:        ${output.mode}`)
  if (output.mode === PERMISSION_MODE_WORKSPACE) {
    console.log(`  Workspace:   ${output.workspaceRoots.join(', ')}`)
  }
  if (output.nativeHostRegistered) {
    console.log(`  Native host: registered (${output.extensionIds.join(', ')})`)
  } else {
    console.log('  Native host: skipped (pass --ext-id <extension-id> to register)')
  }
  if (autostartResult.ok) {
    console.log(`  Auto-start:  enabled (${autostartResult.strategy})`)
  } else {
    console.log(`  Auto-start:  ${autostartResult.strategy}`)
  }
  console.log(`  Daemon:      ${startResult.ok ? 'running' : `not started (${startResult.message})`}`)
}

async function handleUnregister() {
  const manifestPath = getNativeHostManifestPath()

  try {
    await fs.unlink(manifestPath)
    console.log('[trapezohe-companion] Native messaging host unregistered.')
    console.log(`  Removed: ${manifestPath}`)
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('[trapezohe-companion] No native messaging host registration found.')
      return
    }
    throw err
  }

  // Windows: remove registry key
  if (process.platform === 'win32') {
    const regKey = `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
    try {
      await execFileAsync('reg', ['delete', regKey, '/f'])
      console.log(`  Registry key removed: ${regKey}`)
    } catch {
      // Ignore if key doesn't exist
    }
  }
}

function printHelp() {
  console.log(`
Trapezohe Companion — Local MCP server host & command runtime

Usage:
  trapezohe-companion <command> [flags]

Commands:
  start [-d]            Start the companion service (-d for daemon mode)
  stop [--force]        Stop the daemon (--force sends SIGKILL if needed)
  status                Show current status
  init                  Create default config at ~/.trapezohe/companion.json
  config                Print config file path
  token                 Print access token
  policy                Show or update permission policy
  bootstrap            One-shot setup + start (non-interactive friendly)
  register <ext-id>    Register Chrome Native Messaging host for auto-pairing
  unregister           Remove Native Messaging host registration

Examples:
  trapezohe-companion init          # Create config
  trapezohe-companion start         # Start in foreground
  trapezohe-companion start -d      # Start as background daemon
  trapezohe-companion status        # Check if running
  trapezohe-companion stop --force  # Force-stop if graceful stop hangs
  trapezohe-companion policy        # Print current policy JSON
  trapezohe-companion policy full
  trapezohe-companion policy workspace ~/trapezohe-workspace
  trapezohe-companion bootstrap --ext-id abc123 --mode workspace --workspace ~/ghast-workspace
  trapezohe-companion register abc123  # Register native host for extension ID

Config: ~/.trapezohe/companion.json
Docs:   https://github.com/trapezohe/companion
`)
}

main().catch((err) => {
  console.error('[trapezohe-companion] Fatal:', err.message)
  process.exit(1)
})
