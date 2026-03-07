import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path, { delimiter as PATH_DELIMITER } from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'

import { buildMcpSpawnPath, McpManager } from './mcp-manager.mjs'

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for condition.')
}

async function createLifecycleTestServer(tempDir) {
  const scriptPath = path.join(tempDir, 'fake-mcp-server.mjs')
  const startCountPath = path.join(tempDir, 'start-count.txt')
  const source = `
import { readFileSync, writeFileSync } from 'node:fs'

const countPath = process.argv[2]
let count = 0
try {
  count = Number(readFileSync(countPath, 'utf8').trim()) || 0
} catch {}
count += 1
writeFileSync(countPath, String(count))

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newlineIndex = buffer.indexOf('\\n')
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    if (line) handle(JSON.parse(line))
    newlineIndex = buffer.indexOf('\\n')
  }
})

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

function handle(message) {
  if (message.method === 'initialize') {
    respond(message.id, { capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } })
    return
  }

  if (message.method === 'tools/list') {
    respond(message.id, { tools: [] })
    if (count === 1) {
      setTimeout(() => process.exit(0), 20)
    }
    return
  }
}
`

  await writeFile(scriptPath, source, 'utf8')
  return { scriptPath, startCountPath }
}

async function createDelayedInitServer(tempDir, delayMs) {
  const scriptPath = path.join(tempDir, 'slow-init-mcp-server.mjs')
  const source = `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newlineIndex = buffer.indexOf('\\n')
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    if (line) handle(JSON.parse(line))
    newlineIndex = buffer.indexOf('\\n')
  }
})

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

function handle(message) {
  if (message.method === 'initialize') {
    setTimeout(() => {
      respond(message.id, { capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1.0.0' } })
    }, ${Math.max(1, delayMs)})
    return
  }

  if (message.method === 'tools/list') {
    respond(message.id, { tools: [] })
  }
}
`

  await writeFile(scriptPath, source, 'utf8')
  return { scriptPath }
}

test('buildMcpSpawnPath appends common executable directories and nvm bins', async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-mcp-path-'))
  try {
    const nvmNodeRoot = path.join(tempHome, '.nvm', 'versions', 'node')
    const olderNodeBin = path.join(nvmNodeRoot, 'v20.11.0', 'bin')
    const newerNodeBin = path.join(nvmNodeRoot, 'v22.12.0', 'bin')
    await mkdir(olderNodeBin, { recursive: true })
    await mkdir(newerNodeBin, { recursive: true })

    const built = buildMcpSpawnPath('/usr/bin:/bin', {
      homeDir: tempHome,
      execDir: '/custom/node/bin',
    })

    const parts = built.split(PATH_DELIMITER)
    assert.equal(parts[0], '/usr/bin')
    assert.equal(parts[1], '/bin')
    assert.ok(parts.includes('/custom/node/bin'))
    assert.ok(parts.includes(newerNodeBin))
    assert.ok(parts.includes(olderNodeBin))
    assert.ok(parts.includes('/usr/local/bin'))
    assert.ok(parts.includes('/opt/homebrew/bin'))
    assert.equal(new Set(parts).size, parts.length)
  } finally {
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('callTool resolves "name" to configured "name-mcp" server alias', async () => {
  const manager = new McpManager({
    'bnbchain-mcp': {
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 2000)'],
    },
  })

  const result = await manager.callTool('bnbchain', 'get_latest_block', {})
  assert.equal(result.ok, false)
  assert.match(result.error || '', /not connected/)
  assert.doesNotMatch(result.error || '', /Unknown MCP server/i)
})

test('callTool unknown-server error includes available server hints', async () => {
  const manager = new McpManager({
    'bnbchain-mcp': {
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 2000)'],
    },
  })

  const result = await manager.callTool('does-not-exist', 'get_latest_block', {})
  assert.equal(result.ok, false)
  assert.match(result.error || '', /Unknown MCP server/)
  assert.match(result.error || '', /Available servers: bnbchain-mcp/)
})

test('startServer surfaces spawn failures and marks server status as error', async () => {
  const manager = new McpManager({
    broken: {
      command: 'definitely-not-a-real-binary-trapezohe',
      args: [],
    },
  })

  await assert.rejects(
    () => manager.startServer('broken'),
    /ENOENT|not found|spawn/i,
  )

  const status = manager.getServers().find((item) => item.name === 'broken')
  assert.ok(status)
  assert.equal(status.status, 'error')
  assert.match(status.error || '', /ENOENT|not found|spawn/i)
})

