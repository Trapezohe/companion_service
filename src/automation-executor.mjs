import { normalizeAutomationSpec } from './automation-spec.mjs'
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

function buildAutomationPrompt(job) {
  const basePrompt = typeof job?.prompt === 'string' ? job.prompt : ''
  const automationProfile = normalizeAutomationProfile(job?.automationProfile)

  if (automationProfile === 'research_report') {
    return [
      basePrompt,
      '',
      'Use section headings in this order: Summary, Evidence, Next Steps.',
      'Keep the report evidence-based and rely on read-only research where possible.',
    ].join('\n').trim()
  }

  if (automationProfile === 'watcher_digest') {
    return [
      basePrompt,
      '',
      'Use section headings in this order: What Changed, Why It Matters, Action.',
      'Focus on whether the detected change is actionable enough to alert the user.',
    ].join('\n').trim()
  }

  return basePrompt
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

function buildAutomationMeta(job, spec, extra = {}) {
  const target = cloneDeliveryTarget(job)
  return {
    taskId: typeof job?.id === 'string' ? job.id : '',
    taskName: typeof job?.name === 'string' ? job.name : '',
    executionMode: spec.executor === 'companion_acp' ? 'companion_acp' : 'extension_pending',
    sessionTarget: spec.sessionTarget,
    agentType: spec.agentType,
    automationProfile: normalizeAutomationProfile(job?.automationProfile),
    deliveryMode: spec.delivery.mode,
    taskState: 'queued',
    stepState: 'launch',
    ...(target ? { target } : {}),
    ...extra,
  }
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
      prompt: buildAutomationPrompt(job),
      origin: 'automation',
      inputProvenance: buildInputProvenance(job, spec, queuedRun.runId),
      timeoutMs: normalizeTimeoutMs(job?.timeoutMs),
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
