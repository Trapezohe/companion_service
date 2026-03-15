const DEFAULT_EXECUTOR = 'extension_chat'
const DEFAULT_SESSION_TARGET = 'main'
const DEFAULT_DELIVERY_MODE = 'notification'

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

  let unsupportedReason = null
  if (executor === 'companion_acp' && !agentType) {
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
