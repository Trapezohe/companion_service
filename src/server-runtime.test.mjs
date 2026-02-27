import test from 'node:test'
import assert from 'node:assert/strict'

import { createCompanionServer } from './server.mjs'
import { cleanupAllSessions } from './runtime.mjs'

function createMcpManagerStub() {
  return {
    getConnectedCount: () => 0,
    getAllTools: () => [],
    getServers: () => [],
    callTool: async () => ({ ok: true }),
    restartServer: async () => {},
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function startTestServer() {
  const token = 'test-token'
  const server = createCompanionServer({
    token,
    mcpManager: createMcpManagerStub(),
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server.')
  }

  return {
    token,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

async function stopTestServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function requestJson(ctx, endpoint, options = {}) {
  const { method = 'GET', body } = options
  const headers = {
    Authorization: `Bearer ${ctx.token}`,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${ctx.baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json()
  return {
    status: response.status,
    payload,
  }
}

async function waitForSessionExit(ctx, sessionId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await requestJson(ctx, `/api/runtime/session/${sessionId}`)
    if (res.status === 200 && res.payload.status === 'exited') return
    await delay(25)
  }
  throw new Error(`Timed out waiting for session to exit: ${sessionId}`)
}

async function waitForSessionStdout(ctx, sessionId, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await requestJson(ctx, `/api/runtime/session/${sessionId}`)
    if (res.status === 200 && String(res.payload.stdout || '').includes(expected)) return
    await delay(25)
  }
  throw new Error(`Timed out waiting for session stdout: ${sessionId}`)
}

async function waitForRuns(ctx, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await requestJson(ctx, '/api/runtime/runs?limit=100')
    if (res.status === 200 && predicate(res.payload.runs || [])) {
      return res.payload.runs || []
    }
    await delay(25)
  }
  throw new Error('Timed out waiting for expected run data.')
}

test('runtime session list endpoints support new and legacy paths', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const started = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: 'node -e "setTimeout(() => process.stdout.write(\'still-running\'), 1200)"',
      timeoutMs: 5_000,
    },
  })
  assert.equal(started.status, 200)
  const { sessionId } = started.payload
  assert.ok(sessionId)

  const newPath = await requestJson(ctx, '/api/runtime/sessions?status=running&limit=1&offset=0')
  assert.equal(newPath.status, 200)
  assert.ok(Array.isArray(newPath.payload.sessions))
  assert.equal(newPath.payload.limit, 1)
  assert.equal(newPath.payload.offset, 0)
  assert.equal(newPath.payload.sessions.every((item) => item.status === 'running'), true)
  assert.ok(newPath.payload.sessions.length <= 1)

  const legacyPath = await requestJson(ctx, '/api/local-runtime/sessions?limit=10')
  assert.equal(legacyPath.status, 200)
  assert.ok(Array.isArray(legacyPath.payload.sessions))
  assert.ok(legacyPath.payload.sessions.some((item) => item.sessionId === sessionId))
})

test('runtime session log endpoints support stream pagination on new and legacy paths', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const started = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: 'node -e "process.stdout.write(\'0123456789\');process.stderr.write(\'abcdefghij\')"',
      timeoutMs: 5_000,
    },
  })
  assert.equal(started.status, 200)
  const { sessionId } = started.payload
  assert.ok(sessionId)

  await waitForSessionExit(ctx, sessionId)

  const newPath = await requestJson(ctx, `/api/runtime/sessions/${sessionId}/log?stream=stdout&offset=2&limit=4`)
  assert.equal(newPath.status, 200)
  assert.equal(newPath.payload.stream, 'stdout')
  assert.equal(newPath.payload.output, '2345')
  assert.equal(newPath.payload.total, 10)
  assert.equal(newPath.payload.nextOffset, 6)
  assert.equal(newPath.payload.hasMore, true)

  const legacyPath = await requestJson(
    ctx,
    `/api/local-runtime/sessions/${sessionId}/log?stream=both&offset=3&limit=4`,
  )
  assert.equal(legacyPath.status, 200)
  assert.equal(legacyPath.payload.stream, 'both')
  assert.equal(legacyPath.payload.stdout.output, '3456')
  assert.equal(legacyPath.payload.stderr.output, 'defg')
})

