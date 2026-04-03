/**
 * MCP Server lifecycle manager.
 *
 * Spawns MCP server child processes, connects via stdio transport,
 * discovers tools, and routes tool calls to the appropriate server.
 */

import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { formatMcpProcessExitMessage, StdioTransport } from './mcp-transport.mjs'
import { COMPANION_VERSION } from './version.mjs'
import { getDefaultMcpRequestTimeoutMs, normalizeMcpRequestTimeoutMs } from './config.mjs'
import { buildToolchainPath, shouldPreferManagedNodeToolchain } from './toolchain-path.mjs'

const MCP_PROTOCOL_VERSION = '2024-11-05'

const CLIENT_INFO = {
  name: 'trapezohe-companion',
  version: COMPANION_VERSION,
}
const MCP_RESTART_BASE_BACKOFF_MS = Number(process.env.TRAPEZOHE_MCP_RESTART_BASE_BACKOFF_MS || 2_000)
const MCP_RESTART_MAX_BACKOFF_MS = Number(process.env.TRAPEZOHE_MCP_RESTART_MAX_BACKOFF_MS || 30_000)
const MCP_MAX_STARTING = Math.max(0, Number(process.env.TRAPEZOHE_MCP_MAX_STARTING || 4))
const MCP_MAX_CONNECTED = Math.max(0, Number(process.env.TRAPEZOHE_MCP_MAX_CONNECTED || 32))
const DEVTOOLS_SELECTED_PAGE_CLOSED_RE = /the selected page has been closed/i
export function buildMcpSpawnPath(basePath, opts = {}) {
  return buildToolchainPath(basePath, {
    execDir: dirname(process.execPath),
    ...opts,
  })
}

function normalizeServerName(input) {
  return typeof input === 'string' ? input.trim().toLowerCase() : ''
}

function isChromeDevtoolsServerName(input) {
  return getServerBaseName(input) === 'chrome-devtools'
}

function getServerBaseName(input) {
  const normalized = normalizeServerName(input)
  if (!normalized) return ''
  return normalized.endsWith('-mcp') ? normalized.slice(0, -4) : normalized
}

function getToolTextContent(content = []) {
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      return typeof item.text === 'string' ? item.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function isChromeDevtoolsStalePageResult(result) {
  return Boolean(
    result?.isError
    && DEVTOOLS_SELECTED_PAGE_CLOSED_RE.test(getToolTextContent(result.content)),
  )
}

function parseChromeDevtoolsPages(content = []) {
  const pages = []
  const text = getToolTextContent(content)
  if (!text) return pages

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    const match = line.match(/^(\d+):\s+(.+?)(\s+\[selected\])?$/)
    if (!match) continue
    pages.push({
      pageId: Number(match[1]),
      descriptor: match[2].trim(),
      selected: Boolean(match[3]),
    })
  }
  return pages
}

function buildChromeDevtoolsPageHint(toolName, args, result) {
  if (result?.isError) return null

  if (toolName === 'list_pages' || toolName === 'select_page') {
    const pages = parseChromeDevtoolsPages(result.content)
    if (pages.length === 0) return null

    const requestedPageId = Number(args?.pageId)
    const selectedPage = Number.isFinite(requestedPageId)
      ? pages.find((page) => page.pageId === requestedPageId) || pages.find((page) => page.selected)
      : pages.find((page) => page.selected)
    if (!selectedPage) return null

    return {
      pageId: selectedPage.pageId,
      descriptor: selectedPage.descriptor,
    }
  }

  if (toolName === 'take_snapshot') {
    const text = getToolTextContent(result.content)
    const match = text.match(/RootWebArea\s+"[^"]*"\s+url="([^"]+)"/)
    if (!match) return null
    return {
      pageId: null,
      descriptor: match[1],
    }
  }

  return null
}

function resolveChromeDevtoolsRecoveryPageId(pages, hint) {
  if (!hint || pages.length === 0) return null

  const pageId = Number(hint.pageId)
  if (Number.isFinite(pageId)) {
    const byId = pages.find((page) => page.pageId === pageId)
    if (byId && (!hint.descriptor || byId.descriptor === hint.descriptor)) {
      return byId.pageId
    }
  }

  const descriptor = typeof hint.descriptor === 'string' ? hint.descriptor.trim() : ''
  if (!descriptor) return null

  const exactMatches = pages.filter((page) => page.descriptor === descriptor)
  if (exactMatches.length === 1) return exactMatches[0].pageId

  const suffixMatches = pages.filter((page) => page.descriptor.endsWith(descriptor))
  if (suffixMatches.length === 1) return suffixMatches[0].pageId

  return null
}

function formatChromeDevtoolsPageRecoveryError(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return 'Chrome DevTools refreshed the MCP session after the selected page closed, but no open pages were available. Call list_pages before retrying.'
  }

  const summary = pages
    .slice(0, 8)
    .map((page) => `${page.pageId}: ${page.descriptor}${page.selected ? ' [selected]' : ''}`)
    .join('; ')
  return `Chrome DevTools refreshed the MCP session after the selected page closed, but could not safely restore the previous tab. Open pages: ${summary}. Call list_pages and select_page before retrying.`
}

