import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'

import { createCompanionServer } from './server.mjs'
import { clearRunStoreForTests, createRun, loadRunStore } from './run-store.mjs'
import { clearCronStoreForTests } from './cron-store.mjs'
import { clearApprovalStoreForTests } from './approval-store.mjs'
import { clearBrowserLedgerForTests } from './browser-ledger.mjs'
import { clearMemoryShadowStoreForTests } from './memory-shadow-store.mjs'
import { clearMemoryShadowRefreshStateForTests } from './memory-shadow-publisher.mjs'
import { clearCheckpointJobStoreForTests } from './checkpoint-job-runner.mjs'

const previousConfigDir = process.env.TRAPEZOHE_CONFIG_DIR
const testConfigDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-workflow-status-test-'))
process.env.TRAPEZOHE_CONFIG_DIR = testConfigDir

after(async () => {
  await clearRunStoreForTests().catch(() => undefined)
  await clearApprovalStoreForTests().catch(() => undefined)
  await clearCronStoreForTests().catch(() => undefined)
  await clearMemoryShadowStoreForTests().catch(() => undefined)
  await clearMemoryShadowRefreshStateForTests().catch(() => undefined)
  await clearCheckpointJobStoreForTests().catch(() => undefined)
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

async function startServer() {
  const token = 'test-token'
  const server = createCompanionServer({
    token,
    mcpManager: createMcpManagerStub(),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  await fetch(`${baseUrl}/healthz`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  })
  return {
    token,
    server,
    baseUrl,
  }
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

async function fetchStatus(ctx, params = '') {
  return fetch(`${ctx.baseUrl}/api/workflow/status${params}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  })
}

test('GET /api/workflow/status returns 401 without auth', async () => {
  const ctx = await startServer()
  try {
    const res = await fetch(`${ctx.baseUrl}/api/workflow/status?runId=abc`, {
      method: 'GET',
      headers: { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    })
    assert.equal(res.status, 401)
  } finally {
    await stopServer(ctx.server)
  }
})

test('GET /api/workflow/status returns 400 when runId is missing', async () => {
  const ctx = await startServer()
  try {
    const res = await fetchStatus(ctx)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /runId/)
  } finally {
    await stopServer(ctx.server)
  }
})

test('GET /api/workflow/status returns 404 for unknown runId', async () => {
  const ctx = await startServer()
  try {
    await loadRunStore()
    const res = await fetchStatus(ctx, '?runId=nonexistent')
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.match(body.error, /not found/i)
  } finally {
    await stopServer(ctx.server)
  }
})

test('GET /api/workflow/status returns run with workflow: null when no automationSpec', async () => {
  const ctx = await startServer()
  try {
    await loadRunStore()
    const run = await createRun({ runId: 'wf-test-1', state: 'running' })
    const res = await fetchStatus(ctx, `?runId=${run.runId}`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.runId, run.runId)
    assert.equal(body.state, 'running')
    assert.equal(body.workflow, null)
    assert.ok(body.updatedAt)
  } finally {
    await stopServer(ctx.server)
  }
})
