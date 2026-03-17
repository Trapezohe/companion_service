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
    delivery: { mode: 'notification', notification: true, chat: false, target: null },
    ...partial,
  }
}

async function getSharedModules() {
  if (!sharedPromise) {
    sharedPromise = (async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-automation-executor-'))
      process.once('exit', () => {
        rmSync(tempDir, { recursive: true, force: true })
      })
      process.env.TRAPEZOHE_CONFIG_DIR = tempDir

      const runStore = await import('./run-store.mjs')
      const sessionStore = await import('./automation-session-store.mjs')
      const budgetStore = await import('./automation-budget-store.mjs')
      const executor = await import('./automation-executor.mjs')
      return { tempDir, runStore, sessionStore, budgetStore, executor }
    })()
  }

  return sharedPromise
}

async function withFreshState(run) {
  const { runStore, sessionStore, budgetStore, executor } = await getSharedModules()
  await runStore.clearRunStoreForTests()
  await sessionStore.clearAutomationSessionStoreForTests()
  await budgetStore.clearAutomationBudgetStoreForTests()
  await run({ runStore, sessionStore, budgetStore, executor })
}

test('executeAutomationJob keeps extension_chat jobs on legacy pending path', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    let createRunCalled = 0

    const result = await executor.executeAutomationJob(createJob(), {
      createRun: async () => {
        createRunCalled += 1
        throw new Error('should not create run for extension_pending path')
      },
    })

    assert.equal(result.mode, 'extension_pending')
    assert.equal(createRunCalled, 0)

    const runs = await runStore.listRuns({ type: 'cron', limit: 10, offset: 0 })
    assert.equal(runs.runs.length, 0)
  })
})

test('executeAutomationJob starts isolated companion_acp runs without writing pending state', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const createdSessions = []
    const attached = []
    const enqueued = []
    const sessions = new Map()
    const createdRuns = []

    const result = await executor.executeAutomationJob(createJob({
      executor: 'companion_acp',
      agentType: 'codex',
    }), {
      createRun: async (input) => {
        createdRuns.push(input)
        return runStore.createRun(input)
      },
      createAcpSession: (input) => {
        const session = { sessionId: `acp-${createdSessions.length + 1}`, state: 'idle', ...input }
        createdSessions.push(input)
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: (sessionId, runId) => {
        attached.push({ sessionId, runId })
        return { sessionId, runId }
      },
      enqueuePrompt: async (sessionId, input) => {
        enqueued.push({ sessionId, input })
        return { ok: true, sessionId, turnId: 'turn-1' }
      },
    })

    assert.equal(result.mode, 'companion_acp')
    assert.equal(result.sessionId, 'acp-1')
    assert.equal(result.reusedSession, false)
    assert.equal(createdSessions.length, 1)
    assert.deepEqual(attached, [{ sessionId: 'acp-1', runId: result.runId }])
    assert.equal(enqueued.length, 1)
    assert.match(enqueued[0].input.prompt, /^summarize/)
    assert.match(enqueued[0].input.prompt, /Scheduled write policy: read_only\./)

    const runs = await runStore.listRuns({ type: 'cron', limit: 10, offset: 0 })
    assert.equal(runs.runs.length, 1)
    assert.equal(runs.runs[0].state, 'running')
    assert.equal(runs.runs[0].sessionId, 'acp-1')
    assert.equal(runs.runs[0].meta?.executionMode, 'companion_acp')
    assert.equal(runs.runs[0].meta?.acpSessionId, 'acp-1')
    assert.equal(runs.runs[0].meta?.sessionId, 'acp-1')
    assert.equal(createdRuns[0].meta?.taskState, 'queued')
    assert.equal(createdRuns[0].meta?.stepState, 'launch')
    assert.equal(runs.runs[0].meta?.taskState, 'running')
    assert.equal(runs.runs[0].meta?.stepState, 'execute')

    const link = await runStore.getSessionRunLink('acp-1')
    assert.equal(link?.runId, result.runId)
  })
})

test('executeAutomationJob rejects research workflows outside companion_acp', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const result = await executor.executeAutomationJob(createJob({
      executor: 'extension_chat',
      workflow: {
        template: 'research_synthesis',
        state: null,
      },
    }))

    assert.equal(result.mode, 'rejected')
    assert.equal(result.reason, 'workflow_requires_companion_acp')

    const runs = await runStore.listRuns({ type: 'cron', limit: 10, offset: 0 })
    assert.equal(runs.runs.length, 1)
    assert.equal(runs.runs[0].state, 'failed')
    assert.equal(runs.runs[0].meta?.unsupportedReason, 'workflow_requires_companion_acp')
  })
})

