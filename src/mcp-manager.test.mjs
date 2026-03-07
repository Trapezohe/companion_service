import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path, { delimiter as PATH_DELIMITER } from 'node:path'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'

import { buildMcpSpawnPath, McpManager } from './mcp-manager.mjs'

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
