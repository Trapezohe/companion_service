import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

async function withTempHome(run, options = {}) {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-browser-ledger-test-'))
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  const prevMaxSessions = process.env.TRAPEZOHE_MAX_BROWSER_SESSIONS
  const prevMaxActions = process.env.TRAPEZOHE_MAX_BROWSER_ACTIONS_PER_SESSION
  const prevMaxArtifacts = process.env.TRAPEZOHE_MAX_BROWSER_ARTIFACTS_PER_SESSION
  let mod

  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome
  if (options.maxSessions) {
    process.env.TRAPEZOHE_MAX_BROWSER_SESSIONS = String(options.maxSessions)
  } else {
    delete process.env.TRAPEZOHE_MAX_BROWSER_SESSIONS
  }
  if (options.maxActionsPerSession) {
    process.env.TRAPEZOHE_MAX_BROWSER_ACTIONS_PER_SESSION = String(options.maxActionsPerSession)
  } else {
    delete process.env.TRAPEZOHE_MAX_BROWSER_ACTIONS_PER_SESSION
  }
  if (options.maxArtifactsPerSession) {
    process.env.TRAPEZOHE_MAX_BROWSER_ARTIFACTS_PER_SESSION = String(options.maxArtifactsPerSession)
  } else {
    delete process.env.TRAPEZOHE_MAX_BROWSER_ARTIFACTS_PER_SESSION
  }

  try {
    const cacheBust = `${Date.now()}-${Math.random()}`
    mod = await import(`./browser-ledger.mjs?bust=${cacheBust}`)
    await mod.loadBrowserLedger()
    await mod.clearBrowserLedgerForTests()
    await run({ tempHome, mod })
  } finally {
    await mod?.flushBrowserLedger?.().catch(() => undefined)
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevUserProfile
    if (prevMaxSessions === undefined) delete process.env.TRAPEZOHE_MAX_BROWSER_SESSIONS
    else process.env.TRAPEZOHE_MAX_BROWSER_SESSIONS = prevMaxSessions
    if (prevMaxActions === undefined) delete process.env.TRAPEZOHE_MAX_BROWSER_ACTIONS_PER_SESSION
    else process.env.TRAPEZOHE_MAX_BROWSER_ACTIONS_PER_SESSION = prevMaxActions
    if (prevMaxArtifacts === undefined) delete process.env.TRAPEZOHE_MAX_BROWSER_ARTIFACTS_PER_SESSION
    else process.env.TRAPEZOHE_MAX_BROWSER_ARTIFACTS_PER_SESSION = prevMaxArtifacts
    await rm(tempHome, { recursive: true, force: true })
  }
}

function createSession(sessionId, overrides = {}) {
  const timestamp = Number(overrides.updatedAt || overrides.createdAt || Date.now())
  return {
    sessionId,
    driver: 'extension-tab',
    state: 'ready',
    createdAt: timestamp,
    updatedAt: timestamp,
    profileId: 'default',
    capabilities: {
      navigate: true,
      snapshot: true,
      click: true,
      type: true,
      upload: false,
      dialog: false,
      console: false,
      screenshot: false,
      pdf: false,
    },
    ...overrides,
  }
}

function createTarget(sessionId, targetId, overrides = {}) {
  const timestamp = Number(overrides.lastSeenAt || Date.now())
  return {
    targetId,
    sessionId,
    kind: 'page',
    url: 'https://example.com',
    title: 'Example',
    active: true,
    attached: true,
    lastSeenAt: timestamp,
    ...overrides,
  }
}

function createAction(sessionId, actionId, overrides = {}) {
  const timestamp = Number(overrides.startedAt || Date.now())
  return {
    actionId,
    sessionId,
    kind: 'navigate',
    status: 'running',
    startedAt: timestamp,
    inputSummary: 'navigate to example',
    ...overrides,
  }
}