test('executeAutomationJob preserves replay lineage metadata on companion runs', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const sessions = new Map()
    const replayOf = {
      kind: 'cron_pending',
      pendingId: 'pending-replay-1',
      missedAt: 1_700_000_000_000,
      taskId: 'job-1',
    }

    const result = await executor.executeAutomationJob(createJob({
      executor: 'companion_acp',
      agentType: 'codex',
      replayOf,
    }), {
      createAcpSession: () => {
        const session = { sessionId: 'acp-replay-1', state: 'idle' }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: () => ({ ok: true }),
      enqueuePrompt: async (sessionId, input) => ({ ok: true, sessionId, input, turnId: 'turn-replay-1' }),
    })

    const run = await runStore.getRunById(result.runId)
    assert.deepEqual(run?.meta?.replayOf, replayOf)
  })
})

test('executeAutomationJob seeds research_synthesis workflow state on companion runs', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const sessions = new Map()
    const enqueued = []
    const retryPolicy = { maxStepAttempts: 3, retryBackoffMinutes: 5 }

    const result = await executor.executeAutomationJob(createJob({
      executor: 'companion_acp',
      agentType: 'codex',
      workflow: {
        template: 'research_synthesis',
        policy: retryPolicy,
        state: null,
      },
    }), {
      createAcpSession: () => {
        const session = { sessionId: 'acp-workflow-1', state: 'idle' }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: () => ({ ok: true }),
      enqueuePrompt: async (sessionId, input) => {
        enqueued.push({ sessionId, input })
        return { ok: true, sessionId, turnId: 'turn-plan-1' }
      },
    })

    assert.equal(result.mode, 'companion_acp')
    assert.equal(enqueued.length, 1)
    assert.match(enqueued[0].input.prompt, /Current workflow step: plan \(1\/3\)\./)

    const run = await runStore.getRunById(result.runId)
    assert.equal(run?.meta?.workflow?.template, 'research_synthesis')
    assert.deepEqual(run?.meta?.retryPolicy, retryPolicy)
    assert.equal(run?.meta?.workflow?.state?.currentStepId, 'plan')
    assert.deepEqual(
      run?.meta?.workflow?.state?.steps?.map((step) => ({
        id: step.id,
        state: step.state,
      })),
      [
        { id: 'plan', state: 'running' },
        { id: 'research', state: 'queued' },
        { id: 'synthesize', state: 'queued' },
      ],
    )
  })
})

