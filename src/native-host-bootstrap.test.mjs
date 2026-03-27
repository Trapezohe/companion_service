import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  FIXED_EXTENSION_ID,
  getNativeHostManifestTargets,
  resolveBootstrapExtensionIds,
} from './native-host.mjs'

const execFileAsync = promisify(execFile)
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_DIR, '..')
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'cli.mjs')
const FIXED_ORIGIN = `chrome-extension://${FIXED_EXTENSION_ID}/`

async function withTempHome(run) {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'trapezohe-bootstrap-test-'))
  try {
    await run(tempHome)
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true })
  }
}

async function writeConfig(tempHome, extensionIds = []) {
  const configDir = path.join(tempHome, '.trapezohe')
  const configPath = path.join(configDir, 'companion.json')
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        port: 41591,
        token: 'test-token',
        mcpServers: {},
        permissionPolicy: { mode: 'full', workspaceRoots: [] },
        ...(extensionIds.length > 0 ? { extensionIds } : {}),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  return configPath
}

async function readConfig(tempHome) {
  const configPath = path.join(tempHome, '.trapezohe', 'companion.json')
  const raw = await fs.readFile(configPath, 'utf8')
  return JSON.parse(raw)
}

async function runBootstrap(tempHome, args = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      CLI_PATH,
      'bootstrap',
      '--json',
      '--no-autostart',
      '--no-start',
      ...args,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
    },
  )
  return JSON.parse(String(stdout))
}

async function readPackageVersion() {
  const raw = await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')
  return JSON.parse(raw).version
}

async function readManifestPayloads(tempHome) {
  const targets = getNativeHostManifestTargets({ homeDir: tempHome })
  const payloads = []
  for (const target of targets) {
    try {
      const raw = await fs.readFile(target.manifestPath, 'utf8')
      payloads.push({
        manifestPath: target.manifestPath,
        payload: JSON.parse(raw),
      })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  return payloads
}

async function seedManifestPayloads(tempHome, allowedOrigins) {
  const targets = getNativeHostManifestTargets({ homeDir: tempHome })
  for (const target of targets) {
    await fs.mkdir(path.dirname(target.manifestPath), { recursive: true })
    await fs.writeFile(
      target.manifestPath,
      JSON.stringify(
        {
          name: target.hostName,
          description: 'stale native host',
          path: '/tmp/native-host.mjs',
          type: 'stdio',
          allowed_origins: allowedOrigins,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  }
}

async function sendNativeHostRequest(scriptPath, tempHome, request) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const stdoutChunks = []
    const stderrChunks = []

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk))
    child.on('error', reject)

    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(payload.length, 0)
    child.stdin.end(Buffer.concat([header, payload]))

    child.on('close', (code) => {
      try {
        const stdout = Buffer.concat(stdoutChunks)
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
        if (stderr) {
          reject(new Error(`native-host stderr: ${stderr}`))
          return
        }
        if (stdout.length < 4) {
          reject(new Error(`native-host produced no length-prefixed payload (exit=${code})`))
          return
        }
        const bodyLength = stdout.readUInt32LE(0)
        const body = stdout.subarray(4, 4 + bodyLength).toString('utf8')
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function assertManifestOrigins(tempHome, manifests, expectedOrigins) {
  const expectedTargets = getNativeHostManifestTargets({ homeDir: tempHome })
  assert.equal(manifests.length, expectedTargets.length)
  for (const manifest of manifests) {
    assert.deepEqual(manifest.payload.allowed_origins, expectedOrigins)
  }
}

test('resolveBootstrapExtensionIds always resolves to the fixed production extension id', () => {
  const ids = resolveBootstrapExtensionIds({
    requestedExtensionIds: ['cli-extension-1', 'cli-extension-2'],
    configuredExtensionIds: ['configured-extension'],
  })

  assert.deepEqual(ids, [FIXED_EXTENSION_ID])
})

test('bootstrap registers the fixed extension id even when CLI ids and config ids disagree', async () => {
  await withTempHome(async (tempHome) => {
    await writeConfig(tempHome, ['configured-extension'])

    const output = await runBootstrap(tempHome, [
      '--ext-id',
      'cli-extension-1',
      '--ext-id',
      'cli-extension-2',
    ])

    assert.equal(output.nativeHostRegistered, true)
    assert.deepEqual(output.extensionIds, [FIXED_EXTENSION_ID])

    const savedConfig = await readConfig(tempHome)
    assert.equal(savedConfig.token, 'test-token')

    const manifests = await readManifestPayloads(tempHome)
    assertManifestOrigins(tempHome, manifests, [FIXED_ORIGIN])
  })
})

test('bootstrap registers the fixed extension id even when no extension ids exist', async () => {
  await withTempHome(async (tempHome) => {
    const output = await runBootstrap(tempHome)

    assert.equal(output.ok, true)
    assert.equal(output.nativeHostRegistered, true)
    assert.deepEqual(output.extensionIds, [FIXED_EXTENSION_ID])
    assert.deepEqual(output.nativeHost, {
      status: 'registered',
      reason: null,
      extensionIds: [FIXED_EXTENSION_ID],
    })
    assert.equal(output.daemon.message, 'skipped')

    const savedConfig = await readConfig(tempHome)
    assert.equal(savedConfig.token.length > 0, true)

    const manifests = await readManifestPayloads(tempHome)
    assertManifestOrigins(tempHome, manifests, [FIXED_ORIGIN])
  })
})

test('bootstrap replaces stale native-host manifests with the fixed extension origin', async () => {
  await withTempHome(async (tempHome) => {
    await seedManifestPayloads(tempHome, ['chrome-extension://stale-extension/'])

    const output = await runBootstrap(tempHome)

    assert.equal(output.nativeHostRegistered, true)
    assert.deepEqual(output.extensionIds, [FIXED_EXTENSION_ID])

    const manifests = await readManifestPayloads(tempHome)
    assertManifestOrigins(tempHome, manifests, [FIXED_ORIGIN])
  })
})

test('bootstrap deploys a runnable native-host bundle with the real package version', async () => {
  await withTempHome(async (tempHome) => {
    await runBootstrap(tempHome)

    const deployedHostScript = path.join(tempHome, '.trapezohe', 'bin', 'native-host.mjs')
    const deployedCliScript = path.join(tempHome, '.trapezohe', 'bin', 'cli.mjs')
    const deployedPackage = path.join(tempHome, '.trapezohe', 'package.json')
    const deployedVersionModule = path.join(tempHome, '.trapezohe', 'src', 'version.mjs')

    await fs.access(deployedHostScript)
    await fs.access(deployedCliScript)
    await fs.access(deployedPackage)
    await fs.access(deployedVersionModule)

    const expectedVersion = await readPackageVersion()
    const ping = await sendNativeHostRequest(deployedHostScript, tempHome, { type: 'ping' })
    const config = await sendNativeHostRequest(deployedHostScript, tempHome, { type: 'get_config' })

    assert.deepEqual(ping, { ok: true, version: expectedVersion })
    assert.equal(config.version, expectedVersion)
    assert.equal(config.url.startsWith('http://127.0.0.1:'), true)
    assert.equal(typeof config.token, 'string')
    assert.equal(config.token.length > 0, true)
  })
})