function createSnapshot(sessionId, snapshotId, targetId, overrides = {}) {
  const timestamp = Number(overrides.createdAt || Date.now())
  return {
    snapshotId,
    sessionId,
    targetId,
    format: 'ai',
    url: 'https://example.com',
    title: 'Example',
    body: 'Example body',
    refs: [],
    stats: {
      chars: 12,
      lines: 1,
      refs: 0,
      interactive: 0,
      truncated: false,
    },
    createdAt: timestamp,
    source: 'navigate',
    ...overrides,
  }
}

function createArtifact(sessionId, artifactId, overrides = {}) {
  const timestamp = Number(overrides.createdAt || Date.now())
  return {
    artifactId,
    sessionId,
    kind: 'screenshot',
    createdAt: timestamp,
    mimeType: 'image/png',
    byteLength: 24,
    storage: 'companion',
    pathOrKey: `browser/${artifactId}.png`,
    ...overrides,
  }
}

test('browser ledger supports sync, query, and persistence across reload', async () => {
  await withTempHome(async ({ mod }) => {
    const session = await mod.syncBrowserSession({
      session: createSession('browser-session-1', {
        createdAt: 1_710_000_000_000,
        updatedAt: 1_710_000_000_100,
        ownerConversationId: 'conv-1',
        ownerRunId: 'run-1',
        sourceToolName: 'browser_navigate',
        sourceToolCallId: 'call-nav-1',
        approvalRequestId: 'approval-1',
        primaryTargetId: 'target-1',
      }),
      targets: [createTarget('browser-session-1', 'target-1', { lastSeenAt: 1_710_000_000_100 })],
      source: 'extension-background',
    })

    assert.equal(session.session.sessionId, 'browser-session-1')
    assert.equal(session.targets.length, 1)
    assert.equal(session.source, 'extension-background')
    assert.equal(session.link.runId, 'run-1')
    assert.equal(session.link.conversationId, 'conv-1')
    assert.equal(session.link.sourceToolName, 'browser_navigate')
    assert.equal(session.link.sourceToolCallId, 'call-nav-1')

    await mod.syncBrowserAction({
      action: createAction('browser-session-1', 'browser-action-1', {
        targetId: 'target-1',
        startedAt: 1_710_000_000_200,
        status: 'running',
        ownerConversationId: 'conv-1',
        ownerRunId: 'run-1',
        sourceToolName: 'browser_navigate',
        sourceToolCallId: 'call-nav-1',
        approvalRequestId: 'approval-1',
      }),
      snapshot: createSnapshot('browser-session-1', 'snapshot-1', 'target-1', {
        createdAt: 1_710_000_000_210,
      }),
    })

    const completed = await mod.syncBrowserAction({
      action: createAction('browser-session-1', 'browser-action-1', {
        targetId: 'target-1',
        startedAt: 1_710_000_000_200,
        finishedAt: 1_710_000_000_220,
        status: 'completed',
        resultSummary: 'navigation ok',
        nextSnapshotId: 'snapshot-1',
        ownerConversationId: 'conv-1',
        ownerRunId: 'run-1',
        sourceToolName: 'browser_navigate',
        sourceToolCallId: 'call-nav-1',
        approvalRequestId: 'approval-1',
      }),
    })

    assert.equal(completed.action.status, 'completed')
    assert.equal(completed.snapshot.snapshotId, 'snapshot-1')
    assert.equal(completed.action.sourceToolCallId, 'call-nav-1')
    assert.equal(completed.link.runId, 'run-1')
    assert.equal(completed.link.conversationId, 'conv-1')
    assert.equal(completed.link.approvalRequestId, 'approval-1')

    const artifact = await mod.syncBrowserArtifact({
      artifact: createArtifact('browser-session-1', 'browser-artifact-1', {
        targetId: 'target-1',
        createdAt: 1_710_000_000_230,
      }),
      actionId: 'browser-action-1',
    })

    assert.equal(artifact.actionId, 'browser-action-1')

    const sessions = await mod.listBrowserSessions({ limit: 10, offset: 0 })
    assert.equal(sessions.total, 1)
    assert.equal(sessions.sessions[0].session.sessionId, 'browser-session-1')
    assert.equal(sessions.sessions[0].link.runId, 'run-1')

    const linkedSessions = await mod.listBrowserSessions({ runId: 'run-1', limit: 10, offset: 0 })
    assert.equal(linkedSessions.total, 1)
    assert.equal(linkedSessions.sessions[0].link.sourceToolCallId, 'call-nav-1')

    const detail = await mod.getBrowserSessionById('browser-session-1')
    assert.ok(detail)
    assert.equal(detail.targets[0].targetId, 'target-1')
    assert.equal(detail.link.approvalRequestId, 'approval-1')

    const actions = await mod.listBrowserActions({ sessionId: 'browser-session-1', limit: 10, offset: 0 })
    assert.equal(actions.total, 1)
    assert.equal(actions.actions[0].action.status, 'completed')
    assert.equal(actions.actions[0].snapshot.snapshotId, 'snapshot-1')

    const linkedActions = await mod.listBrowserActions({ sourceToolCallId: 'call-nav-1', limit: 10, offset: 0 })
    assert.equal(linkedActions.total, 1)
    assert.equal(linkedActions.actions[0].link.runId, 'run-1')

    const artifacts = await mod.listBrowserArtifacts({ sessionId: 'browser-session-1', limit: 10, offset: 0 })
    assert.equal(artifacts.total, 1)
    assert.equal(artifacts.artifacts[0].artifact.artifactId, 'browser-artifact-1')
    assert.equal(artifacts.artifacts[0].actionId, 'browser-action-1')

    const diagnostics = await mod.getBrowserLedgerDiagnostics()
    assert.equal(diagnostics.loaded, true)
    assert.equal(diagnostics.sessions.total, 1)
    assert.equal(diagnostics.sessions.active, 1)
    assert.equal(diagnostics.sessions.linked, 1)
    assert.equal(diagnostics.sessions.recentLinked[0].sessionId, 'browser-session-1')
    assert.equal(diagnostics.sessions.recentLinked[0].link.runId, 'run-1')
    assert.equal(diagnostics.actions.failedRecent, 0)
    assert.equal(diagnostics.actions.linked, 1)
    assert.equal(diagnostics.actions.recentLinked[0].actionId, 'browser-action-1')
    assert.equal(diagnostics.actions.recentLinked[0].link.sourceToolCallId, 'call-nav-1')
    assert.equal(diagnostics.artifacts.recent, 1)

    await mod.flushBrowserLedger()

    const cacheBust = `${Date.now()}-${Math.random()}`
    const reloaded = await import(`./browser-ledger.mjs?bust=${cacheBust}`)
    await reloaded.loadBrowserLedger()

    const restored = await reloaded.getBrowserSessionById('browser-session-1')
    assert.ok(restored)
    assert.equal(restored.session.ownerConversationId, 'conv-1')
    assert.equal(restored.session.sourceToolName, 'browser_navigate')
    assert.equal(restored.link.runId, 'run-1')
    assert.equal(restored.targets[0].targetId, 'target-1')
  })
})

