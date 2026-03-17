import test from 'node:test'
import assert from 'node:assert/strict'

import { getAllowedOrigins } from './native-host.mjs'
import { createCompanionServer, buildCorsHeaders } from './server.mjs'

function createMcpManagerStub() {
  return {
    getConnectedCount: () => 0,
    getAllTools: () => [],
    getServers: () => [],
    callTool: async () => ({ ok: true }),
    restartServer: async () => {},
  }
}

async function startSecurityServer(options = {}) {
  const token = 'test-token'
  const server = createCompanionServer({
    token,
    mcpManager: createMcpManagerStub(),
    ...(typeof options.getAllowedOrigins === 'function'
      ? { getAllowedOrigins: options.getAllowedOrigins }
      : {}),
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start security test server.')
  }

  return {
    token,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

async function stopSecurityServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function requestHealthWithOrigin(ctx, origin) {
  return fetch(`${ctx.baseUrl}/healthz`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Origin: origin,
    },
  })
}

async function requestJson(ctx, pathname, origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  const response = await fetch(`${ctx.baseUrl}${pathname}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Origin: origin,
    },
  })
  return {
    response,
    payload: await response.json(),
  }
}

test('allowed extension origin receives echoed ACAO header', () => {
  const headers = buildCorsHeaders({
    origin: 'chrome-extension://abc123',
    allowedOrigins: getAllowedOrigins(['abc123']),
  })

  assert.equal(headers['Access-Control-Allow-Origin'], 'chrome-extension://abc123')
  assert.equal(headers.Vary, 'Origin')
  assert.equal(headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization')
  assert.equal(headers['Access-Control-Allow-Methods'], 'GET, POST, DELETE, OPTIONS')
})

test('untrusted browser origin does not receive wildcard CORS access', () => {
  const headers = buildCorsHeaders({
    origin: 'https://evil.example',
    allowedOrigins: getAllowedOrigins(['abc123']),
  })

  assert.equal(headers['Access-Control-Allow-Origin'], undefined)
  assert.equal(headers.Vary, undefined)
  assert.equal(headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization')
  assert.equal(headers['Access-Control-Allow-Methods'], 'GET, POST, DELETE, OPTIONS')
})

test('requests without Origin keep base CORS headers only', () => {
  const headers = buildCorsHeaders({
    origin: '',
    allowedOrigins: getAllowedOrigins(['abc123']),
  })

  assert.equal(headers['Access-Control-Allow-Origin'], undefined)
  assert.equal(headers.Vary, undefined)
  assert.equal(headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization')
  assert.equal(headers['Access-Control-Allow-Methods'], 'GET, POST, DELETE, OPTIONS')
})

test('manual fallback still allows extension origins before enrollment', async (t) => {
  const ctx = await startSecurityServer({
    getAllowedOrigins: async () => [],
  })
  t.after(async () => {
    await stopSecurityServer(ctx.server)
  })

  const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const response = await requestHealthWithOrigin(ctx, origin)

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  assert.equal(response.headers.get('vary'), 'Origin')
})

test('server re-reads trusted origins between requests', async (t) => {
  let allowedOrigins = getAllowedOrigins(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
  const ctx = await startSecurityServer({
    getAllowedOrigins: async () => allowedOrigins,
  })
  t.after(async () => {
    await stopSecurityServer(ctx.server)
  })

  const originA = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const originB = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  const initial = await requestHealthWithOrigin(ctx, originA)
  assert.equal(initial.status, 200)
  assert.equal(initial.headers.get('access-control-allow-origin'), originA)

  allowedOrigins = getAllowedOrigins(['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'])

  const stale = await requestHealthWithOrigin(ctx, originA)
  assert.equal(stale.status, 200)
  assert.equal(stale.headers.get('access-control-allow-origin'), null)

  const updated = await requestHealthWithOrigin(ctx, originB)
  assert.equal(updated.status, 200)
  assert.equal(updated.headers.get('access-control-allow-origin'), originB)
})

test('server falls back to the last known origin policy when origin lookup fails', async (t) => {
  const originA = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const originB = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  let failOriginLookup = false

  const ctx = await startSecurityServer({
    getAllowedOrigins: async () => {
      if (failOriginLookup) {
        throw new Error('config read failed')
      }
      return getAllowedOrigins(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
    },
  })
  t.after(async () => {
    await stopSecurityServer(ctx.server)
  })

  const initial = await requestHealthWithOrigin(ctx, originA)
  assert.equal(initial.status, 200)
  assert.equal(initial.headers.get('access-control-allow-origin'), originA)

  failOriginLookup = true

  const cached = await requestHealthWithOrigin(ctx, originA)
  assert.equal(cached.status, 200)
  assert.equal(cached.headers.get('access-control-allow-origin'), originA)

  const rejected = await requestHealthWithOrigin(ctx, originB)
  assert.equal(rejected.status, 200)
  assert.equal(rejected.headers.get('access-control-allow-origin'), null)
})

test('health and diagnostics expose contract and policy explanation metadata without weakening CORS', async (t) => {
  const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const ctx = await startSecurityServer({
    getAllowedOrigins: async () => getAllowedOrigins(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']),
  })
  t.after(async () => {
    await stopSecurityServer(ctx.server)
  })

  const health = await requestHealthWithOrigin(ctx, origin)
  const healthPayload = await health.json()
  assert.equal(health.status, 200)
  assert.equal(health.headers.get('access-control-allow-origin'), origin)
  assert.equal(healthPayload.runContractVersion, 2)
  assert.equal(healthPayload.permissionPolicy.policyReason, 'policy_mode:full')

  const diagnostics = await requestJson(ctx, '/api/system/diagnostics', origin)
  assert.equal(diagnostics.response.status, 200)
  assert.equal(diagnostics.response.headers.get('access-control-allow-origin'), origin)
  assert.equal(diagnostics.payload.contractVersion, 2)
  assert.equal(diagnostics.payload.permissionPolicy.policyReason, 'policy_mode:full')
})
