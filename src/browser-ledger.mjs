import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureConfigDir, getConfigDir } from './config.mjs'
import {
  linkRunToBrowserAction,
  linkRunToBrowserSession,
} from './run-store.mjs'

const FILE_MODE = 0o600
const MAX_BROWSER_SESSIONS = Math.max(1, Number(process.env.TRAPEZOHE_MAX_BROWSER_SESSIONS || 50) || 50)
const MAX_BROWSER_ACTIONS_PER_SESSION = Math.max(
  1,
  Number(process.env.TRAPEZOHE_MAX_BROWSER_ACTIONS_PER_SESSION || 200) || 200,
)
const MAX_BROWSER_ARTIFACTS_PER_SESSION = Math.max(
  1,
  Number(process.env.TRAPEZOHE_MAX_BROWSER_ARTIFACTS_PER_SESSION || 50) || 50,
)
const MAX_BROWSER_ORPHAN_RETENTION_MS = Math.max(
  1_000,
  Number(process.env.TRAPEZOHE_MAX_BROWSER_ORPHAN_RETENTION_MS || 10 * 60 * 1000) || 10 * 60 * 1000,
)
const MAX_BROWSER_EVENTS = Math.max(
  1,
  Number(process.env.TRAPEZOHE_MAX_BROWSER_EVENTS || 500) || 500,
)
const WRITE_DEBOUNCE_MS = Math.max(50, Number(process.env.TRAPEZOHE_BROWSER_LEDGER_WRITE_DEBOUNCE_MS || 250) || 250)

function BROWSER_LEDGER_FILE() {
  return path.join(getConfigDir(), 'browser-ledger.json')
}

function BROWSER_LEDGER_BACKUP_FILE() {
  return path.join(getConfigDir(), 'browser-ledger.json.bak')
}

let store = { sessions: [], actions: [], artifacts: [], events: [], nextCursor: 1 }
let loaded = false
let persistTimer = null
let persistPromise = null
let loadingPromise = null

function now() {
  return Date.now()
}

function clone(value) {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value))
}

function normalizeSupportedFeatures(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {}
}

function clampInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function normalizeTimestamp(value, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(0, Math.floor(numeric))
}

