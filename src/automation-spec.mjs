const DEFAULT_EXECUTOR = 'extension_chat'
const DEFAULT_SESSION_TARGET = 'main'
const DEFAULT_DELIVERY_MODE = 'notification'
const DEFAULT_WORKFLOW = {
  template: 'single_turn',
  state: null,
}

function normalizeExecutor(raw) {
  return raw === 'companion_acp' ? raw : DEFAULT_EXECUTOR
}

function normalizeAgentType(raw) {
  return raw === 'codex' || raw === 'claude-code' ? raw : null
}

function normalizeSessionTarget(raw) {
  if (raw === 'isolated' || raw === 'main') return raw
  if (typeof raw === 'string' && raw.startsWith('persistent:') && raw.length > 'persistent:'.length) {
    return raw
  }
  return DEFAULT_SESSION_TARGET
}

function normalizeDeliveryMode(raw) {
  return raw === 'chat' || raw === 'remote_channel' || raw === 'webhook'
    ? raw
    : DEFAULT_DELIVERY_MODE
}

function normalizePositiveCount(raw) {
  return Number.isFinite(raw) && Number(raw) > 0 ? Math.floor(Number(raw)) : null
}

function normalizeStringArray(raw) {
  if (!Array.isArray(raw)) return null
  const values = raw
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
  return values.length > 0 ? values : null
}

function normalizeScheduledWriteTool(raw) {
  return raw === 'write_file' || raw === 'run_local_command' || raw === 'run_local_command_session'
    ? raw
    : null
}

function normalizeScheduledWritePolicy(raw, executor) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const mode = raw.mode === 'allowlist' ? 'allowlist' : 'read_only'
  const allowedTools = Array.isArray(raw.allowedTools)
    ? raw.allowedTools
      .map((item) => normalizeScheduledWriteTool(item))
      .filter(Boolean)
    : []
  if (mode === 'read_only') {
    return {
      mode,
      allowedTools: [],
      allowedPaths: null,
      allowedCommandPrefixes: null,
      enforcement: executor === 'companion_acp' ? 'prompt_only' : 'extension_hard',
    }
  }
  return {
    mode,
    allowedTools,
    allowedPaths: normalizeStringArray(raw.allowedPaths),
    allowedCommandPrefixes: normalizeStringArray(raw.allowedCommandPrefixes),
    enforcement: executor === 'companion_acp' ? 'prompt_only' : 'extension_hard',
  }
}

function normalizeWorkflow(raw) {
  // Workflow always normalizes to a stable single_turn shape so downstream diagnostics
  // and prompt builders do not need null checks for the default case.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_WORKFLOW }
  }
  return {
    template: raw.template === 'research_synthesis' ? 'research_synthesis' : 'single_turn',
    state: raw.state && typeof raw.state === 'object' && !Array.isArray(raw.state)
      ? raw.state
      : null,
  }
}

function normalizeWatcherPolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    mode: raw.mode === 'change_only' ? 'change_only' : 'disabled',
    minNotifyIntervalMinutes: normalizePositiveCount(raw.minNotifyIntervalMinutes),
  }
}

function normalizeWatcherState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    lastObservationHash: typeof raw.lastObservationHash === 'string' && raw.lastObservationHash ? raw.lastObservationHash : null,
    lastObservationSummary:
      typeof raw.lastObservationSummary === 'string' && raw.lastObservationSummary
        ? raw.lastObservationSummary
        : null,
    lastClassifiedState:
      raw.lastClassifiedState === 'unchanged'
        || raw.lastClassifiedState === 'changed'
        || raw.lastClassifiedState === 'alerted'
        ? raw.lastClassifiedState
        : null,
    lastDeliveredAt: Number.isFinite(raw.lastDeliveredAt) ? Number(raw.lastDeliveredAt) : null,
  }
}

function normalizeWatcher(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    policy: normalizeWatcherPolicy(raw.policy),
    state: normalizeWatcherState(raw.state),
  }
}

function normalizeSessionBudgetPolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    mode: raw.mode === 'lean' || raw.mode === 'deep_research' ? raw.mode : 'default',
    maxContextBudget: normalizePositiveCount(raw.maxContextBudget),
    dayRollupEnabled: raw.dayRollupEnabled !== false,
    compactAfterRuns: normalizePositiveCount(raw.compactAfterRuns),
  }
}

