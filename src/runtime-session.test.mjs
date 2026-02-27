import test from 'node:test'
import assert from 'node:assert/strict'

import {
  startCommandSession,
  getSessionById,
  listSessions,
  getSessionLog,
  writeToSession,
  sendKeysToSession,
  listSessionEvents,
  cleanupAllSessions,
} from './runtime.mjs'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForSessionExit(sessionId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const session = getSessionById(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    if (session.status === 'exited') return session
    await delay(25)
  }
  throw new Error(`Timed out waiting for session to exit: ${sessionId}`)
}

async function waitForStdoutContains(sessionId, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const session = getSessionById(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    if ((session.stdout || '').includes(expected)) return session
    await delay(25)
  }
  throw new Error(`Timed out waiting for session stdout to contain "${expected}": ${sessionId}`)
}

test('listSessions returns lightweight snapshots and supports status/offset/limit options', async (t) => {
  cleanupAllSessions()
  t.after(() => cleanupAllSessions())

  const exitedId = `runtime-test-exited-${Date.now()}`
  const runningId = `runtime-test-running-${Date.now()}`

  startCommandSession({
    id: exitedId,
    command: 'node -e "process.stdout.write(\'done\')"',
    cwd: process.cwd(),
    timeoutMs: 5_000,
  })
  await waitForSessionExit(exitedId)

  startCommandSession({
    id: runningId,
    command: 'node -e "setTimeout(() => process.stdout.write(\'hold\'), 1200)"',
    cwd: process.cwd(),
    timeoutMs: 5_000,
  })

  const runningOnly = listSessions({ status: 'running', offset: 0, limit: 10 })
  assert.ok(Array.isArray(runningOnly.sessions))
  assert.ok(runningOnly.sessions.length >= 1)
  assert.equal(runningOnly.sessions.every((item) => item.status === 'running'), true)

  const runningSession = runningOnly.sessions.find((item) => item.sessionId === runningId)
  assert.ok(runningSession)
  assert.equal('stdout' in runningSession, false)
  assert.equal('stderr' in runningSession, false)
  assert.equal(typeof runningSession.durationMs, 'number')

  const paged = listSessions({ offset: 0, limit: 1 })
  assert.equal(paged.sessions.length, 1)
  assert.equal(paged.limit, 1)
  assert.equal(paged.offset, 0)
})

test('getSessionLog returns paginated stdout/stderr slices and metadata', async (t) => {
  cleanupAllSessions()
  t.after(() => cleanupAllSessions())

  const sessionId = `runtime-test-logs-${Date.now()}`
  startCommandSession({
    id: sessionId,
    command: 'node -e "process.stdout.write(\'0123456789\');process.stderr.write(\'abcdefghij\')"',
    cwd: process.cwd(),
    timeoutMs: 5_000,
  })
  await waitForSessionExit(sessionId)

  const stdoutLog = getSessionLog(sessionId, { stream: 'stdout', offset: 2, limit: 4 })
  assert.ok(stdoutLog)
  assert.equal(stdoutLog.stream, 'stdout')
  assert.equal(stdoutLog.output, '2345')
  assert.equal(stdoutLog.total, 10)
  assert.equal(stdoutLog.nextOffset, 6)
  assert.equal(stdoutLog.hasMore, true)

  const bothLog = getSessionLog(sessionId, { stream: 'both', offset: 3, limit: 4 })
  assert.ok(bothLog)
  assert.equal(bothLog.stream, 'both')
  assert.equal(bothLog.stdout.output, '3456')
  assert.equal(bothLog.stderr.output, 'defg')
  assert.equal(bothLog.stdout.total, 10)
  assert.equal(bothLog.stderr.total, 10)
})

test('writeToSession writes stdin content and supports submit newline', async (t) => {
  cleanupAllSessions()
  t.after(() => cleanupAllSessions())

  const sessionId = `runtime-test-write-${Date.now()}`
  startCommandSession({
    id: sessionId,
    command: 'node -e "process.stdin.setEncoding(\'utf8\');process.stdin.on(\'data\',d=>{process.stdout.write(\'IN:\'+d);if(d.includes(\'quit\'))process.exit(0)})"',
    cwd: process.cwd(),
    timeoutMs: 10_000,
  })

  const wrote = writeToSession(sessionId, 'hello', true)
  assert.equal(wrote.ok, true)
  assert.equal(typeof wrote.written, 'number')
  await waitForStdoutContains(sessionId, 'IN:hello')

  writeToSession(sessionId, 'quit', true)
  const exited = await waitForSessionExit(sessionId)
  assert.equal(exited.status, 'exited')
})

test('sendKeysToSession ctrl-c exits running process', async (t) => {
  cleanupAllSessions()
  t.after(() => cleanupAllSessions())

  const sessionId = `runtime-test-keys-${Date.now()}`
  startCommandSession({
    id: sessionId,
    command: 'node -e "setInterval(() => {}, 1000)"',
    cwd: process.cwd(),
    timeoutMs: 20_000,
  })

  const sent = sendKeysToSession(sessionId, 'ctrl-c')
  assert.equal(sent.ok, true)

  const exited = await waitForSessionExit(sessionId)
  assert.equal(exited.status, 'exited')
})

test('listSessionEvents returns session_exited event with cursor', async (t) => {
  cleanupAllSessions()
  t.after(() => cleanupAllSessions())

  const cursorStart = listSessionEvents({ after: 0, limit: 10 })
  const baseline = cursorStart.nextCursor

  const sessionId = `runtime-test-events-${Date.now()}`
  startCommandSession({
    id: sessionId,
    command: 'node -e "setTimeout(() => process.exit(7), 80)"',
    cwd: process.cwd(),
    timeoutMs: 5_000,
  })
  await waitForSessionExit(sessionId)

  const events = listSessionEvents({ after: baseline, limit: 10 })
  assert.ok(Array.isArray(events.events))
  assert.ok(events.events.length >= 1)
  const match = events.events.find((event) => event.sessionId === sessionId)
  assert.ok(match)
  assert.equal(match.type, 'session_exited')
  assert.equal(typeof events.nextCursor, 'number')
})