test('browser ledger emits cursor-paged sync events and exposes them in diagnostics', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.syncBrowserSession({
      session: createSession('browser-session-events-1', {
        createdAt: 1_710_000_010_000,
        updatedAt: 1_710_000_010_100,
        ownerConversationId: 'conv-events-1',
        ownerRunId: 'run-events-1',
      }),
      targets: [createTarget('browser-session-events-1', 'target-events-1', { lastSeenAt: 1_710_000_010_100 })],
    })

    await mod.syncBrowserAction({
      action: createAction('browser-session-events-1', 'browser-action-events-1', {
        targetId: 'target-events-1',
        kind: 'click',
        status: 'failed',
        startedAt: 1_710_000_010_200,
        finishedAt: 1_710_000_010_250,
        inputSummary: 'click [7]',
        error: {
          code: 'TARGET_STALE',
          message: 'Snapshot is stale.',
          retryable: true,
        },
      }),
    })

    await mod.syncBrowserArtifact({
      artifact: createArtifact('browser-session-events-1', 'browser-artifact-events-1', {
        targetId: 'target-events-1',
        createdAt: 1_710_000_010_260,
      }),
      actionId: 'browser-action-events-1',
    })

    const firstPage = await mod.listBrowserEvents({ after: 0, limit: 2 })
    assert.equal(firstPage.ok, true)
    assert.equal(firstPage.events.length, 2)
    assert.equal(firstPage.events[0].type, 'session_synced')
    assert.equal(firstPage.events[1].type, 'action_synced')
    assert.equal(firstPage.events[0].sessionId, 'browser-session-events-1')
    assert.equal(firstPage.hasMore, true)

    const secondPage = await mod.listBrowserEvents({ after: firstPage.nextCursor, limit: 2 })
    assert.equal(secondPage.ok, true)
    assert.equal(secondPage.events.length, 1)
    assert.equal(secondPage.events[0].type, 'artifact_synced')
    assert.equal(secondPage.events[0].artifactId, 'browser-artifact-events-1')
    assert.equal(secondPage.hasMore, false)

    const diagnostics = await mod.getBrowserLedgerDiagnostics()
    assert.equal(diagnostics.events.total, 3)
    assert.equal(diagnostics.events.recent[0].type, 'artifact_synced')
    assert.equal(diagnostics.events.recent[0].artifactId, 'browser-artifact-events-1')
  })
})