function normalizeSessionBudgetLedger(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    approxInputTokens: Number.isFinite(raw.approxInputTokens) ? Math.max(0, Math.round(Number(raw.approxInputTokens))) : 0,
    approxOutputTokens: Number.isFinite(raw.approxOutputTokens) ? Math.max(0, Math.round(Number(raw.approxOutputTokens))) : 0,
    compactionCount: Number.isFinite(raw.compactionCount) ? Math.max(0, Math.round(Number(raw.compactionCount))) : 0,
    lastRollupAt: Number.isFinite(raw.lastRollupAt) ? Number(raw.lastRollupAt) : null,
    health: raw.health === 'warning' || raw.health === 'critical' ? raw.health : 'healthy',
  }
}

function normalizeSessionBudget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    policy: normalizeSessionBudgetPolicy(raw.policy),
    ledger: normalizeSessionBudgetLedger(raw.ledger),
  }
}

export function normalizeSessionRetention(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const maxAgeDays = normalizePositiveCount(raw.maxAgeDays)
  const maxRuns = normalizePositiveCount(raw.maxRuns)
  if (maxAgeDays === null && maxRuns === null) return null
  return {
    maxAgeDays,
    maxRuns,
  }
}

function resolveDeliveryTransport(mode) {
  if (mode === 'chat' || mode === 'remote_channel') return 'outbox'
  if (mode === 'webhook') return 'direct'
  return 'local'
}

export function normalizeAutomationSpec(job) {
  const executor = normalizeExecutor(job?.executor)
  const agentType = normalizeAgentType(job?.agentType)
  const sessionTarget = normalizeSessionTarget(job?.sessionTarget)
  const deliveryMode = normalizeDeliveryMode(job?.delivery?.mode)
  const sessionRetention = normalizeSessionRetention(job?.sessionRetention)
  const scheduledWritePolicy = normalizeScheduledWritePolicy(job?.scheduledWritePolicy, executor)
  const workflow = normalizeWorkflow(job?.workflow)
  const watcher = normalizeWatcher(job?.watcher)
  const sessionBudget = normalizeSessionBudget(job?.sessionBudget)

  let unsupportedReason = null
  if (workflow.template !== 'single_turn' && executor !== 'companion_acp') {
    unsupportedReason = 'workflow_requires_companion_acp'
  } else if (executor === 'companion_acp' && !agentType) {
    unsupportedReason = 'agent_type_required'
  } else if (executor === 'companion_acp' && sessionTarget === 'main') {
    unsupportedReason = 'main_session_not_supported'
  }

  return {
    id: typeof job?.id === 'string' ? job.id : '',
    name: typeof job?.name === 'string' ? job.name : '',
    executor,
    agentType,
    sessionTarget,
    sessionRetention,
    scheduledWritePolicy,
    workflow,
    watcher,
    sessionBudget,
    lifecycleCapable: sessionTarget !== 'main',
    supported: unsupportedReason === null,
    unsupportedReason,
    delivery: {
      mode: deliveryMode,
      transport: resolveDeliveryTransport(deliveryMode),
    },
  }
}

export function summarizeAutomationSpecs(jobs) {
  const specs = Array.isArray(jobs) ? jobs.map((job) => normalizeAutomationSpec(job)) : []
  return {
    totalJobs: specs.length,
    extensionChatJobs: specs.filter((spec) => spec.executor === 'extension_chat').length,
    companionExecutableJobs: specs.filter((spec) => spec.executor === 'companion_acp' && spec.supported).length,
    lifecycleCapableJobs: specs.filter((spec) => spec.lifecycleCapable).length,
    allowlistScheduledWrites: specs.filter((spec) => spec.scheduledWritePolicy?.mode === 'allowlist').length,
    scheduledWriteEnforcements: {
      extensionHard: specs.filter(
        (spec) => spec.scheduledWritePolicy?.mode === 'allowlist'
          && spec.scheduledWritePolicy?.enforcement === 'extension_hard',
      ).length,
      promptOnly: specs.filter(
        (spec) => spec.scheduledWritePolicy?.mode === 'allowlist'
          && spec.scheduledWritePolicy?.enforcement === 'prompt_only',
      ).length,
    },
    workflowCapableJobs: specs.filter(
      (spec) => spec.executor === 'companion_acp' && spec.workflow?.template === 'research_synthesis',
    ).length,
    watcherConfiguredJobs: specs.filter((spec) => spec.watcher?.policy?.mode === 'change_only').length,
    budgetManagedJobs: specs.filter((spec) => Boolean(spec.sessionBudget?.policy)).length,
    unsupportedCompanionJobs: specs
      .filter((spec) => spec.executor === 'companion_acp' && !spec.supported)
      .map((spec) => ({
        id: spec.id,
        name: spec.name,
        reason: spec.unsupportedReason,
      })),
    outboxDeliveries: specs.filter((spec) => spec.delivery.transport === 'outbox').length,
    directDeliveries: specs.filter((spec) => spec.delivery.transport === 'direct').length,
  }
}
