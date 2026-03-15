import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeAutomationSpec,
  normalizeSessionRetention,
  summarizeAutomationSpecs,
} from './automation-spec.mjs'

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

test('normalizeAutomationSpec defaults to extension_chat execution', () => {
  const spec = normalizeAutomationSpec(createJob({
    executor: undefined,
  }))

  assert.equal(spec.executor, 'extension_chat')
  assert.equal(spec.supported, true)
  assert.equal(spec.unsupportedReason, null)
})

test('normalizeAutomationSpec marks companion_acp jobs without agentType as unsupported', () => {
  const spec = normalizeAutomationSpec(createJob({
    executor: 'companion_acp',
    agentType: null,
  }))

  assert.equal(spec.supported, false)
  assert.equal(spec.unsupportedReason, 'agent_type_required')
})

test('normalizeAutomationSpec marks main-session companion execution as unsupported', () => {
  const spec = normalizeAutomationSpec(createJob({
    executor: 'companion_acp',
    agentType: 'codex',
    sessionTarget: 'main',
  }))

  assert.equal(spec.supported, false)
  assert.equal(spec.unsupportedReason, 'main_session_not_supported')
})

test('normalizeAutomationSpec routes chat and remote_channel delivery through the outbox', () => {
  const chatSpec = normalizeAutomationSpec(createJob({
    delivery: { mode: 'chat', notification: false, chat: true, target: null },
  }))
  const remoteSpec = normalizeAutomationSpec(createJob({
    delivery: { mode: 'remote_channel', notification: false, chat: true, target: { channel: 'telegram' } },
  }))

  assert.equal(chatSpec.delivery.transport, 'outbox')
  assert.equal(remoteSpec.delivery.transport, 'outbox')
})

test('normalizeAutomationSpec routes webhook delivery directly from the companion', () => {
  const spec = normalizeAutomationSpec(createJob({
    delivery: { mode: 'webhook', notification: false, chat: false, target: { url: 'https://example.com' } },
  }))

  assert.equal(spec.delivery.transport, 'direct')
})

test('normalizeAutomationSpec preserves session retention and lifecycle capability for non-main automation sessions', () => {
  const isolatedSpec = normalizeAutomationSpec(createJob({
    sessionTarget: 'isolated',
    sessionRetention: {
      maxAgeDays: 14,
      maxRuns: 30,
    },
  }))
  const mainSpec = normalizeAutomationSpec(createJob({
    sessionTarget: 'main',
    sessionRetention: {
      maxAgeDays: 7,
      maxRuns: 10,
    },
  }))

  assert.deepEqual(isolatedSpec.sessionRetention, {
    maxAgeDays: 14,
    maxRuns: 30,
  })
  assert.equal(isolatedSpec.lifecycleCapable, true)
  assert.equal(mainSpec.lifecycleCapable, false)
})

test('normalizeSessionRetention rejects invalid boundary values and preserves positive limits', () => {
  assert.equal(normalizeSessionRetention(null), null)
  assert.equal(normalizeSessionRetention({}), null)
  assert.equal(normalizeSessionRetention([]), null)
  assert.equal(normalizeSessionRetention({ maxAgeDays: -1, maxRuns: NaN }), null)
  assert.equal(normalizeSessionRetention({ maxAgeDays: 0, maxRuns: 0 }), null)
  assert.deepEqual(normalizeSessionRetention({ maxAgeDays: 7.2, maxRuns: 3.8 }), {
    maxAgeDays: 7,
    maxRuns: 3,
  })
})

test('normalizeAutomationSpec carries next-phase contract fields and downgrades companion write enforcement to prompt_only', () => {
  const spec = normalizeAutomationSpec(createJob({
    executor: 'companion_acp',
    agentType: 'codex',
    sessionTarget: 'persistent:research-loop',
    scheduledWritePolicy: {
      mode: 'allowlist',
      allowedTools: ['write_file', 'run_local_command'],
      allowedPaths: ['/tmp/reports'],
      allowedCommandPrefixes: ['git status'],
      enforcement: 'extension_hard',
    },
    workflow: {
      template: 'research_synthesis',
      state: null,
    },
    watcher: {
      policy: {
        mode: 'change_only',
        minNotifyIntervalMinutes: 60,
      },
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
  }))

  assert.deepEqual(spec.scheduledWritePolicy, {
    mode: 'allowlist',
    allowedTools: ['write_file', 'run_local_command'],
    allowedPaths: ['/tmp/reports'],
    allowedCommandPrefixes: ['git status'],
    enforcement: 'prompt_only',
  })
  assert.deepEqual(spec.workflow, {
    template: 'research_synthesis',
    state: null,
  })
  assert.deepEqual(spec.watcher, {
    policy: {
      mode: 'change_only',
      minNotifyIntervalMinutes: 60,
    },
    state: null,
  })
  assert.deepEqual(spec.sessionBudget, {
    policy: {
      mode: 'deep_research',
      maxContextBudget: 24000,
      dayRollupEnabled: true,
      compactAfterRuns: 6,
    },
    ledger: null,
  })
})

test('summarizeAutomationSpecs exposes next-phase capability counts', () => {
  const summary = summarizeAutomationSpecs([
    createJob({
      id: 'job-allowlist',
      scheduledWritePolicy: {
        mode: 'allowlist',
        allowedTools: ['write_file'],
        allowedPaths: ['/tmp/reports'],
        allowedCommandPrefixes: null,
        enforcement: 'extension_hard',
      },
    }),
    createJob({
      id: 'job-workflow',
      executor: 'companion_acp',
      agentType: 'codex',
      sessionTarget: 'persistent:research-loop',
      scheduledWritePolicy: {
        mode: 'allowlist',
        allowedTools: ['run_local_command'],
        allowedPaths: null,
        allowedCommandPrefixes: ['git status'],
        enforcement: 'prompt_only',
      },
      workflow: {
        template: 'research_synthesis',
        state: null,
      },
      watcher: {
        policy: {
          mode: 'change_only',
          minNotifyIntervalMinutes: 30,
        },
        state: null,
      },
      sessionBudget: {
        policy: {
          mode: 'lean',
          maxContextBudget: 8000,
          dayRollupEnabled: true,
          compactAfterRuns: 4,
        },
        ledger: null,
      },
    }),
  ])

  assert.equal(summary.allowlistScheduledWrites, 2)
  assert.equal(summary.workflowCapableJobs, 1)
  assert.equal(summary.watcherConfiguredJobs, 1)
  assert.equal(summary.budgetManagedJobs, 1)
})
