import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter as PATH_DELIMITER } from 'node:path'

import {
  createAcpSession,
  getAcpSessionById,
  enqueuePrompt,
  enqueueSteer,
  cancelAcpSession,
  listAcpEvents,
  cleanupAllAcpSessions,
  parseAgentLine,
  resolveDefaultCommand,
  resolveAgentAuthCheck,
  normalizeClaudeAuthEnv,
  synthesizeTerminalEvent,
  buildAgentPath,
  classifyNoOutputDiagnostic,
} from './acp-session.mjs'
import { setAcpSessionTransitionHook } from './acp-lifecycle.mjs'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForState(sessionId, targetStates, timeoutMs = 8000) {
  const states = Array.isArray(targetStates) ? targetStates : [targetStates]
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const session = getAcpSessionById(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    if (states.includes(session.state)) return session
    await delay(25)
  }
  const session = getAcpSessionById(sessionId)
  throw new Error(`Timed out waiting for state ${targetStates}. Current: ${session?.state}`)
}

async function waitForEventType(sessionId, eventType, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { events } = listAcpEvents(sessionId, { after: 0, limit: 500 })
    const match = events.find((e) => e.type === eventType)
    if (match) return match
    await delay(25)
  }
  throw new Error(`Timed out waiting for event type "${eventType}" in session ${sessionId}`)
}

async function waitForEventMatch(sessionId, matcher, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { events } = listAcpEvents(sessionId, { after: 0, limit: 500 })
    const match = events.find((e) => matcher(e))
    if (match) return match
    await delay(25)
  }
  throw new Error(`Timed out waiting for matching event in session ${sessionId}`)
}

