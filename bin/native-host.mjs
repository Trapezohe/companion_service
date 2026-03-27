#!/usr/bin/env node

/**
 * Chrome Native Messaging host for Trapezohe Companion.
 *
 * Chrome launches this script and communicates over stdin/stdout using
 * length-prefixed JSON messages (4-byte little-endian uint32 + UTF-8 JSON).
 *
 * Supported requests:
 *   { type: 'get_config' }  → returns { url, token, version }
 *   { type: 'ping' }        → returns { ok: true }
 *   { type: 'start' }       → starts companion daemon if not running, returns config
 */

import { promises as fs } from 'node:fs'
import { fork } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

function uniquePaths(paths) {
  return Array.from(new Set(paths.filter((value) => typeof value === 'string' && value.trim())))
}

// Inline version resolution — this file is copied to ~/.trapezohe/ at install
// time, so relative imports like '../src/version.mjs' will break. Support the
// repo layout, the deployed native-host bundle, and the installer service bundle.
const COMPANION_VERSION = (() => {
  const require = createRequire(import.meta.url)
  const packageCandidates = uniquePaths([
    path.join(SCRIPT_DIR, '..', 'package.json'),
    path.join(SCRIPT_DIR, 'package.json'),
    path.join(SCRIPT_DIR, 'service', 'package.json'),
    path.join(SCRIPT_DIR, '..', 'service', 'package.json'),
  ])

  try {
    for (const candidate of packageCandidates) {
      try {
        const pkg = require(candidate)
        if (typeof pkg?.version === 'string' && pkg.version.trim()) {
          return pkg.version.trim()
        }
      } catch {
        // Keep scanning candidate layouts.
      }
    }
  } catch {
    // Fall through to the synthetic default below.
  }

  return '0.0.0'
})()

const CONFIG_FILE = path.join(os.homedir(), '.trapezohe', 'companion.json')
const DEFAULT_PORT = 41591
const CLI_SCRIPT_CANDIDATES = uniquePaths([
  path.join(SCRIPT_DIR, 'cli.mjs'),
  path.join(SCRIPT_DIR, 'service', 'bin', 'cli.mjs'),
  path.join(SCRIPT_DIR, '..', 'service', 'bin', 'cli.mjs'),
])

// ── Native Messaging Protocol ──

function readMessage() {
  return new Promise((resolve, reject) => {
    // Read 4-byte length header
    const headerBuf = Buffer.alloc(4)
    let headerRead = 0

    const readHeader = () => {
      const chunk = process.stdin.read(4 - headerRead)
      if (!chunk) return
      chunk.copy(headerBuf, headerRead)
      headerRead += chunk.length
      if (headerRead < 4) return

      const msgLen = headerBuf.readUInt32LE(0)
      if (msgLen === 0 || msgLen > 1024 * 1024) {
        reject(new Error(`Invalid message length: ${msgLen}`))
        return
      }

      // Read message body
      let bodyRead = 0
      const bodyBuf = Buffer.alloc(msgLen)

      const readBody = () => {
        const bodyChunk = process.stdin.read(msgLen - bodyRead)
        if (!bodyChunk) return
        bodyChunk.copy(bodyBuf, bodyRead)
        bodyRead += bodyChunk.length
        if (bodyRead < msgLen) return

        process.stdin.removeListener('readable', readBody)
        try {
          resolve(JSON.parse(bodyBuf.toString('utf8')))
        } catch {
          reject(new Error('Invalid JSON message'))
        }
      }

      process.stdin.removeListener('readable', readHeader)
      process.stdin.on('readable', readBody)
      readBody()
    }

    process.stdin.on('readable', readHeader)
    readHeader()

    process.stdin.on('end', () => {
      resolve(null) // Chrome closed the connection
    })
  })
}

function sendMessage(obj) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(obj)
    const bodyBuf = Buffer.from(json, 'utf8')
    const headerBuf = Buffer.alloc(4)
    headerBuf.writeUInt32LE(bodyBuf.length, 0)
    const fullBuf = Buffer.concat([headerBuf, bodyBuf])
    process.stdout.write(fullBuf, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

// ── Config Reader ──

async function loadCompanionConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8')
    const config = JSON.parse(raw)
    return {
      url: `http://127.0.0.1:${Number(config.port) || DEFAULT_PORT}`,
      token: typeof config.token === 'string' ? config.token : '',
      version: COMPANION_VERSION,
    }
  } catch {
    return null
  }
}

// ── Health Check & Daemon Spawn ──

async function isCompanionRunning(config) {
  try {
    const res = await fetch(config.url + '/healthz', {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return false
    const data = await res.json()
    return data && data.ok
  } catch {
    return false
  }
}

async function resolveCompanionCliPath() {
  for (const candidate of CLI_SCRIPT_CANDIDATES) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Keep scanning candidate layouts.
    }
  }
  return ''
}

async function spawnCompanionDaemon() {
  const cliPath = await resolveCompanionCliPath()
  if (!cliPath) return false

  return new Promise((resolve) => {
    try {
      const child = fork(cliPath, ['start'], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      child.on('error', () => resolve(false))
      // Give it a moment to spawn
      setTimeout(() => resolve(true), 200)
    } catch {
      resolve(false)
    }
  })
}

async function waitForReady(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isCompanionRunning(config)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

// ── Request Handler ──

async function handleRequest(msg) {
  if (!msg || typeof msg !== 'object') {
    return { error: 'Invalid request' }
  }

  switch (msg.type) {
    case 'ping':
      return { ok: true, version: COMPANION_VERSION }

    case 'get_config': {
      const config = await loadCompanionConfig()
      if (!config) {
        return { error: 'Companion config not found. Run "trapezohe-companion init" first.' }
      }
      if (!config.token) {
        return { error: 'No token configured. Run "trapezohe-companion init" first.' }
      }
      return config
    }

    case 'start': {
      const config = await loadCompanionConfig()
      if (!config) {
        return { error: 'Companion config not found. Run "trapezohe-companion init" first.' }
      }
      if (!config.token) {
        return { error: 'No token configured. Run "trapezohe-companion init" first.' }
      }

      // Check if already running
      const running = await isCompanionRunning(config)
      if (running) {
        return { ...config, started: false, already_running: true }
      }

      // Spawn companion daemon
      const started = await spawnCompanionDaemon()
      if (!started) {
        return { ...config, started: false, error: 'Failed to start companion daemon' }
      }

      // Wait briefly for daemon to become ready
      const ready = await waitForReady(config, 3000)
      return { ...config, started: true, ready }
    }

    default:
      return { error: `Unknown request type: ${msg.type}` }
  }
}

// ── Main ──

async function main() {
  // Raw binary mode for stdin/stdout
  process.stdin.resume()

  const msg = await readMessage()
  if (msg === null) {
    process.exit(0)
  }

  const response = await handleRequest(msg)
  await sendMessage(response)

  // Ensure stdout is fully flushed before exiting.
  // process.stdout.write() on a pipe is async — exiting immediately can lose data.
  process.stdin.destroy()
  process.exit(0)
}

main().catch(async (err) => {
  try {
    await sendMessage({ error: err?.message || 'Native host internal error' })
  } catch {
    // ignore — stdout may already be broken
  }
  process.exit(1)
})
