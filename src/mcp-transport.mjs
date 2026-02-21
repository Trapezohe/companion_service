/**
 * JSON-RPC 2.0 over stdio transport for MCP servers.
 *
 * MCP protocol uses newline-delimited JSON messages over stdin/stdout.
 * Each message is a single JSON object followed by a newline character.
 */

const REQUEST_TIMEOUT_MS = 30_000

export class StdioTransport {
  #proc
  #nextId = 1
  #pending = new Map() // id → { resolve, reject, timer }
  #buffer = ''
  #closed = false
  #notificationHandler = null
  #stderrChunks = ''

  constructor(proc) {
    this.#proc = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => this.#onData(chunk))

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      this.#stderrChunks += chunk
      // Keep last 10KB of stderr
      if (this.#stderrChunks.length > 10_000) {
        this.#stderrChunks = this.#stderrChunks.slice(-10_000)
      }
    })

    proc.on('close', () => this.#onClose())
    proc.on('error', (err) => this.#onError(err))
  }

  get stderr() {
    return this.#stderrChunks
  }

  get closed() {
    return this.#closed
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
        reject(new Error(`MCP request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method}`))
      }, REQUEST_TIMEOUT_MS)

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
    for (const [id, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Transport closed'))
    }
    this.#pending.clear()

    // Kill the process
    try {
      this.#proc.stdin.end()
    } catch { /* ignore */ }

    try {
      this.#proc.kill('SIGTERM')
      setTimeout(() => {
        try { this.#proc.kill('SIGKILL') } catch { /* ignore */ }
      }, 3000)
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
      entry.reject(new Error('MCP server process exited'))
    }
    this.#pending.clear()
  }

  #onError(err) {
    if (this.#closed) return
    this.#closed = true

    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`MCP server process error: ${err.message}`))
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
