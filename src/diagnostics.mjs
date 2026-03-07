import { access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { loadConfig, getConfigPath, getPidPath } from './config.mjs'
import { listRuns } from './run-store.mjs'
import { listPendingApprovals } from './approval-store.mjs'
import { listAcpSessions } from './acp-session.mjs'
import { normalizePermissionPolicy } from './permission-policy.mjs'
import { logEvent } from './log.mjs'

const NATIVE_HOST_BASENAME = 'ai.ghast.companion'

function getNativeHostManifestDirs() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
      path.join(home, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
    ]
  }
  if (process.platform === 'win32') {
    return [
      path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts'),
      path.join(home, 'AppData', 'Local', 'Chromium', 'User Data', 'NativeMessagingHosts'),
    ]
  }
  return [
    path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
    path.join(home, '.config', 'chromium', 'NativeMessagingHosts'),
  ]
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function getPathEntries(envPath) {
  return String(envPath || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
}

async function resolveExecutable(command) {
  const trimmed = String(command || '').trim()
  if (!trimmed) return false
  if (trimmed.includes(path.sep)) {
    return exists(trimmed)
  }
  for (const entry of getPathEntries(process.env.PATH)) {
    const candidate = path.join(entry, trimmed)
    if (await exists(candidate)) return true
    if (process.platform === 'win32' && await exists(`${candidate}.exe`)) return true
  }
  return false
}

async function checkNativeHostRegistration(config) {
  const extensionIds = Array.isArray(config.extensionIds) ? config.extensionIds : []
  const manifestPaths = getNativeHostManifestDirs().map((dir) => path.join(dir, `${NATIVE_HOST_BASENAME}.json`))
  const matches = []
  for (const manifestPath of manifestPaths) {
    if (await exists(manifestPath)) matches.push(manifestPath)
  }
  return {
    ok: matches.length > 0,
    extensionIds,
    manifests: matches,
  }
}

export async function buildDiagnosticsPayload(params) {
  const config = await loadConfig()
  const runs = await listRuns({ limit: 100, offset: 0 })
  const approvals = await listPendingApprovals()
  const acpSessions = listAcpSessions({ limit: 100, offset: 0 })
  const permissionPolicy = normalizePermissionPolicy(params.getPermissionPolicy?.() || config.permissionPolicy)
  const servers = params.mcpManager?.getServers?.() || []

  const payload = {
    protocolVersion: params.protocolVersion,
    version: params.version,
    permissionPolicy,
    paths: {
      config: getConfigPath(),
      pid: getPidPath(),
    },
    mcp: {
      configuredServers: Array.isArray(Object.keys(config.mcpServers || {})) ? Object.keys(config.mcpServers || {}).length : 0,
      connectedServers: params.mcpManager?.getConnectedCount?.() || 0,
      totalTools: params.mcpManager?.getAllTools?.().length || 0,
      servers,
    },
    runs: {
      recentFailed: runs.runs.filter((run) => run.state === 'failed').slice(0, 5),
    },
    approvals: {
      pending: approvals,
    },
    acp: {
      totalSessions: acpSessions.total,
      runningSessions: acpSessions.sessions.filter((session) => session.state === 'running').length,
      idleSessions: acpSessions.sessions.filter((session) => session.state === 'idle').length,
    },
  }

  logEvent('info', 'diagnostics', 'Companion diagnostics generated', {
    failedRuns: payload.runs.recentFailed.length,
    pendingApprovals: payload.approvals.pending.length,
    acpSessions: payload.acp.totalSessions,
    mcpServers: payload.mcp.connectedServers,
  })

  return payload
}

export async function runCompanionSelfCheck(params) {
  const config = await loadConfig()
  const permissionPolicy = normalizePermissionPolicy(params.getPermissionPolicy?.() || config.permissionPolicy)
  const nativeHostRegistration = await checkNativeHostRegistration(config)
  const mcpExecutables = await Promise.all(
    Object.entries(config.mcpServers || {}).map(async ([name, serverConfig]) => ({
      name,
      command: serverConfig?.command || '',
      ok: await resolveExecutable(serverConfig?.command || ''),
    })),
  )

  const checks = {
    configReadable: { ok: await exists(getConfigPath()), path: getConfigPath() },
    tokenPresent: { ok: Boolean(String(config.token || '').trim()) },
    workspacePolicy: {
      ok: permissionPolicy.mode !== 'workspace'
        || permissionPolicy.workspaceRoots.every((root) => typeof root === 'string' && root.trim().length > 0),
      mode: permissionPolicy.mode,
      workspaceRoots: permissionPolicy.workspaceRoots,
    },
    nativeHostRegistration,
    mcpExecutables,
  }

  const ok = checks.configReadable.ok
    && checks.tokenPresent.ok
    && checks.workspacePolicy.ok
    && checks.mcpExecutables.every((item) => item.ok)

  const repairActions = []
  if (!checks.configReadable.ok || !checks.tokenPresent.ok || !checks.workspacePolicy.ok) {
    repairActions.push({
      id: 'repair_config',
      title: 'Repair config defaults',
      description: 'Rewrite missing config defaults while preserving MCP servers and extension ids where possible.',
    })
  }
  if (!checks.nativeHostRegistration.ok) {
    repairActions.push({
      id: 'register_native_host',
      title: 'Re-register native host',
      description: 'Restore Chrome native messaging registration for the configured extension ids.',
    })
  }

  logEvent(ok ? 'info' : 'warn', 'diagnostics', 'Companion self-check finished', {
    ok,
    missingExecutables: checks.mcpExecutables.filter((item) => !item.ok).map((item) => item.name),
    nativeHostRegistered: checks.nativeHostRegistration.ok,
  })

  return {
    ok,
    checks,
    repairActions,
  }
}
