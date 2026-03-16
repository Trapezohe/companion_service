import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { rmSync } from 'node:fs'

let sharedPromise = null

function createJob(partial = {}) {
  return {
    id: 'job-1',
    name: 'Daily brief',
    prompt: 'summarize',
    schedule: { kind: 'interval', minutes: 30 },
    enabled: true,
    sessionTarget: 'isolated',
    trustClass: 'scheduled_trusted',
    executor: 'extension_chat',
    agentType: null,
    model: null,
    timeoutMs: null,
    automationProfile: 'general',
    delivery: { mode: 'notification', notification: true, chat: false, target: null },
    ...partial,
  }
}

async function getSharedModules() {
  if (!sharedPromise) {
    sharedPromise = (async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-automation-runtime-e2e-'))
      process.once('exit', () => {
        rmSync(tempDir, { recursive: true, force: true })
      })
      process.env.TRAPEZOHE_CONFIG_DIR = tempDir

      const runStore = await import('./run-store.mjs')
      const sessionStore = await import('./automation-session-store.mjs')
      const outbox = await import('./automation-outbox.mjs')
      const executor = await import('./automation-executor.mjs')
      const diagnostics = await import('./diagnostics.mjs')
      const acp = await import('./acp-session.mjs')
      const cronStore = await import('./cron-store.mjs')
      const budgetStore = await import('./automation-budget-store.mjs')
      return { runStore, sessionStore, outbox, executor, diagnostics, acp, cronStore, budgetStore }
    })()
  }

  return sharedPromise
}

async function withFreshState(run) {
  const { runStore, sessionStore, outbox, acp, executor, diagnostics, cronStore, budgetStore } = await getSharedModules()
  await runStore.clearRunStoreForTests()
  await sessionStore.clearAutomationSessionStoreForTests()
  await outbox.clearAutomationOutboxForTests()
  await cronStore.clearCronStoreForTests()
  await budgetStore.clearAutomationBudgetStoreForTests()
  acp.cleanupAllAcpSessions()
  await run({ runStore, sessionStore, outbox, acp, executor, diagnostics, cronStore, budgetStore })
}

const BASE_FEATURES = {
  acp: true,
  mcp: true,
  cronReplay: true,
  diagnostics: true,
  approvalStore: true,
  runLedger: true,
  automationExecutor: true,
  automationOutbox: true,
  mediaNormalization: false,
}

async function buildDiagnostics(diagnostics) {
  return diagnostics.buildDiagnosticsPayload({
    protocolVersion: 'trapezohe-companion/2026-03-07',
    version: '0.1.0-test',
    supportedFeatures: BASE_FEATURES,
    getPermissionPolicy: () => ({ mode: 'full', workspaceRoots: [] }),
    getMediaSupport: async () => ({ available: false, engine: null, reason: 'feature_disabled' }),
    mcpManager: {
      getConnectedCount: () => 0,
      getAllTools: () => [],
      getServers: () => [],
    },
  })
}

test('automation runtime keeps browser-open extension_chat jobs on the legacy pending path', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const result = await executor.executeAutomationJob(createJob({
      executor: 'extension_chat',
      delivery: { mode: 'chat', notification: false, chat: true, target: null },
    }))

    assert.equal(result.mode, 'extension_pending')
    const runs = await runStore.listRuns({ type: 'cron', limit: 10, offset: 0 })
    assert.equal(runs.runs.length, 0)
  })
})

test('automation runtime keeps report-oriented extension_chat jobs on the legacy pending path', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const researchResult = await executor.executeAutomationJob(createJob({
      id: 'job-report-extension',
      automationProfile: 'research_report',
    }))
    const watcherResult = await executor.executeAutomationJob(createJob({
      id: 'job-watcher-extension',
      automationProfile: 'watcher_digest',
    }))

    assert.equal(researchResult.mode, 'extension_pending')
    assert.equal(watcherResult.mode, 'extension_pending')
    const runs = await runStore.listRuns({ type: 'cron', limit: 10, offset: 0 })
    assert.equal(runs.runs.length, 0)
  })
})

