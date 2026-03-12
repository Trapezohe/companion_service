/**
 * ACP HTTP routes — thin adapter between HTTP and acp-session module.
 *
 * Exports a single handler that returns true if the request was handled.
 */

import {
  createAcpSession,
  attachAcpSessionRunId,
  getAcpSessionById,
  listAcpSessions,
  enqueuePrompt,
  enqueueSteer,
  cancelAcpSession,
  listAcpEvents,
} from './acp-session.mjs'

// Path patterns
const ACP_SESSION_ID_RE = /^\/api\/acp\/sessions\/([^/]+)$/
const ACP_SESSION_PROMPT_RE = /^\/api\/acp\/sessions\/([^/]+)\/prompt$/
const ACP_SESSION_STEER_RE = /^\/api\/acp\/sessions\/([^/]+)\/steer$/
const ACP_SESSION_CANCEL_RE = /^\/api\/acp\/sessions\/([^/]+)\/cancel$/
const ACP_SESSION_EVENTS_RE = /^\/api\/acp\/sessions\/([^/]+)\/events$/

/**
 * Handle ACP requests. Returns true if handled, false otherwise.
 */
export async function handleAcpRequest(req, res, url, pathname, ctx) {
  const { authorize, sendJson, readJsonBody } = ctx

  // Only handle /api/acp/* paths
  if (!pathname.startsWith('/api/acp/')) return false

  // Auth check for all ACP endpoints
  const auth = authorize(req)
  if (!auth.ok) {
    sendJson(res, 401, { error: auth.error })
    return true
  }

  try {
    // POST /api/acp/sessions — create session
    if (req.method === 'POST' && pathname === '/api/acp/sessions') {
      const body = await readJsonBody(req)
      const result = createAcpSession({
        agentType: body.agentType,
        cwd: body.cwd,
        command: body.command,
        env: body.env,
        timeoutMs: body.timeoutMs,
        origin: body.origin,
        inputProvenance: body.inputProvenance,
        permissionPolicy: typeof ctx.getPermissionPolicy === 'function' ? ctx.getPermissionPolicy() : undefined,
      })
      if (typeof ctx.createAcpRun === 'function') {
        const run = await ctx.createAcpRun(result)
        if (run?.runId) {
          attachAcpSessionRunId(result.sessionId, run.runId)
        }
      }
      sendJson(res, 200, getAcpSessionById(result.sessionId) || result)
      return true
    }

    // GET /api/acp/sessions — list sessions
    if (req.method === 'GET' && pathname === '/api/acp/sessions') {
      const result = listAcpSessions({
        state: url.searchParams.get('state') || undefined,
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      })
      sendJson(res, 200, result)
      return true
    }

    // POST /api/acp/sessions/:id/prompt
    const promptMatch = pathname.match(ACP_SESSION_PROMPT_RE)
    if (req.method === 'POST' && promptMatch) {
      const sessionId = decodeURIComponent(promptMatch[1])
      const body = await readJsonBody(req)
      const ack = await enqueuePrompt(sessionId, {
        prompt: body.prompt,
        turnId: body.turnId,
        timeoutMs: body.timeoutMs,
        command: body.command,
        cwd: body.cwd,
        env: body.env,
        origin: body.origin,
        inputProvenance: body.inputProvenance,
        permissionPolicy: typeof ctx.getPermissionPolicy === 'function' ? ctx.getPermissionPolicy() : undefined,
      })
      const session = getAcpSessionById(sessionId)
      if (session && typeof ctx.syncAcpRunIngress === 'function') {
        await ctx.syncAcpRunIngress(session, ack?.turnId)
      }
      sendJson(res, 200, { ok: true, sessionId, turnId: ack?.turnId, runId: session?.runId || null })
      return true
    }

    // POST /api/acp/sessions/:id/steer
    const steerMatch = pathname.match(ACP_SESSION_STEER_RE)
    if (req.method === 'POST' && steerMatch) {
      const sessionId = decodeURIComponent(steerMatch[1])
      const body = await readJsonBody(req)
      const ack = await enqueueSteer(sessionId, {
        text: body.text,
        submit: body.submit,
        turnId: body.turnId,
      })
      sendJson(res, 200, { ok: true, sessionId, turnId: ack?.turnId })
      return true
    }

    // POST /api/acp/sessions/:id/cancel
    const cancelMatch = pathname.match(ACP_SESSION_CANCEL_RE)
    if (req.method === 'POST' && cancelMatch) {
      const sessionId = decodeURIComponent(cancelMatch[1])
      const result = await cancelAcpSession(sessionId)
      sendJson(res, 200, result)
      return true
    }

    // GET /api/acp/sessions/:id/events
    const eventsMatch = pathname.match(ACP_SESSION_EVENTS_RE)
    if (req.method === 'GET' && eventsMatch) {
      const sessionId = decodeURIComponent(eventsMatch[1])
      const result = listAcpEvents(sessionId, {
        after: url.searchParams.get('after'),
        limit: url.searchParams.get('limit'),
      })
      sendJson(res, 200, result)
      return true
    }

    // GET /api/acp/sessions/:id — session status
    const sessionMatch = pathname.match(ACP_SESSION_ID_RE)
    if (req.method === 'GET' && sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1])
      const session = getAcpSessionById(sessionId)
      if (!session) {
        sendJson(res, 404, { error: 'ACP session not found.' })
        return true
      }
      sendJson(res, 200, session)
      return true
    }

    // Unmatched /api/acp/* path
    sendJson(res, 404, { error: `Not found: ${pathname}` })
    return true
  } catch (err) {
    sendJson(res, 400, { error: err.message || 'Invalid request.' })
    return true
  }
}
