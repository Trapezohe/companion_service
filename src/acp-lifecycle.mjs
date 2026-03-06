let sessionTransitionHook = null

export function setAcpSessionTransitionHook(hook) {
  sessionTransitionHook = typeof hook === 'function' ? hook : null
  return () => {
    if (sessionTransitionHook === hook) {
      sessionTransitionHook = null
    }
  }
}

export function applyAcpSessionState(session, nextState, meta = {}) {
  if (!session || typeof session !== 'object') return
  const previousState = session.state
  if (previousState === nextState) return
  session.state = nextState
  if (typeof sessionTransitionHook === 'function') {
    Promise.resolve(sessionTransitionHook({
      sessionId: session.sessionId,
      runId: session.runId || null,
      agentType: session.agentType,
      fromState: previousState,
      toState: nextState,
      meta,
    })).catch(() => undefined)
  }
}