test('browser ledger can read a recent tail window and continue incrementally from its cursor', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.syncBrowserSession({
      session: createSession('browser-session-tail-1', {
        createdAt: 1_710_000_020_000,
        updatedAt: 1_710_000_020_100,
        ownerConversationId: 'conv-tail-1',
        ownerRunId: 'run-tail-1',
      }),
      targets: [createTarget('browser-session-tail-1', 'target-tail-1', { lastSeenAt: 1_710_000_020_100 })],
    })

    await mod.syncBrowserAction({
      action: createAction('browser-session-tail-1', 'browser-action-tail-1', {
        targetId: 'target-tail-1',
        kind: 'navigate',
        status: 'completed',
        startedAt: 1_710_000_020_200,
        finishedAt: 1_710_000_020_250,
        ownerConversationId: 'conv-tail-1',
        ownerRunId: 'run-tail-1',
        sourceToolName: 'browser_navigate',
        sourceToolCallId: 'call-tail-1',
      }),
    })

    await mod.syncBrowserArtifact({
      artifact: createArtifact('browser-session-tail-1', 'browser-artifact-tail-1', {
        targetId: 'target-tail-1',
        createdAt: 1_710_000_020_260,
      }),
      actionId: 'browser-action-tail-1',
      link: {
        runId: 'run-tail-1',
        conversationId: 'conv-tail-1',
        sourceToolName: 'browser_navigate',
        sourceToolCallId: 'call-tail-1',
      },
    })

    const recentWindow = await mod.listBrowserEvents({
      runId: 'run-tail-1',
      window: 'tail',
      limit: 2,
    })
    assert.equal(recentWindow.ok, true)
    assert.deepEqual(
      recentWindow.events.map((event) => event.type),
      ['action_synced', 'artifact_synced'],
    )
    assert.equal(recentWindow.nextCursor, recentWindow.events[recentWindow.events.length - 1].cursor)
    assert.equal(recentWindow.hasMore, false)

    await mod.syncBrowserAction({
      action: createAction('browser-session-tail-1', 'browser-action-tail-2', {
        targetId: 'target-tail-1',
        kind: 'click',
        status: 'completed',
        startedAt: 1_710_000_020_300,
        finishedAt: 1_710_000_020_350,
        ownerConversationId: 'conv-tail-1',
        ownerRunId: 'run-tail-1',
        sourceToolName: 'browser_click',
        sourceToolCallId: 'call-tail-2',
      }),
    })

    const increment = await mod.listBrowserEvents({
      runId: 'run-tail-1',
      after: recentWindow.nextCursor,
      limit: 5,
    })
    assert.equal(increment.ok, true)
    assert.deepEqual(
      increment.events.map((event) => event.type),
      ['action_synced'],
    )
    assert.equal(increment.hasMore, false)
    assert.ok(increment.nextCursor > recentWindow.nextCursor)
  })
})

