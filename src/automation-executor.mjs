import { normalizeAutomationSpec } from './automation-spec.mjs'
import {
  buildAutomationBudgetSnapshot,
  deriveAutomationBudgetLedgerUpdate,
} from './automation-budget.mjs'
import {
  buildAutomationLifecycleSummary,
  extractAutomationLifecycleText,
} from './automation-lifecycle.mjs'
import { resolvePersistentAutomationSession } from './automation-session-store.mjs'
import {
  createAcpSession,
  getAcpSessionById,
  attachAcpSessionRunId,
  enqueuePrompt,
  listAcpEvents,
} from './acp-session.mjs'
import {
  createRun,
  getRunById,
  updateRun,
  setSessionRunLink,
} from './run-store.mjs'
import { enqueueAutomationOutboxItem } from './automation-outbox.mjs'
import {
  getAutomationBudgetLedger,
  setAutomationBudgetLedger,
} from './automation-budget-store.mjs'

function normalizeTimeoutMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined
}

function normalizeAutomationProfile(value) {
  return value === 'research_report' || value === 'watcher_digest'
    ? value
    : 'general'
}

function buildScheduledWritePolicyPrompt(spec) {
  const policy = spec?.scheduledWritePolicy
  if (!policy || policy.mode !== 'allowlist') {
    return [
      'Scheduled write policy: read_only.',
      'Do not use write_file, run_local_command, or run_local_command_session in this unattended run.',
    ].join('\n')
  }

  return [
    'Scheduled write policy: allowlist (prompt_only).',
    'This companion path cannot hard-enforce tool usage in v2.2a. Treat the allowlist below as a hard operator instruction anyway.',
    policy.allowedTools.length > 0 ? `Allowed tools: ${policy.allowedTools.join(', ')}.` : 'No write tools are pre-approved.',
    policy.allowedPaths?.length ? `Allowed path prefixes: ${policy.allowedPaths.join(', ')}.` : '',
    policy.allowedCommandPrefixes?.length ? `Allowed command prefixes: ${policy.allowedCommandPrefixes.join(', ')}.` : '',
  ].filter(Boolean).join('\n')
}

function buildAutomationPrompt(job, spec) {
  const basePrompt = typeof job?.prompt === 'string' ? job.prompt : ''
  const automationProfile = normalizeAutomationProfile(job?.automationProfile)
  const writePolicyPrompt = buildScheduledWritePolicyPrompt(spec)

  if (automationProfile === 'research_report') {
    return [
      basePrompt,
      '',
      'Use section headings in this order: Summary, Evidence, Next Steps.',
      'Keep the report evidence-based and rely on read-only research where possible.',
      '',
      writePolicyPrompt,
    ].join('\n').trim()
  }

  if (automationProfile === 'watcher_digest') {
    return [
      basePrompt,
      '',
      'Use section headings in this order: What Changed, Why It Matters, Action.',
      'Focus on whether the detected change is actionable enough to alert the user.',
      '',
      writePolicyPrompt,
    ].join('\n').trim()
  }

  return [
    basePrompt,
    '',
    writePolicyPrompt,
  ].join('\n').trim()
}

function createDeliveryTimeoutSignal(timeoutMs = 15_000) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs)
  }

  const controller = new AbortController()
  setTimeout(() => controller.abort(), timeoutMs).unref?.()
  return controller.signal
}

function mergeRunMeta(run, extra = {}) {
  return {
    ...(run?.meta && typeof run.meta === 'object' ? run.meta : {}),
    ...(extra && typeof extra === 'object' ? extra : {}),
  }
}

async function finalizeTerminalRunStep(deps, runId, run, {
  taskState,
  stepState = 'done',
  lifecycleSummary,
  lifecycleTerminalState,
}) {
  return deps.updateRun(runId, {
    ...(lifecycleSummary ? { summary: lifecycleSummary } : {}),
    meta: mergeRunMeta(run, {
      taskState,
      stepState,
      lifecycleSummary,
      lifecycleTerminalState,
    }),
  }) || run
}

function cloneDeliveryTarget(job) {
  const target = job?.delivery?.target
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return null
  }
  return JSON.parse(JSON.stringify(target))
}

function cloneSessionBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return JSON.parse(JSON.stringify(value))
}

function resolvePersistentBudgetSessionKey(sessionTarget) {
  return typeof sessionTarget === 'string' && sessionTarget.startsWith('persistent:')
    ? sessionTarget
    : ''
}