test('stopServer clears stale disconnected/error state', async () => {
  const manager = new McpManager({
    broken: {
      command: 'definitely-not-a-real-binary-trapezohe',
      args: [],
    },
  })

  await assert.rejects(() => manager.startServer('broken'))
  await manager.stopServer('broken')

  const status = manager.getServers().find((item) => item.name === 'broken')
  assert.ok(status)
  assert.equal(status.status, 'stopped')
  assert.equal(status.error, null)
  assert.equal(status.toolCount, 0)
})

test('startServer applies restart backoff after repeated failures', async () => {
  const manager = new McpManager({
    broken: {
      command: 'definitely-not-a-real-binary-trapezohe',
      args: [],
    },
  })

  await assert.rejects(() => manager.startServer('broken'))
  await assert.rejects(
    () => manager.startServer('broken'),
    /backoff|retry/i,
  )

  const status = manager.getServers().find((item) => item.name === 'broken')
  assert.ok(status)
  assert.equal(typeof status.failureCount, 'number')
  assert.equal(status.failureCount >= 1, true)
  assert.equal(typeof status.nextRetryAt, 'number')
})

test('upsertServer initializes lifecycle counters and write-capable flag for new servers', async () => {
  const manager = new McpManager({})

  await manager.upsertServer('writer', {
    command: 'node',
    args: ['-e', 'setTimeout(() => {}, 1000)'],
    writeCapable: true,
  }, { start: false })

  const status = manager.getServers().find((item) => item.name === 'writer')
  assert.ok(status)
  assert.equal(status.failureCount, 0)
  assert.equal(status.lastFailureAt, null)
  assert.equal(status.nextRetryAt, null)
  assert.equal(status.writeCapable, true)
})

test('startServer respects configured connected-server concurrency limit', async () => {
  const prevLimit = process.env.TRAPEZOHE_MCP_MAX_CONNECTED
  process.env.TRAPEZOHE_MCP_MAX_CONNECTED = '0'

  try {
    const cacheBust = `${Date.now()}-${Math.random()}`
    const { McpManager: LimitedMcpManager } = await import(`./mcp-manager.mjs?bust=${cacheBust}`)
    const manager = new LimitedMcpManager({
      blocked: {
        command: 'node',
        args: ['-e', 'setTimeout(() => {}, 1000)'],
      },
    })

    await assert.rejects(
      () => manager.startServer('blocked'),
      /connected server limit/i,
    )
  } finally {
    if (prevLimit === undefined) delete process.env.TRAPEZOHE_MCP_MAX_CONNECTED
    else process.env.TRAPEZOHE_MCP_MAX_CONNECTED = prevLimit
  }
})