test('browser ledger trims old sessions and cascades action and artifact retention', async () => {
  await withTempHome(async ({ mod }) => {
    for (let index = 1; index <= 3; index += 1) {
      const sessionId = `browser-session-${index}`
      const targetId = `target-${index}`
      await mod.syncBrowserSession({
        session: createSession(sessionId, {
          createdAt: 1_710_000_001_000 + index,
          updatedAt: 1_710_000_001_000 + index,
          primaryTargetId: targetId,
          state: index === 2 ? 'closed' : 'ready',
        }),
        targets: [createTarget(sessionId, targetId, { lastSeenAt: 1_710_000_001_000 + index })],
        source: 'extension-background',
      })
      await mod.syncBrowserAction({
        action: createAction(sessionId, `browser-action-${index}`, {
          targetId,
          status: index === 3 ? 'failed' : 'completed',
          startedAt: 1_710_000_001_100 + index,
          finishedAt: 1_710_000_001_150 + index,
        }),
      })
      await mod.syncBrowserArtifact({
        artifact: createArtifact(sessionId, `browser-artifact-${index}`, {
          targetId,
          createdAt: 1_710_000_001_200 + index,
        }),
        actionId: `browser-action-${index}`,
      })
    }

    const sessions = await mod.listBrowserSessions({ limit: 10, offset: 0 })
    assert.equal(sessions.total, 2)
    assert.deepEqual(
      sessions.sessions.map((entry) => entry.session.sessionId),
      ['browser-session-3', 'browser-session-2'],
    )

    const actions = await mod.listBrowserActions({ limit: 10, offset: 0 })
    assert.equal(actions.total, 2)
    assert.equal(actions.actions.some((entry) => entry.action.sessionId === 'browser-session-1'), false)

    const artifacts = await mod.listBrowserArtifacts({ limit: 10, offset: 0 })
    assert.equal(artifacts.total, 2)
    assert.equal(artifacts.artifacts.some((entry) => entry.artifact.sessionId === 'browser-session-1'), false)

    const diagnostics = await mod.getBrowserLedgerDiagnostics()
    assert.equal(diagnostics.sessions.active, 1)
    assert.equal(diagnostics.actions.failedRecent, 1)
    assert.equal(diagnostics.artifacts.recent, 2)
  }, {
    maxSessions: 2,
    maxActionsPerSession: 2,
    maxArtifactsPerSession: 2,
  })
})

test('browser ledger limits per-session actions and artifacts to the newest records', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.syncBrowserSession({
      session: createSession('browser-session-1', {
        createdAt: 1_710_000_002_000,
        updatedAt: 1_710_000_002_000,
        primaryTargetId: 'target-1',
      }),
      targets: [createTarget('browser-session-1', 'target-1', { lastSeenAt: 1_710_000_002_000 })],
      source: 'extension-background',
    })

    for (let index = 1; index <= 4; index += 1) {
      await mod.syncBrowserAction({
        action: createAction('browser-session-1', `browser-action-${index}`, {
          targetId: 'target-1',
          startedAt: 1_710_000_002_100 + index,
          finishedAt: 1_710_000_002_150 + index,
          status: 'completed',
        }),
      })
      await mod.syncBrowserArtifact({
        artifact: createArtifact('browser-session-1', `browser-artifact-${index}`, {
          targetId: 'target-1',
          createdAt: 1_710_000_002_200 + index,
        }),
        actionId: `browser-action-${index}`,
      })
    }

    const actions = await mod.listBrowserActions({ sessionId: 'browser-session-1', limit: 10, offset: 0 })
    assert.deepEqual(
      actions.actions.map((entry) => entry.action.actionId),
      ['browser-action-4', 'browser-action-3'],
    )

    const artifacts = await mod.listBrowserArtifacts({ sessionId: 'browser-session-1', limit: 10, offset: 0 })
    assert.deepEqual(
      artifacts.artifacts.map((entry) => entry.artifact.artifactId),
      ['browser-artifact-4'],
    )
  }, {
    maxSessions: 5,
    maxActionsPerSession: 2,
    maxArtifactsPerSession: 1,
  })
})
