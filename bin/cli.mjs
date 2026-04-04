#!/usr/bin/env node

/**
 * Trapezohe Companion CLI
 *
 * Usage:
 *   trapezohe-companion start [-d]          Start the companion daemon
 *   trapezohe-companion stop [--force]      Stop the daemon
 *   trapezohe-companion status              Show daemon status
 *   trapezohe-companion doctor              Show a compact diagnostics summary
 *   trapezohe-companion init                Create default config
 *   trapezohe-companion config              Print config file path
 *   trapezohe-companion token               Show current access token
 *   trapezohe-companion self-check          Run diagnostics and show repair suggestions
 *   trapezohe-companion repair <action>     Repair common local setup issues
 *   trapezohe-companion register            Register Chrome Native Messaging host
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
  repairConfigDefaults,
  updateMcpServerConfig,
  removeMcpServerConfig,
  resolveToken,
  getConfigPath,
  writePid,
  readPid,
  removePid,
} from '../src/config.mjs'
import { createCompanionServer } from '../src/server.mjs'
import { McpManager } from '../src/mcp-manager.mjs'
import { runCompanionSelfCheck } from '../src/diagnostics.mjs'
import { COMPANION_VERSION } from '../src/version.mjs'
import {
  normalizePermissionPolicy,
  PERMISSION_MODE_WORKSPACE,
  PERMISSION_MODE_FULL,
} from '../src/permission-policy.mjs'
import { loadCronStore } from '../src/cron-store.mjs'
import { startCronScheduler, stopCronScheduler } from '../src/cron-scheduler.mjs'
import { loadRunStore, flushRunStore } from '../src/run-store.mjs'
import { flushApprovalStore } from '../src/approval-store.mjs'
import {
  NATIVE_HOST_NAMES,
  getConfiguredExtensionIds,
  getAllowedOrigins,
  getNativeHostManifestDirs,
  getNativeHostManifestTargets,
  resolveBootstrapExtensionIds,
  resolveNativeHostExtensionIds,
} from '../src/native-host.mjs'

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

async function resolveBundledMacosRuntime(entryScript = __filename) {
  if (process.platform !== 'darwin') return null

  const scriptPath = path.resolve(entryScript)
  const binDir = path.dirname(scriptPath)
  const companionDir = path.resolve(binDir, '..')
  const resourcesDir = path.resolve(companionDir, '..')
  const contentsDir = path.resolve(resourcesDir, '..')
  const appPath = path.resolve(contentsDir, '..')

  if (path.basename(binDir) !== 'bin') return null
  if (path.basename(companionDir) !== 'companion') return null
  if (path.basename(resourcesDir) !== 'Resources') return null
  if (path.basename(contentsDir) !== 'Contents') return null
  if (!appPath.endsWith('Trapezohe Companion.app')) return null

  const runtime = {
    appPath,
    nodePath: path.join(resourcesDir, 'runtime', 'node', 'bin', 'node'),
    cliPath: path.join(companionDir, 'bin', 'cli.mjs'),
    nativeHostPath: path.join(companionDir, 'bin', 'native-host.mjs'),
  }

  try {
    await fs.access(runtime.nodePath)
    await fs.access(runtime.cliPath)
    await fs.access(runtime.nativeHostPath)
    return runtime
  } catch {
    return null
  }
}

async function resolveCliLaunchSpec(entryScript = __filename) {
  const runtime = await resolveBundledMacosRuntime(entryScript)
  if (runtime) {
    return {
      program: runtime.nodePath,
      args: [runtime.cliPath, 'start'],
    }
  }

  return {
    program: process.execPath,
    args: [entryScript, 'start'],
  }
}

async function main() {
  switch (command) {
    case 'start':
      return handleStart()
    case 'stop':
      return handleStop()
    case 'status':
      return handleStatus()
    case 'doctor':
      return handleDoctor()
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
    case 'self-check':
      return handleSelfCheck()
    case 'repair':
      return handleRepair()
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

async function fetchDiagnostics(config, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/system/diagnostics`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    return await res.json()
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
  const hooks = {}
  const server = createCompanionServer({
    token,
    mcpManager,
    getAllowedOrigins: async () => {
      const latestConfig = await loadConfig()
      return getAllowedOrigins(getConfiguredExtensionIds(latestConfig))
    },
    getPermissionPolicy: () => currentPermissionPolicy,
    setPermissionPolicy: async (nextPolicy) => {
      currentPermissionPolicy = normalizePermissionPolicy(nextPolicy)
      config.permissionPolicy = currentPermissionPolicy
      await saveConfig(config)
    },
    setMcpServerConfig: async (name, nextServerConfig) => {
      const updated = await updateMcpServerConfig(name, nextServerConfig)
      config.mcpServers = updated.mcpServers
      await mcpManager.upsertServer(name, updated.mcpServers[name])
      return { ok: true, name }
    },
    removeMcpServerConfig: async (name) => {
      const { config: updated, removed } = await removeMcpServerConfig(name)
      config.mcpServers = updated.mcpServers
      const runtimeResult = await mcpManager.deleteServer(name)
      return { ok: true, name, removed: removed || runtimeResult.removed }
    },
    shutdownFn: () => hooks.shutdown?.(),
    cleanupFn: () => hooks.cleanup?.(),
  })

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\n[trapezohe-companion] Shutting down...')
    stopCronScheduler()
    try {
      await flushRunStore()
    } catch (err) {
      console.error(`[trapezohe-companion] Error flushing run store: ${err.message}`)
    }
    try {
      await flushApprovalStore()
    } catch (err) {
      console.error(`[trapezohe-companion] Error flushing approval store: ${err.message}`)
    }
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

  hooks.shutdown = () => shutdown().catch((err) => {
    console.error('[trapezohe-companion] HTTP-triggered shutdown error:', err.message)
    process.exit(1)
  })
  hooks.cleanup = async () => {
    await handleUnregister()
    await removeAutostart()
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
    console.log(`  ║        Trapezohe Companion v${COMPANION_VERSION.padEnd(15, ' ')}║`)
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

    try {
      await loadRunStore()
    } catch (err) {
      console.error(`  Runs:       Failed to load run store: ${err.message}`)
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

async function handleDoctor() {
  const jsonMode = hasFlag('--json')
  const config = await loadConfig()
  const token = resolveToken(config)
  const state = await inspectDaemonState(config, token)

  if (state.state === 'stopped') {
    const payload = { ok: false, status: 'stopped', cleaned: state.cleaned || null }
    if (jsonMode) {
      console.log(JSON.stringify(payload))
      return
    }
    const suffix = state.cleaned ? ` (${state.cleaned})` : ''
    console.log(`[trapezohe-companion] Doctor: stopped${suffix}`)
    return
  }

  if (state.state === 'unknown') {
    const payload = { ok: false, status: 'unknown', pid: state.pid || null }
    if (jsonMode) {
      console.log(JSON.stringify(payload))
      return
    }
    console.log(`[trapezohe-companion] Doctor: unknown (PID file points to ${state.pid})`)
    return
  }

  const diagnostics = await fetchDiagnostics(config, token)
  if (!diagnostics) {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, status: 'unreachable' }))
      return
    }
    console.log('[trapezohe-companion] Doctor: unreachable')
    console.log('  Failed to fetch /api/system/diagnostics from the running daemon.')
    return
  }

  if (jsonMode) {
    console.log(JSON.stringify(diagnostics))
    return
  }

  const doctor = diagnostics.doctor || {
    status: 'unknown',
    summary: {},
    issues: [],
  }
  const summary = doctor.summary || {}
  console.log(`[trapezohe-companion] Doctor: ${doctor.status}`)
  console.log(`  Pending approvals:   ${summary.pendingApprovals ?? 0}`)
  console.log(`  Recent failed runs:  ${summary.recentFailedRuns ?? 0}`)
  console.log(`  Running ACP:         ${summary.runningAcpSessions ?? 0}`)
  console.log(`  Stalled ACP:         ${summary.stalledAcpSessions ?? 0}`)
  console.log(`  Active workflows:    ${summary.activeWorkflowRuns ?? 0}`)
  console.log(`  Browser loaded:      ${summary.browserLoaded == null ? 'unknown' : String(summary.browserLoaded)}`)
  if (Array.isArray(doctor.issues) && doctor.issues.length > 0) {
    console.log('  Issues:')
    for (const issue of doctor.issues) {
      console.log(`    - ${issue.code}: ${issue.message}`)
    }
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

async function handleSelfCheck() {
  const jsonMode = hasFlag('--json')
  const config = await loadConfig()
  const payload = await runCompanionSelfCheck({
    getPermissionPolicy: () => config.permissionPolicy,
  })

  if (jsonMode) {
    console.log(JSON.stringify(payload))
    return
  }

  console.log(`[trapezohe-companion] Self-check: ${payload.ok ? 'ok' : 'needs attention'}`)
  console.log(`  Config:      ${payload.checks.configReadable.ok ? 'ok' : 'missing'} (${payload.checks.configReadable.path || 'n/a'})`)
  console.log(`  Token:       ${payload.checks.tokenPresent.ok ? 'present' : 'missing'}`)
  console.log(`  Policy:      ${payload.checks.workspacePolicy.ok ? 'ok' : 'invalid'} (${payload.checks.workspacePolicy.mode})`)
  console.log(`  Native host: ${payload.checks.nativeHostRegistration.ok ? 'registered' : 'missing'}`)
  if (payload.repairActions?.length) {
    console.log('  Repairs:')
    for (const action of payload.repairActions) {
      console.log(`    - ${action.id}: ${action.description}`)
    }
  }
}

async function handleRepair() {
  const jsonMode = hasFlag('--json')
  const action = String(flags.find((item) => !item.startsWith('--')) || 'repair_config').trim()

  if (action === 'repair_config') {
    const result = await repairConfigDefaults()
    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, action, result }))
      return
    }
    console.log('[trapezohe-companion] Config defaults repaired.')
    console.log(`  Path:        ${result.path}`)
    console.log(`  MCP servers: ${result.mcpServerCount}`)
    console.log(`  Token:       ${result.generatedToken ? 'generated' : 'preserved'}`)
    return
  }

  if (action === 'register_native_host') {
    try {
      const extIds = getMultiFlagValues('--ext-id')
      const result = await registerNativeHost(extIds, {
        allowConfigIds: true,
        failIfMissing: true,
        quiet: jsonMode,
      })
      if (jsonMode) {
        console.log(JSON.stringify({ ok: true, action, result }))
        return
      }
      console.log('[trapezohe-companion] Native host registration repaired.')
      console.log(`  Hosts:       ${result.hostNames.join(', ')}`)
      console.log(`  Origins:     ${result.allowedOrigins.join(', ')}`)
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (jsonMode) {
        console.error(JSON.stringify({ ok: false, action, error: message }))
      } else {
        console.error(`[trapezohe-companion] ${message}`)
      }
      process.exit(1)
      return
    }
  }

  console.error('[trapezohe-companion] Unsupported repair action. Use: repair_config | register_native_host')
  process.exit(1)
}

// ── Native Messaging Host Registration ──

const AUTOSTART_SERVICE_NAME = 'trapezohe-companion'
const AUTOSTART_WIN_TASK_NAME = 'TrapezoheCompanion'

async function resolveNativeHostExecutable(nativeHostScript) {
  const bundledMacosRuntime = await resolveBundledMacosRuntime(nativeHostScript)
  if (bundledMacosRuntime) {
    const deployDir = path.join(os.homedir(), '.trapezohe')
    const launcherPath = path.join(deployDir, 'native-host-launcher.sh')
    await fs.mkdir(deployDir, { recursive: true })
    const launcher = `#!/bin/sh
exec "${bundledMacosRuntime.nodePath}" "${bundledMacosRuntime.nativeHostPath}" "$@"
`
    await fs.writeFile(launcherPath, launcher, 'utf8')
    await fs.chmod(launcherPath, 0o755)
    return launcherPath
  }

  // Deploy native host files to ~/.trapezohe/ instead of the source directory.
  // Chrome on macOS cannot execute files under ~/Desktop/ due to TCC sandbox restrictions.
  // Chrome on Windows cannot execute .mjs files directly — needs a .cmd wrapper.
  const deployDir = path.join(os.homedir(), '.trapezohe')
  const deployBinDir = path.join(deployDir, 'bin')
  const deploySrcDir = path.join(deployDir, 'src')
  const sourceBinDir = path.dirname(nativeHostScript)
  const sourceRootDir = path.resolve(sourceBinDir, '..')
  const sourceCliPath = path.join(sourceBinDir, 'cli.mjs')
  const sourcePackagePath = path.join(sourceRootDir, 'package.json')
  const sourceSrcDir = path.join(sourceRootDir, 'src')
  await fs.mkdir(deployBinDir, { recursive: true })
  await fs.mkdir(deploySrcDir, { recursive: true })

  // Deploy the runnable companion bundle so the native host can report the
  // real version and start the daemon even outside the source tree.
  const deployedScript = path.join(deployBinDir, 'native-host.mjs')
  await fs.copyFile(nativeHostScript, deployedScript)
  await fs.copyFile(sourceCliPath, path.join(deployBinDir, 'cli.mjs'))
  await fs.copyFile(sourcePackagePath, path.join(deployDir, 'package.json'))

  const sourceEntries = await fs.readdir(sourceSrcDir, { withFileTypes: true })
  for (const entry of sourceEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    await fs.copyFile(
      path.join(sourceSrcDir, entry.name),
      path.join(deploySrcDir, entry.name),
    )
  }

  if (process.platform === 'win32') {
    // Windows: Chrome native messaging requires .cmd/.exe — create a .cmd wrapper
    const launcherPath = path.join(deployDir, 'native-host-launcher.cmd')
    const launcher = `@echo off\r\n"${process.execPath}" "${deployedScript}" %*\r\n`
    await fs.writeFile(launcherPath, launcher, 'utf8')
    return launcherPath
  }

  await fs.chmod(deployedScript, 0o755)

  // GUI-launched Chromium browsers may not inherit shell PATH (nvm/node not found).
  // Use a stable launcher with absolute process.execPath so native messaging can always spawn Node.
  const launcherPath = path.join(deployDir, 'native-host-launcher.sh')
  const launcher = `#!/bin/sh
exec "${process.execPath}" "${deployedScript}" "$@"
`
  await fs.writeFile(launcherPath, launcher, 'utf8')
  await fs.chmod(launcherPath, 0o755)
  return launcherPath
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
  const existingIds = resolveNativeHostExtensionIds(config, [], {
    allowConfigIds: true,
    failIfMissing: false,
  })
  const allIds = resolveNativeHostExtensionIds(config, cliExtensionIds, {
    allowConfigIds,
    failIfMissing,
  })
  if (allIds.length === 0) return null
  const allowedOrigins = getAllowedOrigins(allIds)

  const nativeHostExecutable = await resolveNativeHostExecutable(nativeHostScript)

  // Write manifest(s) for multiple host aliases and Chromium browser channels.
  const manifestTargets = getNativeHostManifestTargets()
  for (const target of manifestTargets) {
    const manifest = {
      name: target.hostName,
      description: 'Ghast Companion — local runtime bridge for the Ghast browser extension',
      path: nativeHostExecutable,
      type: 'stdio',
      allowed_origins: allowedOrigins,
    }
    await fs.mkdir(target.dir, { recursive: true })
    await fs.writeFile(target.manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }

  if (!quiet) {
    console.log('[trapezohe-companion] Native messaging host registered.')
    console.log(`  Hosts:    ${NATIVE_HOST_NAMES.join(', ')}`)
    console.log(`  Manifests (${manifestTargets.length}):`)
    for (const target of manifestTargets) {
      console.log(`    - ${target.manifestPath}`)
    }
    console.log(`  Host:     ${nativeHostExecutable}`)
    console.log(`  Origins:  ${allowedOrigins.join(', ')}`)
  }

  // Windows: also register in Windows Registry
  if (process.platform === 'win32') {
    for (const hostName of NATIVE_HOST_NAMES) {
      const manifestPath = path.join(getNativeHostManifestDirs()[0], `${hostName}.json`)
      const regKey = `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`
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
  }

  // Persist extension IDs to config for future use
  if (JSON.stringify(allIds) !== JSON.stringify(existingIds)) {
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
    manifestPaths: manifestTargets.map((item) => item.manifestPath),
    nativeHostScript: nativeHostExecutable,
    allowedOrigins,
    extensionIds: allIds,
    hostNames: [...NATIVE_HOST_NAMES],
  }
}

async function unregisterNativeHost({ quiet = false } = {}) {
  const targets = getNativeHostManifestTargets()
  const removed = []

  for (const target of targets) {
    try {
      await fs.unlink(target.manifestPath)
      removed.push(target.manifestPath)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err
      }
    }
  }

  if (process.platform === 'win32') {
    for (const hostName of NATIVE_HOST_NAMES) {
      const regKey = `HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`
      try {
        await execFileAsync('reg', ['delete', regKey, '/f'])
        if (!quiet) {
          console.log(`  Registry key removed: ${regKey}`)
        }
      } catch {
        // Ignore if key doesn't exist
      }
    }
  }

  return { removed }
}

async function installAutostart() {
  if (process.platform === 'darwin') {
    const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
    const plistPath = path.join(plistDir, 'ai.trapezohe.companion.plist')
    const launchSpec = await resolveCliLaunchSpec()
    const programArguments = launchSpec.args.map((arg) => `  <string>${arg}</string>`).join('\n')
    await fs.mkdir(plistDir, { recursive: true })

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.trapezohe.companion</string>
  <key>ProgramArguments</key>
  <array>
    <string>${launchSpec.program}</string>
${programArguments}
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

async function removeAutostart() {
  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.trapezohe.companion.plist')
    await execFileAsync('launchctl', ['unload', plistPath]).catch(() => undefined)
    await fs.unlink(plistPath).catch(() => undefined)
  } else if (process.platform === 'linux') {
    const serviceName = `${AUTOSTART_SERVICE_NAME}.service`
    await execFileAsync('systemctl', ['--user', 'disable', serviceName]).catch(() => undefined)
    await execFileAsync('systemctl', ['--user', 'stop', serviceName]).catch(() => undefined)
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', serviceName)
    await fs.unlink(servicePath).catch(() => undefined)
  } else if (process.platform === 'win32') {
    await execFileAsync('schtasks', ['/Delete', '/TN', AUTOSTART_WIN_TASK_NAME, '/F']).catch(() => undefined)
  }
}

async function startDaemonDetached() {
  const launchSpec = await resolveCliLaunchSpec()
  await execFileAsync(launchSpec.program, [...launchSpec.args, '-d'])
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
  const requestedExtensionIds = [
    ...getMultiFlagValues('--ext-id'),
    ...getMultiFlagValues('--extension-id'),
  ]

  const defaultWorkspace = path.join(os.homedir(), 'trapezohe-workspace')
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
  const extensionIds = resolveBootstrapExtensionIds({
    requestedExtensionIds,
    configuredExtensionIds: getConfiguredExtensionIds(config),
  })
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

  const registerResult = await registerNativeHost(extensionIds, {
    allowConfigIds: false,
    failIfMissing: false,
    quiet: true,
  })
  if (!registerResult && extensionIds.length === 0) {
    await unregisterNativeHost({ quiet: true })
  }
  const nativeHostResult = registerResult
    ? {
        status: 'registered',
        reason: null,
        extensionIds: registerResult.extensionIds,
      }
    : {
        status: 'skipped',
        reason: extensionIds.length === 0 ? 'missing_extension_id' : 'registration_unavailable',
        extensionIds: [],
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
    nativeHost: nativeHostResult,
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
    console.log(`  Native host: skipped (${output.nativeHost.reason || 'unknown'})`)
  }
  if (autostartResult.ok) {
    console.log(`  Auto-start:  enabled (${autostartResult.strategy})`)
  } else {
    console.log(`  Auto-start:  ${autostartResult.strategy}`)
  }
  console.log(`  Daemon:      ${startResult.ok ? 'running' : `not started (${startResult.message})`}`)
}

async function handleUnregister() {
  const { removed } = await unregisterNativeHost()

  if (removed.length === 0) {
    console.log('[trapezohe-companion] No native messaging host registration found.')
    return
  }

  console.log('[trapezohe-companion] Native messaging host unregistered.')
  for (const manifestPath of removed) {
    console.log(`  Removed: ${manifestPath}`)
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
  doctor [--json]       Show compact diagnostics summary
  init                  Create default config at ~/.trapezohe/companion.json
  config                Print config file path
  token                 Print access token
  policy                Show or update permission policy
  self-check            Run diagnostics and list suggested repairs
  repair <action>       Repair config or native host registration
  bootstrap            One-shot setup + start (non-interactive friendly)
  register             Register Chrome Native Messaging host for the built-in Ghast extension
  unregister           Remove Native Messaging host registration

Examples:
  trapezohe-companion init          # Create config
  trapezohe-companion start         # Start in foreground
  trapezohe-companion start -d      # Start as background daemon
  trapezohe-companion status        # Check if running
  trapezohe-companion doctor        # Show compact diagnostics
  trapezohe-companion stop --force  # Force-stop if graceful stop hangs
  trapezohe-companion policy        # Print current policy JSON
  trapezohe-companion policy full
  trapezohe-companion policy workspace ~/trapezohe-workspace
  trapezohe-companion self-check --json
  trapezohe-companion repair repair_config
  trapezohe-companion repair register_native_host
  trapezohe-companion bootstrap --mode workspace --workspace ~/trapezohe-workspace
  trapezohe-companion register  # Register native host for the built-in Ghast extension

Config: ~/.trapezohe/companion.json
Docs:   https://github.com/Trapezohe/companion_service
`)
}

main().catch((err) => {
  console.error('[trapezohe-companion] Fatal:', err.message)
  process.exit(1)
})