test('automation runtime delivers companion webhook jobs directly when the browser is closed', async () => {
  await withFreshState(async ({ executor, runStore, acp }) => {
    const fetchCalls = []

    const launched = await executor.executeAutomationJob(createJob({
      id: 'job-webhook',
      name: 'Webhook report',
      executor: 'companion_acp',
      agentType: 'codex',
      delivery: {
        mode: 'webhook',
        notification: false,
        chat: false,
        target: { url: 'https://hooks.example.com/automation' },
      },
    }), {
      createAcpSession: () => acp.createAcpSession({ agentType: 'codex', origin: 'automation' }),
      getAcpSessionById: acp.getAcpSessionById,
      enqueuePrompt: async (sessionId) => ({ ok: true, sessionId, turnId: 'turn-1' }),
    })

    const delivery = await executor.deliverAutomationRunResult({
      runId: launched.runId,
      sessionId: 'acp-webhook',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({ events: [{ type: 'text_delta', text: 'Webhook payload ready.' }] }),
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init })
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    assert.equal(delivery.mode, 'webhook')
    assert.equal(fetchCalls.length, 1)

    const run = await runStore.getRunById(launched.runId)
    assert.equal(run?.deliveryState?.channel, 'webhook')
  })
})

test('automation runtime queues companion chat deliveries and clears them after reconnect drain ack', async () => {
  await withFreshState(async ({ executor, outbox, diagnostics, acp }) => {

    const launched = await executor.executeAutomationJob(createJob({
      id: 'job-chat',
      name: 'Chat report',
      executor: 'companion_acp',
      agentType: 'codex',
      delivery: { mode: 'chat', notification: false, chat: true, target: null },
    }), {
      createAcpSession: () => acp.createAcpSession({ agentType: 'codex', origin: 'automation' }),
      getAcpSessionById: acp.getAcpSessionById,
      enqueuePrompt: async (sessionId) => ({ ok: true, sessionId, turnId: 'turn-1' }),
    })

    await executor.deliverAutomationRunResult({
      runId: launched.runId,
      sessionId: 'acp-chat',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({ events: [{ type: 'text_delta', text: 'Chat delivery ready.' }] }),
      enqueueAutomationOutboxItem: outbox.enqueueAutomationOutboxItem,
    })

    let payload = await buildDiagnostics(diagnostics)
    assert.equal(payload.automation.outbox.depth, 1)
    assert.equal(payload.automation.execution.activeAcpSessions, 1)

    const acked = await outbox.ackAutomationOutboxItems([launched.runId])
    assert.equal(acked.acked, 1)

    payload = await buildDiagnostics(diagnostics)
    assert.equal(payload.automation.outbox.depth, 0)
  })
})