test('executeAutomationJob marks companion allowlists as prompt-only guidance in the ACP prompt', async () => {
  await withFreshState(async ({ executor }) => {
    const enqueued = []
    const sessions = new Map()

    const result = await executor.executeAutomationJob(createJob({
      executor: 'companion_acp',
      agentType: 'codex',
      scheduledWritePolicy: {
        mode: 'allowlist',
        allowedTools: ['write_file'],
        allowedPaths: ['/tmp/reports'],
        allowedCommandPrefixes: ['git status'],
        enforcement: 'extension_hard',
      },
    }), {
      createAcpSession: () => {
        const session = { sessionId: 'acp-write-1', state: 'idle' }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: () => ({ ok: true }),
      setSessionRunLink: () => ({ ok: true }),
      enqueuePrompt: async (sessionId, input) => {
        enqueued.push({ sessionId, input })
        return { ok: true, sessionId, turnId: 'turn-write-1' }
      },
    })

    assert.equal(result.mode, 'companion_acp')
    assert.equal(enqueued.length, 1)
    assert.match(enqueued[0].input.prompt, /Scheduled write policy: allowlist \(prompt_only\)\./)
    assert.match(enqueued[0].input.prompt, /cannot hard-enforce tool usage in v2\.2a/)
    assert.match(enqueued[0].input.prompt, /Allowed path prefixes: \/tmp\/reports\./)
    assert.match(enqueued[0].input.prompt, /Allowed command prefixes: git status\./)
  })
})

test('executeAutomationJob injects evidence discipline for deep research automation profiles', async () => {
  await withFreshState(async ({ executor }) => {
    const enqueued = []
    const sessions = new Map()

    const result = await executor.executeAutomationJob(createJob({
      executor: 'companion_acp',
      agentType: 'codex',
      automationProfile: 'deep_research_brief',
    }), {
      createAcpSession: () => {
        const session = { sessionId: 'acp-research-brief-1', state: 'idle' }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: () => ({ ok: true }),
      setSessionRunLink: () => ({ ok: true }),
      enqueuePrompt: async (sessionId, input) => {
        enqueued.push({ sessionId, input })
        return { ok: true, sessionId, turnId: 'turn-research-brief-1' }
      },
    })

    assert.equal(result.mode, 'companion_acp')
    assert.equal(enqueued.length, 1)
    assert.match(enqueued[0].input.prompt, /Thesis/)
    assert.match(enqueued[0].input.prompt, /Recommendation/)
    assert.match(enqueued[0].input.prompt, /Disclose uncertainty explicitly/)
    assert.match(enqueued[0].input.prompt, /Do not invent URLs, tx hashes, or quotes\./)
  })
})

test('executeAutomationJob reuses persistent companion sessions across runs', async () => {
  await withFreshState(async ({ executor }) => {
    const sessions = new Map()
    let created = 0

    const deps = {
      createAcpSession: () => {
        created += 1
        const session = { sessionId: `acp-${created}`, state: 'idle' }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: (sessionId, runId) => ({ sessionId, runId }),
      enqueuePrompt: async (sessionId) => ({ ok: true, sessionId, turnId: `turn-${created}` }),
    }

    const first = await executor.executeAutomationJob(createJob({
      id: 'job-persistent',
      sessionTarget: 'persistent:research-loop',
      executor: 'companion_acp',
      agentType: 'codex',
    }), deps)

    sessions.get(first.sessionId).state = 'done'

    const second = await executor.executeAutomationJob(createJob({
      id: 'job-persistent',
      sessionTarget: 'persistent:research-loop',
      executor: 'companion_acp',
      agentType: 'codex',
    }), deps)

    assert.equal(first.sessionId, 'acp-1')
    assert.equal(second.sessionId, 'acp-1')
    assert.equal(second.reusedSession, true)
    assert.equal(created, 1)
  })
})



test('executeAutomationJob records a persistent budget snapshot for companion budget-managed sessions', async () => {
  await withFreshState(async ({ executor, runStore, budgetStore }) => {
    const sessions = new Map()

    const result = await executor.executeAutomationJob(createJob({
      id: 'job-budget',
      name: 'Budgeted report',
      executor: 'companion_acp',
      agentType: 'codex',
      sessionTarget: 'persistent:budget-loop',
      sessionBudget: {
        policy: {
          mode: 'default',
          maxContextBudget: 120,
          dayRollupEnabled: true,
          compactAfterRuns: null,
        },
        ledger: null,
      },
    }), {
      createAcpSession: () => {
        const session = { sessionId: 'acp-budget-1', state: 'idle' }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: () => ({ ok: true }),
      setSessionRunLink: () => ({ ok: true }),
      enqueuePrompt: async (sessionId, input) => ({ ok: true, sessionId, input }),
    })

    assert.equal(result.mode, 'companion_acp')
    const run = await runStore.getRunById(result.runId)
    assert.equal(run?.meta?.budgetSnapshot?.ledger?.approxInputTokens > 0, true)
    assert.equal(run?.meta?.budgetSnapshot?.sessionKey, 'persistent:budget-loop')

    const ledger = await budgetStore.getAutomationBudgetLedger('persistent:budget-loop')
    assert.equal(ledger?.approxInputTokens > 0, true)
    assert.equal(ledger?.approxOutputTokens, 0)
  })
})

test('deliverAutomationRunResult sends webhook deliveries directly and updates the run ledger', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const run = await runStore.createRun({
      runId: 'run-webhook',
      type: 'cron',
      state: 'done',
      summary: 'Automation finished',
      meta: {
        taskId: 'task-webhook',
        taskName: 'Webhook report',
        executionMode: 'companion_acp',
        deliveryMode: 'webhook',
        target: { url: 'https://hooks.example.com/automation' },
      },
    })

    const fetchCalls = []
    /** @type {AbortSignal | undefined} */
    let capturedSignal
    const delivery = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-webhook',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({
        events: [
          { type: 'text_delta', text: 'Webhook payload ready.' },
          { type: 'done', result: 'ignored' },
        ],
      }),
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init })
        capturedSignal = init?.signal
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })

    assert.equal(delivery.mode, 'webhook')
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].url, 'https://hooks.example.com/automation')
    assert.ok(capturedSignal instanceof AbortSignal)
    assert.equal(capturedSignal.aborted, false)

    const updated = await runStore.getRunById(run.runId)
    assert.deepEqual(updated?.deliveryState, {
      channel: 'webhook',
      attempts: 1,
      lastAttemptAt: updated?.deliveryState?.lastAttemptAt,
    })
  })
})

test('deliverAutomationRunResult queues chat deliveries into the automation outbox', async () => {
  await withFreshState(async ({ executor, runStore, sessionStore }) => {
    const outbox = await import('./automation-outbox.mjs')
    await outbox.clearAutomationOutboxForTests()
    const run = await runStore.createRun({
      runId: 'run-chat',
      type: 'cron',
      state: 'done',
      summary: 'Automation finished',
      meta: {
        taskId: 'task-chat',
        taskName: 'Chat report',
        executionMode: 'companion_acp',
        deliveryMode: 'chat',
      },
    })

    const delivery = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-chat',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({
        events: [
          { type: 'text_delta', text: 'Chat delivery ready.' },
        ],
      }),
      enqueueAutomationOutboxItem: outbox.enqueueAutomationOutboxItem,
    })

    assert.equal(delivery.mode, 'outbox')
    const listed = await outbox.listAutomationOutboxItems()
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].id, 'run-chat')
    assert.equal(listed.items[0].mode, 'chat')
    assert.equal(listed.items[0].text, 'Chat delivery ready.')

    const updated = await runStore.getRunById(run.runId)
    assert.equal(updated?.deliveryState?.channel, 'outbox')
  })
})