function buildAutomationMeta(job, spec, extra = {}) {
  const target = cloneDeliveryTarget(job)
  const sessionBudget = cloneSessionBudget(spec.sessionBudget)
  return {
    taskId: typeof job?.id === 'string' ? job.id : '',
    taskName: typeof job?.name === 'string' ? job.name : '',
    executionMode: spec.executor === 'companion_acp' ? 'companion_acp' : 'extension_pending',
    sessionTarget: spec.sessionTarget,
    agentType: spec.agentType,
    automationProfile: normalizeAutomationProfile(job?.automationProfile),
    deliveryMode: spec.delivery.mode,
    sessionBudget,
    taskState: 'queued',
    stepState: 'launch',
    ...(target ? { target } : {}),
    ...extra,
  }
}

async function refreshBudgetSnapshotForRun(deps, run, {
  sessionBudget,
  sessionKey,
  promptText = '',
  outputText = '',
  compactionCountDelta = 0,
  rollupAt = null,
}) {
  const budgetConfig = cloneSessionBudget(sessionBudget ?? run?.meta?.sessionBudget)
  if (!budgetConfig?.policy) return run

  const persistentKey = resolvePersistentBudgetSessionKey(sessionKey || run?.meta?.sessionTarget)
  const persistedLedger = persistentKey ? await deps.getAutomationBudgetLedger(persistentKey).catch(() => null) : null
  const ledger = deriveAutomationBudgetLedgerUpdate({
    sessionBudget: {
      ...budgetConfig,
      ledger: persistedLedger ?? budgetConfig.ledger ?? null,
    },
    promptText,
    outputText,
    compactionCountDelta,
    rollupAt,
  })
  if (!ledger) return run

  if (persistentKey) {
    await deps.setAutomationBudgetLedger(persistentKey, ledger)
  }

  return deps.updateRun(run.runId, {
    meta: mergeRunMeta(run, {
      sessionBudget: {
        ...budgetConfig,
        ledger,
      },
      budgetSnapshot: persistentKey
        ? buildAutomationBudgetSnapshot(persistentKey, ledger)
        : { sessionKey: null, ledger },
    }),
  }) || run
}

function buildInputProvenance(job, spec, runId = null) {
  return {
    source: 'cron',
    executor: spec.executor,
    sessionTarget: spec.sessionTarget,
    taskId: typeof job?.id === 'string' ? job.id : '',
    taskName: typeof job?.name === 'string' ? job.name : '',
    trustClass: typeof job?.trustClass === 'string' ? job.trustClass : 'scheduled_trusted',
    ...(runId ? { runId } : {}),
  }
}

function createAcpSessionFactory(job, spec, deps, runId) {
  return () => deps.createAcpSession({
    agentType: spec.agentType,
    origin: 'automation',
    inputProvenance: buildInputProvenance(job, spec, runId),
    timeoutMs: normalizeTimeoutMs(job?.timeoutMs),
  })
}

function getExecutorDeps(overrides = {}) {
  return {
    createRun,
    getRunById,
    updateRun,
    createAcpSession,
    getAcpSessionById,
    attachAcpSessionRunId,
    enqueuePrompt,
    listAcpEvents,
    setSessionRunLink,
    resolvePersistentAutomationSession,
    enqueueAutomationOutboxItem,
    getAutomationBudgetLedger,
    setAutomationBudgetLedger,
    fetchImpl: fetch,
    ...overrides,
  }
}

async function recordRejectedRun(job, spec, deps) {
  const reason = spec.unsupportedReason || 'unsupported_automation_job'
  const run = await deps.createRun({
    type: 'cron',
    state: 'failed',
    finishedAt: Date.now(),
    summary: `Companion automation rejected: ${job?.name || 'unnamed job'}`,
    error: reason,
    meta: buildAutomationMeta(job, spec, {
      unsupportedReason: reason,
      taskState: 'failed',
      stepState: 'launch',
    }),
  })

  return {
    mode: 'rejected',
    reason,
    runId: run.runId,
  }
}

