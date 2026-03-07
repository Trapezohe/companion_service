import test from 'node:test'
import assert from 'node:assert/strict'

import { spawnAgentChild } from './acp-process.mjs'

test('spawnAgentChild emits auth error and skips process spawn when auth is blocking', () => {
  const events = []
  let spawnCalled = false
  const transitions = []

  const session = {
    sessionId: 'session-1',
    agentType: 'claude-code',
    currentTurnId: 'turn-1',
    state: 'idle',
    terminalEmitted: false,
  }

  spawnAgentChild(session, {
    command: ['claude', '--print'],
    cwd: '/tmp',
    timeoutMs: 5_000,
    prompt: 'hello',
  }, {
    now: () => 1_000,
    pushEvent: (_sessionId, event) => events.push(event),
    applySessionState: (_session, _nextState, meta) => transitions.push(meta.reason),
    markOutputActivity: () => {},
    startNoOutputWatchdog: () => {},
    clearNoOutputWatchdog: () => {},
    parseAgentLine: () => [],
    synthesizeTerminalEvent: () => null,
    prepareEnvironment: () => ({
      env: {},
      authCheck: {
        blocking: true,
        missingKeys: ['ANTHROPIC_API_KEY'],
        message: 'Missing Claude auth env.',
      },
    }),
    spawnImpl: () => {
      spawnCalled = true
      throw new Error('should not spawn')
    },
  })

  assert.equal(spawnCalled, false)
  assert.equal(session.terminalEmitted, true)
  assert.equal(session.finishedAt, 1_000)
  assert.deepEqual(session.authDiagnosticMissingKeys, ['ANTHROPIC_API_KEY'])
  assert.deepEqual(transitions, ['spawn', 'missing_auth_env'])
  assert.equal(events.length, 1)
  assert.equal(events[0].code, 'missing_auth_env')
})