test('deliverAutomationRunResult updates the persistent budget snapshot with output usage', async () => {
  await withFreshState(async ({ executor, runStore, budgetStore }) => {
    await budgetStore.setAutomationBudgetLedger('persistent:budget-loop', {
      approxInputTokens: 18,
      approxOutputTokens: 0,
      compactionCount: 0,
      lastRollupAt: null,
      health: 'healthy',
    })

    const run = await runStore.createRun({
      runId: 'run-budget-delivery',
      type: 'cron',
      state: 'done',
      summary: 'Automation finished',
      meta: {
        taskId: 'task-budget-delivery',
        taskName: 'Budget delivery',
        executionMode: 'companion_acp',
        deliveryMode: 'chat',
        sessionTarget: 'persistent:budget-loop',
        sessionBudget: {
          policy: {
            mode: 'default',
            maxContextBudget: 120,
            dayRollupEnabled: true,
            compactAfterRuns: null,
          },
          ledger: null,
        },
        budgetSnapshot: {
          sessionKey: 'persistent:budget-loop',
          ledger: {
            approxInputTokens: 18,
            approxOutputTokens: 0,
            compactionCount: 0,
            lastRollupAt: null,
            health: 'healthy',
          },
        },
      },
    })

    const delivery = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-budget-delivery',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({
        events: [
          { type: 'text_delta', text: 'Budget-aware delivery payload ready.' },
        ],
      }),
      enqueueAutomationOutboxItem: async (item) => item,
    })

    assert.equal(delivery.mode, 'outbox')
    const updatedRun = await runStore.getRunById(run.runId)
    assert.equal(updatedRun?.meta?.budgetSnapshot?.ledger?.approxOutputTokens > 0, true)

    const ledger = await budgetStore.getAutomationBudgetLedger('persistent:budget-loop')
    assert.equal(ledger?.approxOutputTokens > 0, true)
  })
})

test('deliverAutomationRunResult writes lifecycle summary before entering deliver phase', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const phaseUpdates = []
    const run = await runStore.createRun({
      runId: 'run-lifecycle',
      type: 'cron',
      state: 'done',
      summary: 'ACP session done',
      meta: {
        taskId: 'task-lifecycle',
        taskName: 'Lifecycle report',
        executionMode: 'companion_acp',
        deliveryMode: 'chat',
      },
    })

    const delivery = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-lifecycle',
      terminalState: 'done',
    }, {
      updateRun: async (runId, patch) => {
        if (patch?.meta?.stepState) {
          phaseUpdates.push(patch.meta.stepState)
        }
        return runStore.updateRun(runId, patch)
      },
      listAcpEvents: () => ({
        events: [
          { type: 'text_delta', text: 'Lifecycle summary ready.' },
        ],
      }),
      enqueueAutomationOutboxItem: async (item) => item,
    })

    assert.equal(delivery.mode, 'outbox')
    assert.deepEqual(phaseUpdates.slice(0, 2), ['summarize', 'deliver'])

    const updated = await runStore.getRunById(run.runId)
    assert.equal(updated?.meta?.taskState, 'done')
    assert.equal(updated?.meta?.stepState, 'deliver')
    assert.match(String(updated?.meta?.lifecycleSummary || ''), /Lifecycle summary ready\./)
  })
})

test('deliverAutomationRunResult closes notification-only runs with a terminal stepState', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const run = await runStore.createRun({
      runId: 'run-notification-only',
      type: 'cron',
      state: 'done',
      summary: 'Automation finished',
      meta: {
        taskId: 'task-notification-only',
        taskName: 'Notification-only report',
        executionMode: 'companion_acp',
        deliveryMode: 'notification',
      },
    })

    const delivery = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-notification',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({
        events: [
          { type: 'text_delta', text: 'Lifecycle summary ready.' },
        ],
      }),
    })

    assert.equal(delivery.mode, 'skipped')
    assert.equal(delivery.reason, 'delivery_not_requested')

    const updated = await runStore.getRunById(run.runId)
    assert.equal(updated?.meta?.taskState, 'done')
    assert.equal(updated?.meta?.stepState, 'done')
    assert.match(String(updated?.meta?.lifecycleSummary || ''), /Lifecycle summary ready\./)
  })
})

