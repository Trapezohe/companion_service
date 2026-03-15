function compactText(raw, maxLength = 320) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!text) return null
  return text.slice(0, maxLength)
}

export function extractAutomationLifecycleText(events = [], fallbackSummary = '') {
  const deltas = []
  let doneResult = ''
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'text_delta' && typeof event.text === 'string') {
      deltas.push(event.text)
      continue
    }
    if (event?.type === 'done' && typeof event.result === 'string' && event.result.trim()) {
      doneResult = event.result.trim()
    }
  }

  const fromDeltas = deltas.join('').trim()
  if (fromDeltas) return fromDeltas
  if (doneResult) return doneResult
  return typeof fallbackSummary === 'string' ? fallbackSummary.trim() : ''
}

function normalizeTerminalState(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized || 'unknown'
}

export function buildAutomationLifecycleSummary({ run, events, terminalState }) {
  const taskName = compactText(run?.meta?.taskName, 120) || 'Automation run'
  const deliveryMode = compactText(run?.meta?.deliveryMode, 60) || 'notification'
  const outcome = compactText(extractAutomationLifecycleText(events, run?.summary || ''), 320)
  if (!outcome) return null

  return [
    `### ${taskName}`,
    `- Terminal state: ${normalizeTerminalState(terminalState)}`,
    `- Delivery: ${deliveryMode}`,
    `- Outcome: ${outcome}`,
  ].join('\n')
}