function isWriteCapableToolName(name) {
  return /(?:write|edit|delete|remove|create|update|upsert|insert|save|apply|transfer|approve|swap|send|execute|run)/i.test(String(name || ''))
}

function resolveWriteCapable(config, tools = []) {
  if (typeof config?.writeCapable === 'boolean') {
    return config.writeCapable
  }
  return tools.some((tool) => isWriteCapableToolName(tool?.name))
}

function resolveServerRequestTimeoutMs(config) {
  return normalizeMcpRequestTimeoutMs(config?.requestTimeoutMs, getDefaultMcpRequestTimeoutMs())
}

function normalizeManagerServerConfig(config) {
  return {
    command: config.command,
    args: Array.isArray(config.args)
      ? config.args.filter((item) => typeof item === 'string')
      : [],
    env: config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? config.env
      : {},
    cwd: typeof config.cwd === 'string' && config.cwd.trim() ? config.cwd.trim() : undefined,
    ...(config.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: resolveServerRequestTimeoutMs(config) }
      : {}),
    ...(typeof config.restartable === 'boolean' ? { restartable: config.restartable } : {}),
    ...(typeof config.writeCapable === 'boolean' ? { writeCapable: config.writeCapable } : {}),
  }
}

export class McpManager {
  #servers = new Map() // name → ServerEntry
  #startingLocks = new Set() // prevent concurrent startServer() for the same name

  constructor(serverConfigs) {
    this.#parseConfigs(serverConfigs)
  }