test('deliverAutomationRunResult closes failed runs with a terminal stepState', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const run = await runStore.createRun({
      runId: 'run-terminal-failed',
      type: 'cron',
      state: 'failed',
      summary: 'Automation failed',
      meta: {
        taskId: 'task-terminal-failed',
        taskName: 'Failed report',
        executionMode: 'companion_acp',
        deliveryMode: 'chat',
      },
    })

    const delivery = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-terminal-failed',
      terminalState: 'failed',
    }, {
      listAcpEvents: () => ({
        events: [
          { type: 'text_delta', text: 'Failure summary ready.' },
        ],
      }),
    })

    assert.equal(delivery.mode, 'skipped')
    assert.equal(delivery.reason, 'terminal_state_not_deliverable')

    const updated = await runStore.getRunById(run.runId)
    assert.equal(updated?.meta?.taskState, 'failed')
    assert.equal(updated?.meta?.stepState, 'done')
    assert.equal(updated?.meta?.lifecycleTerminalState, 'failed')
    assert.match(String(updated?.meta?.lifecycleSummary || ''), /Failure summary ready\./)
  })
})

test('deliverAutomationRunResult queues remote channel deliveries with target metadata preserved', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const outbox = await import('./automation-outbox.mjs')
    await outbox.clearAutomationOutboxForTests()
    const run = await runStore.createRun({
      runId: 'run-remote',
      type: 'cron',
      state: 'done',
      summary: 'Automation finished',
      meta: {
        taskId: 'task-remote',
        taskName: 'Remote report',
        executionMode: 'companion_acp',
        deliveryMode: 'remote_channel',
        target: {
          channelId: 'telegram',
          authToken: 'bot-token',
          bindingKey: 'chat:1',
        },
      },
    })

    const delivery = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-remote',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({
        events: [
          { type: 'text_delta', text: 'Remote delivery ready.' },
        ],
      }),
      enqueueAutomationOutboxItem: outbox.enqueueAutomationOutboxItem,
    })

    assert.equal(delivery.mode, 'outbox')
    const listed = await outbox.listAutomationOutboxItems()
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].mode, 'remote_channel')
    assert.deepEqual(listed.items[0].target, {
      channelId: 'telegram',
      authToken: 'bot-token',
      bindingKey: 'chat:1',
    })
  })
})

test('deliverAutomationRunResult advances research workflows across plan -> research -> synthesize before delivery', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const run = await runStore.createRun({
      runId: 'run-workflow',
      type: 'cron',
      state: 'running',
      summary: 'Launching workflow',
      meta: {
        taskId: 'task-workflow',
        taskName: 'Research workflow',
        executionMode: 'companion_acp',
        deliveryMode: 'chat',
        automationPromptBase: 'Produce a research report.',
        workflow: {
          template: 'research_synthesis',
          state: {
            currentStepId: 'plan',
            steps: [
              { id: 'plan', kind: 'plan', state: 'running', runId: null, summary: null },
              { id: 'research', kind: 'research', state: 'queued', runId: null, summary: null },
              { id: 'synthesize', kind: 'synthesize', state: 'queued', runId: null, summary: null },
            ],
            lastWorkflowSummary: null,
          },
        },
      },
    })

    const enqueuedPrompts = []
    const deliveredItems = []
    const eventsByStep = [
      [{ type: 'text_delta', text: 'Plan the scope.' }],
      [{ type: 'text_delta', text: 'Collect evidence.' }],
      [{ type: 'text_delta', text: 'Final report.' }],
    ]

    const first = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-workflow',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({ events: eventsByStep.shift() || [] }),
      enqueuePrompt: async (sessionId, input) => {
        enqueuedPrompts.push({ sessionId, input })
        return { ok: true, sessionId, turnId: `turn-${enqueuedPrompts.length}` }
      },
      enqueueAutomationOutboxItem: async (item) => {
        deliveredItems.push(item)
        return item
      },
    })

    assert.equal(first.mode, 'workflow_continued')
    assert.equal(first.nextStepId, 'research')
    assert.equal(enqueuedPrompts.length, 1)
    assert.match(enqueuedPrompts[0].input.prompt, /Current workflow step: research \(2\/3\)\./)

    let updated = await runStore.getRunById(run.runId)
    assert.equal(updated?.state, 'running')
    assert.equal(updated?.meta?.workflow?.state?.currentStepId, 'research')
    assert.equal(updated?.meta?.workflow?.state?.steps?.[0]?.state, 'done')
    assert.equal(updated?.meta?.workflow?.state?.steps?.[0]?.summary, 'Plan the scope.')

    const second = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-workflow',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({ events: eventsByStep.shift() || [] }),
      enqueuePrompt: async (sessionId, input) => {
        enqueuedPrompts.push({ sessionId, input })
        return { ok: true, sessionId, turnId: `turn-${enqueuedPrompts.length}` }
      },
      enqueueAutomationOutboxItem: async (item) => {
        deliveredItems.push(item)
        return item
      },
    })

    assert.equal(second.mode, 'workflow_continued')
    assert.equal(second.nextStepId, 'synthesize')
    assert.equal(enqueuedPrompts.length, 2)
    assert.match(enqueuedPrompts[1].input.prompt, /Current workflow step: synthesize \(3\/3\)\./)

    updated = await runStore.getRunById(run.runId)
    assert.equal(updated?.meta?.workflow?.state?.currentStepId, 'synthesize')
    assert.equal(updated?.meta?.workflow?.state?.steps?.[1]?.state, 'done')
    assert.equal(updated?.meta?.workflow?.state?.steps?.[1]?.summary, 'Collect evidence.')

    const third = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-workflow',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({ events: eventsByStep.shift() || [] }),
      enqueuePrompt: async (sessionId, input) => {
        enqueuedPrompts.push({ sessionId, input })
        return { ok: true, sessionId, turnId: `turn-${enqueuedPrompts.length}` }
      },
      enqueueAutomationOutboxItem: async (item) => {
        deliveredItems.push(item)
        return item
      },
    })

    assert.equal(third.mode, 'outbox')
    assert.equal(deliveredItems.length, 1)
    assert.equal(deliveredItems[0].text, 'Final report.')

    updated = await runStore.getRunById(run.runId)
    assert.equal(updated?.meta?.workflow?.state?.currentStepId, null)
    assert.equal(updated?.meta?.workflow?.state?.steps?.[2]?.state, 'done')
    assert.equal(updated?.meta?.workflow?.state?.steps?.[2]?.summary, 'Final report.')
    assert.equal(updated?.meta?.workflow?.state?.lastWorkflowSummary, 'Final report.')
  })
})

