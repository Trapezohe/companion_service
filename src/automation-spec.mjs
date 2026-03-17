const DEFAULT_EXECUTOR = 'extension_chat'
const DEFAULT_SESSION_TARGET = 'main'
const DEFAULT_DELIVERY_MODE = 'notification'
const DEFAULT_WORKFLOW = {
  template: 'single_turn',
  policy: null,
  state: null,
}

function normalizeExecutor(raw) {
  return raw === 'companion_acp' ? raw : DEFAULT_EXECUTOR
}

function normalizeAgentType(raw) {
  return raw === 'codex' || raw === 'claude-code' ? raw : null
}

function normalizeSessionTarget(raw, executor = DEFAULT_EXECUTOR) {
  if (raw === 'isolated' || raw === 'main') return raw
  if (typeof raw === 'string' && raw.startsWith('persistent:') && raw.length > 'persistent:'.length) {
    return raw
  }
  return executor === 'companion_acp' ? 'isolated' : DEFAULT_SESSION_TARGET
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

function normalizeWorkflowTemplate(raw) {
  return raw === 'research_synthesis' || raw === 'research_decision' ? raw : 'single_turn'
}

function normalizeWorkflowPolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const maxStepAttempts = normalizePositiveCount(raw.maxStepAttempts)
  const retryBackoffMinutes = normalizePositiveCount(raw.retryBackoffMinutes)
  if (maxStepAttempts === null && retryBackoffMinutes === null) return null
  return { maxStepAttempts, retryBackoffMinutes }
}

function normalizeWorkflow(raw) {
  // Workflow always normalizes to a stable single_turn shape so downstream diagnostics
  // and prompt builders do not need null checks for the default case.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_WORKFLOW }
  }
  const template = normalizeWorkflowTemplate(raw.template)
  const policy = normalizeWorkflowPolicy(raw.policy)
  if (!raw.state || typeof raw.state !== 'object' || Array.isArray(raw.state)) {
    return { template, policy, state: null }
  }
  const state = { ...raw.state }
  if (Array.isArray(state.steps)) {
    state.steps = state.steps.map((step) => {
      if (!step || typeof step !== 'object') return step
      return {
        ...step,
        startedAt: Number.isFinite(step.startedAt) ? step.startedAt : null,
        finishedAt: Number.isFinite(step.finishedAt) ? step.finishedAt : null,
        handoffSummary: typeof step.handoffSummary === 'string' && step.handoffSummary ? step.handoffSummary : null,
        retry: step.retry && typeof step.retry === 'object' && !Array.isArray(step.retry)
          ? {
            attempt: Number.isFinite(step.retry.attempt) ? Math.max(0, Math.round(step.retry.attempt)) : 0,
            lastError: typeof step.retry.lastError === 'string' && step.retry.lastError ? step.retry.lastError : null,
            nextRetryAt: Number.isFinite(step.retry.nextRetryAt) ? step.retry.nextRetryAt : null,
          }
          : null,
      }
    })
  }
  if (typeof state.lastContinuationAt !== 'number' || !Number.isFinite(state.lastContinuationAt)) {
    state.lastContinuationAt = null
  }
  if (typeof state.terminalState !== 'string' || !state.terminalState) {
    state.terminalState = null
  }
  return { template, policy, state }
}

function normalizeEscalationTemplate(raw) {
  return raw === 'research_synthesis' || raw === 'research_decision' ? raw : null
}

function normalizeWatcherPolicy(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    mode: raw.mode === 'change_only' ? 'change_only' : 'disabled',
    minNotifyIntervalMinutes: normalizePositiveCount(raw.minNotifyIntervalMinutes),
    escalateWithWorkflow: raw.escalateWithWorkflow === true,
    escalationTemplate: normalizeEscalationTemplate(raw.escalationTemplate),
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
    lastEscalationRunId: typeof raw.lastEscalationRunId === 'string' && raw.lastEscalationRunId
      ? raw.lastEscalationRunId
      : null,
    lastEscalationAt: Number.isFinite(raw.lastEscalationAt) ? Number(raw.lastEscalationAt) : null,
    lastInvestigatedHash: typeof raw.lastInvestigatedHash === 'string' && raw.lastInvestigatedHash
      ? raw.lastInvestigatedHash
      : null,
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

function normalizeCompactionReason(raw) {
  return raw === 'day_rollup' || raw === 'budget_critical' || raw === 'run_threshold' ? raw : null
}

function normalizeSessionBudgetLedger(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    approxInputTokens: Number.isFinite(raw.approxInputTokens) ? Math.max(0, Math.round(Number(raw.approxInputTokens))) : 0,
    approxOutputTokens: Number.isFinite(raw.approxOutputTokens) ? Math.max(0, Math.round(Number(raw.approxOutputTokens))) : 0,
    compactionCount: Number.isFinite(raw.compactionCount) ? Math.max(0, Math.round(Number(raw.compactionCount))) : 0,
    lastRollupAt: Number.isFinite(raw.lastRollupAt) ? Number(raw.lastRollupAt) : null,
    lastCompactedAt: Number.isFinite(raw.lastCompactedAt) ? Number(raw.lastCompactedAt) : null,
    lastCompactionReason: normalizeCompactionReason(raw.lastCompactionReason),
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
  const sessionTarget = normalizeSessionTarget(job?.sessionTarget, executor)
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
      (spec) => spec.executor === 'companion_acp'
        && (spec.workflow?.template === 'research_synthesis' || spec.workflow?.template === 'research_decision'),
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