function safeText(value, maxChars = 1_000) {
  const normalized = String(value || '').trim()
  if (!normalized) return undefined
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(32, maxChars - 16)).trimEnd()}...[truncated]`
}

function safeChmod(target, mode) {
  return fs.chmod(target, mode).catch((err) => {
    if (err.code === 'ENOSYS' || err.code === 'EPERM' || err.code === 'EINVAL') return undefined
    throw err
  })
}

function sortByTimestampDescending(items, getTimestamp) {
  return items.slice().sort((a, b) => getTimestamp(b) - getTimestamp(a))
}

function sessionSortKey(entry) {
  return (
    normalizeTimestamp(entry?.session?.updatedAt, undefined)
    ?? normalizeTimestamp(entry?.session?.createdAt, undefined)
    ?? normalizeTimestamp(entry?.syncedAt, 0)
  )
}

function actionSortKey(entry) {
  return (
    normalizeTimestamp(entry?.action?.finishedAt, undefined)
    ?? normalizeTimestamp(entry?.action?.startedAt, undefined)
    ?? normalizeTimestamp(entry?.syncedAt, 0)
  )
}

function artifactSortKey(entry) {
  return (
    normalizeTimestamp(entry?.artifact?.createdAt, undefined)
    ?? normalizeTimestamp(entry?.syncedAt, 0)
  )
}

function eventSortKey(entry) {
  return normalizeTimestamp(entry?.cursor, 0)
}

function readLinkedField(entry, field) {
  if (!entry || typeof entry !== 'object') return undefined
  if (entry.link && typeof entry.link === 'object' && safeText(entry.link[field], 200)) {
    return safeText(entry.link[field], 200)
  }
  const ownerRecord = entry.session && typeof entry.session === 'object'
    ? entry.session
    : entry.action && typeof entry.action === 'object'
      ? entry.action
      : null
  if (!ownerRecord) return undefined
  switch (field) {
    case 'runId':
      return safeText(ownerRecord.ownerRunId, 200)
    case 'conversationId':
      return safeText(ownerRecord.ownerConversationId, 200)
    case 'sourceToolName':
      return safeText(ownerRecord.sourceToolName, 200)
    case 'sourceToolCallId':
      return safeText(ownerRecord.sourceToolCallId, 200)
    case 'approvalRequestId':
      return safeText(ownerRecord.approvalRequestId, 200)
    default:
      return undefined
  }
}

function matchesLinkFilters(entry, query = {}) {
  const runId = safeText(query.runId, 200)
  const conversationId = safeText(query.conversationId, 200)
  const sourceToolName = safeText(query.sourceToolName, 200)
  const sourceToolCallId = safeText(query.sourceToolCallId, 200)
  const approvalRequestId = safeText(query.approvalRequestId, 200)

  if (runId && readLinkedField(entry, 'runId') !== runId) return false
  if (conversationId && readLinkedField(entry, 'conversationId') !== conversationId) return false
  if (sourceToolName && readLinkedField(entry, 'sourceToolName') !== sourceToolName) return false
  if (sourceToolCallId && readLinkedField(entry, 'sourceToolCallId') !== sourceToolCallId) return false
  if (approvalRequestId && readLinkedField(entry, 'approvalRequestId') !== approvalRequestId) return false

  return true
}

function resolveSessionTarget(entry) {
  if (!Array.isArray(entry?.targets) || entry.targets.length === 0) return null
  const primaryTargetId = safeText(entry?.session?.primaryTargetId, 200)
  if (primaryTargetId) {
    const primary = entry.targets.find((target) => target?.targetId === primaryTargetId)
    if (primary) return primary
  }
  const active = entry.targets.find((target) => target?.active === true)
  return active || entry.targets[0] || null
}

function buildRecentLinkedSessionSummary(entry) {
  const target = resolveSessionTarget(entry)
  return {
    sessionId: entry.session.sessionId,
    state: entry.session.state,
    updatedAt: normalizeTimestamp(entry.session.updatedAt, entry.syncedAt),
    ...(safeText(target?.targetId, 200) ? { targetId: safeText(target.targetId, 200) } : {}),
    ...(safeText(target?.url, 2_000) ? { url: safeText(target.url, 2_000) } : {}),
    ...(safeText(target?.title, 500) ? { title: safeText(target.title, 500) } : {}),
    link: clone(entry.link || {
      runId: readLinkedField(entry, 'runId'),
      conversationId: readLinkedField(entry, 'conversationId'),
      sourceToolName: readLinkedField(entry, 'sourceToolName'),
      sourceToolCallId: readLinkedField(entry, 'sourceToolCallId'),
      approvalRequestId: readLinkedField(entry, 'approvalRequestId'),
      updatedAt: normalizeTimestamp(entry.session.updatedAt, entry.syncedAt),
    }),
  }
}

function buildRecentLinkedActionSummary(entry) {
  return {
    actionId: entry.action.actionId,
    sessionId: entry.action.sessionId,
    ...(safeText(entry.action.targetId, 200) ? { targetId: safeText(entry.action.targetId, 200) } : {}),
    kind: entry.action.kind,
    status: entry.action.status,
    finishedAt: normalizeTimestamp(entry.action.finishedAt, entry.action.startedAt || entry.syncedAt),
    ...(entry.action.error?.code ? { errorCode: safeText(entry.action.error.code, 64) } : {}),
    ...(safeText(entry.action.resultSummary, 500) ? { resultSummary: safeText(entry.action.resultSummary, 500) } : {}),
    link: clone(entry.link || {
      runId: readLinkedField(entry, 'runId'),
      conversationId: readLinkedField(entry, 'conversationId'),
      sourceToolName: readLinkedField(entry, 'sourceToolName'),
      sourceToolCallId: readLinkedField(entry, 'sourceToolCallId'),
      approvalRequestId: readLinkedField(entry, 'approvalRequestId'),
      updatedAt: normalizeTimestamp(entry.action.finishedAt, entry.action.startedAt || entry.syncedAt),
    }),
  }
}

function normalizeCapabilities(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  return {
    navigate: input.navigate === true,
    snapshot: input.snapshot === true,
    click: input.click === true,
    type: input.type === true,
    upload: input.upload === true,
    dialog: input.dialog === true,
    console: input.console === true,
    screenshot: input.screenshot === true,
    pdf: input.pdf === true,
    ...(typeof input.debugger === 'boolean' ? { debugger: input.debugger } : {}),
  }
}

function normalizeRuntimeError(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const code = safeText(input.code, 64)
  const message = safeText(input.message, 500)
  if (!code || !message) return undefined
  return {
    code,
    message,
    retryable: input.retryable !== false,
    ...(safeText(input.hint, 500) ? { hint: safeText(input.hint, 500) } : {}),
    ...(input.details && typeof input.details === 'object' && !Array.isArray(input.details)
      ? { details: clone(input.details) }
      : {}),
  }
}

function normalizeLinkRecord(input, fallback = {}) {
  const candidate = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : fallback
  const runId = safeText(candidate.runId, 200) || safeText(fallback.runId, 200)
  if (!runId) return undefined
  return {
    runId,
    ...(safeText(candidate.conversationId, 200) || safeText(fallback.conversationId, 200)
      ? { conversationId: safeText(candidate.conversationId, 200) || safeText(fallback.conversationId, 200) }
      : {}),
    ...(safeText(candidate.sourceToolName, 200) || safeText(fallback.sourceToolName, 200)
      ? { sourceToolName: safeText(candidate.sourceToolName, 200) || safeText(fallback.sourceToolName, 200) }
      : {}),
    ...(safeText(candidate.sourceToolCallId, 200) || safeText(fallback.sourceToolCallId, 200)
      ? { sourceToolCallId: safeText(candidate.sourceToolCallId, 200) || safeText(fallback.sourceToolCallId, 200) }
      : {}),
    ...(safeText(candidate.approvalRequestId, 200) || safeText(fallback.approvalRequestId, 200)
      ? { approvalRequestId: safeText(candidate.approvalRequestId, 200) || safeText(fallback.approvalRequestId, 200) }
      : {}),
    updatedAt: normalizeTimestamp(candidate.updatedAt, normalizeTimestamp(fallback.updatedAt, now())),
  }
}

function normalizeTargets(input, sessionId) {
  if (!Array.isArray(input)) return []
  return input
    .map((target) => normalizeTargetRecord(target, sessionId))
    .filter(Boolean)
}

function normalizeTargetRecord(input, sessionId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const targetId = safeText(input.targetId, 200)
  if (!targetId) return null
  return {
    targetId,
    sessionId,
    ...(Number.isFinite(Number(input.tabId)) ? { tabId: Number(input.tabId) } : {}),
    ...(Number.isFinite(Number(input.frameId)) ? { frameId: Number(input.frameId) } : {}),
    kind: safeText(input.kind, 32) || 'page',
    url: safeText(input.url, 2_000) || '',
    title: safeText(input.title, 500) || '',
    active: input.active !== false,
    attached: input.attached !== false,
    lastSeenAt: normalizeTimestamp(input.lastSeenAt, now()),
  }
}

function normalizeSessionEnvelope(input) {
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const rawSession = payload.session && typeof payload.session === 'object' ? payload.session : payload
  const sessionId = safeText(rawSession.sessionId, 200)
  if (!sessionId) return null

  const createdAt = normalizeTimestamp(rawSession.createdAt, now())
  const updatedAt = normalizeTimestamp(rawSession.updatedAt, createdAt)

  return {
    session: {
      sessionId,
      driver: safeText(rawSession.driver, 64) || 'extension-tab',
      state: safeText(rawSession.state, 64) || 'idle',
      createdAt,
      updatedAt,
      ...(safeText(rawSession.ownerConversationId, 200)
        ? { ownerConversationId: safeText(rawSession.ownerConversationId, 200) }
        : {}),
      ...(safeText(rawSession.ownerRunId, 200)
        ? { ownerRunId: safeText(rawSession.ownerRunId, 200) }
        : {}),
      ...(safeText(rawSession.sourceToolName, 200)
        ? { sourceToolName: safeText(rawSession.sourceToolName, 200) }
        : {}),
      ...(safeText(rawSession.sourceToolCallId, 200)
        ? { sourceToolCallId: safeText(rawSession.sourceToolCallId, 200) }
        : {}),
      ...(safeText(rawSession.approvalRequestId, 200)
        ? { approvalRequestId: safeText(rawSession.approvalRequestId, 200) }
        : {}),
      profileId: safeText(rawSession.profileId, 200) || 'default',
      ...(safeText(rawSession.primaryTargetId, 200)
        ? { primaryTargetId: safeText(rawSession.primaryTargetId, 200) }
        : {}),
      ...(safeText(rawSession.lastSnapshotId, 200)
        ? { lastSnapshotId: safeText(rawSession.lastSnapshotId, 200) }
        : {}),
      ...(normalizeRuntimeError(rawSession.lastError)
        ? { lastError: normalizeRuntimeError(rawSession.lastError) }
        : {}),
      capabilities: normalizeCapabilities(rawSession.capabilities) || {
        navigate: true,
        snapshot: true,
        click: true,
        type: true,
        upload: false,
        dialog: false,
        console: false,
        screenshot: false,
        pdf: false,
      },
    },
    targets: normalizeTargets(payload.targets, sessionId),
    ...(normalizeLinkRecord(payload.link, {
      runId: rawSession.ownerRunId,
      conversationId: rawSession.ownerConversationId,
      sourceToolName: rawSession.sourceToolName,
      sourceToolCallId: rawSession.sourceToolCallId,
      approvalRequestId: rawSession.approvalRequestId,
      updatedAt,
    }) ? {
      link: normalizeLinkRecord(payload.link, {
        runId: rawSession.ownerRunId,
        conversationId: rawSession.ownerConversationId,
        sourceToolName: rawSession.sourceToolName,
        sourceToolCallId: rawSession.sourceToolCallId,
        approvalRequestId: rawSession.approvalRequestId,
        updatedAt,
      }),
    } : {}),
    source: safeText(payload.source, 64) || 'extension-background',
    syncedAt: now(),
  }
}

function normalizeSnapshotRecord(input, fallbackSessionId, fallbackTargetId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const snapshotId = safeText(input.snapshotId, 200)
  if (!snapshotId) return undefined
  const sessionId = safeText(input.sessionId, 200) || fallbackSessionId
  const targetId = safeText(input.targetId, 200) || fallbackTargetId
  if (!sessionId || !targetId) return undefined

  const rawStats = input.stats && typeof input.stats === 'object' ? input.stats : {}
  return {
    snapshotId,
    sessionId,
    targetId,
    format: safeText(input.format, 32) || 'ai',
    url: safeText(input.url, 2_000) || '',
    title: safeText(input.title, 500) || '',
    body: typeof input.body === 'string' ? input.body : String(input.body || ''),
    refs: Array.isArray(input.refs) ? clone(input.refs) : [],
    stats: {
      chars: Math.max(0, Number(rawStats.chars) || 0),
      lines: Math.max(0, Number(rawStats.lines) || 0),
      refs: Math.max(0, Number(rawStats.refs) || 0),
      interactive: Math.max(0, Number(rawStats.interactive) || 0),
      truncated: rawStats.truncated === true,
    },
    createdAt: normalizeTimestamp(input.createdAt, now()),
    source: safeText(input.source, 64) || 'manual',
  }
}

function normalizeActionEnvelope(input) {
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const rawAction = payload.action && typeof payload.action === 'object' ? payload.action : payload
  const actionId = safeText(rawAction.actionId, 200)
  const sessionId = safeText(rawAction.sessionId, 200)
  if (!actionId || !sessionId) return null

  const targetId = safeText(rawAction.targetId, 200)
  return {
    action: {
      actionId,
      sessionId,
      ...(targetId ? { targetId } : {}),
      kind: safeText(rawAction.kind, 64) || 'navigate',
      status: safeText(rawAction.status, 64) || 'queued',
      ...(normalizeTimestamp(rawAction.startedAt, undefined) !== undefined
        ? { startedAt: normalizeTimestamp(rawAction.startedAt, undefined) }
        : {}),
      ...(normalizeTimestamp(rawAction.finishedAt, undefined) !== undefined
        ? { finishedAt: normalizeTimestamp(rawAction.finishedAt, undefined) }
        : {}),
      ...(safeText(rawAction.ownerConversationId, 200)
        ? { ownerConversationId: safeText(rawAction.ownerConversationId, 200) }
        : {}),
      ...(safeText(rawAction.ownerRunId, 200)
        ? { ownerRunId: safeText(rawAction.ownerRunId, 200) }
        : {}),
      ...(safeText(rawAction.sourceToolName, 200)
        ? { sourceToolName: safeText(rawAction.sourceToolName, 200) }
        : {}),
      ...(safeText(rawAction.sourceToolCallId, 200)
        ? { sourceToolCallId: safeText(rawAction.sourceToolCallId, 200) }
        : {}),
      ...(safeText(rawAction.approvalRequestId, 200)
        ? { approvalRequestId: safeText(rawAction.approvalRequestId, 200) }
        : {}),
      inputSummary: safeText(rawAction.inputSummary, 500) || '',
      ...(safeText(rawAction.resultSummary, 500) ? { resultSummary: safeText(rawAction.resultSummary, 500) } : {}),
      ...(safeText(rawAction.nextSnapshotId, 200) ? { nextSnapshotId: safeText(rawAction.nextSnapshotId, 200) } : {}),
      ...(normalizeRuntimeError(rawAction.error) ? { error: normalizeRuntimeError(rawAction.error) } : {}),
      ...(rawAction.effects && typeof rawAction.effects === 'object' && !Array.isArray(rawAction.effects)
        ? { effects: clone(rawAction.effects) }
        : {}),
    },
    ...(normalizeLinkRecord(payload.link, {
      runId: rawAction.ownerRunId,
      conversationId: rawAction.ownerConversationId,
      sourceToolName: rawAction.sourceToolName,
      sourceToolCallId: rawAction.sourceToolCallId,
      approvalRequestId: rawAction.approvalRequestId,
      updatedAt: rawAction.finishedAt || rawAction.startedAt,
    }) ? {
      link: normalizeLinkRecord(payload.link, {
        runId: rawAction.ownerRunId,
        conversationId: rawAction.ownerConversationId,
        sourceToolName: rawAction.sourceToolName,
        sourceToolCallId: rawAction.sourceToolCallId,
        approvalRequestId: rawAction.approvalRequestId,
        updatedAt: rawAction.finishedAt || rawAction.startedAt,
      }),
    } : {}),
    ...(normalizeSnapshotRecord(payload.snapshot, sessionId, targetId)
      ? { snapshot: normalizeSnapshotRecord(payload.snapshot, sessionId, targetId) }
      : {}),
    syncedAt: now(),
  }
}

function normalizeArtifactEnvelope(input) {
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const rawArtifact = payload.artifact && typeof payload.artifact === 'object' ? payload.artifact : payload
  const artifactId = safeText(rawArtifact.artifactId, 200)
  const sessionId = safeText(rawArtifact.sessionId, 200)
  if (!artifactId || !sessionId) return null
  const actionId = safeText(payload.actionId, 200)
  const relatedAction = actionId
    ? store.actions.find((entry) => entry?.action?.actionId === actionId) || null
    : null
  const relatedSession = store.sessions.find((entry) => entry?.session?.sessionId === sessionId) || null
  const linkedFallback = relatedAction
    ? {
      runId: readLinkedField(relatedAction, 'runId'),
      conversationId: readLinkedField(relatedAction, 'conversationId'),
      sourceToolName: readLinkedField(relatedAction, 'sourceToolName'),
      sourceToolCallId: readLinkedField(relatedAction, 'sourceToolCallId'),
      approvalRequestId: readLinkedField(relatedAction, 'approvalRequestId'),
      updatedAt: normalizeTimestamp(
        relatedAction?.action?.finishedAt,
        normalizeTimestamp(relatedAction?.action?.startedAt, now()),
      ),
    }
    : relatedSession
      ? {
        runId: readLinkedField(relatedSession, 'runId'),
        conversationId: readLinkedField(relatedSession, 'conversationId'),
        sourceToolName: readLinkedField(relatedSession, 'sourceToolName'),
        sourceToolCallId: readLinkedField(relatedSession, 'sourceToolCallId'),
        approvalRequestId: readLinkedField(relatedSession, 'approvalRequestId'),
        updatedAt: normalizeTimestamp(relatedSession?.session?.updatedAt, now()),
      }
      : payload.link

  return {
    artifact: {
      artifactId,
      sessionId,
      ...(safeText(rawArtifact.targetId, 200) ? { targetId: safeText(rawArtifact.targetId, 200) } : {}),
      kind: safeText(rawArtifact.kind, 64) || 'download',
      createdAt: normalizeTimestamp(rawArtifact.createdAt, now()),
      mimeType: safeText(rawArtifact.mimeType, 200) || 'application/octet-stream',
      byteLength: Math.max(0, Number(rawArtifact.byteLength) || 0),
      storage: safeText(rawArtifact.storage, 64) || 'companion',
      pathOrKey: safeText(rawArtifact.pathOrKey, 2_000) || '',
    },
    ...(actionId ? { actionId } : {}),
    ...(normalizeLinkRecord(payload.link, linkedFallback) ? { link: normalizeLinkRecord(payload.link, linkedFallback) } : {}),
    ...(typeof payload.bytesBase64 === 'string' && payload.bytesBase64
      ? { bytesBase64: payload.bytesBase64 }
      : {}),
    syncedAt: now(),
  }
}

function normalizeBrowserEventRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const cursor = normalizeTimestamp(input.cursor, undefined)
  const type = safeText(input.type, 64)
  const sessionId = safeText(input.sessionId, 200)
  if (cursor === undefined || !type || !sessionId) return null

  return {
    cursor,
    type,
    sessionId,
    ...(safeText(input.actionId, 200) ? { actionId: safeText(input.actionId, 200) } : {}),
    ...(safeText(input.artifactId, 200) ? { artifactId: safeText(input.artifactId, 200) } : {}),
    ...(safeText(input.targetId, 200) ? { targetId: safeText(input.targetId, 200) } : {}),
    ...(safeText(input.kind, 64) ? { kind: safeText(input.kind, 64) } : {}),
    ...(safeText(input.state, 64) ? { state: safeText(input.state, 64) } : {}),
    ...(safeText(input.status, 64) ? { status: safeText(input.status, 64) } : {}),
    ...(safeText(input.source, 64) ? { source: safeText(input.source, 64) } : {}),
    ...(safeText(input.errorCode, 64) ? { errorCode: safeText(input.errorCode, 64) } : {}),
    ...(safeText(input.resultSummary, 500) ? { resultSummary: safeText(input.resultSummary, 500) } : {}),
    ...(safeText(input.mimeType, 200) ? { mimeType: safeText(input.mimeType, 200) } : {}),
    syncedAt: normalizeTimestamp(input.syncedAt, now()),
    ...(normalizeLinkRecord(input.link, input.link) ? { link: normalizeLinkRecord(input.link, input.link) } : {}),
  }
}

async function readStoreFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw)
  const events = Array.isArray(parsed.events)
    ? parsed.events.map(normalizeBrowserEventRecord).filter(Boolean)
    : []
  return {
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.map(normalizeSessionEnvelope).filter(Boolean) : [],
    actions: Array.isArray(parsed.actions) ? parsed.actions.map(normalizeActionEnvelope).filter(Boolean) : [],
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.map(normalizeArtifactEnvelope).filter(Boolean) : [],
    events: sortByTimestampDescending(events, eventSortKey).reverse(),
    nextCursor: Math.max(
      normalizeTimestamp(parsed.nextCursor, 0) || 0,
      events.length > 0 ? events[events.length - 1].cursor + 1 : 1,
      1,
    ),
  }
}

function trimPerSession(entries, getSessionId, limit, getSortKey) {
  const grouped = new Map()
  for (const entry of sortByTimestampDescending(entries, getSortKey)) {
    const sessionId = getSessionId(entry)
    const existing = grouped.get(sessionId) || []
    if (existing.length < limit) {
      existing.push(entry)
      grouped.set(sessionId, existing)
    }
  }
  return sortByTimestampDescending(Array.from(grouped.values()).flat(), getSortKey)
}

function isWithinOrphanRetention(entry, currentTs) {
  const syncedAt = normalizeTimestamp(entry?.syncedAt, 0)
  if (!syncedAt) return false
  return currentTs - syncedAt <= MAX_BROWSER_ORPHAN_RETENTION_MS
}

function trimStore() {
  const currentTs = now()
  const knownSessionIds = new Set(store.sessions.map((entry) => entry.session.sessionId))
  store.sessions = sortByTimestampDescending(store.sessions, sessionSortKey).slice(0, MAX_BROWSER_SESSIONS)
  const validSessionIds = new Set(store.sessions.map((entry) => entry.session.sessionId))

  store.actions = store.actions.filter((entry) => (
    validSessionIds.has(entry.action.sessionId)
    || (!knownSessionIds.has(entry.action.sessionId) && isWithinOrphanRetention(entry, currentTs))
  ))
  store.artifacts = store.artifacts.filter((entry) => (
    validSessionIds.has(entry.artifact.sessionId)
    || (!knownSessionIds.has(entry.artifact.sessionId) && isWithinOrphanRetention(entry, currentTs))
  ))

  const knownActionIds = new Set(store.actions.map((entry) => entry.action.actionId))
  store.actions = trimPerSession(
    store.actions,
    (entry) => entry.action.sessionId,
    MAX_BROWSER_ACTIONS_PER_SESSION,
    actionSortKey,
  )

  const validActionIds = new Set(store.actions.map((entry) => entry.action.actionId))
  store.artifacts = store.artifacts.filter((entry) => (
    !entry.actionId
    || validActionIds.has(entry.actionId)
    || (!knownActionIds.has(entry.actionId) && isWithinOrphanRetention(entry, currentTs))
  ))
  store.artifacts = trimPerSession(
    store.artifacts,
    (entry) => entry.artifact.sessionId,
    MAX_BROWSER_ARTIFACTS_PER_SESSION,
    artifactSortKey,
  )

  if (!Array.isArray(store.events)) {
    store.events = []
  }
  if (store.events.length > MAX_BROWSER_EVENTS) {
    store.events = store.events.slice(store.events.length - MAX_BROWSER_EVENTS)
  }
}

async function writeStoreSnapshot(snapshot) {
  await ensureConfigDir()
  const payload = JSON.stringify(snapshot, null, 2) + '\n'
  const target = BROWSER_LEDGER_FILE()
  const backup = BROWSER_LEDGER_BACKUP_FILE()
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.round(Math.random() * 1_000_000)}.tmp`

  await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: FILE_MODE })
  await safeChmod(tmp, FILE_MODE)
  try {
    await fs.copyFile(target, backup)
    await safeChmod(backup, FILE_MODE)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  await fs.rename(tmp, target)
  await safeChmod(target, FILE_MODE)
}