test('deliverAutomationRunResult counts workflow continuation prompts toward budget snapshots', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const run = await runStore.createRun({
      runId: 'run-workflow-budget',
      type: 'cron',
      state: 'running',
      summary: 'Launching workflow',
      meta: {
        taskId: 'task-workflow-budget',
        taskName: 'Budgeted workflow',
        executionMode: 'companion_acp',
        deliveryMode: 'chat',
        sessionTarget: 'persistent:workflow-budget',
        timeoutMs: null,
        automationPromptBase: 'Produce a research report with evidence and synthesis.',
        sessionBudget: {
          policy: {
            mode: 'deep_research',
            maxContextBudget: 24000,
            dayRollupEnabled: true,
            compactAfterRuns: 6,
          },
          ledger: null,
        },
        workflow: {
          template: 'research_synthesis',
          state: {
            currentStepId: 'plan',
            steps: [
              { id: 'plan', kind: 'plan', state: 'running', runId: null, summary: null },
              { id: 'research', kind: 'research', state: 'queued', runId: null, summary: null },
              { id: 'synthesize', kind: 'synthesize', state: 'queued', runId: null, summary: null },
            ],
            lastWorkflowSummary: null,
          },
        },
      },
    })

    const result = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-workflow-budget',
      terminalState: 'done',
    }, {
      listAcpEvents: () => ({ events: [{ type: 'text_delta', text: 'Plan the scope.' }] }),
      enqueuePrompt: async (sessionId, input) => ({ ok: true, sessionId, turnId: 'turn-workflow-budget-1', input }),
      enqueueAutomationOutboxItem: async (item) => item,
    })

    assert.equal(result.mode, 'workflow_continued')

    const updated = await runStore.getRunById(run.runId)
    assert.equal(updated?.meta?.budgetSnapshot?.ledger?.approxOutputTokens > 0, true)
    assert.equal(updated?.meta?.budgetSnapshot?.ledger?.approxInputTokens > 0, true)
  })
})

test('executeAutomationJob rejects unsupported main-session companion jobs with a failed run', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    let createAcpSessionCalled = 0

    const result = await executor.executeAutomationJob(createJob({
      executor: 'companion_acp',
      agentType: 'codex',
      sessionTarget: 'main',
    }), {
      createAcpSession: () => {
        createAcpSessionCalled += 1
        throw new Error('should not create acp session for rejected jobs')
      },
    })

    assert.equal(result.mode, 'rejected')
    assert.equal(result.reason, 'main_session_not_supported')
    assert.equal(createAcpSessionCalled, 0)

    const runs = await runStore.listRuns({ type: 'cron', limit: 10, offset: 0 })
    assert.equal(runs.runs.length, 1)
    assert.equal(runs.runs[0].state, 'failed')
    assert.equal(runs.runs[0].meta?.unsupportedReason, 'main_session_not_supported')
  })
})

