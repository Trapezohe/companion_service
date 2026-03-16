const DEFAULT_BUDGET_LIMIT_BY_MODE = {
  default: 60_000,
  lean: 36_000,
  deep_research: 90_000,
}

const WARNING_RATIO = 0.72
const ASCII_TOKEN_WEIGHT = 0.25
const ASCII_SYMBOL_TOKEN_WEIGHT = 0.42
const NON_ASCII_TOKEN_WEIGHT = 0.6
const CJK_TOKEN_WEIGHT = 0.92

function normalizeNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}

function normalizeTimestamp(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}

function normalizeHealth(value) {
  return value === 'warning' || value === 'critical' ? value : 'healthy'
}

function createEmptyLedger() {
  return {
    approxInputTokens: 0,
    approxOutputTokens: 0,
    compactionCount: 0,
    lastRollupAt: null,
    health: 'healthy',
  }
}

function normalizeLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return createEmptyLedger()
  }
  return {
    approxInputTokens: normalizeNonNegativeInt(ledger.approxInputTokens),
    approxOutputTokens: normalizeNonNegativeInt(ledger.approxOutputTokens),
    compactionCount: normalizeNonNegativeInt(ledger.compactionCount),
    lastRollupAt: normalizeTimestamp(ledger.lastRollupAt),
    health: normalizeHealth(ledger.health),
  }
}

function resolveBudgetLimit(policy) {
  return normalizeNonNegativeInt(policy?.maxContextBudget)
    || DEFAULT_BUDGET_LIMIT_BY_MODE[policy?.mode === 'lean' || policy?.mode === 'deep_research' ? policy.mode : 'default']
}

export function estimateAutomationTokens(text) {
  const raw = String(text || '')
  if (!raw) return 0

  let total = 0
  for (const char of raw) {
    const code = char.codePointAt(0) || 0
    if (/\s/u.test(char)) continue
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) {
      total += CJK_TOKEN_WEIGHT
      continue
    }
    if (code <= 0x7f) {
      total += /[A-Za-z0-9]/.test(char) ? ASCII_TOKEN_WEIGHT : ASCII_SYMBOL_TOKEN_WEIGHT
      continue
    }
    total += NON_ASCII_TOKEN_WEIGHT
  }

  return Math.max(0, Math.ceil(total))
}

export function classifyAutomationBudgetHealth(policy, ledger) {
  const totalTokens = normalizeNonNegativeInt(ledger?.approxInputTokens) + normalizeNonNegativeInt(ledger?.approxOutputTokens)
  const budgetLimit = resolveBudgetLimit(policy || {})
  const compactionCount = normalizeNonNegativeInt(ledger?.compactionCount)
  const compactAfterRuns = normalizeNonNegativeInt(policy?.compactAfterRuns)
  const ratio = budgetLimit > 0 ? totalTokens / budgetLimit : 0

  if (ratio >= 1 || (compactAfterRuns > 0 && compactionCount >= compactAfterRuns * 2)) {
    return 'critical'
  }
  if (ratio >= WARNING_RATIO || (compactAfterRuns > 0 && compactionCount >= compactAfterRuns)) {
    return 'warning'
  }
  return 'healthy'
}

export function deriveAutomationBudgetLedgerUpdate(input = {}) {
  const policy = input.sessionBudget?.policy
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null

  const current = normalizeLedger(input.sessionBudget?.ledger)
  const next = {
    approxInputTokens: current.approxInputTokens + estimateAutomationTokens(input.promptText),
    approxOutputTokens: current.approxOutputTokens + estimateAutomationTokens(input.outputText),
    compactionCount: current.compactionCount + normalizeNonNegativeInt(input.compactionCountDelta),
    lastRollupAt: normalizeTimestamp(input.rollupAt) ?? current.lastRollupAt,
    health: current.health,
  }
  next.health = classifyAutomationBudgetHealth(policy, next)
  return next
}

export function buildAutomationBudgetSnapshot(sessionKey, ledger) {
  const normalizedKey = typeof sessionKey === 'string' ? sessionKey.trim() : ''
  if (!normalizedKey || !normalizedKey.startsWith('persistent:')) return null
  return {
    sessionKey: normalizedKey,
    ledger: normalizeLedger(ledger),
  }
}
