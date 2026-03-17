import { access } from 'node:fs/promises'
import path from 'node:path'

import {
  COMPANION_SUPPORTED_FEATURES,
  loadConfig,
  getConfigPath,
  getPidPath,
} from './config.mjs'
import { summarizeAutomationSpecs } from './automation-spec.mjs'
import { listRuns } from './run-store.mjs'
import { listPendingApprovals } from './approval-store.mjs'
import { listAcpSessions } from './acp-session.mjs'
import { getMemoryShadowStatus } from './memory-shadow-store.mjs'
import { getBrowserLedgerDiagnostics } from './browser-ledger.mjs'
import { normalizePermissionPolicy } from './permission-policy.mjs'
import { logEvent } from './log.mjs'
import { RUN_CONTRACT_VERSION } from './run-envelope.mjs'
import { getJobs } from './cron-store.mjs'
import {
  getAutomationSessionSweepSummary,
  listAutomationSessionBindings,
} from './automation-session-store.mjs'
import { listAutomationOutboxItems } from './automation-outbox.mjs'
import { listAutomationBudgetLedgers } from './automation-budget-store.mjs'
import {
  NATIVE_HOST_NAMES,
  getConfiguredExtensionIds,
  getNativeHostManifestTargets,
} from './native-host.mjs'

const AUTOMATION_FEATURE_FLAGS = {
  scheduledWriteGuardV22: true,
  persistentBudgetV22: true,
  workflowKernelV22: true,
  watcherPolicyV23: true,
  orchestrationRegistryV23: false,
  watcherEscalationV23: false,
  sessionQualityRollupV23: false,
  recipeLayerV23: false,
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

function getRunMeta(run) {
  return run?.meta && typeof run.meta === 'object' && !Array.isArray(run.meta)
    ? run.meta
    : {}
}

function resolveRunOwner(run) {
  const source = typeof run?.source === 'string' ? run.source.trim() : ''
  if (source) return source
  if (run?.type === 'cron') return 'cron'
  return 'unknown'
}

function resolveReplayCount(run) {
  const replayOf = getRunMeta(run).replayOf
  if (!replayOf || typeof replayOf !== 'object' || Array.isArray(replayOf)) {
    return run?.source === 'replay' ? 1 : 0
  }
  const explicit = Number(replayOf.count)
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit)
  }
  return 1
}

function resolveRunPolicyReason(run) {
  const meta = getRunMeta(run)
  if (typeof meta.policyReason === 'string' && meta.policyReason.trim()) {
    return meta.policyReason.trim()
  }
  if (run?.state === 'waiting_approval') {
    return 'awaiting_user_approval'
  }
  return null
}

function resolveFailureCategory(run, policyReason) {
  const errorText = String(run?.error || '').toLowerCase()
  if (policyReason && policyReason.startsWith('blocked_by_')) return 'policy_blocked'
  if (run?.state === 'waiting_approval') return 'approval_wait'
  if (run?.state === 'cancelled') return 'cancelled'
  if (/fetch failed|network|socket|econn|enotfound|timed out|timeout|dns/.test(errorText)) return 'network'
  if (/\b429\b|rate limit|too many requests/.test(errorText)) return 'rate_limit'
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid token|token expired|credential/.test(errorText)) return 'auth_expired'
  if (/\b413\b|payload too large|message too long|too large/.test(errorText)) return 'payload_too_large'
  return run?.state === 'failed' ? 'unknown' : null
}

function resolveRunLifecycle(run, policyReason, replayCount) {
  if (policyReason && policyReason.startsWith('blocked_by_')) return 'blocked'
  if (run?.state === 'waiting_approval') return 'waiting_approval'
  if (run?.state === 'cancelled') return 'cancelled'
  if (run?.state === 'retrying' && replayCount > 0) return 'replaying'
  return run?.state || 'unknown'
}

