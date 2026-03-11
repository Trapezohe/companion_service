import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

async function withTempHome(run) {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'trapezohe-companion-test-'))
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome

  try {
    const cacheBust = `${Date.now()}-${Math.random()}`
    const mod = await import(`./config.mjs?bust=${cacheBust}`)
    await run({ tempHome, mod })
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevUserProfile
    await rm(tempHome, { recursive: true, force: true })
  }
}

async function importDiagnosticsModule() {
  const cacheBust = `${Date.now()}-${Math.random()}`
  return import(`./diagnostics.mjs?bust=${cacheBust}`)
}

async function runCli(tempHome, args) {
  return execFileAsync(
    process.execPath,
    [
      path.resolve(process.cwd(), 'bin/cli.mjs'),
      ...args,
    ],
    {
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
    },
  )
}

test('initConfig creates config and token', async () => {
  await withTempHome(async ({ mod }) => {
    const result = await mod.initConfig()
    assert.equal(result.created, true)
    assert.ok(result.token)

    const loaded = await mod.loadConfig()
    assert.equal(loaded.port, 41591)
    assert.equal(loaded.token, result.token)
    assert.deepEqual(loaded.mcpServers, {})
    assert.equal(loaded.permissionPolicy.mode, 'full')
    assert.deepEqual(loaded.permissionPolicy.workspaceRoots, [])
  })
})

test('writePid supports explicit PID values', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.writePid(43210)
    const pid = await mod.readPid()
    assert.equal(pid, 43210)
  })
})

test('config directory and files are private by default on unix-like platforms', { skip: process.platform === 'win32' }, async () => {
  await withTempHome(async ({ mod }) => {
    await mod.initConfig()
    await mod.writePid(12345)

    const dirMode = (await stat(mod.getConfigDir())).mode & 0o777
    const configMode = (await stat(mod.getConfigPath())).mode & 0o777
    const pidMode = (await stat(mod.getPidPath())).mode & 0o777

    assert.equal(dirMode, 0o700)
    assert.equal(configMode, 0o600)
    assert.equal(pidMode, 0o600)

    const pidRaw = await readFile(mod.getPidPath(), 'utf8')
    assert.equal(pidRaw.trim(), '12345')
  })
})

test('updateMcpServerConfig rewrites legacy bnbchain package name to canonical package', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.initConfig()
    await mod.updateMcpServerConfig('bnbchain-mcp', {
      command: 'npx',
      args: ['-y', '@bnb-chain/bnbchain-mcp'],
    })

    const loaded = await mod.loadConfig()
    const server = loaded.mcpServers['bnbchain-mcp']
    assert.ok(server)
    assert.deepEqual(server.args, ['-y', '@bnb-chain/mcp@latest'])
  })
})

test('repairConfigDefaults restores token while preserving MCP servers and extension ids', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.saveConfig({
      port: 41591,
      token: '',
      mcpServers: {
        'bnbchain-mcp': {
          command: 'npx',
          args: ['-y', '@bnb-chain/mcp@latest'],
        },
      },
      permissionPolicy: { mode: 'workspace', workspaceRoots: ['/tmp/ws'] },
      extensionIds: ['ext-1'],
    })

    const repaired = await mod.repairConfigDefaults()
    expectLikeToken(repaired.token)
    assert.equal(repaired.generatedToken, true)
    assert.equal(repaired.mcpServerCount, 1)
    assert.deepEqual(repaired.extensionIds, ['ext-1'])

    const loaded = await mod.loadConfig()
    expectLikeToken(loaded.token)
    assert.ok(loaded.mcpServers['bnbchain-mcp'])
    assert.deepEqual(loaded.extensionIds, ['ext-1'])
    assert.equal(loaded.permissionPolicy.mode, 'workspace')
  })
})

