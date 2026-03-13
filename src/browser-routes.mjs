import {
  getBrowserLedgerDiagnostics,
  getBrowserLedgerDrilldown,
  getBrowserSessionById,
  listBrowserEvents,
  listBrowserActions,
  listBrowserArtifacts,
  listBrowserSessions,
  syncBrowserAction,
  syncBrowserArtifact,
  syncBrowserSession,
} from './browser-ledger.mjs'

const BROWSER_SESSION_ID_RE = /^\/api\/browser\/sessions\/([^/]+)$/

export async function handleBrowserRequest(req, res, url, pathname, ctx) {
  const { authorize, sendJson, readJsonBody, supportedFeatures } = ctx

  if (!pathname.startsWith('/api/browser/')) return false

  const auth = authorize(req)
  if (!auth.ok) {
    sendJson(res, 401, { error: auth.error })
    return true
  }

  try {
    if (req.method === 'POST' && pathname === '/api/browser/sessions/sync') {
      const body = await readJsonBody(req)
      const session = await syncBrowserSession(body)
      sendJson(res, 200, { ok: true, session })
      return true
    }

    if (req.method === 'POST' && pathname === '/api/browser/actions/sync') {
      const body = await readJsonBody(req)
      const action = await syncBrowserAction(body)
      sendJson(res, 200, { ok: true, action })
      return true
    }

    if (req.method === 'POST' && pathname === '/api/browser/artifacts/sync') {
      const body = await readJsonBody(req)
      const artifact = await syncBrowserArtifact(body)
      sendJson(res, 200, { ok: true, artifact })
      return true
    }

    if (req.method === 'GET' && pathname === '/api/browser/sessions') {
      const result = await listBrowserSessions({
        sessionId: url.searchParams.get('sessionId'),
        state: url.searchParams.get('state'),
        ownerConversationId: url.searchParams.get('ownerConversationId'),
        runId: url.searchParams.get('runId'),
        conversationId: url.searchParams.get('conversationId'),
        sourceToolName: url.searchParams.get('sourceToolName'),
        sourceToolCallId: url.searchParams.get('sourceToolCallId'),
        approvalRequestId: url.searchParams.get('approvalRequestId'),
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      })
      sendJson(res, 200, result)
      return true
    }

    const sessionMatch = pathname.match(BROWSER_SESSION_ID_RE)
    if (req.method === 'GET' && sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1])
      const session = await getBrowserSessionById(sessionId)
      if (!session) {
        sendJson(res, 404, { error: 'Browser session not found.' })
        return true
      }
      sendJson(res, 200, { session })
      return true
    }

    if (req.method === 'GET' && pathname === '/api/browser/actions') {
      const result = await listBrowserActions({
        sessionId: url.searchParams.get('sessionId'),
        targetId: url.searchParams.get('targetId'),
        kind: url.searchParams.get('kind'),
        status: url.searchParams.get('status'),
        runId: url.searchParams.get('runId'),
        conversationId: url.searchParams.get('conversationId'),
        sourceToolName: url.searchParams.get('sourceToolName'),
        sourceToolCallId: url.searchParams.get('sourceToolCallId'),
        approvalRequestId: url.searchParams.get('approvalRequestId'),
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      })
      sendJson(res, 200, result)
      return true
    }

    if (req.method === 'GET' && pathname === '/api/browser/artifacts') {
      const result = await listBrowserArtifacts({
        sessionId: url.searchParams.get('sessionId'),
        targetId: url.searchParams.get('targetId'),
        actionId: url.searchParams.get('actionId'),
        kind: url.searchParams.get('kind'),
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      })
      sendJson(res, 200, result)
      return true
    }

    if (req.method === 'GET' && pathname === '/api/browser/events') {
      const result = await listBrowserEvents({
        after: url.searchParams.get('after'),
        window: url.searchParams.get('window'),
        limit: url.searchParams.get('limit'),
        sessionId: url.searchParams.get('sessionId'),
        actionId: url.searchParams.get('actionId'),
        artifactId: url.searchParams.get('artifactId'),
        type: url.searchParams.get('type'),
        runId: url.searchParams.get('runId'),
        conversationId: url.searchParams.get('conversationId'),
        sourceToolName: url.searchParams.get('sourceToolName'),
        sourceToolCallId: url.searchParams.get('sourceToolCallId'),
        approvalRequestId: url.searchParams.get('approvalRequestId'),
      })
      sendJson(res, 200, result)
      return true
    }

    if (req.method === 'GET' && pathname === '/api/browser/drilldown') {
      const result = await getBrowserLedgerDrilldown({
        runId: url.searchParams.get('runId'),
        conversationId: url.searchParams.get('conversationId'),
        sourceToolName: url.searchParams.get('sourceToolName'),
        sourceToolCallId: url.searchParams.get('sourceToolCallId'),
        approvalRequestId: url.searchParams.get('approvalRequestId'),
        sessionId: url.searchParams.get('sessionId'),
        actionId: url.searchParams.get('actionId'),
        artifactId: url.searchParams.get('artifactId'),
        type: url.searchParams.get('type'),
        sessionLimit: url.searchParams.get('sessionLimit'),
        actionLimit: url.searchParams.get('actionLimit'),
        artifactLimit: url.searchParams.get('artifactLimit'),
        eventLimit: url.searchParams.get('eventLimit'),
        eventAfter: url.searchParams.get('eventAfter'),
        eventWindow: url.searchParams.get('eventWindow'),
      })
      sendJson(res, 200, result)
      return true
    }

    if (req.method === 'GET' && pathname === '/api/browser/diagnostics') {
      const diagnostics = await getBrowserLedgerDiagnostics({ supportedFeatures })
      sendJson(res, 200, diagnostics)
      return true
    }

    sendJson(res, 404, { error: `Not found: ${pathname}` })
    return true
  } catch (err) {
    sendJson(res, 400, { error: err.message || 'Invalid request.' })
    return true
  }
}