function resolveApprovalWaitMs(run, approvalsById) {
  if (run?.state !== 'waiting_approval') return null
  const meta = getRunMeta(run)
  const approvalRequestId = typeof meta.approvalRequestId === 'string' && meta.approvalRequestId.trim()
    ? meta.approvalRequestId.trim()
    : typeof meta.requestId === 'string' && meta.requestId.trim()
      ? meta.requestId.trim()
      : ''
  if (!approvalRequestId) return null
  const approval = approvalsById.get(approvalRequestId)
  if (!approval || !Number.isFinite(approval.createdAt)) return null
  return Math.max(0, Date.now() - Number(approval.createdAt))
}

function buildRecentRunExplanations(runs, approvals) {
  const approvalsById = new Map(
    approvals
      .filter((approval) => typeof approval?.requestId === 'string' && approval.requestId.trim())
      .map((approval) => [approval.requestId.trim(), approval]),
  )

  return runs.runs
    .filter((run) => {
      const policyReason = resolveRunPolicyReason(run)
      return Boolean(
        policyReason
        || run.state === 'failed'
        || run.state === 'waiting_approval'
        || run.state === 'cancelled'
        || run.state === 'retrying'
        || run.source === 'replay',
      )
    })
    .slice(0, 10)
    .map((run) => {
      const policyReason = resolveRunPolicyReason(run)
      const replayCount = resolveReplayCount(run)
      return {
        runId: run.runId,
        state: run.state,
        lifecycle: resolveRunLifecycle(run, policyReason, replayCount),
        summary: run.summary,
        updatedAt: Number.isFinite(run.updatedAt) ? run.updatedAt : Date.now(),
        runOwner: resolveRunOwner(run),
        policyReason,
        approvalWaitMs: resolveApprovalWaitMs(run, approvalsById),
        replayCount,
        failureCategory: resolveFailureCategory(run, policyReason),
        contractVersion: Number.isFinite(run.contractVersion) ? Number(run.contractVersion) : RUN_CONTRACT_VERSION,
      }
    })
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

async function buildAutomationExecutionSummary(acpSessions) {
  const bindings = await listAutomationSessionBindings().catch(() => [])
  const sweep = getAutomationSessionSweepSummary()
  const automationSessions = Array.isArray(acpSessions?.sessions)
    ? acpSessions.sessions.filter((session) => session.origin === 'automation')
    : []

  return {
    persistentBindings: bindings.length,
    cleanedBindings: sweep.removed || 0,
    lastSweepAt: sweep.sweptAt,
    lastSweepReasons: sweep.reasons,
    activeAcpSessions: automationSessions.length,
    runningAcpSessions: automationSessions.filter((session) => session.state === 'running').length,
    recentBindings: bindings.slice(0, 10),
  }
}

async function buildAutomationOutboxSummary() {
  const listed = await listAutomationOutboxItems({ limit: 10, offset: 0 }).catch(() => ({
    items: [],
    total: 0,
    limit: 10,
    offset: 0,
    hasMore: false,
  }))
  return {
    depth: listed.total || 0,
    recent: Array.isArray(listed.items)
      ? listed.items.slice(0, 5).map((item) => ({
          id: item.id,
          runId: item.runId,
          taskId: item.taskId,
          taskName: item.taskName,
          mode: item.mode,
          createdAt: item.createdAt,
        }))
      : [],
  }
}

function buildAutomationLifecyclePhaseSummary(runs) {
  return runs.runs
    .filter((run) => run.type === 'cron' && run.meta?.executionMode === 'companion_acp')
    .slice(0, 5)
    .map((run) => ({
      runId: run.runId,
      taskId: typeof run.meta?.taskId === 'string' ? run.meta.taskId : '',
      taskName: typeof run.meta?.taskName === 'string' ? run.meta.taskName : '',
      taskState: typeof run.meta?.taskState === 'string' ? run.meta.taskState : null,
      stepState: typeof run.meta?.stepState === 'string' ? run.meta.stepState : null,
      workflow:
        run.meta?.workflow && typeof run.meta.workflow === 'object' && !Array.isArray(run.meta.workflow)
          ? JSON.parse(JSON.stringify(run.meta.workflow))
          : null,
    }))
}

function countActiveWorkflowRuns(runs) {
  return runs.runs.filter((run) => {
    if (run.type !== 'cron' || run.meta?.executionMode !== 'companion_acp') return false
    const workflow = run.meta?.workflow
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return false
    if (workflow.template !== 'research_synthesis' && workflow.template !== 'research_decision') return false
    return run.state === 'queued' || run.state === 'running' || run.state === 'retrying'
  }).length
}

function countActiveWorkflowTemplates(jobs) {
  const specs = Array.isArray(jobs) ? jobs : []
  const counts = {}
  for (const job of specs) {
    const template = job?.workflow?.template
    if (template && template !== 'single_turn') {
      counts[template] = (counts[template] || 0) + 1
    }
  }
  return counts
}

function countWatcherEscalationsPending(jobs) {
  const specs = Array.isArray(jobs) ? jobs : []
  return specs.filter((job) =>
    job?.watcher?.policy?.escalateWithWorkflow === true
    && job?.watcher?.policy?.mode === 'change_only',
  ).length
}

function countCriticalSessionQuality(jobs) {
  const specs = Array.isArray(jobs) ? jobs : []
  return specs.filter((job) =>
    job?.sessionBudget?.ledger?.health === 'critical',
  ).length
}

function countRollupBackedSessions(jobs) {
  const specs = Array.isArray(jobs) ? jobs : []
  return specs.filter((job) =>
    job?.sessionBudget?.ledger?.lastCompactedAt != null,
  ).length
}

function countRecentCompactions(jobs) {
  const specs = Array.isArray(jobs) ? jobs : []
  let total = 0
  for (const job of specs) {
    const count = job?.sessionBudget?.ledger?.compactionCount
    if (typeof count === 'number' && count > 0) total += count
  }
  return total
}

async function buildAutomationBudgetHealthSummary() {
  const ledgers = await listAutomationBudgetLedgers().catch(() => [])
  const summary = {
    trackedSessions: ledgers.length,
    healthy: 0,
    warning: 0,
    critical: 0,
    lastRollupAt: null,
  }

  for (const entry of ledgers) {
    const health = entry?.ledger?.health === 'warning' || entry?.ledger?.health === 'critical'
      ? entry.ledger.health
      : 'healthy'
    summary[health] += 1
    const rollupAt = Number.isFinite(entry?.ledger?.lastRollupAt) ? Number(entry.ledger.lastRollupAt) : null
    if (rollupAt && (!summary.lastRollupAt || rollupAt > summary.lastRollupAt)) {
      summary.lastRollupAt = rollupAt
    }
  }

  return summary
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

async function buildMemoryShadowRefreshSummary(params) {
  if (!params.memoryShadowRefresh || typeof params.memoryShadowRefresh.getState !== 'function') {
    return null
  }

  try {
    const state = await params.memoryShadowRefresh.getState()
    return {
      available: state?.available === true || params.memoryShadowRefresh.available === true,
      state: state?.state || 'empty',
      freshnessOwner: state?.freshnessOwner || 'none',
      freshnessSlaHours: Number.isFinite(state?.freshnessSlaHours)
        ? Number(state.freshnessSlaHours)
        : (Number.isFinite(params.memoryShadowRefresh.freshnessSlaHours)
          ? Number(params.memoryShadowRefresh.freshnessSlaHours)
          : null),
      lastAttemptAt: Number.isFinite(state?.lastAttemptAt) ? Number(state.lastAttemptAt) : null,
      lastOutcome: state?.lastOutcome || null,
      lastError: state?.lastError || null,
      lastSourceGeneration: state?.lastSourceGeneration || null,
      lastSourceCommittedAt: Number.isFinite(state?.lastSourceCommittedAt)
        ? Number(state.lastSourceCommittedAt)
        : null,
      lastPublishedGeneration: state?.lastPublishedGeneration || null,
      lastPublishedAt: Number.isFinite(state?.lastPublishedAt) ? Number(state.lastPublishedAt) : null,
      lastPublishSource: state?.lastPublishSource || null,
    }
  } catch (error) {
    return {
      available: false,
      state: 'failed',
      freshnessOwner: 'none',
      freshnessSlaHours: null,
      lastAttemptAt: null,
      lastOutcome: 'failed',
      lastError: error instanceof Error ? error.message : String(error),
      lastSourceGeneration: null,
      lastSourceCommittedAt: null,
      lastPublishedGeneration: null,
      lastPublishedAt: null,
      lastPublishSource: null,
    }
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
  const memoryShadow = await getMemoryShadowStatus().catch(() => null)
  const automationJobs = getJobs()
  const automationSummary = summarizeAutomationSpecs(automationJobs)
  const automationExecution = await buildAutomationExecutionSummary(acpSessions)
  const automationOutbox = await buildAutomationOutboxSummary()
  const automationLifecyclePhases = buildAutomationLifecyclePhaseSummary(runs)
  const automationBudgetHealth = await buildAutomationBudgetHealthSummary()
  const activeWorkflowRuns = countActiveWorkflowRuns(runs)
  const automationFailures = runs.runs
    .filter((run) => run.type === 'cron' && run.meta?.executionMode === 'companion_acp' && run.state === 'failed')
    .slice(0, 5)
    .map((run) => ({
      runId: run.runId,
      summary: run.summary,
      error: run.error,
      taskId: typeof run.meta?.taskId === 'string' ? run.meta.taskId : undefined,
      taskName: typeof run.meta?.taskName === 'string' ? run.meta.taskName : undefined,
      finishedAt: run.finishedAt,
    }))

  const capabilitySummary = buildCapabilitySummary(params.supportedFeatures)
  const acpIngressSummary = buildAcpIngressSummary({ runs, approvals, acpSessions })
  const mediaNormalizationSummary = await buildMediaNormalizationSummary(params)
  const memoryShadowRefresh = await buildMemoryShadowRefreshSummary(params)
  const browserLedgerSummary = await getBrowserLedgerDiagnostics({
    supportedFeatures: params.supportedFeatures,
  })
  const recentRunExplanations = buildRecentRunExplanations(runs, approvals)

  const payload = {
    contractVersion: RUN_CONTRACT_VERSION,
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
    automation: {
      ...automationSummary,
      featureFlags: AUTOMATION_FEATURE_FLAGS,
      activeWorkflowRuns,
      activeWorkflowTemplates: countActiveWorkflowTemplates(automationJobs),
      watcherEscalationsPending: countWatcherEscalationsPending(automationJobs),
      criticalSessionQuality: countCriticalSessionQuality(automationJobs),
      rollupBackedSessions: countRollupBackedSessions(automationJobs),
      recentCompactions: countRecentCompactions(automationJobs),
      budgetHealth: automationBudgetHealth,
      execution: automationExecution,
      outbox: automationOutbox,
      recentLifecyclePhases: automationLifecyclePhases,
      recentFailures: automationFailures,
    },
    runs: {
      recentFailed: runs.runs.filter((run) => run.state === 'failed').slice(0, 5),
      recentExplanations: recentRunExplanations,
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
    ...(memoryShadow ? { memoryShadow } : {}),
    ...(memoryShadowRefresh ? { memoryShadowRefresh } : {}),
    browser: {
      enabled: params.supportedFeatures?.browserLedger === true,
      loaded: browserLedgerSummary.loaded,
      sessions: browserLedgerSummary.sessions,
      actions: browserLedgerSummary.actions,
      artifacts: browserLedgerSummary.artifacts,
      events: browserLedgerSummary.events,
      operator: browserLedgerSummary.operator,
      capabilities: browserLedgerSummary.capabilities,
    },
  }

  logEvent('info', 'diagnostics', 'Companion diagnostics generated', {
    failedRuns: payload.runs.recentFailed.length,
    pendingApprovals: payload.approvals.pending.length,
    acpSessions: payload.acp.totalSessions,
    automationJobs: payload.automation.totalJobs,
    automationUnsupported: payload.automation.unsupportedCompanionJobs.length,
    mcpServers: payload.mcp.connectedServers,
    capabilityFeatures: payload.capabilitySummary.availableFeatures.length,
    memoryShadowGeneration: payload.memoryShadow?.mirroredGeneration || null,
    memoryShadowRefreshState: payload.memoryShadowRefresh?.state || null,
    browserSessions: payload.browser.sessions.active,
    browserFailedActions: payload.browser.actions.failedRecent,
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