test('updateMcpServerConfig preserves restartable flag for MCP lifecycle policy', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.initConfig()
    await mod.updateMcpServerConfig('bnbchain-mcp', {
      command: 'npx',
      args: ['-y', '@bnb-chain/mcp@latest'],
      restartable: false,
    })

    const loaded = await mod.loadConfig()
    assert.equal(loaded.mcpServers['bnbchain-mcp']?.restartable, false)
  })
})

test('updateMcpServerConfig preserves requestTimeoutMs override for MCP servers', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.initConfig()
    await mod.updateMcpServerConfig('slow-mcp', {
      command: 'npx',
      args: ['-y', '@bnb-chain/mcp@latest'],
      requestTimeoutMs: 45_000,
    })

    const loaded = await mod.loadConfig()
    assert.equal(loaded.mcpServers['slow-mcp']?.requestTimeoutMs, 45_000)
  })
})

test('updateMcpServerConfig clears requestTimeoutMs override when the field is blank', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.initConfig()
    await mod.updateMcpServerConfig('slow-mcp', {
      command: 'npx',
      args: ['-y', '@bnb-chain/mcp@latest'],
      requestTimeoutMs: 45_000,
    })

    await mod.updateMcpServerConfig('slow-mcp', {
      command: 'npx',
      args: ['-y', '@bnb-chain/mcp@latest'],
      requestTimeoutMs: '',
    })

    const loaded = await mod.loadConfig()
    assert.equal(loaded.mcpServers['slow-mcp']?.requestTimeoutMs, undefined)
  })
})

test('self-check stays unhealthy when extension IDs are configured but native host registration is missing', async () => {
  await withTempHome(async ({ mod }) => {
    await mod.saveConfig({
      port: 41591,
      token: 'test-token',
      mcpServers: {},
      permissionPolicy: { mode: 'full', workspaceRoots: [] },
      extensionIds: ['ext-1'],
    })

    const diagnostics = await importDiagnosticsModule()
    const payload = await diagnostics.runCompanionSelfCheck({
      getPermissionPolicy: () => ({ mode: 'full', workspaceRoots: [] }),
    })

    assert.equal(payload.ok, false)
    assert.equal(payload.checks.nativeHostRegistration.ok, false)
    assert.equal(payload.checks.nativeHostRegistration.required, true)
    assert.ok(payload.repairActions.some((action) => action.id === 'register_native_host'))
  })
})

test('CLI native-host repair and self-check inspect the same manifest targets', async () => {
  await withTempHome(async ({ tempHome, mod }) => {
    await mod.initConfig()

    const registered = await runCli(tempHome, [
      'repair',
      'register_native_host',
      '--json',
      '--ext-id',
      'ext-1',
    ])
    const repairPayload = JSON.parse(String(registered.stdout || '{}'))
    const diagnostics = await importDiagnosticsModule()
    const selfCheck = await diagnostics.runCompanionSelfCheck({
      getPermissionPolicy: () => ({ mode: 'full', workspaceRoots: [] }),
    })

    const expectedManifestPaths = [...(repairPayload.result?.manifestPaths || [])].sort()
    const actualManifestPaths = [...(selfCheck.checks.nativeHostRegistration.manifests || [])].sort()

    assert.deepEqual(actualManifestPaths, expectedManifestPaths)
  })
})

test('CLI native-host repair uses the fixed extension ID when no extension ID is provided', async () => {
  await withTempHome(async ({ tempHome, mod }) => {
    await mod.initConfig()

    const registered = await runCli(tempHome, ['repair', 'register_native_host', '--json'])
    const payload = JSON.parse(String(registered.stdout || '{}'))

    assert.deepEqual(payload.result?.extensionIds, ['nnhdkkgpoeojjddikcjadgpkbfbjhcal'])
    assert.deepEqual(payload.result?.allowedOrigins, ['chrome-extension://nnhdkkgpoeojjddikcjadgpkbfbjhcal/'])
  })
})

function expectLikeToken(value) {
  assert.equal(typeof value, 'string')
  assert.ok(value.length >= 32)
}