test('runtime session write endpoint sends stdin to running session', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const started = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: 'node -e "process.stdin.setEncoding(\'utf8\');process.stdin.on(\'data\',d=>{process.stdout.write(\'IN:\'+d);if(d.includes(\'quit\'))process.exit(0)})"',
      timeoutMs: 8_000,
    },
  })
  assert.equal(started.status, 200)
  const { sessionId } = started.payload
  assert.ok(sessionId)

  const writeRes = await requestJson(ctx, `/api/runtime/session/${sessionId}/write`, {
    method: 'POST',
    body: { text: 'hello', submit: true },
  })
  assert.equal(writeRes.status, 200)
  assert.equal(writeRes.payload.ok, true)
  assert.equal(typeof writeRes.payload.written, 'number')

  await waitForSessionStdout(ctx, sessionId, 'IN:hello')

  await requestJson(ctx, `/api/runtime/session/${sessionId}/write`, {
    method: 'POST',
    body: { text: 'quit', submit: true },
  })
  await waitForSessionExit(ctx, sessionId)
})

test('runtime session send-keys endpoint can interrupt running process', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const started = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: 'node -e "setInterval(() => {}, 1000)"',
      timeoutMs: 15_000,
    },
  })
  assert.equal(started.status, 200)
  const { sessionId } = started.payload
  assert.ok(sessionId)

  const sendKeys = await requestJson(ctx, `/api/runtime/session/${sessionId}/send-keys`, {
    method: 'POST',
    body: { keys: 'ctrl-c' },
  })
  assert.equal(sendKeys.status, 200)
  assert.equal(sendKeys.payload.ok, true)

  await waitForSessionExit(ctx, sessionId)
})

test('runtime session-events endpoint returns exited events with cursor paging', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const baseline = await requestJson(ctx, '/api/runtime/session-events?after=0&limit=1')
  assert.equal(baseline.status, 200)
  const startCursor = Number(baseline.payload.nextCursor || 0)

  const started = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: 'node -e "setTimeout(() => process.exit(9), 80)"',
      timeoutMs: 5_000,
    },
  })
  assert.equal(started.status, 200)
  const { sessionId } = started.payload
  await waitForSessionExit(ctx, sessionId)

  const events = await requestJson(
    ctx,
    `/api/runtime/session-events?after=${startCursor}&limit=10`,
  )
  assert.equal(events.status, 200)
  assert.ok(Array.isArray(events.payload.events))
  const exitEvent = events.payload.events.find((item) => item.sessionId === sessionId)
  assert.ok(exitEvent)
  assert.equal(exitEvent.type, 'session_exited')
  assert.equal(typeof events.payload.nextCursor, 'number')
})

test('runtime runs endpoints expose exec/session lifecycle and diagnostics', async (t) => {
  cleanupAllSessions()
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  const execRes = await requestJson(ctx, '/api/runtime/exec', {
    method: 'POST',
    body: {
      command: 'node -e "process.stdout.write(\'ok\')"',
      timeoutMs: 5_000,
    },
  })
  assert.equal(execRes.status, 200)
  assert.equal(execRes.payload.ok, true)

  const runsAfterExec = await waitForRuns(
    ctx,
    (runs) => runs.some((run) => run.type === 'exec' && (run.state === 'done' || run.state === 'failed')),
  )
  const execRun = runsAfterExec.find((run) => run.type === 'exec')
  assert.ok(execRun)
  assert.equal(execRun.state, 'done')
  assert.equal(execRun.meta.command.includes('node -e'), true)

  const runDetail = await requestJson(ctx, `/api/runtime/runs/${encodeURIComponent(execRun.runId)}`)
  assert.equal(runDetail.status, 200)
  assert.equal(runDetail.payload.ok, true)
  assert.equal(runDetail.payload.run.runId, execRun.runId)

  const sessionStart = await requestJson(ctx, '/api/runtime/session/start', {
    method: 'POST',
    body: {
      command: 'node -e "setTimeout(() => process.exit(0), 80)"',
      timeoutMs: 5_000,
    },
  })
  assert.equal(sessionStart.status, 200)
  await waitForSessionExit(ctx, sessionStart.payload.sessionId)

  const runsAfterSession = await waitForRuns(
    ctx,
    (runs) => runs.some((run) => run.type === 'session' && run.meta?.sessionId === sessionStart.payload.sessionId),
  )
  const sessionRun = runsAfterSession.find(
    (run) => run.type === 'session' && run.meta?.sessionId === sessionStart.payload.sessionId,
  )
  assert.ok(sessionRun)
  assert.equal(sessionRun.state, 'done')

  const diagnostics = await requestJson(ctx, '/api/runtime/runs/diagnostics?limit=50')
  assert.equal(diagnostics.status, 200)
  assert.equal(diagnostics.payload.ok, true)
  assert.equal(diagnostics.payload.totalRuns >= 2, true)
  assert.equal(diagnostics.payload.byType.exec.total >= 1, true)
  assert.equal(diagnostics.payload.byType.session.total >= 1, true)

  const legacyList = await requestJson(ctx, '/api/local-runtime/runs?limit=20')
  assert.equal(legacyList.status, 200)
  assert.equal(Array.isArray(legacyList.payload.runs), true)
})
