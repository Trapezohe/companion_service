/**
 * Unified HTTP server — command runtime + MCP API.
 *
 * All endpoints require Bearer token auth + loopback-only access.
 * Backwards-compatible with existing /api/local-runtime/* paths.
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import {
  runCommand,
  resolveCwd,
  clampTimeout,
  startCommandSession,
  getSessionById,
  makeSessionSnapshot,
  pruneSessions,
  stopSession,
  cleanupAllSessions,
} from './runtime.mjs'

// ── Helpers ──

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  res.end(JSON.stringify(payload))
}

function isLoopback(addr) {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('Invalid JSON body.'))
      }
    })
  })
}

function authorize(req, token) {
  if (!isLoopback(req.socket.remoteAddress)) {
    return { ok: false, error: 'Only loopback clients are allowed.' }
  }
  const auth = String(req.headers.authorization || '')
  const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
  if (!provided || provided !== token) {
    return { ok: false, error: 'Unauthorized: invalid token.' }
  }
  return { ok: true }
}

// ── Command execution handler ──

async function handleExec(req, res) {
  const body = await readJsonBody(req)
  const command = typeof body.command === 'string' ? body.command.trim() : ''
  if (!command) return sendJson(res, 400, { error: 'command is required.' })
  if (command.length > 10_000) return sendJson(res, 400, { error: 'command exceeds max length (10000).' })

  const cwd = await resolveCwd(body.cwd)
  const timeoutMs = clampTimeout(body.timeoutMs)
  const result = await runCommand({ command, cwd, timeoutMs })
  sendJson(res, 200, { ...result, command, cwd })
}

async function handleSessionStart(req, res) {
  const body = await readJsonBody(req)
  const command = typeof body.command === 'string' ? body.command.trim() : ''
  if (!command) return sendJson(res, 400, { error: 'command is required.' })
  if (command.length > 10_000) return sendJson(res, 400, { error: 'command exceeds max length (10000).' })

  const cwd = await resolveCwd(body.cwd)
  const timeoutMs = clampTimeout(body.timeoutMs)
  pruneSessions()
  const id = randomBytes(12).toString('hex')
  const session = startCommandSession({ id, command, cwd, timeoutMs })
  sendJson(res, 200, makeSessionSnapshot(session))
}

function handleSessionStatus(sessionId, res) {
  const session = getSessionById(sessionId)
  if (!session) return sendJson(res, 404, { error: 'Session not found.' })
  sendJson(res, 200, makeSessionSnapshot(session))
}

async function handleSessionStop(sessionId, req, res) {
  const body = await readJsonBody(req)
  const force = Boolean(body.force)
  const session = stopSession(sessionId, force)
  if (!session) return sendJson(res, 404, { error: 'Session not found.' })
  sendJson(res, 200, makeSessionSnapshot(session))
}

// ── Server factory ──

export function createCompanionServer({ token, mcpManager }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const pathname = url.pathname

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return sendJson(res, 200, { ok: true })
    }

    // Health check (requires auth)
    if (req.method === 'GET' && pathname === '/healthz') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return sendJson(res, 200, {
        ok: true,
        ts: Date.now(),
        version: '0.1.0',
        mcpServers: mcpManager.getConnectedCount(),
        mcpTools: mcpManager.getAllTools().length,
      })
    }

    // ── Command Runtime endpoints ──
    // Support both /api/local-runtime/* (legacy) and /api/runtime/* (new)

    const isExec = (
      req.method === 'POST' &&
      (pathname === '/api/local-runtime/exec' || pathname === '/api/runtime/exec')
    )
    if (isExec) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return await handleExec(req, res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    const isSessionStart = (
      req.method === 'POST' &&
      (pathname === '/api/local-runtime/session/start' || pathname === '/api/runtime/session/start')
    )
    if (isSessionStart) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return await handleSessionStart(req, res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    // Session status — GET /api/(local-runtime|runtime)/session/:id
    const sessionStatusMatch = pathname.match(
      /^\/api\/(?:local-runtime|runtime)\/session\/([^/]+)$/
    )
    if (req.method === 'GET' && sessionStatusMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return handleSessionStatus(decodeURIComponent(sessionStatusMatch[1]), res)
    }

    // Session stop — POST /api/(local-runtime|runtime)/session/:id/stop
    const sessionStopMatch = pathname.match(
      /^\/api\/(?:local-runtime|runtime)\/session\/([^/]+)\/stop$/
    )
    if (req.method === 'POST' && sessionStopMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try { return await handleSessionStop(decodeURIComponent(sessionStopMatch[1]), req, res) }
      catch (err) { return sendJson(res, 400, { error: err.message || 'Invalid request.' }) }
    }

    // ── MCP endpoints ──

    // List MCP servers
    if (req.method === 'GET' && pathname === '/api/mcp/servers') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return sendJson(res, 200, { servers: mcpManager.getServers() })
    }

    // List all MCP tools
    if (req.method === 'GET' && pathname === '/api/mcp/tools') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      return sendJson(res, 200, { tools: mcpManager.getAllTools() })
    }

    // Call an MCP tool
    if (req.method === 'POST' && pathname === '/api/mcp/tools/call') {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      try {
        const body = await readJsonBody(req)
        const { server, tool, arguments: toolArgs } = body
        if (!server || !tool) {
          return sendJson(res, 400, { error: '"server" and "tool" are required.' })
        }
        const result = await mcpManager.callTool(server, tool, toolArgs || {})
        return sendJson(res, 200, result)
      } catch (err) {
        return sendJson(res, 400, { error: err.message || 'Invalid request.' })
      }
    }

    // Restart an MCP server
    const serverRestartMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/restart$/)
    if (req.method === 'POST' && serverRestartMatch) {
      const auth = authorize(req, token)
      if (!auth.ok) return sendJson(res, 401, { error: auth.error })
      const name = decodeURIComponent(serverRestartMatch[1])
      try {
        await mcpManager.restartServer(name)
        return sendJson(res, 200, { ok: true, name })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message })
      }
    }

    sendJson(res, 404, { error: `Not found: ${pathname}` })
  })

  // Cleanup on server close
  server.on('close', () => {
    cleanupAllSessions()
  })

  return server
}
