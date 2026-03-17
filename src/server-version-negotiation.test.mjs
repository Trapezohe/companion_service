import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'

import { createCompanionServer } from './server.mjs'
import { cleanupAllSessions } from './runtime.mjs'
import { clearRunStoreForTests, createRun, loadRunStore } from './run-store.mjs'
import { clearApprovalStoreForTests } from './approval-store.mjs'
import { clearCronStoreForTests } from './cron-store.mjs'
import { clearBrowserLedgerForTests } from './browser-ledger.mjs'
import { clearMemoryShadowStoreForTests } from './memory-shadow-store.mjs'
import { clearMemoryShadowRefreshStateForTests } from './memory-shadow-publisher.mjs'

const previousConfigDir = process.env.TRAPEZOHE_CONFIG_DIR
const testConfigDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-server-version-negotiation-'))
process.env.TRAPEZOHE_CONFIG_DIR = testConfigDir

after(async () => {
  await clearRunStoreForTests().catch(() => undefined)
  await clearApprovalStoreForTests().catch(() => undefined)
  await clearCronStoreForTests().catch(() => undefined)
  await clearBrowserLedgerForTests().catch(() => undefined)
  await clearMemoryShadowStoreForTests().catch(() => undefined)
  await clearMemoryShadowRefreshStateForTests().catch(() => undefined)
  cleanupAllSessions()
  if (previousConfigDir === undefined) delete process.env.TRAPEZOHE_CONFIG_DIR
  else process.env.TRAPEZOHE_CONFIG_DIR = previousConfigDir
  await rm(testConfigDir, { recursive: true, force: true }).catch(() => undefined)
})

function createMcpManagerStub() {
  return {
    getConnectedCount: () => 0,
    getAllTools: () => [],
    getServers: () => [],
    callTool: async () => ({ ok: true }),
    restartServer: async () => {},
  }
}

async function startTestServer() {
  await clearRunStoreForTests()
  await clearApprovalStoreForTests()
  await clearCronStoreForTests()
  await clearBrowserLedgerForTests()
  await clearMemoryShadowStoreForTests()
  await clearMemoryShadowRefreshStateForTests()

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

async function requestJson(ctx, endpoint) {
  const response = await fetch(`${ctx.baseUrl}${endpoint}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${ctx.token}`,
    },
  })
  return {
    status: response.status,
    payload: await response.json(),
  }
}

test('version negotiation exposes v2 contract support while preserving legacy run rows', async (t) => {
  const ctx = await startTestServer()
  t.after(async () => {
    await stopTestServer(ctx.server)
    cleanupAllSessions()
  })

  await writeFile(
    path.join(testConfigDir, 'runs.json'),
    JSON.stringify({
      runs: [
        {
          runId: 'run-legacy',
          type: 'session',
          state: 'running',
          createdAt: 1_710_000_000_000,
          updatedAt: 1_710_000_000_100,
          meta: {
            sessionId: 'session-legacy',
            command: 'node server.js',
          },
        },
      ],
      sessionLinks: {},
      actionLinks: {},
    }, null, 2) + '\n',
    'utf8',
  )
  await loadRunStore()

  await createRun({
    runId: 'run-v2',
    type: 'exec',
    state: 'done',
    createdAt: 1_710_000_000_200,
    updatedAt: 1_710_000_000_300,
    sessionId: 'session-v2',
    attemptId: 'run-v2:attempt-1',
    laneId: 'remote:exec',
    source: 'remote',
    contractVersion: 2,
  })

  const health = await requestJson(ctx, '/healthz')
  const capabilities = await requestJson(ctx, '/api/system/capabilities')
  const listed = await requestJson(ctx, '/api/runtime/runs?limit=10&offset=0')

  assert.equal(health.status, 200)
  assert.equal(capabilities.status, 200)
  assert.equal(listed.status, 200)
  assert.equal(health.payload.runContractVersion, 2)
  assert.equal(capabilities.payload.runContractVersion, 2)
  assert.equal(capabilities.payload.protocolVersion, health.payload.protocolVersion)

  const legacy = listed.payload.runs.find((run) => run.runId === 'run-legacy')
  const modern = listed.payload.runs.find((run) => run.runId === 'run-v2')

  assert.ok(legacy)
  assert.ok(modern)
  assert.equal(legacy.contractVersion, 1)
  assert.equal(legacy.sessionId, 'session-legacy')
  assert.equal(legacy.attemptId, undefined)
  assert.equal(legacy.laneId, undefined)
  assert.equal(modern.contractVersion, 2)
  assert.equal(modern.sessionId, 'session-v2')
  assert.equal(modern.attemptId, 'run-v2:attempt-1')
  assert.equal(modern.laneId, 'remote:exec')
})
