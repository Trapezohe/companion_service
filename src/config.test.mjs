import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'

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