test('deliverAutomationRunResult advances research_decision workflows through all 4 steps', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const run = await runStore.createRun({
      runId: 'run-decision-workflow',
      type: 'cron',
      state: 'running',
      summary: 'Launching decision workflow',
      meta: {
        taskId: 'task-decision',
        taskName: 'Decision workflow',
        executionMode: 'companion_acp',
        deliveryMode: 'chat',
        automationPromptBase: 'Decide on the best approach.',
        workflow: {
          template: 'research_decision',
          policy: null,
          state: {
            currentStepId: 'plan',
            steps: [
              { id: 'plan', kind: 'plan', state: 'running', runId: null, summary: null, startedAt: null, finishedAt: null, handoffSummary: null, retry: null },
              { id: 'compare', kind: 'compare', state: 'queued', runId: null, summary: null, startedAt: null, finishedAt: null, handoffSummary: null, retry: null },
              { id: 'decide', kind: 'decide', state: 'queued', runId: null, summary: null, startedAt: null, finishedAt: null, handoffSummary: null, retry: null },
              { id: 'write', kind: 'write', state: 'queued', runId: null, summary: null, startedAt: null, finishedAt: null, handoffSummary: null, retry: null },
            ],
            lastWorkflowSummary: null,
            lastContinuationAt: null,
            terminalState: null,
          },
        },
      },
    })

    const enqueuedPrompts = []
    const stepTexts = ['Plan done.', 'Compare done.', 'Decide done.', 'Final output.']
    let stepIndex = 0

    const deps = {
      listAcpEvents: () => ({ events: [{ type: 'text_delta', text: stepTexts[stepIndex++] || '' }] }),
      enqueuePrompt: async (sessionId, input) => {
        enqueuedPrompts.push({ sessionId, input })
        return { ok: true, sessionId, turnId: `turn-${enqueuedPrompts.length}` }
      },
      enqueueAutomationOutboxItem: async (item) => item,
    }

    // Steps 1-3 should continue
    for (let i = 0; i < 3; i++) {
      const result = await executor.deliverAutomationRunResult({
        runId: run.runId,
        sessionId: 'acp-decision',
        terminalState: 'done',
      }, deps)
      assert.equal(result.mode, 'workflow_continued', `step ${i} should continue`)
    }

    assert.equal(enqueuedPrompts.length, 3)
    assert.match(enqueuedPrompts[0].input.prompt, /compare/)
    assert.match(enqueuedPrompts[1].input.prompt, /decide/)
    assert.match(enqueuedPrompts[2].input.prompt, /write/)

    // Step 4 (write) should deliver
    const final = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-decision',
      terminalState: 'done',
    }, deps)
    assert.equal(final.mode, 'outbox')

    const updated = await runStore.getRunById(run.runId)
    assert.equal(updated?.meta?.workflow?.state?.terminalState, 'done')
    assert.equal(updated?.meta?.workflow?.state?.currentStepId, null)
  })
})

test('executeAutomationJob injects recipe section headings in workflow prompts', async () => {
  await withFreshState(async ({ executor }) => {
    const sessions = new Map()
    const enqueued = []

    await executor.executeAutomationJob(createJob({
      executor: 'companion_acp',
      agentType: 'codex',
      workflow: {
        template: 'research_synthesis',
        state: null,
      },
    }), {
      createAcpSession: () => {
        const session = { sessionId: 'acp-recipe-1', state: 'idle' }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (sessionId) => sessions.get(sessionId) ?? null,
      attachAcpSessionRunId: () => ({ ok: true }),
      enqueuePrompt: async (sessionId, input) => {
        enqueued.push({ sessionId, input })
        return { ok: true, sessionId, turnId: 'turn-recipe-1' }
      },
    })

    assert.equal(enqueued.length, 1)
    // Recipe sections for plan step should be in the prompt
    assert.match(enqueued[0].input.prompt, /Scope, Evidence Targets, Execution Order/)
    assert.match(enqueued[0].input.prompt, /Define the research scope/)
  })
})

test('deliverAutomationRunResult returns workflow_needs_retry when step fails with retry policy', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const run = await runStore.createRun({
      runId: 'run-needs-retry',
      type: 'cron',
      state: 'running',
      summary: 'Running workflow',
      meta: {
        taskId: 'task-retry',
        taskName: 'Retryable workflow',
        executionMode: 'companion_acp',
        deliveryMode: 'chat',
        automationPromptBase: 'Research with retry.',
        workflow: {
          template: 'research_synthesis',
          policy: { maxStepAttempts: 3, retryBackoffMinutes: 1 },
          state: {
            currentStepId: 'plan',
            steps: [
              { id: 'plan', kind: 'plan', state: 'running', runId: null, summary: null, startedAt: null, finishedAt: null, handoffSummary: null, retry: null },
              { id: 'research', kind: 'research', state: 'queued', runId: null, summary: null, startedAt: null, finishedAt: null, handoffSummary: null, retry: null },
              { id: 'synthesize', kind: 'synthesize', state: 'queued', runId: null, summary: null, startedAt: null, finishedAt: null, handoffSummary: null, retry: null },
            ],
            lastWorkflowSummary: null,
            lastContinuationAt: null,
            terminalState: null,
          },
        },
      },
    })

    const result = await executor.deliverAutomationRunResult({
      runId: run.runId,
      sessionId: 'acp-retry',
      terminalState: 'failed',
    }, {
      listAcpEvents: () => ({ events: [{ type: 'text_delta', text: 'timeout error' }] }),
    })

    assert.equal(result.mode, 'workflow_needs_retry')
    assert.equal(result.currentStepId, 'plan')
    assert.equal(result.retryAttempt, 1)

    const updated = await runStore.getRunById(run.runId)
    assert.equal(updated?.meta?.taskState, 'retrying')
    assert.equal(updated?.meta?.workflow?.state?.steps?.[0]?.state, 'needs_retry')
    assert.equal(updated?.meta?.workflow?.state?.steps?.[0]?.retry?.attempt, 1)
  })
})

