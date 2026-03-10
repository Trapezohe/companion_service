import { access } from 'node:fs/promises'
import path from 'node:path'

import {
  COMPANION_SUPPORTED_FEATURES,
  loadConfig,
  getConfigPath,
  getPidPath,
} from './config.mjs'
import { listRuns } from './run-store.mjs'
import { listPendingApprovals } from './approval-store.mjs'
import { listAcpSessions } from './acp-session.mjs'
import { normalizePermissionPolicy } from './permission-policy.mjs'
import { logEvent } from './log.mjs'
import {
  NATIVE_HOST_NAMES,
  getConfiguredExtensionIds,
  getNativeHostManifestTargets,
} from './native-host.mjs'

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



function buildCapabilitySummary(supportedFeatures = {}) {
  const featureEntries = Object.entries({
    ...COMPANION_SUPPORTED_FEATURES,
    ...(supportedFeatures && typeof supportedFeatures === 'object' ? supportedFeatures : {}),
  })
  const availableFeatures = featureEntries
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name)
  const unavailableFeatures = featureEntries
    .filter(([, enabled]) => enabled !== true)
    .map(([name]) => name)
  return {
    totalFeatures: featureEntries.length,
    availableCount: availableFeatures.length,
    availableFeatures,
    unavailableFeatures,
  }
}

function buildAcpIngressSummary({ runs, approvals, acpSessions }) {
  const recentAcpRuns = runs.runs.filter((run) => run.type === 'acp')
  return {
    totalSessions: acpSessions.total,
    runningSessions: acpSessions.sessions.filter((session) => session.state === 'running').length,
    idleSessions: acpSessions.sessions.filter((session) => session.state === 'idle').length,
    recentRuns: recentAcpRuns.length,
    failedRuns: recentAcpRuns.filter((run) => run.state === 'failed').length,
    pendingApprovals: approvals.length,
  }
}

async function buildMediaNormalizationSummary(params) {
  const enabled = params.supportedFeatures?.mediaNormalization === true
  let support = { available: false, engine: null, reason: enabled ? 'probe_unavailable' : 'feature_disabled' }
  if (typeof params.getMediaSupport === 'function') {
    try {
      const probed = await params.getMediaSupport()
      support = {
        available: probed?.available === true,
        engine: probed?.engine || null,
        reason: probed?.reason || null,
      }
    } catch (error) {
      support = {
        available: false,
        engine: null,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return {
    enabled,
    available: support.available,
    engine: support.engine,
    reason: support.reason,
  }
}

async function checkNativeHostRegistration(config) {
  const extensionIds = getConfiguredExtensionIds(config)
  const manifestTargets = getNativeHostManifestTargets()
  const manifests = []
  const missingManifests = []
  for (const target of manifestTargets) {
    if (await exists(target.manifestPath)) manifests.push(target.manifestPath)
    else missingManifests.push(target.manifestPath)
  }
  const required = extensionIds.length > 0
  const ok = manifests.length > 0 && (!required || missingManifests.length === 0)
  return {
    ok,
    required,
    repairable: required,
    extensionIds,
    hostNames: [...NATIVE_HOST_NAMES],
    expectedManifests: manifestTargets.map((target) => target.manifestPath),
    manifests,
    missingManifests,
  }
}

export async function buildDiagnosticsPayload(params) {
  const config = await loadConfig()
  const runs = await listRuns({ limit: 100, offset: 0 })
  const approvals = await listPendingApprovals()
  const acpSessions = listAcpSessions({ limit: 100, offset: 0 })
  const permissionPolicy = normalizePermissionPolicy(params.getPermissionPolicy?.() || config.permissionPolicy)
  const servers = params.mcpManager?.getServers?.() || []
  const nativeHostRegistration = await checkNativeHostRegistration(config)

  const capabilitySummary = buildCapabilitySummary(params.supportedFeatures)
  const acpIngressSummary = buildAcpIngressSummary({ runs, approvals, acpSessions })
  const mediaNormalizationSummary = await buildMediaNormalizationSummary(params)

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
    nativeHostRegistration,
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
    capabilitySummary,
    acpIngressSummary,
    mediaNormalizationSummary,
  }

  logEvent('info', 'diagnostics', 'Companion diagnostics generated', {
    failedRuns: payload.runs.recentFailed.length,
    pendingApprovals: payload.approvals.pending.length,
    acpSessions: payload.acp.totalSessions,
    mcpServers: payload.mcp.connectedServers,
    capabilityFeatures: payload.capabilitySummary.availableFeatures.length,
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
    && (!checks.nativeHostRegistration.required || checks.nativeHostRegistration.ok)
    && checks.mcpExecutables.every((item) => item.ok)

  const repairActions = []
  if (!checks.configReadable.ok || !checks.tokenPresent.ok || !checks.workspacePolicy.ok) {
    repairActions.push({
      id: 'repair_config',
      title: 'Repair config defaults',
      description: 'Rewrite missing config defaults while preserving MCP servers and extension ids where possible.',
    })
  }
  if (checks.nativeHostRegistration.required && !checks.nativeHostRegistration.ok) {
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
