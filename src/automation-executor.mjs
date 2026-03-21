import { normalizeAutomationSpec } from './automation-spec.mjs'
import {
  buildAutomationBudgetSnapshot,
  deriveAutomationBudgetLedgerUpdate,
} from './automation-budget.mjs'
import {
  buildAutomationLifecycleSummary,
  extractAutomationLifecycleText,
} from './automation-lifecycle.mjs'
import {
  advanceAutomationWorkflow,
  buildAutomationWorkflowPrompt,
  failAutomationWorkflowStep,
  initializeAutomationWorkflow,
  resumeAutomationWorkflowRetry,
} from './automation-workflow.mjs'
import { isMultiTurnTemplate } from './automation-workflow-templates.mjs'
import { evaluateWatcherEscalation } from './automation-watcher.mjs'
import { evaluateCondition } from './automation-condition-engine.mjs'
import {
  createConditionState,
  shouldTrigger,
  recordTrigger,
} from './automation-condition-state.mjs'
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
  listRuns,
  setSessionRunLink,
} from './run-store.mjs'
import { enqueueAutomationOutboxItem } from './automation-outbox.mjs'
import {
  getAutomationBudgetLedger,
  setAutomationBudgetLedger,
} from './automation-budget-store.mjs'
import { patchJobWatcherState } from './cron-store.mjs'

function normalizeTimeoutMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined
}

const AUTOMATION_PROFILE_PROMPTS = {
  research_report: {
    outputSections: ['Summary', 'Evidence', 'Next Steps'],
    promptGuidance: [
      'Keep the report evidence-based and rely on read-only research where possible.',
      'Cite concrete sources, URLs, or tool outputs for factual claims.',
      'Disclose uncertainty explicitly when evidence is incomplete or conflicting.',
      'Do not invent URLs, tx hashes, or quotes.',
    ],
  },
  watcher_digest: {
    outputSections: ['What Changed', 'Why It Matters', 'Action'],
    promptGuidance: [
      'Focus on signal detection, validation, and whether the user actually needs to be alerted.',
      'Cite concrete sources, URLs, or tool outputs for factual claims.',
      'Disclose uncertainty explicitly when evidence is incomplete or conflicting.',
      'Do not invent URLs, tx hashes, or quotes.',
    ],
  },
  deep_research_brief: {
    outputSections: ['Thesis', 'Evidence', 'Unknowns', 'Recommendation'],
    promptGuidance: [
      'Go broad on source gathering before converging on the strongest explanation.',
      'Cite concrete sources, URLs, or tool outputs for factual claims.',
      'Disclose uncertainty explicitly when evidence is incomplete or conflicting.',
      'Do not invent URLs, tx hashes, or quotes.',
    ],
  },
  structured_writer: {
    outputSections: ['Objective', 'Draft', 'Open Risks'],
    promptGuidance: [
      'Optimize for structure, clarity, and traceable claims over breadth.',
      'Cite concrete sources, URLs, or tool outputs for factual claims.',
      'Disclose uncertainty explicitly when evidence is incomplete or conflicting.',
      'Do not invent URLs, tx hashes, or quotes.',
    ],
  },
  synthesis_report: {
    outputSections: ['Decision', 'Evidence', 'Tradeoffs', 'Next Steps'],
    promptGuidance: [
      'Synthesize across multiple findings and make the tradeoffs explicit.',
      'Cite concrete sources, URLs, or tool outputs for factual claims.',
      'Disclose uncertainty explicitly when evidence is incomplete or conflicting.',
      'Do not invent URLs, tx hashes, or quotes.',
    ],
  },
}