test('executeAutomationJob escalates watcher job to workflow when change is detected', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const sessions = new Map()
    const enqueued = []
    const patchCalls = []

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
          lastObservationHash: 'hash-new',
          lastInvestigatedHash: 'hash-old',
        },
      },
    }), {
      createAcpSession: (input) => {
        const session = { sessionId: 'acp-watcher-1', state: 'idle', ...input }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (id) => sessions.get(id) ?? null,
      attachAcpSessionRunId: () => ({}),
      enqueuePrompt: async (sessionId, input) => {
        enqueued.push({ sessionId, input })
        return { ok: true, sessionId, turnId: 'turn-1' }
      },
      patchJobWatcherState: async (taskId, patch) => {
        patchCalls.push({ taskId, patch })
        return true
      },
    })

    assert.equal(result.mode, 'companion_acp')
    assert.equal(enqueued.length, 1)

    // The prompt should contain research_synthesis workflow markers
    const prompt = enqueued[0].input.prompt
    assert.match(prompt, /research_synthesis/)

    // Run metadata should record escalation details
    const run = await runStore.getRunById(result.runId)
    assert.equal(run?.meta?.watcherEscalation?.shouldEscalate, true)
    assert.equal(run?.meta?.watcherEscalation?.escalationTemplate, 'research_synthesis')
    assert.equal(run?.meta?.watcherEscalation?.reason, 'change_detected')
    assert.ok(run?.meta?.watcherStatePatch)
    assert.equal(run?.meta?.watcherStatePatch?.lastInvestigatedHash, 'hash-new')
    // runId should be backfilled with the real run ID (not null)
    assert.equal(run?.meta?.watcherStatePatch?.lastEscalationRunId, result.runId)

    // Workflow should be initialized with escalation template
    assert.equal(run?.meta?.workflow?.template, 'research_synthesis')

    // watcherStatePatch should be persisted back to the job store
    assert.equal(patchCalls.length, 1)
    assert.equal(patchCalls[0].taskId, 'job-1')
    assert.equal(patchCalls[0].patch.lastInvestigatedHash, 'hash-new')
    assert.equal(patchCalls[0].patch.lastEscalationRunId, result.runId)
  })
})

test('executeAutomationJob skips watcher escalation when hash is already investigated', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const sessions = new Map()
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
          lastObservationHash: 'hash-same',
          lastInvestigatedHash: 'hash-same',
        },
      },
    }), {
      createAcpSession: (input) => {
        const session = { sessionId: 'acp-watcher-2', state: 'idle', ...input }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (id) => sessions.get(id) ?? null,
      attachAcpSessionRunId: () => ({}),
      enqueuePrompt: async (sessionId, input) => {
        enqueued.push({ sessionId, input })
        return { ok: true, sessionId, turnId: 'turn-1' }
      },
    })

    assert.equal(result.mode, 'companion_acp')

    // Should NOT escalate — same hash already investigated
    const run = await runStore.getRunById(result.runId)
    assert.equal(run?.meta?.watcherEscalation?.shouldEscalate, false)
    assert.equal(run?.meta?.watcherEscalation?.reason, 'already_investigated')

    // Workflow should remain single_turn (no escalation override)
    assert.equal(run?.meta?.workflow?.template, 'single_turn')
  })
})

test('executeAutomationJob skips watcher escalation when observation hash is empty', async () => {
  await withFreshState(async ({ executor, runStore }) => {
    const sessions = new Map()

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
          // No observation hash yet — first run before baseline is established
          lastObservationHash: null,
          lastInvestigatedHash: null,
        },
      },
    }), {
      createAcpSession: (input) => {
        const session = { sessionId: 'acp-watcher-3', state: 'idle', ...input }
        sessions.set(session.sessionId, session)
        return session
      },
      getAcpSessionById: (id) => sessions.get(id) ?? null,
      attachAcpSessionRunId: () => ({}),
      enqueuePrompt: async () => ({ ok: true, sessionId: 'acp-watcher-3', turnId: 'turn-1' }),
    })

    assert.equal(result.mode, 'companion_acp')

    // No escalation — empty observation hash means no concrete observation to investigate
    const run = await runStore.getRunById(result.runId)
    assert.equal(run?.meta?.watcherEscalation, undefined)
    assert.equal(run?.meta?.workflow?.template, 'single_turn')
  })
})
