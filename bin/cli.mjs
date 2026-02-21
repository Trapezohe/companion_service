#!/usr/bin/env node

/**
 * Trapezohe Companion CLI
 *
 * Usage:
 *   trapezohe-companion start [-d]   Start the companion daemon
 *   trapezohe-companion stop         Stop the daemon
 *   trapezohe-companion status       Show daemon status
 *   trapezohe-companion init         Create default config
 *   trapezohe-companion config       Print config file path
 *   trapezohe-companion token        Show current access token
 */

import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  loadConfig,
  initConfig,
  resolveToken,
  getConfigPath,
  writePid,
  readPid,
  removePid,
} from '../src/config.mjs'
import { createCompanionServer } from '../src/server.mjs'
import { McpManager } from '../src/mcp-manager.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const command = process.argv[2]
const flags = process.argv.slice(3)

async function main() {
  switch (command) {
    case 'start':
      return handleStart()
    case 'stop':
      return handleStop()
    case 'status':
      return handleStatus()
    case 'init':
      return handleInit()
    case 'config':
      return handleConfig()
    case 'token':
      return handleToken()
    default:
      printHelp()
      process.exit(command === '--help' || command === '-h' ? 0 : 1)
  }
}

async function handleStart() {
  const daemon = flags.includes('-d') || flags.includes('--daemon')

  if (daemon) {
    // Fork self as background process
    const child = fork(__filename, ['start'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    console.log(`[trapezohe-companion] Daemon started (PID: ${child.pid})`)
    process.exit(0)
    return
  }

  const config = await loadConfig()
  const token = resolveToken(config)

  // Save token back if it was auto-generated
  if (!config.token && token) {
    const { saveConfig } = await import('../src/config.mjs')
    await saveConfig({ ...config, token })
  }

  const mcpManager = new McpManager(config.mcpServers)
  const server = createCompanionServer({ token, mcpManager })

  // Write PID file
  await writePid()

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[trapezohe-companion] Shutting down...')
    await mcpManager.stopAll()
    server.close()
    await removePid()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  server.listen(config.port, '127.0.0.1', async () => {
    console.log('')
    console.log('  ╔══════════════════════════════════════════════╗')
    console.log('  ║        Trapezohe Companion v0.1.0            ║')
    console.log('  ╚══════════════════════════════════════════════╝')
    console.log('')
    console.log(`  Listening:  http://127.0.0.1:${config.port}`)
    console.log(`  Token:      ${token}`)
    console.log(`  Config:     ${getConfigPath()}`)
    console.log('')

    // Start MCP servers
    const serverCount = mcpManager.getServerCount()
    if (serverCount > 0) {
      console.log(`  Starting ${serverCount} MCP server(s)...`)
      await mcpManager.startAll()
      const connected = mcpManager.getConnectedCount()
      const tools = mcpManager.getAllTools()
      console.log(`  MCP:        ${connected}/${serverCount} connected, ${tools.length} tool(s)`)
      console.log('')

      // Print tool list
      if (tools.length > 0) {
        console.log('  Available MCP tools:')
        for (const tool of tools) {
          console.log(`    [${tool.server}] ${tool.name} — ${tool.description.slice(0, 60)}`)
        }
        console.log('')
      }
    } else {
      console.log('  MCP:        No servers configured')
      console.log('')
    }

    console.log('  Save the token in your Trapezohe extension:')
    console.log('    Settings → Local Command Runtime → Access Token')
    console.log('')
    console.log('  Press Ctrl+C to stop')
    console.log('')
  })
}

async function handleStop() {
  const pid = await readPid()
  if (!pid) {
    console.log('[trapezohe-companion] No running daemon found.')
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
    console.log(`[trapezohe-companion] Sent SIGTERM to PID ${pid}`)
    await removePid()
  } catch (err) {
    if (err.code === 'ESRCH') {
      console.log(`[trapezohe-companion] Process ${pid} not found (already stopped).`)
      await removePid()
    } else {
      console.error(`[trapezohe-companion] Failed to stop: ${err.message}`)
    }
  }
}

async function handleStatus() {
  const pid = await readPid()
  if (!pid) {
    console.log('[trapezohe-companion] Status: stopped')
    return
  }

  try {
    process.kill(pid, 0) // Signal 0 = check if process exists
    console.log(`[trapezohe-companion] Status: running (PID: ${pid})`)

    // Try to fetch health info
    const config = await loadConfig()
    const token = resolveToken(config)
    try {
      const res = await fetch(`http://127.0.0.1:${config.port}/healthz`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const data = await res.json()
        console.log(`  Port:       ${config.port}`)
        console.log(`  MCP:        ${data.mcpServers} server(s), ${data.mcpTools} tool(s)`)
      }
    } catch {
      console.log(`  Port:       ${config.port} (health check failed)`)
    }
  } catch {
    console.log(`[trapezohe-companion] Status: stopped (stale PID file: ${pid})`)
    await removePid()
  }
}

async function handleInit() {
  const result = await initConfig()
  if (result.created) {
    console.log('[trapezohe-companion] Config created:')
    console.log(`  Path:   ${result.path}`)
    console.log(`  Token:  ${result.token}`)
    console.log('')
    console.log('  Edit the config file to add MCP servers:')
    console.log(`    ${result.path}`)
  } else {
    console.log(`[trapezohe-companion] Config already exists: ${result.path}`)
  }
}

async function handleConfig() {
  console.log(getConfigPath())
}

async function handleToken() {
  const config = await loadConfig()
  if (config.token) {
    console.log(config.token)
  } else {
    console.log('[trapezohe-companion] No token configured. Run "trapezohe-companion init" first.')
  }
}

function printHelp() {
  console.log(`
Trapezohe Companion — Local MCP server host & command runtime

Usage:
  trapezohe-companion <command> [flags]

Commands:
  start [-d]    Start the companion service (-d for daemon mode)
  stop          Stop the daemon
  status        Show current status
  init          Create default config at ~/.trapezohe/companion.json
  config        Print config file path
  token         Print access token

Examples:
  trapezohe-companion init          # Create config
  trapezohe-companion start         # Start in foreground
  trapezohe-companion start -d      # Start as background daemon
  trapezohe-companion status        # Check if running

Config: ~/.trapezohe/companion.json
Docs:   https://github.com/trapezohe/companion
`)
}

main().catch((err) => {
  console.error('[trapezohe-companion] Fatal:', err.message)
  process.exit(1)
})