test('automation runtime reuses persistent companion sessions across repeated runs', async () => {
  await withFreshState(async ({ executor }) => {
    const sessions = new Map()
    let created = 0

    const deps = {
      createAcpSession: () => {
        created += 1
        const session = { sessionId: `acp-${created}`, state: 'idle', origin: 'automation' }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: (sessionId, runId) => ({ sessionId, runId }),
      enqueuePrompt: async (sessionId) => ({ ok: true, sessionId, turnId: `turn-${created}` }),
    }

    const first = await executor.executeAutomationJob(createJob({
      id: 'job-persistent',
      name: 'Research loop',
      executor: 'companion_acp',
      agentType: 'codex',
      sessionTarget: 'persistent:research-loop',
    }), deps)

    sessions.get(first.sessionId).state = 'done'

    const second = await executor.executeAutomationJob(createJob({
      id: 'job-persistent',
      name: 'Research loop',
      executor: 'companion_acp',
      agentType: 'codex',
      sessionTarget: 'persistent:research-loop',
    }), deps)

    assert.equal(first.sessionId, second.sessionId)
    assert.equal(second.reusedSession, true)
    assert.equal(created, 1)
  })
})

test('automation runtime injects research report headings into companion prompts', async () => {
  await withFreshState(async ({ executor, acp }) => {
    let capturedPrompt = ''

    const launched = await executor.executeAutomationJob(createJob({
      id: 'job-report-companion',
      name: 'Research loop',
      executor: 'companion_acp',
      agentType: 'codex',
      automationProfile: 'research_report',
      sessionTarget: 'isolated',
    }), {
      createAcpSession: () => acp.createAcpSession({ agentType: 'codex', origin: 'automation' }),
      getAcpSessionById: acp.getAcpSessionById,
      enqueuePrompt: async (sessionId, input) => {
        capturedPrompt = String(input?.prompt || '')
        return { ok: true, sessionId, turnId: 'turn-report-1' }
      },
    })

    assert.equal(launched.mode, 'companion_acp')
    assert.match(capturedPrompt, /Summary/)
    assert.match(capturedPrompt, /Evidence/)
    assert.match(capturedPrompt, /Next Steps/)
  })
})

test('automation runtime injects watcher digest headings into persistent companion prompts', async () => {
  await withFreshState(async ({ executor }) => {
    const sessions = new Map()
    let capturedPrompt = ''

    const deps = {
      createAcpSession: () => {
        const session = { sessionId: 'acp-watcher-1', state: 'idle', origin: 'automation' }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: (sessionId, runId) => ({ sessionId, runId }),
      enqueuePrompt: async (sessionId, input) => {
        capturedPrompt = String(input?.prompt || '')
        return { ok: true, sessionId, turnId: 'turn-watcher-1' }
      },
    }

    const launched = await executor.executeAutomationJob(createJob({
      id: 'job-watcher-companion',
      name: 'Watcher loop',
      executor: 'companion_acp',
      agentType: 'codex',
      automationProfile: 'watcher_digest',
      sessionTarget: 'persistent:watcher-loop',
    }), deps)

    assert.equal(launched.mode, 'companion_acp')
    assert.match(capturedPrompt, /What Changed/)
    assert.match(capturedPrompt, /Why It Matters/)
    assert.match(capturedPrompt, /Action/)
  })
})

test('automation runtime injects recipe section headings for research_decision workflow prompts', async () => {
  await withFreshState(async ({ executor, acp }) => {
    const enqueuedPrompts = []

    await executor.executeAutomationJob(createJob({
      id: 'job-recipe-e2e',
      name: 'Decision workflow',
      executor: 'companion_acp',
      agentType: 'codex',
      workflow: {
        template: 'research_decision',
        state: null,
      },
    }), {
      createAcpSession: () => acp.createAcpSession({ agentType: 'codex', origin: 'automation' }),
      getAcpSessionById: acp.getAcpSessionById,
      enqueuePrompt: async (sessionId, input) => {
        enqueuedPrompts.push({ sessionId, input })
        return { ok: true, sessionId, turnId: 'turn-recipe-e2e-1' }
      },
    })

    assert.equal(enqueuedPrompts.length, 1)
    // Plan step recipe sections should be present
    assert.match(enqueuedPrompts[0].input.prompt, /Scope, Evidence Targets, Execution Order/)
    assert.match(enqueuedPrompts[0].input.prompt, /Define the research scope/)
  })
})

test('automation runtime advances research_decision through 4 steps with recipe guidance at each step', async () => {
  await withFreshState(async ({ executor, runStore, acp }) => {
    const launched = await executor.executeAutomationJob(createJob({
      id: 'job-decision-e2e',
      name: 'Decision e2e',
      executor: 'companion_acp',
      agentType: 'codex',
      workflow: {
        template: 'research_decision',
        state: null,
      },
      delivery: { mode: 'chat', notification: false, chat: true, target: null },
    }), {
      createAcpSession: () => acp.createAcpSession({ agentType: 'codex', origin: 'automation' }),
      getAcpSessionById: acp.getAcpSessionById,
      enqueuePrompt: async (sessionId) => ({ ok: true, sessionId, turnId: 'turn-1' }),
    })

    const enqueuedPrompts = []
    const stepTexts = ['Plan done.', 'Compare done.', 'Decide done.', 'Final output.']
    let stepIndex = 0

    const deps = {
      listAcpEvents: () => ({ events: [{ type: 'text_delta', text: stepTexts[stepIndex++] || '' }] }),
      enqueuePrompt: async (sessionId, input) => {
        enqueuedPrompts.push({ sessionId, input })
        return { ok: true, sessionId, turnId: `turn-${enqueuedPrompts.length + 1}` }
      },
      enqueueAutomationOutboxItem: async (item) => item,
    }

    // Advance through plan -> compare -> decide -> write
    for (let i = 0; i < 3; i++) {
      const result = await executor.deliverAutomationRunResult({
        runId: launched.runId,
        sessionId: launched.sessionId,
        terminalState: 'done',
      }, deps)
      assert.equal(result.mode, 'workflow_continued', `step ${i} should continue`)
    }

    // Compare step prompt should include recipe guidance
    assert.match(enqueuedPrompts[0].input.prompt, /Comparison Matrix/)
    // Decide step prompt should include tradeoff matrix guidance
    assert.match(enqueuedPrompts[1].input.prompt, /Tradeoff Matrix/)
    // Write step prompt should include draft guidance
    assert.match(enqueuedPrompts[2].input.prompt, /Objective/)

    // Final step delivers
    const final = await executor.deliverAutomationRunResult({
      runId: launched.runId,
      sessionId: launched.sessionId,
      terminalState: 'done',
    }, deps)
    assert.equal(final.mode, 'outbox')

    const updated = await runStore.getRunById(launched.runId)
    assert.equal(updated?.meta?.workflow?.state?.terminalState, 'done')
  })
})

test('automation diagnostics summarize prompt-only write guards, active workflows, and budget alerts', async () => {
  await withFreshState(async ({ executor, diagnostics, acp, cronStore, budgetStore }) => {
    const job = createJob({
      id: 'job-workflow-budget',
      name: 'Workflow loop',
      executor: 'companion_acp',
      agentType: 'codex',
      sessionTarget: 'persistent:workflow-loop',
      automationProfile: 'deep_research_brief',
      scheduledWritePolicy: {
        mode: 'allowlist',
        allowedTools: ['write_file'],
        allowedPaths: ['/tmp/reports'],
        allowedCommandPrefixes: null,
        enforcement: 'prompt_only',
      },
      workflow: {
        template: 'research_synthesis',
        state: null,
      },
      sessionBudget: {
        policy: {
          mode: 'deep_research',
          maxContextBudget: 24000,
          dayRollupEnabled: true,
          compactAfterRuns: 6,
        },
        ledger: null,
      },
      delivery: { mode: 'chat', notification: false, chat: true, target: null },
    })

    await cronStore.upsertJob(job)
    await budgetStore.setAutomationBudgetLedger('persistent:workflow-loop', {
      approxInputTokens: 18000,
      approxOutputTokens: 4000,
      compactionCount: 4,
      lastRollupAt: 1_700_000_000_000,
      health: 'warning',
    })

    await executor.executeAutomationJob(job, {
      createAcpSession: () => acp.createAcpSession({ agentType: 'codex', origin: 'automation' }),
      getAcpSessionById: acp.getAcpSessionById,
      enqueuePrompt: async (sessionId) => ({ ok: true, sessionId, turnId: 'turn-workflow-1' }),
    })

    const payload = await buildDiagnostics(diagnostics)
    assert.equal(payload.automation.workflowCapableJobs, 1)
    assert.equal(payload.automation.activeWorkflowRuns, 1)
    assert.equal(payload.automation.scheduledWriteEnforcements.extensionHard, 0)
    assert.equal(payload.automation.scheduledWriteEnforcements.promptOnly, 1)
    assert.equal(payload.automation.budgetHealth.warning, 1)
    assert.equal(payload.automation.budgetHealth.critical, 0)
    // v2.3 diagnostics counters
    assert.equal(typeof payload.automation.activeWorkflowTemplates, 'object')
    assert.equal(payload.automation.activeWorkflowTemplates?.research_synthesis, 1)
    assert.equal(typeof payload.automation.rollupBackedSessions, 'number')
    assert.equal(typeof payload.automation.recentCompactions, 'number')
  })
})

test('automation runtime escalates watcher job to workflow when observation hash changes', async () => {
  await withFreshState(async ({ executor, runStore, acp }) => {
    const enqueued = []

    const result = await executor.executeAutomationJob(createJob({
      executor: 'companion_acp',
      agentType: 'codex',
      watcher: {
        policy: {
          mode: 'change_only',
          minNotifyIntervalMinutes: 30,
          escalateWithWorkflow: true,
          escalationTemplate: 'research_synthesis',
        },
        state: {
          lastObservationHash: 'hash-v2',
          lastInvestigatedHash: 'hash-v1',
        },
      },
    }), {
      createAcpSession: () => acp.createAcpSession({ agentType: 'codex', origin: 'automation' }),
      getAcpSessionById: acp.getAcpSessionById,
      enqueuePrompt: async (sessionId, input) => {
        enqueued.push({ sessionId, input })
        return { ok: true, sessionId, turnId: 'turn-watcher-1' }
      },
    })

    assert.equal(result.mode, 'companion_acp')
    assert.equal(enqueued.length, 1)

    // Prompt must reference the escalated research_synthesis workflow
    assert.match(enqueued[0].input.prompt, /research_synthesis/)

    // Run metadata records watcher escalation
    const run = await runStore.getRunById(result.runId)
    assert.equal(run?.meta?.watcherEscalation?.shouldEscalate, true)
    assert.equal(run?.meta?.watcherEscalation?.reason, 'change_detected')
    assert.equal(run?.meta?.workflow?.template, 'research_synthesis')
    assert.equal(run?.meta?.watcherStatePatch?.lastInvestigatedHash, 'hash-v2')
  })
})

test('automation runtime does not escalate watcher when observation hash is unchanged', async () => {
  await withFreshState(async ({ executor, runStore, acp }) => {
    const enqueued = []

    const result = await executor.executeAutomationJob(createJob({
      executor: 'companion_acp',
      agentType: 'codex',
      watcher: {
        policy: {
          mode: 'change_only',
          minNotifyIntervalMinutes: 30,
          escalateWithWorkflow: true,
          escalationTemplate: 'research_decision',
        },
        state: {
          lastObservationHash: 'hash-same',
          lastInvestigatedHash: 'hash-same',
        },
      },
    }), {
      createAcpSession: () => acp.createAcpSession({ agentType: 'codex', origin: 'automation' }),
      getAcpSessionById: acp.getAcpSessionById,
      enqueuePrompt: async (sessionId, input) => {
        enqueued.push({ sessionId, input })
        return { ok: true, sessionId, turnId: 'turn-watcher-2' }
      },
    })

    assert.equal(result.mode, 'companion_acp')

    // No escalation — prompt should NOT reference research_decision workflow
    const prompt = enqueued[0].input.prompt
    assert.ok(!prompt.includes('research_decision') || prompt.includes('single_turn'))

    const run = await runStore.getRunById(result.runId)
    assert.equal(run?.meta?.watcherEscalation?.shouldEscalate, false)
    assert.equal(run?.meta?.watcherEscalation?.reason, 'already_investigated')
    assert.equal(run?.meta?.workflow?.template, 'single_turn')
  })
})
