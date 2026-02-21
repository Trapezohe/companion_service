/**
 * MCP Server lifecycle manager.
 *
 * Spawns MCP server child processes, connects via stdio transport,
 * discovers tools, and routes tool calls to the appropriate server.
 */

import { spawn } from 'node:child_process'
import { StdioTransport } from './mcp-transport.mjs'

const MCP_PROTOCOL_VERSION = '2024-11-05'

const CLIENT_INFO = {
  name: 'trapezohe-companion',
  version: '0.1.0',
}

export class McpManager {
  #servers = new Map() // name → ServerEntry
  #startingLocks = new Set() // prevent concurrent startServer() for the same name

  constructor(serverConfigs) {
    this.#parseConfigs(serverConfigs)
  }

  #parseConfigs(configs) {
    if (!configs || typeof configs !== 'object') return

    for (const [name, config] of Object.entries(configs)) {
      if (!config.command) {
        console.warn(`[MCP] Skipping server "${name}": no command specified`)
        continue
      }
      this.#servers.set(name, {
        name,
        config,
        status: 'stopped',
        transport: null,
        tools: [],
        capabilities: null,
        error: null,
        startedAt: null,
      })
    }
  }

  async startAll() {
    const results = []
    for (const [name] of this.#servers) {
      results.push(
        this.startServer(name).catch((err) => {
          console.error(`[MCP] Failed to start "${name}":`, err.message)
          return { name, error: err.message }
        })
      )
    }
    return Promise.allSettled(results)
  }

  async stopAll() {
    for (const [name] of this.#servers) {
      await this.stopServer(name)
    }
  }

  async startServer(name) {
    const entry = this.#servers.get(name)
    if (!entry) throw new Error(`Unknown MCP server: ${name}`)

    // Prevent concurrent startServer() calls for the same server
    if (this.#startingLocks.has(name)) {
      throw new Error(`MCP server "${name}" is already starting`)
    }
    this.#startingLocks.add(name)

    try {
      // Stop if already running
      if (entry.transport && !entry.transport.closed) {
        await this.stopServer(name)
      }

      entry.status = 'starting'
      entry.error = null
      entry.tools = []

      const { command, args = [], env = {}, cwd } = entry.config
      const childEnv = { ...process.env, ...env }

      // Use a promise to detect early spawn failure
      const proc = spawn(command, args, {
        cwd: cwd || undefined,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      // Wait briefly for spawn errors (e.g. ENOENT) before proceeding
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          proc.removeListener('spawn', onSpawn)
          reject(err)
        }
        const onSpawn = () => {
          proc.removeListener('error', onError)
          resolve()
        }
        proc.once('error', onError)
        proc.once('spawn', onSpawn)
      })

      // Register close handler after confirmed spawn
      proc.on('close', (code) => {
        if (entry.status !== 'stopped') {
          entry.status = 'disconnected'
          entry.tools = [] // Clear tools when server disconnects
          entry.error = `Process exited with code ${code}`
          console.warn(`[MCP] "${name}" exited with code ${code}`)
        }
      })

      // Register late error handler (after spawn succeeded)
      proc.on('error', (err) => {
        if (entry.status !== 'stopped') {
          entry.status = 'error'
          entry.tools = []
          entry.error = `Process error: ${err.message}`
          console.error(`[MCP] "${name}" error:`, err.message)
        }
      })

      const transport = new StdioTransport(proc)
      entry.transport = transport
      entry.startedAt = Date.now()

      // Initialize MCP connection
      const initResult = await transport.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      })

      entry.capabilities = initResult.capabilities || {}

      // Send initialized notification
      try {
        proc.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {},
        }) + '\n')
      } catch { /* ignore */ }

      // Discover tools
      if (entry.capabilities.tools) {
        try {
          const toolsResult = await transport.request('tools/list', {})
          entry.tools = (toolsResult.tools || []).map((t) => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
          }))
        } catch (err) {
          console.warn(`[MCP] "${name}" tools/list failed:`, err.message)
        }
      }

      entry.status = 'connected'
      console.log(`[MCP] "${name}" connected — ${entry.tools.length} tool(s)`)
      return { name, tools: entry.tools.length }
    } catch (err) {
      entry.status = 'error'
      entry.error = err.message
      entry.tools = []
      // Cleanup transport if it was created
      if (entry.transport) {
        entry.transport.close()
        entry.transport = null
      }
      throw err
    } finally {
      this.#startingLocks.delete(name)
    }
  }

  async stopServer(name) {
    const entry = this.#servers.get(name)
    if (!entry) return

    if (entry.transport) {
      entry.transport.close()
      entry.transport = null
    }

    entry.status = 'stopped'
    entry.tools = []
    entry.error = null
    entry.startedAt = null
  }

  async restartServer(name) {
    await this.stopServer(name)
    return this.startServer(name)
  }

  getServers() {
    const result = []
    for (const [, entry] of this.#servers) {
      result.push({
        name: entry.name,
        status: entry.status,
        toolCount: entry.tools.length,
        error: entry.error,
        startedAt: entry.startedAt,
        command: entry.config.command,
        args: entry.config.args || [],
      })
    }
    return result
  }

  getAllTools() {
    const tools = []
    for (const [, entry] of this.#servers) {
      if (entry.status !== 'connected') continue
      for (const tool of entry.tools) {
        tools.push({
          server: entry.name,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })
      }
    }
    return tools
  }

  async callTool(serverName, toolName, args = {}) {
    const entry = this.#servers.get(serverName)
    if (!entry) {
      return { ok: false, error: `Unknown MCP server: ${serverName}` }
    }
    if (entry.status !== 'connected' || !entry.transport || entry.transport.closed) {
      return { ok: false, error: `MCP server "${serverName}" is not connected (status: ${entry.status})` }
    }

    // Verify tool exists
    const tool = entry.tools.find((t) => t.name === toolName)
    if (!tool) {
      return { ok: false, error: `Tool "${toolName}" not found on server "${serverName}"` }
    }

    try {
      const result = await entry.transport.request('tools/call', {
        name: toolName,
        arguments: args,
      })

      return {
        ok: !result.isError,
        content: result.content || [],
        isError: Boolean(result.isError),
      }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  getServerCount() {
    return this.#servers.size
  }

  getConnectedCount() {
    let count = 0
    for (const [, entry] of this.#servers) {
      if (entry.status === 'connected') count++
    }
    return count
  }
}
