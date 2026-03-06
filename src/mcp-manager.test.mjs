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