  #clearScheduledRestart(entry) {
    if (!entry) return
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer)
      entry.restartTimer = null
    }
    entry.restartPending = false
  }

  #setNextRetry(entry, now = Date.now()) {
    entry.failureCount = Number(entry.failureCount || 0) + 1
    entry.lastFailureAt = now
    entry.nextRetryAt = now + Math.min(
      MCP_RESTART_MAX_BACKOFF_MS,
      MCP_RESTART_BASE_BACKOFF_MS * (2 ** Math.max(0, entry.failureCount - 1)),
    )
    return entry.nextRetryAt
  }

  #scheduleRestart(name, entry, opts = {}) {
    if (!entry || entry.config?.restartable === false || entry.status === 'stopped') {
      if (entry) {
        this.#clearScheduledRestart(entry)
        entry.nextRetryAt = null
      }
      return
    }
    if (entry.restartTimer) return

    const now = opts.now ?? Date.now()
    const nextRetryAt = typeof opts.nextRetryAt === 'number'
      ? opts.nextRetryAt
      : (typeof entry.nextRetryAt === 'number' && entry.nextRetryAt > now
          ? entry.nextRetryAt
          : this.#setNextRetry(entry, now))
    const delayMs = Math.max(0, nextRetryAt - now)
    entry.nextRetryAt = nextRetryAt
    entry.restartPending = true
    entry.restartTimer = setTimeout(async () => {
      entry.restartTimer = null
      entry.restartPending = false

      const current = this.#servers.get(name)
      if (!current || current.status === 'stopped' || current.config?.restartable === false) {
        return
      }

      try {
        await this.startServer(name)
      } catch (err) {
        const latest = this.#servers.get(name)
        if (!latest || latest.status === 'stopped' || latest.config?.restartable === false) {
          return
        }
        if (!(typeof latest.nextRetryAt === 'number' && latest.nextRetryAt > Date.now())) {
          this.#setNextRetry(latest)
        }
        latest.error = err.message || String(err)
        this.#scheduleRestart(name, latest)
      }
    }, delayMs)
    if (entry.restartTimer.unref) entry.restartTimer.unref()
  }

  #parseConfigs(configs) {
    if (!configs || typeof configs !== 'object') return

    for (const [name, config] of Object.entries(configs)) {
      if (!config.command) {
        console.warn(`[MCP] Skipping server "${name}": no command specified`)
        continue
      }
      const normalizedConfig = normalizeManagerServerConfig(config)
      this.#servers.set(name, {
        name,
        config: normalizedConfig,
        status: 'stopped',
        transport: null,
        tools: [],
        capabilities: null,
        error: null,
        startedAt: null,
        failureCount: 0,
        lastFailureAt: null,
        nextRetryAt: null,
        restartPending: false,
        restartTimer: null,
        startToken: null,
        writeCapable: resolveWriteCapable(normalizedConfig),
        lastSelectedPageHint: null,
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

    const now = Date.now()
    if (typeof entry.nextRetryAt === 'number' && entry.nextRetryAt > now) {
      throw new Error(`MCP server "${name}" is in restart backoff. Retry after ${entry.nextRetryAt}.`)
    }
    if (this.#startingLocks.size >= MCP_MAX_STARTING) {
      throw new Error(`MCP starting concurrency limit reached (${MCP_MAX_STARTING})`)
    }
    if (this.getConnectedCount() >= MCP_MAX_CONNECTED) {
      throw new Error(`MCP connected server limit reached (${MCP_MAX_CONNECTED})`)
    }

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

      this.#clearScheduledRestart(entry)
      entry.status = 'starting'
      entry.error = null
      entry.tools = []
      entry.startedAt = null

      const startToken = Symbol(`mcp-start:${name}`)
      entry.startToken = startToken
      const { command, args = [], env = {}, cwd } = entry.config
      const childEnv = { ...process.env, ...env }
      childEnv.PATH = buildMcpSpawnPath(childEnv.PATH, {
        preferNodeToolchain: shouldPreferManagedNodeToolchain(command),
      })

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
        if (entry.startToken !== startToken) return
        if (entry.status !== 'stopped') {
          entry.status = 'disconnected'
          entry.transport = null
          entry.tools = [] // Clear tools when server disconnects
          entry.error = formatMcpProcessExitMessage(
            `Process exited with code ${code}`,
            transport.stderr,
          )
          entry.startedAt = null
          console.warn(`[MCP] "${name}" exited with code ${code}`)
          this.#scheduleRestart(name, entry)
        }
      })

      // Register late error handler (after spawn succeeded)
      proc.on('error', (err) => {
        if (entry.startToken !== startToken) return
        if (entry.status !== 'stopped') {
          entry.status = 'error'
          entry.transport = null
          entry.tools = []
          entry.error = `Process error: ${err.message}`
          entry.startedAt = null
          console.error(`[MCP] "${name}" error:`, err.message)
          this.#scheduleRestart(name, entry)
        }
      })

      const transport = new StdioTransport(proc, {
        requestTimeoutMs: resolveServerRequestTimeoutMs(entry.config),
      })
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
          entry.writeCapable = resolveWriteCapable(entry.config, entry.tools)
        } catch (err) {
          console.warn(`[MCP] "${name}" tools/list failed:`, err.message)
        }
      }

      entry.status = 'connected'
      entry.failureCount = 0
      entry.lastFailureAt = null
      entry.nextRetryAt = null
      entry.restartPending = false
      console.log(`[MCP] "${name}" connected — ${entry.tools.length} tool(s)`)
      return { name, tools: entry.tools.length }
    } catch (err) {
      entry.status = 'error'
      entry.startToken = null
      const failureMessage = formatMcpProcessExitMessage(
        err?.message || String(err),
        entry.transport?.stderr,
      )
      entry.error = failureMessage
      entry.tools = []
      this.#setNextRetry(entry, now)
      // Cleanup transport if it was created
      if (entry.transport) {
        entry.transport.close()
        entry.transport = null
      }
      if (err instanceof Error) {
        err.message = failureMessage
        throw err
      }
      throw new Error(failureMessage)
    } finally {
      this.#startingLocks.delete(name)
    }
  }

  async stopServer(name) {
    const entry = this.#servers.get(name)
    if (!entry) return

    this.#clearScheduledRestart(entry)
    entry.status = 'stopped'
    entry.startToken = null

    if (entry.transport) {
      entry.transport.close()
      entry.transport = null
    }

    entry.tools = []
    entry.error = null
    entry.startedAt = null
    entry.nextRetryAt = null
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
        requestTimeoutMs: entry.transport?.requestTimeoutMs ?? resolveServerRequestTimeoutMs(entry.config),
        failureCount: entry.failureCount || 0,
        lastFailureAt: entry.lastFailureAt,
        nextRetryAt: entry.nextRetryAt,
        restartable: entry.config.restartable !== false,
        restartPending: Boolean(entry.restartPending),
        writeCapable: Boolean(entry.writeCapable),
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

  async #callToolRaw(entry, toolName, args = {}) {
    return entry.transport.request('tools/call', {
      name: toolName,
      arguments: args,
    })
  }

  #rememberChromeDevtoolsPageHint(entry, toolName, args, result) {
    if (!isChromeDevtoolsServerName(entry?.name)) return
    const hint = buildChromeDevtoolsPageHint(toolName, args, result)
    if (hint) entry.lastSelectedPageHint = hint
  }

  #normalizeToolCallResult(result) {
    return {
      ok: !result?.isError,
      content: result?.content || [],
      isError: Boolean(result?.isError),
    }
  }

  async #recoverChromeDevtoolsToolCall(entry, toolName, args = {}) {
    const previousHint = entry?.lastSelectedPageHint ? { ...entry.lastSelectedPageHint } : null
    await this.restartServer(entry.name)

    const recoveredEntry = this.#resolveServerEntry(entry.name)
    if (!recoveredEntry || recoveredEntry.status !== 'connected' || !recoveredEntry.transport || recoveredEntry.transport.closed) {
      return {
        ok: false,
        error: `Chrome DevTools MCP could not be reconnected after the selected page closed.`,
      }
    }

    if (toolName === 'list_pages' || toolName === 'select_page') {
      const retryResult = await this.#callToolRaw(recoveredEntry, toolName, args)
      this.#rememberChromeDevtoolsPageHint(recoveredEntry, toolName, args, retryResult)
      return this.#normalizeToolCallResult(retryResult)
    }

    const pageListResult = await this.#callToolRaw(recoveredEntry, 'list_pages', {})
    this.#rememberChromeDevtoolsPageHint(recoveredEntry, 'list_pages', {}, pageListResult)
    if (pageListResult?.isError) {
      return this.#normalizeToolCallResult(pageListResult)
    }

    const pages = parseChromeDevtoolsPages(pageListResult.content)
    const recoveryPageId = resolveChromeDevtoolsRecoveryPageId(pages, previousHint)
    if (!Number.isFinite(recoveryPageId)) {
      return {
        ok: false,
        error: formatChromeDevtoolsPageRecoveryError(pages),
      }
    }

    const selectResult = await this.#callToolRaw(recoveredEntry, 'select_page', {
      pageId: recoveryPageId,
      bringToFront: false,
    })
    this.#rememberChromeDevtoolsPageHint(recoveredEntry, 'select_page', { pageId: recoveryPageId }, selectResult)
    if (selectResult?.isError) {
      return this.#normalizeToolCallResult(selectResult)
    }

    const retryResult = await this.#callToolRaw(recoveredEntry, toolName, args)
    this.#rememberChromeDevtoolsPageHint(recoveredEntry, toolName, args, retryResult)
    return this.#normalizeToolCallResult(retryResult)
  }

  async callTool(serverName, toolName, args = {}) {
    const entry = this.#resolveServerEntry(serverName)
    if (!entry) {
      const available = this.getServers().map((item) => item.name).filter(Boolean)
      const hint = available.length > 0 ? ` Available servers: ${available.join(', ')}` : ''
      return { ok: false, error: `Unknown MCP server: ${serverName}.${hint}` }
    }
    if (entry.status !== 'connected' || !entry.transport || entry.transport.closed) {
      return { ok: false, error: `MCP server "${entry.name}" is not connected (status: ${entry.status})` }
    }

    // Verify tool exists
    const tool = entry.tools.find((t) => t.name === toolName)
    if (!tool) {
      return { ok: false, error: `Tool "${toolName}" not found on server "${entry.name}"` }
    }

    try {
      const result = await this.#callToolRaw(entry, toolName, args)
      if (isChromeDevtoolsServerName(entry.name) && isChromeDevtoolsStalePageResult(result)) {
        return await this.#recoverChromeDevtoolsToolCall(entry, toolName, args)
      }
      this.#rememberChromeDevtoolsPageHint(entry, toolName, args, result)
      return this.#normalizeToolCallResult(result)
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  #resolveServerEntry(serverName) {
    const requested = typeof serverName === 'string' ? serverName.trim() : ''
    if (!requested) return null

    const exact = this.#servers.get(requested)
    if (exact) return exact

    const normalizedRequested = normalizeServerName(requested)
    const requestedBase = getServerBaseName(requested)
    if (!normalizedRequested || !requestedBase) return null

    const candidates = []
    for (const [, entry] of this.#servers) {
      const normalizedEntry = normalizeServerName(entry.name)
      if (!normalizedEntry) continue
      const entryBase = getServerBaseName(entry.name)
      if (
        normalizedEntry === normalizedRequested
        || entryBase === requestedBase
        || normalizedEntry === `${requestedBase}-mcp`
      ) {
        candidates.push(entry)
      }
    }

    if (candidates.length !== 1) return null
    return candidates[0]
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

  async upsertServer(name, config, options = {}) {
    const serverName = typeof name === 'string' ? name.trim() : ''
    if (!serverName) throw new Error('MCP server name is required.')
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('MCP server config must be an object.')
    }
    const command = typeof config.command === 'string' ? config.command.trim() : ''
    if (!command) throw new Error('MCP server config.command is required.')
    const normalizedConfig = normalizeManagerServerConfig({
      ...config,
      command,
    })

    const existing = this.#servers.get(serverName)
    if (existing) {
      await this.stopServer(serverName)
      existing.config = normalizedConfig
      existing.error = null
      existing.writeCapable = resolveWriteCapable(normalizedConfig, existing.tools)
      existing.lastSelectedPageHint = null
    } else {
      this.#servers.set(serverName, {
        name: serverName,
        config: normalizedConfig,
        status: 'stopped',
        transport: null,
        tools: [],
        capabilities: null,
        error: null,
        startedAt: null,
        failureCount: 0,
        lastFailureAt: null,
        nextRetryAt: null,
        restartPending: false,
        restartTimer: null,
        startToken: null,
        writeCapable: resolveWriteCapable(normalizedConfig),
        lastSelectedPageHint: null,
      })
    }

    if (options.start === false) {
      return { ok: true, name: serverName }
    }

    await this.startServer(serverName)
    return { ok: true, name: serverName }
  }

  async deleteServer(name) {
    const serverName = typeof name === 'string' ? name.trim() : ''
    if (!serverName) throw new Error('MCP server name is required.')
    const existing = this.#servers.get(serverName)
    if (!existing) return { ok: true, name: serverName, removed: false }
    await this.stopServer(serverName)
    this.#servers.delete(serverName)
    return { ok: true, name: serverName, removed: true }
  }
}