function queuePersist() {
  persistPromise = (persistPromise || Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      trimStore()
      return writeStoreSnapshot(clone(store))
    })
  return persistPromise
}

function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void queuePersist()
  }, WRITE_DEBOUNCE_MS)
  if (persistTimer.unref) persistTimer.unref()
}

async function ensureLoaded() {
  if (loaded) return
  if (loadingPromise) return loadingPromise
  loadingPromise = loadBrowserLedger().finally(() => {
    loadingPromise = null
  })
  return loadingPromise
}

async function cleanOrphanTmp() {
  try {
    await fs.unlink(`${BROWSER_LEDGER_FILE()}.tmp`)
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[browser-ledger] Failed to clean orphan .tmp: ${err.message}`)
    }
  }
}

export async function loadBrowserLedger() {
  await ensureConfigDir()
  await cleanOrphanTmp()
  try {
    store = await readStoreFile(BROWSER_LEDGER_FILE())
  } catch (err) {
    if (err.code === 'ENOENT') {
      store = { sessions: [], actions: [], artifacts: [], events: [], nextCursor: 1 }
    } else {
      console.warn(`[browser-ledger] Primary browser-ledger.json corrupted: ${err.message}`)
      try {
        store = await readStoreFile(BROWSER_LEDGER_BACKUP_FILE())
        console.warn('[browser-ledger] Recovered from backup browser-ledger.json.bak')
      } catch (backupErr) {
        console.warn(`[browser-ledger] Backup also unavailable: ${backupErr.message ?? 'unknown error'}`)
        store = { sessions: [], actions: [], artifacts: [], events: [], nextCursor: 1 }
      }
    }
  }
  trimStore()
  loaded = true
  return clone(store)
}

export async function flushBrowserLedger() {
  await ensureLoaded()
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
    await queuePersist()
  }
  if (persistPromise) {
    await persistPromise
  }
}

function mergeSessionEnvelope(current, incoming) {
  return {
    session: {
      ...(current?.session && typeof current.session === 'object' ? current.session : {}),
      ...incoming.session,
      createdAt: normalizeTimestamp(current?.session?.createdAt, incoming.session.createdAt) || incoming.session.createdAt,
      updatedAt: Math.max(
        normalizeTimestamp(current?.session?.updatedAt, 0),
        normalizeTimestamp(incoming.session.updatedAt, 0),
      ) || incoming.session.updatedAt,
      capabilities: incoming.session.capabilities || current?.session?.capabilities,
      ...(incoming.session.lastError
        ? { lastError: incoming.session.lastError }
        : current?.session?.lastError
          ? { lastError: current.session.lastError }
          : {}),
    },
    targets: incoming.targets.length > 0
      ? incoming.targets
      : (Array.isArray(current?.targets) ? current.targets : []),
    ...(normalizeLinkRecord(incoming.link, current?.link) ? { link: normalizeLinkRecord(incoming.link, current?.link) } : {}),
    source: incoming.source || current?.source || 'extension-background',
    syncedAt: incoming.syncedAt,
  }
}

function mergeActionEnvelope(current, incoming) {
  return {
    action: {
      ...(current?.action && typeof current.action === 'object' ? current.action : {}),
      ...incoming.action,
      ...(incoming.action.error
        ? { error: incoming.action.error }
        : current?.action?.error
          ? { error: current.action.error }
          : {}),
      ...(incoming.action.effects
        ? { effects: incoming.action.effects }
        : current?.action?.effects
          ? { effects: current.action.effects }
          : {}),
    },
    ...(incoming.snapshot
      ? { snapshot: incoming.snapshot }
      : current?.snapshot
        ? { snapshot: current.snapshot }
        : {}),
    ...(normalizeLinkRecord(incoming.link, current?.link) ? { link: normalizeLinkRecord(incoming.link, current?.link) } : {}),
    syncedAt: incoming.syncedAt,
  }
}

function mergeArtifactEnvelope(current, incoming) {
  return {
    artifact: {
      ...(current?.artifact && typeof current.artifact === 'object' ? current.artifact : {}),
      ...incoming.artifact,
    },
    ...(incoming.actionId ? { actionId: incoming.actionId } : current?.actionId ? { actionId: current.actionId } : {}),
    ...(normalizeLinkRecord(incoming.link, current?.link) ? { link: normalizeLinkRecord(incoming.link, current?.link) } : {}),
    ...(incoming.bytesBase64
      ? { bytesBase64: incoming.bytesBase64 }
      : current?.bytesBase64
        ? { bytesBase64: current.bytesBase64 }
        : {}),
    syncedAt: incoming.syncedAt,
  }
}

function appendBrowserEvent(event) {
  const normalized = normalizeBrowserEventRecord({
    ...event,
    cursor: store.nextCursor,
  })
  if (!normalized) return null
  store.nextCursor = normalized.cursor + 1
  store.events.push(normalized)
  if (store.events.length > MAX_BROWSER_EVENTS) {
    store.events.splice(0, store.events.length - MAX_BROWSER_EVENTS)
  }
  return normalized
}

function recordSessionSyncEvent(entry) {
  const target = resolveSessionTarget(entry)
  return appendBrowserEvent({
    type: 'session_synced',
    sessionId: entry.session.sessionId,
    ...(safeText(target?.targetId, 200) ? { targetId: safeText(target.targetId, 200) } : {}),
    state: entry.session.state,
    source: entry.source,
    syncedAt: entry.syncedAt,
    link: entry.link,
  })
}

function recordActionSyncEvent(entry) {
  return appendBrowserEvent({
    type: 'action_synced',
    sessionId: entry.action.sessionId,
    ...(safeText(entry.action.actionId, 200) ? { actionId: safeText(entry.action.actionId, 200) } : {}),
    ...(safeText(entry.action.targetId, 200) ? { targetId: safeText(entry.action.targetId, 200) } : {}),
    kind: entry.action.kind,
    status: entry.action.status,
    source: 'extension-background',
    syncedAt: entry.syncedAt,
    ...(safeText(entry.action.error?.code, 64) ? { errorCode: safeText(entry.action.error.code, 64) } : {}),
    ...(safeText(entry.action.resultSummary, 500) ? { resultSummary: safeText(entry.action.resultSummary, 500) } : {}),
    link: entry.link,
  })
}

function recordArtifactSyncEvent(entry) {
  return appendBrowserEvent({
    type: 'artifact_synced',
    sessionId: entry.artifact.sessionId,
    ...(safeText(entry.actionId, 200) ? { actionId: safeText(entry.actionId, 200) } : {}),
    ...(safeText(entry.artifact.artifactId, 200) ? { artifactId: safeText(entry.artifact.artifactId, 200) } : {}),
    ...(safeText(entry.artifact.targetId, 200) ? { targetId: safeText(entry.artifact.targetId, 200) } : {}),
    kind: entry.artifact.kind,
    mimeType: entry.artifact.mimeType,
    source: 'extension-background',
    syncedAt: entry.syncedAt,
    link: entry.link,
  })
}

export async function syncBrowserSession(payload) {
  await ensureLoaded()
  const normalized = normalizeSessionEnvelope(payload)
  if (!normalized) {
    throw new Error('session.sessionId is required.')
  }

  const index = store.sessions.findIndex((entry) => entry.session.sessionId === normalized.session.sessionId)
  if (index >= 0) {
    store.sessions[index] = mergeSessionEnvelope(store.sessions[index], normalized)
  } else {
    store.sessions.push(normalized)
  }
  const stored = store.sessions.find((entry) => entry.session.sessionId === normalized.session.sessionId)
  if (stored) recordSessionSyncEvent(stored)
  trimStore()
  if (normalized.link?.runId) {
    await linkRunToBrowserSession(normalized.session.sessionId, {
      ...normalized.link,
      type: 'browser_session',
    }).catch(() => undefined)
  }
  schedulePersist()
  return clone(stored)
}

export async function syncBrowserAction(payload) {
  await ensureLoaded()
  const normalized = normalizeActionEnvelope(payload)
  if (!normalized) {
    throw new Error('action.actionId and action.sessionId are required.')
  }

  const index = store.actions.findIndex((entry) => entry.action.actionId === normalized.action.actionId)
  if (index >= 0) {
    store.actions[index] = mergeActionEnvelope(store.actions[index], normalized)
  } else {
    store.actions.push(normalized)
  }
  const stored = store.actions.find((entry) => entry.action.actionId === normalized.action.actionId)
  if (stored) recordActionSyncEvent(stored)
  trimStore()
  if (normalized.link?.runId) {
    await linkRunToBrowserAction(normalized.action.actionId, {
      ...normalized.link,
      sessionId: normalized.action.sessionId,
      type: 'browser_action',
    }).catch(() => undefined)
  }
  schedulePersist()
  return clone(stored)
}

export async function syncBrowserArtifact(payload) {
  await ensureLoaded()
  const normalized = normalizeArtifactEnvelope(payload)
  if (!normalized) {
    throw new Error('artifact.artifactId and artifact.sessionId are required.')
  }

  const index = store.artifacts.findIndex((entry) => entry.artifact.artifactId === normalized.artifact.artifactId)
  if (index >= 0) {
    store.artifacts[index] = mergeArtifactEnvelope(store.artifacts[index], normalized)
  } else {
    store.artifacts.push(normalized)
  }
  const stored = store.artifacts.find((entry) => entry.artifact.artifactId === normalized.artifact.artifactId)
  if (stored) recordArtifactSyncEvent(stored)
  trimStore()
  schedulePersist()
  return clone(stored)
}

function paginate(items, limitRaw, offsetRaw) {
  const total = items.length
  const limit = clampInt(limitRaw, 50, 1, 500)
  const offset = clampInt(offsetRaw, 0, 0, Math.max(total, 0))
  const page = items.slice(offset, offset + limit)
  return {
    total,
    limit,
    offset,
    hasMore: offset + page.length < total,
    items: clone(page),
  }
}

function buildBrowserSessionListResult(query = {}) {
  const sessionId = safeText(query.sessionId, 200)
  const state = safeText(query.state, 64)
  const ownerConversationId = safeText(query.ownerConversationId, 200)
  let sessions = sortByTimestampDescending(store.sessions, sessionSortKey)
  if (sessionId) sessions = sessions.filter((entry) => entry.session.sessionId === sessionId)
  if (state) sessions = sessions.filter((entry) => entry.session.state === state)
  if (ownerConversationId) {
    sessions = sessions.filter((entry) => entry.session.ownerConversationId === ownerConversationId)
  }
  sessions = sessions.filter((entry) => matchesLinkFilters(entry, query))
  const result = paginate(sessions, query.limit, query.offset)
  return {
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    hasMore: result.hasMore,
    sessions: result.items,
  }
}

function buildBrowserActionListResult(query = {}) {
  const actionId = safeText(query.actionId, 200)
  const sessionId = safeText(query.sessionId, 200)
  const targetId = safeText(query.targetId, 200)
  const kind = safeText(query.kind, 64)
  const status = safeText(query.status, 64)
  let actions = sortByTimestampDescending(store.actions, actionSortKey)
  if (actionId) actions = actions.filter((entry) => entry.action.actionId === actionId)
  if (sessionId) actions = actions.filter((entry) => entry.action.sessionId === sessionId)
  if (targetId) actions = actions.filter((entry) => entry.action.targetId === targetId)
  if (kind) actions = actions.filter((entry) => entry.action.kind === kind)
  if (status) actions = actions.filter((entry) => entry.action.status === status)
  actions = actions.filter((entry) => matchesLinkFilters(entry, query))
  const result = paginate(actions, query.limit, query.offset)
  return {
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    hasMore: result.hasMore,
    actions: result.items,
  }
}

function buildBrowserArtifactListResult(query = {}) {
  const artifactId = safeText(query.artifactId, 200)
  const sessionId = safeText(query.sessionId, 200)
  const targetId = safeText(query.targetId, 200)
  const actionId = safeText(query.actionId, 200)
  const kind = safeText(query.kind, 64)
  let artifacts = sortByTimestampDescending(store.artifacts, artifactSortKey)
  if (artifactId) artifacts = artifacts.filter((entry) => entry.artifact.artifactId === artifactId)
  if (sessionId) artifacts = artifacts.filter((entry) => entry.artifact.sessionId === sessionId)
  if (targetId) artifacts = artifacts.filter((entry) => entry.artifact.targetId === targetId)
  if (actionId) artifacts = artifacts.filter((entry) => entry.actionId === actionId)
  if (kind) artifacts = artifacts.filter((entry) => entry.artifact.kind === kind)
  const result = paginate(artifacts, query.limit, query.offset)
  return {
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    hasMore: result.hasMore,
    artifacts: result.items,
  }
}

function buildBrowserEventListResult(query = {}) {
  const after = clampInt(query.after, 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = clampInt(query.limit, 50, 1, 500)
  const windowMode = safeText(query.window, 32)
  const useTailWindow = windowMode === 'tail' || windowMode === 'recent'
  const sessionId = safeText(query.sessionId, 200)
  const actionId = safeText(query.actionId, 200)
  const artifactId = safeText(query.artifactId, 200)
  const type = safeText(query.type, 64)

  const filtered = store.events
    .filter((entry) => entry.cursor > after)
    .filter((entry) => !sessionId || entry.sessionId === sessionId)
    .filter((entry) => !actionId || entry.actionId === actionId)
    .filter((entry) => !artifactId || entry.artifactId === artifactId)
    .filter((entry) => !type || entry.type === type)
    .filter((entry) => matchesLinkFilters(entry, query))
    .sort((a, b) => a.cursor - b.cursor)

  const events = clone(
    useTailWindow
      ? filtered.slice(Math.max(filtered.length - limit, 0))
      : filtered.slice(0, limit),
  )
  const nextCursor = events.length > 0
    ? events[events.length - 1].cursor
    : Math.max(after, (store.nextCursor || 1) - 1)

  return {
    ok: true,
    events,
    nextCursor,
    hasMore: useTailWindow ? false : filtered.some((entry) => entry.cursor > nextCursor),
  }
}

function normalizeBrowserDrilldownQuery(query = {}) {
  const sourceToolCallId = safeText(query.sourceToolCallId, 200)
  return {
    ...(safeText(query.runId, 200) ? { runId: safeText(query.runId, 200) } : {}),
    ...(safeText(query.conversationId, 200) ? { conversationId: safeText(query.conversationId, 200) } : {}),
    ...(sourceToolCallId ? { sourceToolCallId } : {}),
    ...(!sourceToolCallId && safeText(query.sourceToolName, 200)
      ? { sourceToolName: safeText(query.sourceToolName, 200) }
      : {}),
    ...(safeText(query.approvalRequestId, 200) ? { approvalRequestId: safeText(query.approvalRequestId, 200) } : {}),
    ...(safeText(query.sessionId, 200) ? { sessionId: safeText(query.sessionId, 200) } : {}),
    ...(safeText(query.actionId, 200) ? { actionId: safeText(query.actionId, 200) } : {}),
    ...(safeText(query.artifactId, 200) ? { artifactId: safeText(query.artifactId, 200) } : {}),
    ...(safeText(query.type, 64) ? { type: safeText(query.type, 64) } : {}),
    sessionLimit: clampInt(query.sessionLimit, 5, 1, 100),
    actionLimit: clampInt(query.actionLimit, 8, 1, 100),
    artifactLimit: clampInt(query.artifactLimit, 6, 1, 100),
    eventLimit: clampInt(query.eventLimit, 10, 1, 100),
    eventAfter: clampInt(query.eventAfter, 0, 0, Number.MAX_SAFE_INTEGER),
    ...(safeText(query.eventWindow, 32) === 'tail' ? { eventWindow: 'tail' } : {}),
  }
}

export async function listBrowserSessions(query = {}) {
  await ensureLoaded()
  return buildBrowserSessionListResult(query)
}

export async function getBrowserSessionById(sessionId) {
  await ensureLoaded()
  const id = safeText(sessionId, 200)
  if (!id) return null
  const found = store.sessions.find((entry) => entry.session.sessionId === id)
  return found ? clone(found) : null
}

export async function listBrowserActions(query = {}) {
  await ensureLoaded()
  return buildBrowserActionListResult(query)
}

export async function listBrowserArtifacts(query = {}) {
  await ensureLoaded()
  return buildBrowserArtifactListResult(query)
}

export async function listBrowserEvents(query = {}) {
  await ensureLoaded()
  return buildBrowserEventListResult(query)
}

export async function getBrowserLedgerDrilldown(query = {}) {
  await ensureLoaded()
  const filters = normalizeBrowserDrilldownQuery(query)
  const sessions = buildBrowserSessionListResult({
    ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
    ...(filters.runId ? { runId: filters.runId } : {}),
    ...(filters.conversationId ? { conversationId: filters.conversationId } : {}),
    ...(filters.sourceToolName ? { sourceToolName: filters.sourceToolName } : {}),
    ...(filters.sourceToolCallId ? { sourceToolCallId: filters.sourceToolCallId } : {}),
    ...(filters.approvalRequestId ? { approvalRequestId: filters.approvalRequestId } : {}),
    limit: filters.sessionLimit,
    offset: 0,
  })
  const actions = buildBrowserActionListResult({
    ...(filters.actionId ? { actionId: filters.actionId } : {}),
    ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
    ...(filters.runId ? { runId: filters.runId } : {}),
    ...(filters.conversationId ? { conversationId: filters.conversationId } : {}),
    ...(filters.sourceToolName ? { sourceToolName: filters.sourceToolName } : {}),
    ...(filters.sourceToolCallId ? { sourceToolCallId: filters.sourceToolCallId } : {}),
    ...(filters.approvalRequestId ? { approvalRequestId: filters.approvalRequestId } : {}),
    limit: filters.actionLimit,
    offset: 0,
  })
  const artifacts = buildBrowserArtifactListResult({
    ...(filters.artifactId ? { artifactId: filters.artifactId } : {}),
    ...(filters.actionId ? { actionId: filters.actionId } : {}),
    ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
    limit: filters.artifactLimit,
    offset: 0,
  })
  const events = buildBrowserEventListResult({
    ...(filters.runId ? { runId: filters.runId } : {}),
    ...(filters.conversationId ? { conversationId: filters.conversationId } : {}),
    ...(filters.sourceToolName ? { sourceToolName: filters.sourceToolName } : {}),
    ...(filters.sourceToolCallId ? { sourceToolCallId: filters.sourceToolCallId } : {}),
    ...(filters.approvalRequestId ? { approvalRequestId: filters.approvalRequestId } : {}),
    ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
    ...(filters.actionId ? { actionId: filters.actionId } : {}),
    ...(filters.artifactId ? { artifactId: filters.artifactId } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.eventWindow ? { window: filters.eventWindow } : {}),
    after: filters.eventAfter,
    limit: filters.eventLimit,
  })

  return {
    ok: true,
    filters: {
      ...(filters.runId ? { runId: filters.runId } : {}),
      ...(filters.conversationId ? { conversationId: filters.conversationId } : {}),
      ...(filters.sourceToolName ? { sourceToolName: filters.sourceToolName } : {}),
      ...(filters.sourceToolCallId ? { sourceToolCallId: filters.sourceToolCallId } : {}),
      ...(filters.approvalRequestId ? { approvalRequestId: filters.approvalRequestId } : {}),
      ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
      ...(filters.actionId ? { actionId: filters.actionId } : {}),
      ...(filters.artifactId ? { artifactId: filters.artifactId } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.eventWindow ? { eventWindow: filters.eventWindow } : {}),
      sessionLimit: filters.sessionLimit,
      actionLimit: filters.actionLimit,
      artifactLimit: filters.artifactLimit,
      eventLimit: filters.eventLimit,
      eventAfter: filters.eventAfter,
    },
    sessions,
    actions,
    artifacts,
    events,
  }
}

export async function getBrowserLedgerDiagnostics(options = {}) {
  const supportedFeatures = normalizeSupportedFeatures(options.supportedFeatures)
  await ensureLoaded()
  const activeSessions = store.sessions.filter((entry) => {
    const state = String(entry?.session?.state || '').trim().toLowerCase()
    return state && state !== 'closed' && state !== 'error'
  }).length
  const failedRecent = store.actions.filter((entry) => entry?.action?.status === 'failed').length
  const linkedSessions = sortByTimestampDescending(
    store.sessions.filter((entry) => Boolean(readLinkedField(entry, 'runId'))),
    sessionSortKey,
  )
  const linkedActions = sortByTimestampDescending(
    store.actions.filter((entry) => Boolean(readLinkedField(entry, 'runId'))),
    actionSortKey,
  )
  return {
    enabled: supportedFeatures.browserLedger === false ? false : true,
    loaded,
    sessions: {
      total: store.sessions.length,
      active: activeSessions,
      linked: linkedSessions.length,
      recentLinked: linkedSessions.slice(0, 5).map(buildRecentLinkedSessionSummary),
    },
    actions: {
      total: store.actions.length,
      failedRecent,
      linked: linkedActions.length,
      recentLinked: linkedActions.slice(0, 5).map(buildRecentLinkedActionSummary),
    },
    artifacts: {
      total: store.artifacts.length,
      recent: store.artifacts.length,
    },
    events: {
      total: store.events.length,
      recent: sortByTimestampDescending(store.events, eventSortKey).slice(0, 5).map(clone),
      nextCursor: Math.max((store.nextCursor || 1) - 1, 0),
    },
    operator: {
      drilldownAvailable: supportedFeatures.browserDrilldown === true,
      routes: {
        ...(supportedFeatures.browserDrilldown === true ? { drilldown: '/api/browser/drilldown' } : {}),
      },
      eventWindowModes: supportedFeatures.browserEvents === true ? ['tail'] : [],
    },
    capabilities: {
      browserLedger: supportedFeatures.browserLedger === true,
      browserEvents: supportedFeatures.browserEvents === true,
      browserDrilldown: supportedFeatures.browserDrilldown === true,
    },
  }
}

export async function clearBrowserLedgerForTests() {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  store = { sessions: [], actions: [], artifacts: [], events: [], nextCursor: 1 }
  loaded = true
  await queuePersist()
}