test('startServer uses env default timeout unless a per-server override is configured', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-mcp-timeout-'))
  const previousTimeout = process.env.TRAPEZOHE_MCP_REQUEST_TIMEOUT_MS
  process.env.TRAPEZOHE_MCP_REQUEST_TIMEOUT_MS = '30'

  try {
    const { scriptPath } = await createDelayedInitServer(tempDir, 120)

    const timedOutManager = new McpManager({
      slow: {
        command: process.execPath,
        args: [scriptPath],
      },
    })

    await assert.rejects(
      () => timedOutManager.startServer('slow'),
      /timed out after 30ms: initialize/i,
    )

    const timedOutStatus = timedOutManager.getServers().find((item) => item.name === 'slow')
    assert.ok(timedOutStatus)
    assert.equal(timedOutStatus.status, 'error')
    assert.equal(timedOutStatus.requestTimeoutMs, 30)

    const manager = new McpManager({
      slow: {
        command: process.execPath,
        args: [scriptPath],
        requestTimeoutMs: 300,
      },
    })

    await manager.startServer('slow')

    const status = manager.getServers().find((item) => item.name === 'slow')
    assert.ok(status)
    assert.equal(status.status, 'connected')
    assert.equal(status.requestTimeoutMs, 300)

    await manager.stopServer('slow')
  } finally {
    if (previousTimeout === undefined) delete process.env.TRAPEZOHE_MCP_REQUEST_TIMEOUT_MS
    else process.env.TRAPEZOHE_MCP_REQUEST_TIMEOUT_MS = previousTimeout
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('disconnected servers schedule bounded restart metadata and reconnect by default', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-mcp-restart-'))
  const prevBase = process.env.TRAPEZOHE_MCP_RESTART_BASE_BACKOFF_MS
  const prevMax = process.env.TRAPEZOHE_MCP_RESTART_MAX_BACKOFF_MS
  process.env.TRAPEZOHE_MCP_RESTART_BASE_BACKOFF_MS = '40'
  process.env.TRAPEZOHE_MCP_RESTART_MAX_BACKOFF_MS = '40'

  try {
    const { scriptPath, startCountPath } = await createLifecycleTestServer(tempDir)
    const cacheBust = `${Date.now()}-${Math.random()}`
    const { McpManager: RestartingMcpManager } = await import(`./mcp-manager.mjs?bust=${cacheBust}`)
    const manager = new RestartingMcpManager({
      flappy: {
        command: process.execPath,
        args: [scriptPath, startCountPath],
      },
    })

    await manager.startServer('flappy')

    const disconnected = await waitFor(() => {
      const status = manager.getServers().find((item) => item.name === 'flappy')
      if (status?.status === 'disconnected') return status
      return null
    })
    assert.equal(disconnected.restartable, true)
    assert.equal(disconnected.restartPending, true)
    assert.equal(typeof disconnected.nextRetryAt, 'number')
    assert.equal(disconnected.nextRetryAt > Date.now(), true)

    const reconnected = await waitFor(() => {
      const status = manager.getServers().find((item) => item.name === 'flappy')
      if (status?.status === 'connected') return status
      return null
    })
    assert.equal(reconnected.restartPending, false)

    const startCount = Number(await readFile(startCountPath, 'utf8'))
    assert.equal(startCount >= 2, true)

    await manager.stopAll()
  } finally {
    if (prevBase === undefined) delete process.env.TRAPEZOHE_MCP_RESTART_BASE_BACKOFF_MS
    else process.env.TRAPEZOHE_MCP_RESTART_BASE_BACKOFF_MS = prevBase
    if (prevMax === undefined) delete process.env.TRAPEZOHE_MCP_RESTART_MAX_BACKOFF_MS
    else process.env.TRAPEZOHE_MCP_RESTART_MAX_BACKOFF_MS = prevMax
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('servers marked restartable false do not auto-restart after disconnect', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-mcp-no-restart-'))
  const prevBase = process.env.TRAPEZOHE_MCP_RESTART_BASE_BACKOFF_MS
  const prevMax = process.env.TRAPEZOHE_MCP_RESTART_MAX_BACKOFF_MS
  process.env.TRAPEZOHE_MCP_RESTART_BASE_BACKOFF_MS = '40'
  process.env.TRAPEZOHE_MCP_RESTART_MAX_BACKOFF_MS = '40'

  try {
    const { scriptPath, startCountPath } = await createLifecycleTestServer(tempDir)
    const cacheBust = `${Date.now()}-${Math.random()}`
    const { McpManager: RestartingMcpManager } = await import(`./mcp-manager.mjs?bust=${cacheBust}`)
    const manager = new RestartingMcpManager({
      flappy: {
        command: process.execPath,
        args: [scriptPath, startCountPath],
        restartable: false,
      },
    })

    await manager.startServer('flappy')

    const disconnected = await waitFor(() => {
      const status = manager.getServers().find((item) => item.name === 'flappy')
      if (status?.status === 'disconnected') return status
      return null
    })
    assert.equal(disconnected.restartable, false)
    assert.equal(disconnected.restartPending, false)
    assert.equal(disconnected.nextRetryAt, null)

    await new Promise((resolve) => setTimeout(resolve, 120))

    const latest = manager.getServers().find((item) => item.name === 'flappy')
    assert.equal(latest?.status, 'disconnected')
    const startCount = Number(await readFile(startCountPath, 'utf8'))
    assert.equal(startCount, 1)

    await manager.stopAll()
  } finally {
    if (prevBase === undefined) delete process.env.TRAPEZOHE_MCP_RESTART_BASE_BACKOFF_MS
    else process.env.TRAPEZOHE_MCP_RESTART_BASE_BACKOFF_MS = prevBase
    if (prevMax === undefined) delete process.env.TRAPEZOHE_MCP_RESTART_MAX_BACKOFF_MS
    else process.env.TRAPEZOHE_MCP_RESTART_MAX_BACKOFF_MS = prevMax
    await rm(tempDir, { recursive: true, force: true })
  }
})