export async function executeAutomationJob(job, overrides = {}) {
  const spec = normalizeAutomationSpec(job)
  if (spec.executor === 'extension_chat') {
    return {
      mode: 'extension_pending',
      executor: spec.executor,
    }
  }

  const deps = getExecutorDeps(overrides)
  if (!spec.supported) {
    return recordRejectedRun(job, spec, deps)
  }

  const queuedRun = await deps.createRun({
    type: 'cron',
    state: 'queued',
    summary: `Launching companion automation: ${job?.name || 'unnamed job'}`,
    meta: buildAutomationMeta(job, spec),
  })

  try {
    const automationPrompt = buildAutomationPrompt(job, spec)
    const sessionResolution = spec.sessionTarget === 'isolated'
      ? {
          key: null,
          ...(await createAcpSessionFactory(job, spec, deps, queuedRun.runId)()),
          reused: false,
          created: true,
        }
      : await deps.resolvePersistentAutomationSession(spec.sessionTarget, {
          getSessionById: deps.getAcpSessionById,
          createSession: createAcpSessionFactory(job, spec, deps, queuedRun.runId),
        })

    const sessionId = typeof sessionResolution?.sessionId === 'string'
      ? sessionResolution.sessionId
      : ''
    if (!sessionId) {
      throw new Error('automation executor could not resolve an ACP sessionId')
    }

    await deps.attachAcpSessionRunId(sessionId, queuedRun.runId)
    await deps.setSessionRunLink(sessionId, queuedRun.runId, {
      type: 'acp',
    })
    await deps.updateRun(queuedRun.runId, {
      state: 'running',
      summary: `Companion automation executing: ${job?.name || 'unnamed job'}`,
      meta: buildAutomationMeta(job, spec, {
        acpSessionId: sessionId,
        reusedSession: sessionResolution.reused === true,
        taskState: 'running',
        stepState: 'execute',
      }),
    })

    await deps.enqueuePrompt(sessionId, {
      prompt: automationPrompt,
      origin: 'automation',
      inputProvenance: buildInputProvenance(job, spec, queuedRun.runId),
      timeoutMs: normalizeTimeoutMs(job?.timeoutMs),
    })

    await refreshBudgetSnapshotForRun(deps, {
      ...(await deps.getRunById(queuedRun.runId) || queuedRun),
    }, {
      sessionBudget: spec.sessionBudget,
      sessionKey: spec.sessionTarget,
      promptText: automationPrompt,
    })

    return {
      mode: 'companion_acp',
      runId: queuedRun.runId,
      sessionId,
      reusedSession: sessionResolution.reused === true,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await deps.updateRun(queuedRun.runId, {
      state: 'failed',
      summary: `Companion automation failed to start: ${job?.name || 'unnamed job'}`,
      error: message,
      meta: buildAutomationMeta(job, spec, {
        startupFailed: true,
        taskState: 'failed',
        stepState: 'launch',
      }),
    })
    return {
      mode: 'failed',
      reason: 'startup_failed',
      runId: queuedRun.runId,
      error: message,
    }
  }
}

export async function deliverAutomationRunResult(input, overrides = {}) {
  const deps = getExecutorDeps(overrides)
  const runId = typeof input?.runId === 'string' ? input.runId.trim() : ''
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : ''
  const terminalState = typeof input?.terminalState === 'string' ? input.terminalState.trim() : ''
  if (!runId) {
    throw new Error('deliverAutomationRunResult requires runId')
  }

  const run = await deps.getRunById(runId)
  if (!run) {
    return { mode: 'skipped', reason: 'run_not_found' }
  }

  const finalTaskState = terminalState === 'done' ? 'done' : terminalState === 'retrying' ? 'retrying' : 'failed'
  const events = sessionId
    ? deps.listAcpEvents(sessionId, { after: 0, limit: 500 })?.events || []
    : []
  const lifecycleSummary = buildAutomationLifecycleSummary({
    run,
    events,
    terminalState,
  })
  let currentRun = await deps.updateRun(runId, {
    ...(lifecycleSummary ? { summary: lifecycleSummary } : {}),
    meta: mergeRunMeta(run, {
      taskState: finalTaskState,
      stepState: 'summarize',
      lifecycleSummary,
      lifecycleTerminalState: terminalState || null,
    }),
  }) || run
  const budgetOutputText = extractAutomationLifecycleText(events, run.summary || '') || lifecycleSummary || run.summary || ''
  currentRun = await refreshBudgetSnapshotForRun(deps, currentRun, {
    sessionBudget: currentRun.meta?.sessionBudget ?? run.meta?.sessionBudget ?? null,
    sessionKey: currentRun.meta?.sessionTarget ?? run.meta?.sessionTarget ?? '',
    outputText: budgetOutputText,
  })

  const deliveryMode = typeof run.meta?.deliveryMode === 'string' ? run.meta.deliveryMode : ''
  if (run.meta?.executionMode !== 'companion_acp' || !deliveryMode || deliveryMode === 'notification') {
    currentRun = await finalizeTerminalRunStep(deps, runId, currentRun, {
      taskState: finalTaskState,
      lifecycleSummary,
      lifecycleTerminalState: terminalState || null,
    })
    return { mode: 'skipped', reason: 'delivery_not_requested' }
  }

  if (terminalState !== 'done') {
    currentRun = await finalizeTerminalRunStep(deps, runId, currentRun, {
      taskState: finalTaskState,
      lifecycleSummary,
      lifecycleTerminalState: terminalState || null,
    })
    return { mode: 'skipped', reason: 'terminal_state_not_deliverable' }
  }

  const deliveryAttemptAt = Date.now()
  const text = extractAutomationLifecycleText(events, run.summary || '')
  if (!text) {
    currentRun = await finalizeTerminalRunStep(deps, runId, currentRun, {
      taskState: finalTaskState,
      lifecycleSummary,
      lifecycleTerminalState: terminalState || null,
    })
    return { mode: 'skipped', reason: 'empty_delivery_payload' }
  }

  currentRun = await deps.updateRun(runId, {
    meta: mergeRunMeta(currentRun, {
      taskState: 'done',
      stepState: 'deliver',
      lifecycleSummary,
      lifecycleTerminalState: terminalState || null,
    }),
  }) || currentRun

  const baseMeta = mergeRunMeta(currentRun)
  const target = currentRun.meta?.target && typeof currentRun.meta.target === 'object' && !Array.isArray(currentRun.meta.target)
    ? JSON.parse(JSON.stringify(currentRun.meta.target))
    : null

  if (deliveryMode === 'webhook') {
    const url = typeof target?.url === 'string' ? target.url.trim() : ''
    if (!url) {
      await deps.updateRun(runId, {
        deliveryState: {
          channel: 'webhook',
          attempts: 1,
          lastAttemptAt: deliveryAttemptAt,
        },
        meta: mergeRunMeta(currentRun, {
          deliveryError: 'webhook_target_missing',
        }),
      })
      return { mode: 'failed', reason: 'webhook_target_missing' }
    }

    try {
      const response = await deps.fetchImpl(url, {
        method: 'POST',
        signal: createDeliveryTimeoutSignal(),
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          id: run.runId,
          runId: run.runId,
          taskId: baseMeta.taskId || '',
          taskName: baseMeta.taskName || '',
          sessionId,
          text,
          createdAt: deliveryAttemptAt,
        }),
      })
      if (!response?.ok) {
        throw new Error(`webhook_delivery_failed:${response?.status ?? 'unknown'}`)
      }
      await deps.updateRun(runId, {
        deliveryState: {
          channel: 'webhook',
          attempts: 1,
          lastAttemptAt: deliveryAttemptAt,
        },
        meta: mergeRunMeta(currentRun, {
          deliveryError: null,
        }),
      })
      return { mode: 'webhook', delivered: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await deps.updateRun(runId, {
        deliveryState: {
          channel: 'webhook',
          attempts: 1,
          lastAttemptAt: deliveryAttemptAt,
        },
        meta: mergeRunMeta(currentRun, {
          deliveryError: message,
        }),
      })
      return { mode: 'failed', reason: message }
    }
  }

  if (deliveryMode !== 'chat' && deliveryMode !== 'remote_channel') {
    return { mode: 'skipped', reason: 'unsupported_delivery_mode' }
  }

  try {
    const item = await deps.enqueueAutomationOutboxItem({
      id: run.runId,
      runId: run.runId,
      taskId: baseMeta.taskId || '',
      taskName: baseMeta.taskName || '',
      mode: deliveryMode,
      text,
      target,
      createdAt: deliveryAttemptAt,
    })
    await deps.updateRun(runId, {
      deliveryState: {
        channel: 'outbox',
        attempts: 1,
        lastAttemptAt: deliveryAttemptAt,
      },
      meta: mergeRunMeta(currentRun, {
        outboxItemId: item.id,
        deliveryError: null,
      }),
    })
    return { mode: 'outbox', delivered: true, itemId: item.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await deps.updateRun(runId, {
      deliveryState: {
        channel: 'outbox',
        attempts: 1,
        lastAttemptAt: deliveryAttemptAt,
      },
      meta: mergeRunMeta(currentRun, {
        deliveryError: message,
      }),
    })
    return { mode: 'failed', reason: message }
  }
}
