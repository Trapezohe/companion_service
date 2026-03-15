import { normalizeAutomationSpec } from './automation-spec.mjs'
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

function mergeRunMeta(run, extra = {}) {
  return {
    ...(run?.meta && typeof run.meta === 'object' ? run.meta : {}),
    ...(extra && typeof extra === 'object' ? extra : {}),
  }
}

function buildAutomationMeta(job, spec, extra = {}) {
  return {
    taskId: typeof job?.id === 'string' ? job.id : '',
    taskName: typeof job?.name === 'string' ? job.name : '',
    executionMode: spec.executor === 'companion_acp' ? 'companion_acp' : 'extension_pending',
    sessionTarget: spec.sessionTarget,
    agentType: spec.agentType,
    deliveryMode: spec.delivery.mode,
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

function extractAutomationText(events = [], fallbackSummary = '') {
  const deltas = []
  let doneResult = ''
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'text_delta' && typeof event.text === 'string') {
      deltas.push(event.text)
      continue
    }
    if (event?.type === 'done' && typeof event.result === 'string' && event.result.trim()) {
      doneResult = event.result.trim()
    }
  }

  const fromDeltas = deltas.join('').trim()
  if (fromDeltas) return fromDeltas
  if (doneResult) return doneResult
  return typeof fallbackSummary === 'string' ? fallbackSummary.trim() : ''
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
      }),
    })

    await deps.enqueuePrompt(sessionId, {
      prompt: typeof job?.prompt === 'string' ? job.prompt : '',
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

  const deliveryMode = typeof run.meta?.deliveryMode === 'string' ? run.meta.deliveryMode : ''
  if (run.meta?.executionMode !== 'companion_acp' || !deliveryMode || deliveryMode === 'notification') {
    return { mode: 'skipped', reason: 'delivery_not_requested' }
  }

  if (terminalState !== 'done') {
    return { mode: 'skipped', reason: 'terminal_state_not_deliverable' }
  }

  const deliveryAttemptAt = Date.now()
  const events = sessionId
    ? deps.listAcpEvents(sessionId, { after: 0, limit: 500 })?.events || []
    : []
  const text = extractAutomationText(events, run.summary || '')
  if (!text) {
    return { mode: 'skipped', reason: 'empty_delivery_payload' }
  }

  const baseMeta = mergeRunMeta(run)
  const target = run.meta?.target && typeof run.meta.target === 'object' && !Array.isArray(run.meta.target)
    ? JSON.parse(JSON.stringify(run.meta.target))
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
        meta: mergeRunMeta(run, {
          deliveryError: 'webhook_target_missing',
        }),
      })
      return { mode: 'failed', reason: 'webhook_target_missing' }
    }

    try {
      const response = await deps.fetchImpl(url, {
        method: 'POST',
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
        meta: mergeRunMeta(run, {
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
        meta: mergeRunMeta(run, {
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
      meta: mergeRunMeta(run, {
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
      meta: mergeRunMeta(run, {
        deliveryError: message,
      }),
    })
    return { mode: 'failed', reason: message }
  }
}
