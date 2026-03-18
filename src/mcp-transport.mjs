/**
 * JSON-RPC 2.0 over stdio transport for MCP servers.
 *
 * MCP protocol uses newline-delimited JSON messages over stdin/stdout.
 * Each message is a single JSON object followed by a newline character.
 */

import { getDefaultMcpRequestTimeoutMs, normalizeMcpRequestTimeoutMs } from './config.mjs'
import { signalChildProcessTree } from './runtime.mjs'

export function formatMcpProcessExitMessage(message, stderr) {
  const baseMessage = typeof message === 'string' && message.trim()
    ? message.trim()
    : 'MCP server process exited'
  const normalizedStderr = typeof stderr === 'string'
    ? stderr.trim().replace(/\s+/g, ' ')
    : ''

  if (!normalizedStderr || baseMessage.includes(normalizedStderr)) {
    return baseMessage
  }

  const limit = 500
  const summarizedStderr = normalizedStderr.length > limit
    ? `${normalizedStderr.slice(0, limit)}...`
    : normalizedStderr
  return `${baseMessage}: ${summarizedStderr}`
}

export class StdioTransport {
  #proc
  #nextId = 1
  #pending = new Map() // id → { resolve, reject, timer }
  #buffer = ''
  #closed = false
  #notificationHandler = null
  #stderrChunks = []
  #stderrSize = 0
  #requestTimeoutMs

  constructor(proc, options = {}) {
    this.#proc = proc
    this.#requestTimeoutMs = normalizeMcpRequestTimeoutMs(
      options.requestTimeoutMs,
      getDefaultMcpRequestTimeoutMs(),
    )

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => this.#onData(chunk))

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      this.#stderrChunks.push(chunk)
      this.#stderrSize += chunk.length
      // Compact when accumulated size exceeds 20KB (keep last 10KB)
      if (this.#stderrSize > 20_000) {
        const full = this.#stderrChunks.join('')
        const trimmed = full.slice(-10_000)
        this.#stderrChunks = [trimmed]
        this.#stderrSize = trimmed.length
      }
    })

    proc.on('close', () => this.#onClose())
    proc.on('error', (err) => this.#onError(err))
  }

  get stderr() {
    return this.#stderrChunks.join('')
  }

  get closed() {
    return this.#closed
  }

  get requestTimeoutMs() {
    return this.#requestTimeoutMs
  }

  async request(method, params = {}) {
    if (this.#closed) {
      throw new Error('Transport is closed')
    }

    const id = this.#nextId++
    const message = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`MCP request timed out after ${this.#requestTimeoutMs}ms: ${method}`))
      }, this.#requestTimeoutMs)

      this.#pending.set(id, { resolve, reject, timer })

      try {
        this.#proc.stdin.write(message + '\n')
      } catch (err) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`Failed to write to MCP server stdin: ${err.message}`))
      }
    })
  }

  onNotification(handler) {
    this.#notificationHandler = handler
  }

  close() {
    if (this.#closed) return
    this.#closed = true

    // Reject all pending requests
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Transport closed'))
    }
    this.#pending.clear()

    // Destroy all streams to prevent file descriptor leaks
    try { this.#proc.stdout.destroy() } catch { /* ignore */ }
    try { this.#proc.stderr.destroy() } catch { /* ignore */ }
    try { this.#proc.stdin.end() } catch { /* ignore */ }

    // Kill the process tree; verify it actually exited before force-killing
    try {
      signalChildProcessTree(this.#proc, 'SIGTERM')
      const killTimer = setTimeout(() => {
        try {
          if (!this.#proc.killed) signalChildProcessTree(this.#proc, 'SIGKILL')
        } catch { /* ignore */ }
      }, 3000)
      // Clear the kill timer if the process exits on its own
      this.#proc.once('exit', () => clearTimeout(killTimer))
      // Prevent the timer from keeping the process alive
      if (killTimer.unref) killTimer.unref()
    } catch { /* ignore */ }
  }

  #onData(chunk) {
    this.#buffer += chunk

    // Process complete lines
    let newlineIdx
    while ((newlineIdx = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, newlineIdx).trim()
      this.#buffer = this.#buffer.slice(newlineIdx + 1)

      if (!line) continue

      try {
        const msg = JSON.parse(line)
        this.#handleMessage(msg)
      } catch {
        // Ignore non-JSON lines (some MCP servers emit logging to stdout)
      }
    }
  }

  #handleMessage(msg) {
    if (msg.jsonrpc !== '2.0') return

    // Response to a request (has id)
    if (msg.id !== undefined && msg.id !== null) {
      const entry = this.#pending.get(msg.id)
      if (!entry) return

      this.#pending.delete(msg.id)
      clearTimeout(entry.timer)

      if (msg.error) {
        entry.reject(new McpError(msg.error.code, msg.error.message, msg.error.data))
      } else {
        entry.resolve(msg.result)
      }
      return
    }

    // Notification (no id)
    if (msg.method && this.#notificationHandler) {
      this.#notificationHandler(msg.method, msg.params)
    }
  }

  #onClose() {
    if (this.#closed) return
    this.#closed = true

    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(formatMcpProcessExitMessage('MCP server process exited', this.stderr)))
    }
    this.#pending.clear()
  }

  #onError(err) {
    if (this.#closed) return
    this.#closed = true

    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(
        formatMcpProcessExitMessage(`MCP server process error: ${err.message}`, this.stderr),
      ))
    }
    this.#pending.clear()
  }
}

export class McpError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.data = data
  }
}