async function waitForEventCount(sessionId, minCount, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { events } = listAcpEvents(sessionId, { after: 0, limit: 500 })
    if (events.length >= minCount) return events
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${minCount} events in session ${sessionId}`)
}

// ── Test 1: createAcpSession creates idle session ──

test('createAcpSession creates session in idle state', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const result = createAcpSession({ agentType: 'raw', cwd: process.cwd() })
  assert.ok(result.sessionId)
  assert.equal(result.state, 'idle')

  const session = getAcpSessionById(result.sessionId)
  assert.ok(session)
  assert.equal(session.agentType, 'raw')
  assert.equal(session.state, 'idle')
})

test('ACP lifecycle hook receives create -> running -> terminal transitions', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const transitions = []
  const detach = setAcpSessionTransitionHook((event) => {
    transitions.push(`${event.fromState || 'none'}->${event.toState}`)
  })
  t.after(() => detach())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "process.stdin.on(\'data\', () => { console.log(JSON.stringify({type:\'message_stop\',message:{stop_reason:\'end_turn\'}})); process.exit(0); })"',
    timeoutMs: 8_000,
  })

  await enqueuePrompt(sessionId, { prompt: 'hello' })
  await waitForEventType(sessionId, 'done')
  await waitForState(sessionId, ['done', 'error'])

  assert.ok(transitions.includes('idle->running'))
  assert.ok(transitions.some((item) => item === 'running->done' || item === 'running->error'))
})

// ── Test 2: enqueuePrompt spawns agent and produces events ──

test('enqueuePrompt spawns agent and events appear in ring buffer', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "process.stdin.on(\'data\', () => { console.log(JSON.stringify({type:\'message_stop\',message:{stop_reason:\'end_turn\'}})); process.exit(0); })"',
    timeoutMs: 8_000,
  })

  await enqueuePrompt(sessionId, { prompt: 'hello' })
  const doneEvent = await waitForEventType(sessionId, 'done')
  assert.equal(doneEvent.type, 'done')
  assert.equal(doneEvent.stopReason, 'end_turn')
})

test('enqueuePrompt can continue on same session after terminal state', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "process.stdin.on(\'data\', () => { console.log(JSON.stringify({type:\'message_stop\',message:{stop_reason:\'end_turn\'}})); process.exit(0); })"',
    timeoutMs: 8_000,
  })

  await enqueuePrompt(sessionId, { prompt: 'first task' })
  const firstDone = await waitForEventType(sessionId, 'done')
  assert.equal(firstDone.type, 'done')
  await waitForState(sessionId, 'done')

  await enqueuePrompt(sessionId, { prompt: 'second task' })
  await waitForState(sessionId, 'done')

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 500 })
  const doneEvents = events.filter((event) => event.type === 'done')
  assert.ok(doneEvents.length >= 1, `Expected >=1 done event, got ${doneEvents.length}`)
})

test('session reuse clears prior event buffer and keeps only current turn events', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "process.stdin.on(\'data\', () => { console.log(JSON.stringify({type:\'message_stop\',message:{stop_reason:\'end_turn\'}})); process.exit(0); })"',
    timeoutMs: 8_000,
  })

  const first = await enqueuePrompt(sessionId, { prompt: 'first task' })
  await waitForState(sessionId, 'done')
  const firstEvents = listAcpEvents(sessionId, { after: 0, limit: 500 }).events
  assert.ok(firstEvents.some((event) => event.turnId === first.turnId))

  const second = await enqueuePrompt(sessionId, { prompt: 'second task' })
  await waitForState(sessionId, 'done')
  const secondEvents = listAcpEvents(sessionId, { after: 0, limit: 500 }).events
  assert.ok(secondEvents.length > 0)
  assert.ok(secondEvents.every((event) => event.turnId === second.turnId))
  assert.ok(secondEvents.every((event) => event.turnId !== first.turnId))
})

// ── Test 3: Non-JSON stdout → status event ──

test('non-JSON stdout lines become status events', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "console.log(\'plain text output\'); console.log(\'another line\')"',
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  await waitForState(sessionId, ['done', 'error'])

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 500 })
  const statusEvents = events.filter((e) => e.type === 'status' && !e.text.startsWith('[stderr]'))
  assert.ok(statusEvents.length >= 1, `Expected at least 1 status event, got ${statusEvents.length}`)
  assert.ok(statusEvents.some((e) => e.text.includes('plain text output')))
})

test('default claude-code command includes dangerously-skip-permissions flag', () => {
  const command = resolveDefaultCommand('claude-code', 'hello')
  assert.ok(Array.isArray(command))
  assert.ok(command.includes('--dangerously-skip-permissions'))
  const disallowedIdx = command.indexOf('--disallowedTools')
  assert.ok(disallowedIdx >= 0)
  assert.equal(command[disallowedIdx + 1], 'AskUserQuestion')
})

test('default claude-code command omits non-interactive flag when capability is disabled', (t) => {
  const prev = process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS
  process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS = 'false'
  t.after(() => {
    if (prev == null) delete process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS
    else process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS = prev
  })

  const command = resolveDefaultCommand('claude-code', 'hello')
  assert.ok(Array.isArray(command))
  assert.equal(command.includes('--non-interactive-permissions'), false)
})

test('default claude-code command includes non-interactive fail-safe flag when capability is enabled', (t) => {
  const prev = process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS
  process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS = 'true'
  t.after(() => {
    if (prev == null) delete process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS
    else process.env.TRAPEZOHE_CLAUDE_SUPPORTS_NON_INTERACTIVE_PERMISSIONS = prev
  })

  const command = resolveDefaultCommand('claude-code', 'hello')
  assert.ok(Array.isArray(command))
  assert.ok(command.includes('--non-interactive-permissions'))
  const idx = command.indexOf('--non-interactive-permissions')
  assert.equal(command[idx + 1], 'fail')
})

test('default codex command injects safe reasoning effort override', () => {
  const command = resolveDefaultCommand('codex', 'hello')
  assert.ok(Array.isArray(command))
  assert.ok(command.includes('-c'))
  const idx = command.indexOf('-c')
  assert.equal(command[idx + 1], 'model_reasoning_effort=high')
})

test('default claude-code command can pin a stable claude session id', () => {
  const sessionId = '123e4567-e89b-12d3-a456-426614174000'
  const command = resolveDefaultCommand('claude-code', 'hello', sessionId)
  assert.ok(Array.isArray(command))
  const idx = command.indexOf('--session-id')
  assert.ok(idx >= 0)
  assert.equal(command[idx + 1], sessionId)
})

test('enqueuePrompt preserves explicit claude auth env after inherited sanitization', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const prevToken = process.env.ANTHROPIC_AUTH_TOKEN
  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_AUTH_TOKEN = 'inherited_stale_token'
  process.env.ANTHROPIC_BASE_URL = 'https://inherited.example'
  t.after(() => {
    if (prevToken == null) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = prevToken
    if (prevBaseUrl == null) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = prevBaseUrl
  })

  const { sessionId } = createAcpSession({
    agentType: 'claude-code',
    cwd: process.cwd(),
    command: ['node', '-e', 'console.log(process.env.ANTHROPIC_AUTH_TOKEN || "missing"); console.log(process.env.ANTHROPIC_BASE_URL || "no_base")'],
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, {
    prompt: 'check env',
    env: {
      ANTHROPIC_AUTH_TOKEN: 'explicit_runtime_token',
      ANTHROPIC_BASE_URL: 'https://runtime.example',
    },
  })
  await waitForState(sessionId, ['done', 'error'])

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 200 })
  const statuses = events
    .filter((event) => event.type === 'status')
    .map((event) => event.text || '')
  assert.ok(statuses.some((line) => line.includes('explicit_runtime_token')))
  assert.ok(statuses.some((line) => line.includes('https://runtime.example')))
  assert.ok(statuses.every((line) => !line.includes('inherited_stale_token')))
})

test('enqueuePrompt strips inherited Claude runtime marker env to avoid nested sessions', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const prevEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  const prevClaudeCode = process.env.CLAUDECODE
  process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode'
  process.env.CLAUDECODE = '1'
  t.after(() => {
    if (prevEntrypoint == null) delete process.env.CLAUDE_CODE_ENTRYPOINT
    else process.env.CLAUDE_CODE_ENTRYPOINT = prevEntrypoint
    if (prevClaudeCode == null) delete process.env.CLAUDECODE
    else process.env.CLAUDECODE = prevClaudeCode
  })

  const { sessionId } = createAcpSession({
    agentType: 'claude-code',
    cwd: process.cwd(),
    command: ['node', '-e', 'console.log("ENTRY=" + (process.env.CLAUDE_CODE_ENTRYPOINT || "unset")); console.log("CCODE=" + (process.env.CLAUDECODE || "unset"))'],
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: 'check runtime markers' })
  await waitForState(sessionId, ['done', 'error'])

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 200 })
  const statuses = events
    .filter((event) => event.type === 'status')
    .map((event) => event.text || '')
  assert.ok(statuses.some((line) => line.includes('ENTRY=unset')))
  assert.ok(statuses.some((line) => line.includes('CCODE=unset')))
})

test('enqueuePrompt preserves inherited Claude auth env by default', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const prevToken = process.env.ANTHROPIC_AUTH_TOKEN
  const prevCrsKey = process.env.CRS_OAI_KEY
  const prevApiKey = process.env.ANTHROPIC_API_KEY
  const prevImportShellEnv = process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV
  process.env.ANTHROPIC_AUTH_TOKEN = 'inherited_stale_token'
  delete process.env.CRS_OAI_KEY
  delete process.env.ANTHROPIC_API_KEY
  process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV = 'false'
  t.after(() => {
    if (prevToken == null) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = prevToken
    if (prevCrsKey == null) delete process.env.CRS_OAI_KEY
    else process.env.CRS_OAI_KEY = prevCrsKey
    if (prevApiKey == null) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevApiKey
    if (prevImportShellEnv == null) delete process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV
    else process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV = prevImportShellEnv
  })

  const { sessionId } = createAcpSession({
    agentType: 'claude-code',
    cwd: process.cwd(),
    command: ['node', '-e', 'console.log(process.env.ANTHROPIC_AUTH_TOKEN || "missing")'],
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: 'check inherited env' })
  await waitForState(sessionId, ['done', 'error'])

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 200 })
  const statuses = events
    .filter((event) => event.type === 'status')
    .map((event) => event.text || '')
  assert.ok(statuses.some((line) => line.includes('inherited_stale_token')))
})

test('enqueuePrompt keeps CRS/AUTH env unchanged by default', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const prevToken = process.env.ANTHROPIC_AUTH_TOKEN
  const prevCrsKey = process.env.CRS_OAI_KEY
  const prevApiKey = process.env.ANTHROPIC_API_KEY
  const prevImportShellEnv = process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV
  process.env.ANTHROPIC_AUTH_TOKEN = 'cr_should_be_stripped'
  process.env.CRS_OAI_KEY = 'cr_test_crs_key'
  delete process.env.ANTHROPIC_API_KEY
  process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV = 'false'
  t.after(() => {
    if (prevToken == null) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = prevToken
    if (prevCrsKey == null) delete process.env.CRS_OAI_KEY
    else process.env.CRS_OAI_KEY = prevCrsKey
    if (prevApiKey == null) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevApiKey
    if (prevImportShellEnv == null) delete process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV
    else process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV = prevImportShellEnv
  })

  const { sessionId } = createAcpSession({
    agentType: 'claude-code',
    cwd: process.cwd(),
    command: ['node', '-e', 'process.stderr.write("API_KEY=" + (process.env.ANTHROPIC_API_KEY || "unset") + "\\n"); process.stderr.write("AUTH_TOKEN=" + (process.env.ANTHROPIC_AUTH_TOKEN || "unset") + "\\n")'],
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: 'check CRS env' })
  await waitForState(sessionId, ['done', 'error'])

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 200 })
  const statuses = events
    .filter((event) => event.type === 'status')
    .map((event) => event.text || '')
  // Default behavior is preserve: do not rewrite CRS token into API key
  assert.ok(statuses.some((line) => line.includes('API_KEY=unset')))
  // Keep inherited auth token intact
  assert.ok(statuses.some((line) => line.includes('AUTH_TOKEN=cr_should_be_stripped')))
})

test('legacy auth rewrite mode promotes CRS key and strips auth token', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const prevToken = process.env.ANTHROPIC_AUTH_TOKEN
  const prevCrsKey = process.env.CRS_OAI_KEY
  const prevApiKey = process.env.ANTHROPIC_API_KEY
  const prevImportShellEnv = process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV
  const prevLegacyRewrite = process.env.TRAPEZOHE_ACP_LEGACY_AUTH_REWRITE
  process.env.ANTHROPIC_AUTH_TOKEN = 'cr_should_be_stripped'
  process.env.CRS_OAI_KEY = 'cr_test_crs_key'
  delete process.env.ANTHROPIC_API_KEY
  process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV = 'false'
  process.env.TRAPEZOHE_ACP_LEGACY_AUTH_REWRITE = 'true'
  t.after(() => {
    if (prevToken == null) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = prevToken
    if (prevCrsKey == null) delete process.env.CRS_OAI_KEY
    else process.env.CRS_OAI_KEY = prevCrsKey
    if (prevApiKey == null) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevApiKey
    if (prevImportShellEnv == null) delete process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV
    else process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV = prevImportShellEnv
    if (prevLegacyRewrite == null) delete process.env.TRAPEZOHE_ACP_LEGACY_AUTH_REWRITE
    else process.env.TRAPEZOHE_ACP_LEGACY_AUTH_REWRITE = prevLegacyRewrite
  })

  const { sessionId } = createAcpSession({
    agentType: 'claude-code',
    cwd: process.cwd(),
    command: ['node', '-e', 'process.stderr.write("API_KEY=" + (process.env.ANTHROPIC_API_KEY || "unset") + "\\n"); process.stderr.write("AUTH_TOKEN=" + (process.env.ANTHROPIC_AUTH_TOKEN || "unset") + "\\n")'],
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: 'check legacy rewrite env' })
  await waitForState(sessionId, ['done', 'error'])

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 200 })
  const statuses = events
    .filter((event) => event.type === 'status')
    .map((event) => event.text || '')
  assert.ok(statuses.some((line) => line.includes('API_KEY=cr_test_crs_key')))
  assert.ok(statuses.some((line) => line.includes('AUTH_TOKEN=unset')))
})

test('resolveAgentAuthCheck allows claude-code without auth env by default', () => {
  const result = resolveAgentAuthCheck('claude-code', {})
  assert.equal(result.blocking, false)
  assert.deepEqual(result.missingKeys, [])
})

test('resolveAgentAuthCheck can block missing claude auth env in strict mode', (t) => {
  const prev = process.env.TRAPEZOHE_ACP_ENFORCE_CLAUDE_AUTH_ENV
  process.env.TRAPEZOHE_ACP_ENFORCE_CLAUDE_AUTH_ENV = 'true'
  t.after(() => {
    if (prev == null) delete process.env.TRAPEZOHE_ACP_ENFORCE_CLAUDE_AUTH_ENV
    else process.env.TRAPEZOHE_ACP_ENFORCE_CLAUDE_AUTH_ENV = prev
  })

  const result = resolveAgentAuthCheck('claude-code', {})
  assert.equal(result.blocking, true)
  assert.ok(result.message?.includes('ANTHROPIC_AUTH_TOKEN'))
})

test('resolveAgentAuthCheck marks base URL as missing for custom cr_ token', () => {
  const result = resolveAgentAuthCheck('claude-code', {
    ANTHROPIC_AUTH_TOKEN: 'cr_token_like_value',
  })
  assert.equal(result.blocking, false)
  assert.deepEqual(result.missingKeys, ['ANTHROPIC_BASE_URL'])
})

test('normalizeClaudeAuthEnv promotes CRS_OAI_KEY to ANTHROPIC_API_KEY', () => {
  const env = normalizeClaudeAuthEnv({
    CRS_OAI_KEY: 'cr_from_crs',
    ANTHROPIC_BASE_URL: 'https://example.test',
  })
  assert.equal(env.ANTHROPIC_API_KEY, 'cr_from_crs')
})

test('normalizeClaudeAuthEnv promotes real API key from ANTHROPIC_AUTH_TOKEN', () => {
  // cr_ tokens are OAuth credentials — should NOT be promoted
  const crEnv = normalizeClaudeAuthEnv({
    ANTHROPIC_AUTH_TOKEN: 'cr_from_auth_token',
  })
  assert.equal(crEnv.ANTHROPIC_API_KEY, undefined)

  // sk- tokens are real API keys — should be promoted
  const skEnv = normalizeClaudeAuthEnv({
    ANTHROPIC_AUTH_TOKEN: 'sk-ant-real-api-key',
  })
  assert.equal(skEnv.ANTHROPIC_API_KEY, 'sk-ant-real-api-key')
})

test('normalizeClaudeAuthEnv does not promote oauth-like auth token', () => {
  const env = normalizeClaudeAuthEnv({
    ANTHROPIC_AUTH_TOKEN: 'oauth_token_like_value',
  })
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
})

test('resolveAgentAuthCheck allows codex without auth env hard block', () => {
  const result = resolveAgentAuthCheck('codex', {})
  assert.equal(result.blocking, false)
  assert.deepEqual(result.missingKeys, [])
})

test('codex sessions bootstrap isolated CODEX_HOME with copied auth scaffold', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const home = mkdtempSync(join(tmpdir(), 'acp-codex-home-'))
  const sourceCodexHome = join(home, '.codex')
  const runtimeCodexHome = join(home, '.trapezohe', 'codex-home-test')
  mkdirSync(sourceCodexHome, { recursive: true })
  writeFileSync(join(sourceCodexHome, 'auth.json'), '{"token":"source-auth"}\n', 'utf8')

  const prevHome = process.env.HOME
  const prevCodeHome = process.env.CODEX_HOME
  const prevImportShellEnv = process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV
  const prevIsolate = process.env.TRAPEZOHE_ACP_CODEX_ISOLATE_HOME
  const prevRuntimeHome = process.env.TRAPEZOHE_ACP_CODEX_RUNTIME_HOME
  process.env.HOME = home
  delete process.env.CODEX_HOME
  process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV = 'false'
  process.env.TRAPEZOHE_ACP_CODEX_ISOLATE_HOME = 'true'
  process.env.TRAPEZOHE_ACP_CODEX_RUNTIME_HOME = runtimeCodexHome

  t.after(() => {
    rmSync(home, { recursive: true, force: true })
    if (prevHome == null) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevCodeHome == null) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodeHome
    if (prevImportShellEnv == null) delete process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV
    else process.env.TRAPEZOHE_ACP_IMPORT_SHELL_ENV = prevImportShellEnv
    if (prevIsolate == null) delete process.env.TRAPEZOHE_ACP_CODEX_ISOLATE_HOME
    else process.env.TRAPEZOHE_ACP_CODEX_ISOLATE_HOME = prevIsolate
    if (prevRuntimeHome == null) delete process.env.TRAPEZOHE_ACP_CODEX_RUNTIME_HOME
    else process.env.TRAPEZOHE_ACP_CODEX_RUNTIME_HOME = prevRuntimeHome
  })

  const { sessionId } = createAcpSession({
    agentType: 'codex',
    cwd: process.cwd(),
    command: ['node', '-e', 'const fs=require("node:fs");const path=require("node:path");const home=process.env.CODEX_HOME||"unset";console.log("CODEX_HOME="+home);if(home==="unset"){console.log("AUTH=missing")}else{const authPath=path.join(home,"auth.json");console.log("AUTH="+(fs.existsSync(authPath)?fs.readFileSync(authPath,"utf8").trim():"missing"))}'],
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: 'check codex runtime home' })
  await waitForState(sessionId, ['done', 'error'])

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 200 })
  const statuses = events
    .filter((event) => event.type === 'status')
    .map((event) => event.text || '')
  assert.ok(statuses.some((line) => line.includes(`CODEX_HOME=${runtimeCodexHome}`)))
  assert.ok(statuses.some((line) => line.includes('AUTH={"token":"source-auth"}')))
})

test('codex stderr migration spam is condensed into stable warning statuses', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'codex',
    cwd: process.cwd(),
    command: [
      'node',
      '-e',
      [
        'console.error("2026-02-28 WARN codex_state::runtime: failed to open state db at /Users/demo/.codex/state_5.sqlite: migration 11 was previously applied but is missing");',
        'console.error("2026-02-28 WARN codex_core::state_db: state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back");',
        'console.error("2026-02-28 ERROR codex_core::models_manager::manager: failed to refresh available models: timeout waiting for child process to exit");',
      ].join(' '),
    ],
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: 'check codex stderr normalization' })
  await waitForState(sessionId, ['done', 'error'])

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 200 })
  const statusEvents = events.filter((event) => event.type === 'status')
  const stateDbWarnings = statusEvents.filter((event) => event.statusCode === 'codex_state_db_warning')
  const modelWarnings = statusEvents.filter((event) => event.statusCode === 'codex_models_refresh_warning')
  assert.equal(stateDbWarnings.length, 1)
  assert.equal(modelWarnings.length, 1)
  assert.ok(statusEvents.every((event) => !String(event.text || '').includes('failed to open state db at')))
})

test('buildAgentPath appends exec dir and deduplicates entries', () => {
  const built = buildAgentPath('/usr/bin:/bin:/usr/bin', {
    execDir: '/tmp/node/bin',
    homeDir: '',
  })
  const parts = built.split(PATH_DELIMITER)
  assert.equal(parts[0], '/usr/bin')
  assert.equal(parts[1], '/bin')
  assert.ok(parts.includes('/tmp/node/bin'))
  assert.equal(parts.filter((entry) => entry === '/usr/bin').length, 1)
})

test('buildAgentPath discovers nvm node bin directories from home', (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), 'acp-path-'))
  t.after(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  mkdirSync(join(homeDir, '.nvm', 'versions', 'node', 'v22.12.0', 'bin'), { recursive: true })
  mkdirSync(join(homeDir, '.nvm', 'versions', 'node', 'v20.11.1', 'bin'), { recursive: true })

  const built = buildAgentPath('/usr/bin:/bin', {
    execDir: '/tmp/node/bin',
    homeDir,
  })
  const parts = built.split(PATH_DELIMITER)
  assert.ok(parts.includes(join(homeDir, '.nvm', 'versions', 'node', 'v22.12.0', 'bin')))
  assert.ok(parts.includes(join(homeDir, '.nvm', 'versions', 'node', 'v20.11.1', 'bin')))
})

// ── Test 4: Claude content_block_delta → text_delta ──

test('Claude content_block_delta text_delta normalizes to text_delta event', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const claudeEvent = JSON.stringify({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: 'Hello world' },
  })

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: ['node', '-e', `console.log(${JSON.stringify(claudeEvent)})`],
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  const event = await waitForEventType(sessionId, 'text_delta')
  assert.equal(event.type, 'text_delta')
  assert.equal(event.text, 'Hello world')
})

test('Claude user tool_result error is surfaced as status signal', () => {
  const line = JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          is_error: true,
          content: 'Requested permissions were not granted yet.',
        },
      ],
    },
  })
  const events = parseAgentLine(line, { agentType: 'claude-code', currentTurnId: 'turn-1' })
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'status')
  assert.equal(events[0].statusCode, 'awaiting_approval')
  assert.match(events[0].text, /awaiting_approval/i)
})

test('Claude user non-error tool_result emits condensed diagnostic summary', () => {
  const session = {
    agentType: 'claude-code',
    currentTurnId: 'turn-1',
    toolCallsById: new Map([
      ['toolu_read_1', { tool: 'Read', targetSummary: 'file=/tmp/index.html' }],
    ]),
  }
  const line = JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', is_error: false, tool_use_id: 'toolu_read_1', content: 'line1\nline2\nline3' },
      ],
    },
  })
  const events = parseAgentLine(line, session)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'status')
  assert.equal(events[0].statusCode, 'tool_result_ok')
  assert.match(events[0].text || '', /\[tool_result]/)
  assert.match(events[0].text || '', /Read/)
  assert.match(events[0].text || '', /chars=/)
  assert.match(events[0].text || '', /lines=/)
})

test('Claude tool_result diagnostics can be disabled via env flag', (t) => {
  const prev = process.env.TRAPEZOHE_ACP_DIAGNOSTIC_TOOL_RESULTS
  process.env.TRAPEZOHE_ACP_DIAGNOSTIC_TOOL_RESULTS = 'false'
  t.after(() => {
    if (prev == null) delete process.env.TRAPEZOHE_ACP_DIAGNOSTIC_TOOL_RESULTS
    else process.env.TRAPEZOHE_ACP_DIAGNOSTIC_TOOL_RESULTS = prev
  })

  const line = JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', is_error: false, tool_use_id: 'toolu_read_1', content: 'ok' },
      ],
    },
  })
  const events = parseAgentLine(line, {
    agentType: 'claude-code',
    currentTurnId: 'turn-1',
    toolCallsById: new Map([['toolu_read_1', { tool: 'Read', targetSummary: 'file=/tmp/index.html' }]]),
  })
  assert.equal(events.length, 0)
})

test('Claude init event surfaces runtime session_id as status event', () => {
  const line = JSON.stringify({
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-4-6',
    session_id: 'runtime-session-abc',
  })
  const session = { agentType: 'claude-code', currentTurnId: 'turn-1' }
  const events = parseAgentLine(line, session)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'status')
  assert.equal(events[1].type, 'status')
  assert.equal(events[1].statusCode, 'runtime_session_id')
  assert.match(events[1].text || '', /session_id=runtime-session-abc/)
})

test('Claude assistant thinking block emits throttled model_thinking status', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'internal reasoning' },
      ],
    },
  })

  const session = { agentType: 'claude-code', currentTurnId: 'turn-1', lastThinkingStatusAt: 0 }
  const first = parseAgentLine(line, session)
  assert.equal(first.length, 1)
  assert.equal(first[0].type, 'status')
  assert.equal(first[0].statusCode, 'model_thinking')

  const second = parseAgentLine(line, session)
  assert.equal(second.length, 0)
})

// ── Test 5: Claude message_stop → done ──

test('Claude message_stop normalizes to done event', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const claudeEvent = JSON.stringify({
    type: 'message_stop',
    message: { stop_reason: 'end_turn' },
  })

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: ['node', '-e', `console.log(${JSON.stringify(claudeEvent)})`],
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  const event = await waitForEventType(sessionId, 'done')
  assert.equal(event.type, 'done')
  assert.equal(event.stopReason, 'end_turn')
})

// ── Test 6: Zero exit without done → forced done event ──

test('zero exit without message_stop synthesizes done event', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "console.log(\'no-terminal-event\'); process.exit(0)"',
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  await waitForState(sessionId, ['done', 'error'])

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 500 })
  const doneEvents = events.filter((e) => e.type === 'done')
  assert.ok(doneEvents.length >= 1, 'Expected at least one done event')
  assert.equal(doneEvents[0].stopReason, 'process_exit')
})

// ── Test 7: Non-zero exit → forced error event ──

test('non-zero exit synthesizes error event with process_exit code', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "process.exit(42)"',
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  await waitForState(sessionId, ['done', 'error'])

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 500 })
  const errorEvents = events.filter((e) => e.type === 'error')
  assert.ok(errorEvents.length >= 1, 'Expected at least one error event')
  assert.equal(errorEvents[0].code, 'process_exit')
  assert.equal(errorEvents[0].exitCode, 42)
})

// ── Test 8: Spawn failure → error event ──

test('spawn failure produces spawn_failed error event', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: ['/nonexistent/binary/that/does/not/exist'],
    timeoutMs: 5_000,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  // Wait a bit for spawn failure to propagate
  await delay(200)

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 500 })
  const errorEvents = events.filter((e) => e.type === 'error')
  assert.ok(errorEvents.length >= 1, 'Expected at least one error event for spawn failure')
  assert.ok(
    errorEvents.some((e) => e.code === 'spawn_failed'),
    `Expected spawn_failed code, got: ${JSON.stringify(errorEvents.map((e) => e.code))}`,
  )
})

// ── Test 9: Timeout → error event ──

test('timeout produces timeout error event', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "setInterval(() => {}, 60000)"',
    timeoutMs: 1_000, // 1 second timeout
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  await waitForState(sessionId, ['timeout', 'error', 'done'], 10_000)

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 500 })
  const errorEvents = events.filter((e) => e.type === 'error')
  assert.ok(errorEvents.length >= 1, 'Expected at least one error event for timeout')
  assert.ok(
    errorEvents.some((e) => e.code === 'timeout'),
    `Expected timeout code, got: ${JSON.stringify(errorEvents.map((e) => e.code))}`,
  )
})

test('no-output watchdog emits status heartbeat while process is silent', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "setTimeout(() => process.exit(0), 450)"',
    timeoutMs: 0,
    noOutputHeartbeatMs: 100,
    noOutputCheckIntervalMs: 25,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  await waitForEventMatch(
    sessionId,
    (event) => event.type === 'status' && /waiting for model response/i.test(event.text || ''),
    5_000,
  )
  await waitForState(sessionId, 'done', 5_000)
})

test('no-output watchdog emits session probe diagnostics for long silence', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "setTimeout(() => process.exit(0), 900)"',
    timeoutMs: 0,
    noOutputHeartbeatMs: 100,
    noOutputCheckIntervalMs: 25,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  await waitForEventMatch(
    sessionId,
    (event) => event.type === 'status' && event.statusCode === 'session_probe',
    5_000,
  )

  const { events } = listAcpEvents(sessionId, { after: 0, limit: 500 })
  const probes = events.filter((event) => event.type === 'status' && event.statusCode === 'session_probe')
  assert.ok(probes.length >= 1)
  assert.ok(probes.some((event) => /state=running/.test(event.text || '')))
  assert.ok(probes.some((event) => /alive=/.test(event.text || '')))
  await waitForState(sessionId, 'done', 5_000)
})

test('classifyNoOutputDiagnostic returns auth when missing auth keys are present', () => {
  const result = classifyNoOutputDiagnostic({
    agentType: 'claude-code',
    missingKeys: ['ANTHROPIC_BASE_URL'],
    recentEvents: [],
  })
  assert.equal(result.kind, 'auth')
  assert.equal(result.statusCode, 'no_output_auth')
})

test('classifyNoOutputDiagnostic returns network for transport errors', () => {
  const result = classifyNoOutputDiagnostic({
    agentType: 'claude-code',
    missingKeys: [],
    recentEvents: [
      {
        type: 'status',
        statusCode: 'stderr',
        text: '[stderr] client_error: Failed to fetch',
      },
    ],
  })
  assert.equal(result.kind, 'network')
  assert.equal(result.statusCode, 'no_output_network')
})

test('classifyNoOutputDiagnostic returns model queue when initialized but no content yet', () => {
  const result = classifyNoOutputDiagnostic({
    agentType: 'claude-code',
    missingKeys: [],
    recentEvents: [
      {
        type: 'status',
        text: '[claude-code] initialized (model=claude-sonnet-4-6)',
      },
    ],
  })
  assert.equal(result.kind, 'model_queue')
  assert.equal(result.statusCode, 'no_output_model_queue')
})

test('classifyNoOutputDiagnostic returns tool_wait when silence follows tool execution', () => {
  const result = classifyNoOutputDiagnostic({
    agentType: 'claude-code',
    missingKeys: [],
    recentEvents: [
      {
        type: 'status',
        text: '[claude-code] initialized (model=claude-sonnet-4-6)',
      },
      {
        type: 'tool_call',
        tool: 'Read',
      },
    ],
  })
  assert.equal(result.kind, 'tool_wait')
  assert.equal(result.statusCode, 'no_output_tool_wait')
})

test('classifyNoOutputDiagnostic returns cli blocked when no protocol signal exists', () => {
  const result = classifyNoOutputDiagnostic({
    agentType: 'claude-code',
    missingKeys: [],
    recentEvents: [],
  })
  assert.equal(result.kind, 'cli_blocked')
  assert.equal(result.statusCode, 'no_output_cli_blocked')
})

test('no-output watchdog emits classified network diagnostic status', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "console.error(\'client_error: Failed to fetch\'); setTimeout(() => process.exit(0), 550)"',
    timeoutMs: 0,
    noOutputHeartbeatMs: 100,
    noOutputCheckIntervalMs: 25,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  const diagnostic = await waitForEventMatch(
    sessionId,
    (event) => event.type === 'status' && event.statusCode === 'no_output_network',
    5_000,
  )
  assert.match(diagnostic.text || '', /network/i)
  await waitForState(sessionId, 'done', 5_000)
})

test('no-output watchdog emits classified tool_wait diagnostic status', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const toolUseLine = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'demo.txt' } },
      ],
    },
  })

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: ['node', '-e', `console.log(${JSON.stringify(toolUseLine)}); setTimeout(() => process.exit(0), 700)`],
    timeoutMs: 0,
    noOutputHeartbeatMs: 100,
    noOutputCheckIntervalMs: 25,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  const diagnostic = await waitForEventMatch(
    sessionId,
    (event) => event.type === 'status' && event.statusCode === 'no_output_tool_wait',
    5_000,
  )
  assert.match(diagnostic.text || '', /tool/i)
  await waitForState(sessionId, 'done', 5_000)
})

// ── Test 10: Cancel idempotent ──

test('cancelAcpSession is idempotent — two calls return same promise', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "setInterval(() => {}, 60000)"',
    timeoutMs: 30_000,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  await delay(100)

  const promise1 = cancelAcpSession(sessionId)
  const promise2 = cancelAcpSession(sessionId)
  assert.equal(promise1, promise2, 'Cancel should return the same promise for idempotency')

  const result = await promise1
  assert.equal(result.ok, true)
  assert.equal(result.state, 'cancelled')
})

// ── Test 11: Actor queue serializes operations ──

test('actor queue serializes operations in order', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const order = []

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "process.stdin.setEncoding(\'utf8\'); process.stdin.on(\'data\', d => { console.log(\'GOT:\' + d.trim()); if (d.includes(\'quit\')) process.exit(0); })"',
    timeoutMs: 10_000,
  })

  // First prompt spawns the process
  await enqueuePrompt(sessionId, { prompt: 'start' })
  await delay(200)

  // Enqueue two steers rapidly
  const p1 = enqueueSteer(sessionId, { text: 'first', submit: true }).then(() => order.push(1))
  const p2 = enqueueSteer(sessionId, { text: 'quit', submit: true }).then(() => order.push(2))

  await Promise.all([p1, p2])
  assert.deepEqual(order, [1, 2], 'Operations should complete in enqueue order')
})

// ── Test 12: Actor queue error isolation ──

test('actor queue error in one op does not block the next', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "setTimeout(() => process.exit(0), 500)"',
    timeoutMs: 5_000,
  })

  // First prompt spawns
  await enqueuePrompt(sessionId, { prompt: '' })

  // Wait for process to exit
  await waitForState(sessionId, ['done', 'error'])

  // Now trying to steer a terminated session should fail in the queue,
  // but the session should remain accessible
  try {
    await enqueueSteer(sessionId, { text: 'fail' })
  } catch {
    // Expected to fail
  }

  // Session should still be queryable
  const session = getAcpSessionById(sessionId)
  assert.ok(session, 'Session should still be accessible after queue error')
})

// ── Test 13: Cancel bypasses queue ──

test('cancel bypasses actor queue and terminates immediately', async (t) => {
  cleanupAllAcpSessions()
  t.after(() => cleanupAllAcpSessions())

  const { sessionId } = createAcpSession({
    agentType: 'raw',
    cwd: process.cwd(),
    command: 'node -e "setInterval(() => {}, 60000)"',
    timeoutMs: 60_000,
  })

  await enqueuePrompt(sessionId, { prompt: '' })
  await delay(200)

  // Cancel should not wait for any queued operations
  const cancelStart = Date.now()
  const result = await cancelAcpSession(sessionId)
  const cancelDuration = Date.now() - cancelStart

  assert.equal(result.ok, true)
  assert.equal(result.state, 'cancelled')
  // Cancel should complete in well under the 60s timeout
  assert.ok(cancelDuration < 10_000, `Cancel took too long: ${cancelDuration}ms`)

  // Verify terminal event was emitted
  const { events } = listAcpEvents(sessionId, { after: 0, limit: 500 })
  const terminalEvents = events.filter((e) => e.type === 'error' || e.type === 'done')
  assert.ok(terminalEvents.length >= 1, 'Expected terminal event after cancel')
})