function normalizeAutomationProfile(value) {
  return typeof value === 'string' && value in AUTOMATION_PROFILE_PROMPTS
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

function buildAutomationBasePrompt(job, spec) {
  const basePrompt = typeof job?.prompt === 'string' ? job.prompt : ''
  const automationProfile = normalizeAutomationProfile(job?.automationProfile)
  const writePolicyPrompt = buildScheduledWritePolicyPrompt(spec)
  const profilePrompt = automationProfile !== 'general' ? AUTOMATION_PROFILE_PROMPTS[automationProfile] : null
  if (profilePrompt) {
    return [
      basePrompt,
      '',
      `Use section headings in this order: ${profilePrompt.outputSections.join(', ')}.`,
      ...profilePrompt.promptGuidance,
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

function cloneWorkflow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return JSON.parse(JSON.stringify(value))
}

function cloneReplayOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return JSON.parse(JSON.stringify(value))
}

function cloneRetryPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return JSON.parse(JSON.stringify(value))
}

function buildSessionLineage(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim()
    ? sessionId.trim()
    : ''
  if (!normalizedSessionId) {
    return {
      runPatch: {},
      metaPatch: {},
    }
  }
  return {
    runPatch: {
      sessionId: normalizedSessionId,
    },
    metaPatch: {
      sessionId: normalizedSessionId,
      acpSessionId: normalizedSessionId,
    },
  }
}

function resolvePersistentBudgetSessionKey(sessionTarget) {
  return typeof sessionTarget === 'string' && sessionTarget.startsWith('persistent:')
    ? sessionTarget
    : ''
}

function buildAutomationMeta(job, spec, extra = {}) {
  const target = cloneDeliveryTarget(job)
  const sessionBudget = cloneSessionBudget(spec.sessionBudget)
  const workflow = cloneWorkflow(spec.workflow)
  const replayOf = cloneReplayOf(job?.replayOf)
  const retryPolicy = cloneRetryPolicy(workflow?.policy)
  const conditionConfig = job?.condition && typeof job.condition === 'object' && !Array.isArray(job.condition)
    ? JSON.parse(JSON.stringify(job.condition))
    : null
  return {
    taskId: typeof job?.id === 'string' ? job.id : '',
    taskName: typeof job?.name === 'string' ? job.name : '',
    executionMode: spec.executor === 'companion_acp' ? 'companion_acp' : 'extension_pending',
    sessionTarget: spec.sessionTarget,
    agentType: spec.agentType,
    automationProfile: normalizeAutomationProfile(job?.automationProfile),
    deliveryMode: spec.delivery.mode,
    trustClass: typeof job?.trustClass === 'string' ? job.trustClass : 'scheduled_trusted',
    timeoutMs: normalizeTimeoutMs(job?.timeoutMs) ?? null,
    sessionBudget,
    ...(workflow ? { workflow } : {}),
    ...(retryPolicy ? { retryPolicy } : {}),
    ...(replayOf ? { replayOf } : {}),
    ...(conditionConfig ? { conditionConfig } : {}),
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

function buildInputProvenanceFromRun(run, runId = null) {
  const meta = run?.meta && typeof run.meta === 'object' ? run.meta : {}
  return {
    source: 'cron',
    executor: meta.executionMode === 'companion_acp' ? 'companion_acp' : 'extension_chat',
    sessionTarget: typeof meta.sessionTarget === 'string' ? meta.sessionTarget : 'isolated',
    taskId: typeof meta.taskId === 'string' ? meta.taskId : '',
    taskName: typeof meta.taskName === 'string' ? meta.taskName : '',
    trustClass: typeof meta.trustClass === 'string' ? meta.trustClass : 'scheduled_trusted',
    ...(runId ? { runId } : {}),
  }
}

function buildWorkflowExecutionSummary(run, workflowStep) {
  const taskName = typeof run?.meta?.taskName === 'string' && run.meta.taskName.trim()
    ? run.meta.taskName.trim()
    : 'automation'
  const stepKind = typeof workflowStep?.kind === 'string' && workflowStep.kind
    ? workflowStep.kind
    : 'step'
  return `Companion automation executing: ${taskName} (${stepKind})`
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
    listRuns,
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
    patchJobWatcherState,
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
  const deps = getExecutorDeps(overrides)
  if (!spec.supported) {
    return recordRejectedRun(job, spec, deps)
  }
  if (spec.executor === 'extension_chat') {
    return {
      mode: 'extension_pending',
      executor: spec.executor,
    }
  }

  const replayOf = cloneReplayOf(job?.replayOf)
  const queuedRun = await deps.createRun({
    type: 'cron',
    state: 'queued',
    summary: `Launching companion automation: ${job?.name || 'unnamed job'}`,
    ...(replayOf ? { source: 'replay' } : {}),
    ...(typeof job?.parentRunId === 'string' && job.parentRunId ? { parentRunId: job.parentRunId } : {}),
    meta: buildAutomationMeta(job, spec),
  })

  // Watcher escalation runs after createRun() so we have a real runId for the
  // state patch. We also guard against empty currentHash — without a concrete
  // observation there is nothing to investigate.
  const observationHash = typeof spec.watcher?.state?.lastObservationHash === 'string'
    ? spec.watcher.state.lastObservationHash
    : ''
  let watcherEscalation = null
  if (spec.watcher?.policy && observationHash) {
    watcherEscalation = evaluateWatcherEscalation({
      watcherPolicy: spec.watcher.policy,
      watcherState: spec.watcher.state,
      currentHash: observationHash,
      runId: queuedRun.runId,
    })
  }

  // Persist watcher state patch back to the job store immediately — before the
  // ACP run starts — so the next timer fire sees the updated lastInvestigatedHash
  // and does not re-escalate for the same observation.
  if (watcherEscalation?.watcherStatePatch) {
    const taskId = typeof spec.id === 'string' ? spec.id : ''
    if (taskId) {
      await deps.patchJobWatcherState(taskId, watcherEscalation.watcherStatePatch).catch(() => undefined)
    }
  }

  let workflow = initializeAutomationWorkflow(spec.workflow)
  if (watcherEscalation?.shouldEscalate && watcherEscalation.escalationTemplate) {
    workflow = initializeAutomationWorkflow({
      ...spec.workflow,
      template: watcherEscalation.escalationTemplate,
    })
  }

  const automationPromptBase = buildAutomationBasePrompt(job, spec)
  const automationPrompt = buildAutomationWorkflowPrompt({
    workflow,
    basePrompt: automationPromptBase,
  })

  // Persist workflow + escalation metadata now that we have all computed values.
  await deps.updateRun(queuedRun.runId, {
    meta: mergeRunMeta(queuedRun, {
      workflow,
      automationPromptBase,
      ...(watcherEscalation ? {
        watcherEscalation: {
          shouldEscalate: watcherEscalation.shouldEscalate,
          escalationTemplate: watcherEscalation.escalationTemplate,
          reason: watcherEscalation.reason,
        },
        watcherStatePatch: watcherEscalation.watcherStatePatch,
      } : {}),
    }),
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
    const sessionLineage = buildSessionLineage(sessionId)
    await deps.updateRun(queuedRun.runId, {
      ...sessionLineage.runPatch,
      state: 'running',
      summary: `Companion automation executing: ${job?.name || 'unnamed job'}`,
      meta: buildAutomationMeta(job, spec, {
        ...sessionLineage.metaPatch,
        reusedSession: sessionResolution.reused === true,
        workflow,
        automationPromptBase,
        taskState: 'running',
        stepState: 'execute',
        ...(watcherEscalation ? {
          watcherEscalation: {
            shouldEscalate: watcherEscalation.shouldEscalate,
            escalationTemplate: watcherEscalation.escalationTemplate,
            reason: watcherEscalation.reason,
          },
          watcherStatePatch: watcherEscalation.watcherStatePatch,
        } : {}),
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
  const sessionLineage = buildSessionLineage(sessionId)
  let currentRun = await deps.updateRun(runId, {
    ...sessionLineage.runPatch,
    ...(lifecycleSummary ? { summary: lifecycleSummary } : {}),
    meta: mergeRunMeta(run, {
      ...sessionLineage.metaPatch,
      taskState: finalTaskState,
      stepState: 'summarize',
      lifecycleSummary,
      lifecycleTerminalState: terminalState || null,
    }),
  }) || run
  const lifecycleText = extractAutomationLifecycleText(events, currentRun.summary || run.summary || '')
  const budgetOutputText = lifecycleText || lifecycleSummary || currentRun.summary || run.summary || ''
  currentRun = await refreshBudgetSnapshotForRun(deps, currentRun, {
    sessionBudget: currentRun.meta?.sessionBudget ?? run.meta?.sessionBudget ?? null,
    sessionKey: currentRun.meta?.sessionTarget ?? run.meta?.sessionTarget ?? '',
    outputText: budgetOutputText,
  })
  // Evaluate condition if the current workflow step is a condition_check
  let conditionResult = null
  const currentWorkflowState = currentRun.meta?.workflow ?? run.meta?.workflow ?? null
  if (currentWorkflowState?.state && terminalState === 'done') {
    const currentStepId = currentWorkflowState.state.currentStepId
    const currentStep = Array.isArray(currentWorkflowState.state.steps)
      ? currentWorkflowState.state.steps.find((s) => s?.id === currentStepId)
      : null
    if (currentStep?.kind === 'condition_check') {
      const conditionConfig = currentRun.meta?.conditionConfig ?? run.meta?.conditionConfig ?? null
      if (conditionConfig?.type) {
        const evalResult = await evaluateCondition(conditionConfig, deps)
        const taskId = currentRun.meta?.taskId ?? run.meta?.taskId ?? ''
        const condState = currentRun.meta?.conditionState
          ? { ...createConditionState(), ...currentRun.meta.conditionState }
          : createConditionState()
        const triggered = shouldTrigger(condState, evalResult, {
          cooldownMs: conditionConfig.cooldownMs ?? 0,
          edgeTrigger: conditionConfig.edgeTrigger ?? false,
        })
        if (triggered) {
          recordTrigger(condState)
        }
        // Persist updated condition state back to run meta
        currentRun = await deps.updateRun(runId, {
          meta: mergeRunMeta(currentRun, { conditionState: condState }),
        }) || currentRun

        conditionResult = {
          met: evalResult.met && triggered,
          onFalse: conditionConfig.onFalse || 'skip',
          value: evalResult.value,
          threshold: evalResult.threshold,
          reason: evalResult.reason || evalResult.error || null,
        }
      }
    }
  }

  const workflowProgress = advanceAutomationWorkflow(currentWorkflowState, {
    runId,
    terminalState,
    stepSummary: lifecycleText || lifecycleSummary || currentRun.summary || run.summary || '',
    handoffSummary: lifecycleText || lifecycleSummary || '',
    conditionResult,
  })

  if (isMultiTurnTemplate(workflowProgress.workflow.template)) {
    currentRun = await deps.updateRun(runId, {
      meta: mergeRunMeta(currentRun, {
        workflow: workflowProgress.workflow,
        ...(workflowProgress.workflow?.policy ? { retryPolicy: cloneRetryPolicy(workflowProgress.workflow.policy) } : {}),
      }),
    }) || currentRun

    if (workflowProgress.continued) {
      const automationPromptBase = typeof currentRun.meta?.automationPromptBase === 'string'
        ? currentRun.meta.automationPromptBase
        : typeof run.meta?.automationPromptBase === 'string'
          ? run.meta.automationPromptBase
          : ''
      const nextPrompt = buildAutomationWorkflowPrompt({
        workflow: workflowProgress.workflow,
        basePrompt: automationPromptBase,
      })

      try {
        if (!sessionId) {
          throw new Error('workflow_continuation_requires_session')
        }
        await deps.enqueuePrompt(sessionId, {
          prompt: nextPrompt,
          origin: 'automation',
          inputProvenance: buildInputProvenanceFromRun(currentRun, runId),
          timeoutMs: normalizeTimeoutMs(currentRun.meta?.timeoutMs ?? run.meta?.timeoutMs),
        })
        currentRun = await refreshBudgetSnapshotForRun(deps, currentRun, {
          sessionBudget: currentRun.meta?.sessionBudget ?? run.meta?.sessionBudget ?? null,
          sessionKey: currentRun.meta?.sessionTarget ?? run.meta?.sessionTarget ?? '',
          promptText: nextPrompt,
        })
        currentRun = await deps.updateRun(runId, {
          ...sessionLineage.runPatch,
          state: 'running',
          summary: buildWorkflowExecutionSummary(currentRun, workflowProgress.nextStep),
          meta: mergeRunMeta(currentRun, {
            ...sessionLineage.metaPatch,
            taskState: 'running',
            stepState: 'execute',
            workflow: workflowProgress.workflow,
            ...(workflowProgress.workflow?.policy ? { retryPolicy: cloneRetryPolicy(workflowProgress.workflow.policy) } : {}),
            lifecycleSummary,
            lifecycleTerminalState: terminalState || null,
          }),
        }) || currentRun
        return {
          mode: 'workflow_continued',
          runId,
          sessionId,
          nextStepId: workflowProgress.nextStep?.id || null,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failedWorkflow = failAutomationWorkflowStep(workflowProgress.workflow, {
          stepId: workflowProgress.nextStep?.id || null,
          runId,
          summary: message,
        })
        currentRun = await deps.updateRun(runId, {
          state: 'failed',
          summary: `Companion automation failed to continue: ${currentRun.meta?.taskName || 'unnamed job'}`,
          error: message,
          meta: mergeRunMeta(currentRun, {
            taskState: 'failed',
            stepState: 'done',
            workflow: failedWorkflow,
            ...(failedWorkflow?.policy ? { retryPolicy: cloneRetryPolicy(failedWorkflow.policy) } : {}),
            lifecycleSummary,
            lifecycleTerminalState: 'failed',
          }),
        }) || currentRun
        return { mode: 'failed', reason: 'workflow_continue_failed', error: message }
      }
    }

    if (workflowProgress.needsRetry) {
      currentRun = await deps.updateRun(runId, {
        state: 'failed',
        summary: `Companion automation step needs retry: ${currentRun.meta?.taskName || 'unnamed job'}`,
        meta: mergeRunMeta(currentRun, {
          taskState: 'retrying',
          stepState: 'done',
          workflow: workflowProgress.workflow,
          ...(workflowProgress.workflow?.policy ? { retryPolicy: cloneRetryPolicy(workflowProgress.workflow.policy) } : {}),
          lifecycleSummary,
          lifecycleTerminalState: terminalState || null,
        }),
      }) || currentRun
      return {
        mode: 'workflow_needs_retry',
        runId,
        sessionId,
        currentStepId: workflowProgress.currentStep?.id || null,
        retryAttempt: workflowProgress.currentStep?.retry?.attempt || 0,
      }
    }
  }

  const deliveryMode = typeof currentRun.meta?.deliveryMode === 'string' ? currentRun.meta.deliveryMode : ''
  if (currentRun.meta?.executionMode !== 'companion_acp' || !deliveryMode || deliveryMode === 'notification') {
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
  if (!lifecycleText) {
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
          text: lifecycleText,
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
      text: lifecycleText,
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

export async function checkAndResumeRetryableRuns(overrides = {}) {
  const deps = getExecutorDeps(overrides)
  const { runs } = await deps.listRuns({ state: 'failed', limit: 100 })
  const retryable = runs.filter(
    (run) => run.meta?.taskState === 'retrying' && isMultiTurnTemplate(run.meta?.workflow?.template),
  )

  const results = []
  for (const run of retryable) {
    const workflow = run.meta?.workflow
    const retryResult = resumeAutomationWorkflowRetry(workflow, { runId: run.runId })
    if (!retryResult.resumed || !retryResult.step) continue

    const sessionId = typeof run.sessionId === 'string' ? run.sessionId : ''
    if (!sessionId) {
      const failedWorkflow = failAutomationWorkflowStep(retryResult.workflow, {
        stepId: retryResult.step.id,
        runId: run.runId,
        summary: 'no_session_for_retry',
      })
      await deps.updateRun(run.runId, {
        state: 'failed',
        meta: mergeRunMeta(run, {
          workflow: failedWorkflow,
          taskState: 'failed',
        }),
      }).catch(() => undefined)
      results.push({ runId: run.runId, resumed: false, reason: 'no_session' })
      continue
    }

    try {
      const automationPromptBase = typeof run.meta?.automationPromptBase === 'string'
        ? run.meta.automationPromptBase
        : ''
      const nextPrompt = buildAutomationWorkflowPrompt({
        workflow: retryResult.workflow,
        basePrompt: automationPromptBase,
      })

      await deps.updateRun(run.runId, {
        state: 'running',
        summary: buildWorkflowExecutionSummary(run, retryResult.step),
        meta: mergeRunMeta(run, {
          workflow: retryResult.workflow,
          taskState: 'running',
          stepState: 'execute',
        }),
      })

      await deps.enqueuePrompt(sessionId, {
        prompt: nextPrompt,
        origin: 'automation',
        inputProvenance: buildInputProvenanceFromRun(run, run.runId),
        timeoutMs: normalizeTimeoutMs(run.meta?.timeoutMs),
      })

      results.push({ runId: run.runId, resumed: true, stepId: retryResult.step.id })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failedWorkflow = failAutomationWorkflowStep(retryResult.workflow, {
        stepId: retryResult.step.id,
        runId: run.runId,
        summary: message,
      })
      await deps.updateRun(run.runId, {
        state: 'failed',
        summary: `Retry resume failed: ${run.meta?.taskName || 'unnamed job'}`,
        error: message,
        meta: mergeRunMeta(run, {
          workflow: failedWorkflow,
          taskState: 'failed',
        }),
      }).catch(() => undefined)
      results.push({ runId: run.runId, resumed: false, reason: message })
    }
  }

  return { checked: retryable.length, results }
}
