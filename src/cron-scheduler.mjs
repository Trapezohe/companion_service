/**
 * Companion cron scheduler — setTimeout-based persistent timer.
 *
 * When a timer fires:
 * - extension_chat jobs keep the legacy pending replay path
 * - companion_acp jobs execute immediately through the ACP runtime
 */

import { getJobs, addPendingRun, upsertJob } from './cron-store.mjs'
import { createRun, updateRun } from './run-store.mjs'
import { executeAutomationJob, checkAndResumeRetryableRuns } from './automation-executor.mjs'
import { normalizeAutomationSpec } from './automation-spec.mjs'

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const timers = new Map()
let schedulerOptions = {}
let retryTimer = null

/**
 * Compute delay in ms until the next occurrence of a schedule.
 * @param {{ kind: string, minutes?: number, hour?: number, minute?: number, tz?: string }} schedule
 * @returns {number}
 */
function computeDelay(schedule) {
  if (schedule.kind === 'interval') {
    return Math.max((schedule.minutes || 1), 1) * 60_000
  }

  // Daily: compute ms until next HH:MM in the given timezone
  const now = new Date()
  const tz = schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone
  const hour = schedule.hour ?? 9
  const minute = schedule.minute ?? 0

  // Get today's date in target timezone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0)
  const nowHour = get('hour')
  const nowMin = get('minute')
  const nowSec = get('second')

  // Current time in minutes since midnight (in target tz)
  const nowMinutes = nowHour * 60 + nowMin
  const targetMinutes = hour * 60 + minute

  let delayMinutes = targetMinutes - nowMinutes
  if (delayMinutes <= 0) {
    // Already passed today, schedule for tomorrow
    delayMinutes += 1440
  }

  // Convert to ms and subtract current seconds
  return delayMinutes * 60_000 - nowSec * 1000
}

function getAutomationExecutor(options = {}) {
  return typeof options.automationExecutor === 'function'
    ? options.automationExecutor
    : executeAutomationJob
}

function cloneLifecycleObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return JSON.parse(JSON.stringify(value))
}

function buildCronLifecycleMeta(job) {
  const spec = normalizeAutomationSpec(job)
  const workflow = cloneLifecycleObject(spec.workflow)
  const retryPolicy = cloneLifecycleObject(spec.workflow?.policy)
  return {
    taskId: job.id,
    taskName: job.name,
    scheduleKind: job.schedule?.kind || 'unknown',
    executionMode: spec.executor === 'companion_acp' ? 'companion_acp' : 'extension_pending',
    sessionTarget: spec.sessionTarget,
    ...(workflow ? { workflow } : {}),
    ...(retryPolicy ? { retryPolicy } : {}),
  }
}

function buildAutomationSessionType(taskId) {
  const normalizedTaskId = typeof taskId === 'string' && taskId.trim()
    ? taskId.trim()
    : ''
  return normalizedTaskId ? `automation/${normalizedTaskId}` : undefined
}

async function queuePendingRun(job) {
  const sessionType = buildAutomationSessionType(job?.id)
  const run = await createRun({
    type: 'cron',
    state: 'queued',
    ...(sessionType ? { sessionType } : {}),
    summary: `Cron timer fired, queuing for extension: ${job.name}`,
    meta: buildCronLifecycleMeta(job),
  }).catch(() => null)

  try {
    const pending = await addPendingRun(job.id)
    if (run?.runId) {
      await updateRun(run.runId, {
        state: 'done',
        finishedAt: Date.now(),
        summary: `Marked pending for extension catch-up: ${job.name}`,
        meta: {
          ...(run.meta && typeof run.meta === 'object' ? run.meta : {}),
          pendingId: pending.pendingId,
          missedAt: pending.missedAt,
          replayOf: {
            kind: 'cron_pending',
            pendingId: pending.pendingId,
            missedAt: pending.missedAt,
            taskId: job.id,
          },
        },
      }).catch(() => undefined)
    }
  } catch (err) {
    console.error(`[cron-companion] Failed to mark pending for ${job.id}:`, err.message)
    if (run?.runId) {
      await updateRun(run.runId, {
        state: 'failed',
        finishedAt: Date.now(),
        summary: `Failed to mark pending: ${job.name}`,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined)
    }
  }
}

async function executeCompanionAutomation(job, options = {}) {
  const automationExecutor = getAutomationExecutor(options)
  try {
    return await automationExecutor(job)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const sessionType = buildAutomationSessionType(job?.id)
    console.error(`[cron-companion] Failed to execute automation job ${job.id}:`, message)
    await createRun({
      type: 'cron',
      state: 'failed',
      finishedAt: Date.now(),
      ...(sessionType ? { sessionType } : {}),
      summary: `Companion automation failed before run startup: ${job.name}`,
      error: message,
      meta: {
        ...buildCronLifecycleMeta(job),
        startupFailed: true,
      },
    }).catch(() => undefined)
    return null
  }
}

function scheduleJob(job, options = schedulerOptions) {
  if (!job.enabled) return

  const delay = computeDelay(job.schedule)
  job.nextRunAt = Date.now() + delay
  void upsertJob(job).catch(() => undefined)

  const timer = setTimeout(async () => {
    if (job.executor === 'companion_acp') {
      console.log(`[cron-companion] Timer fired for "${job.name}" (${job.id}), executing via companion ACP`)
      await executeCompanionAutomation(job, options)
    } else {
      console.log(`[cron-companion] Timer fired for "${job.name}" (${job.id}), marking as pending`)
      await queuePendingRun(job)
    }
    // Re-schedule for next occurrence
    scheduleJob(job, options)
  }, delay)

  // Prevent timer from keeping the process alive
  if (timer.unref) timer.unref()

  timers.set(job.id, timer)

  const nextRun = new Date(Date.now() + delay)
  console.log(`[cron-companion] Scheduled "${job.name}" — next: ${nextRun.toLocaleString()}`)
}

export function startCronScheduler(options = {}) {
  schedulerOptions = { ...options }
  const jobs = getJobs()
  for (const job of jobs) {
    if (job.enabled) {
      scheduleJob(job, schedulerOptions)
    }
  }
  console.log(`[cron-companion] Scheduler started with ${jobs.filter((j) => j.enabled).length} job(s)`)

  if (!retryTimer) {
    retryTimer = setInterval(() => {
      checkAndResumeRetryableRuns().catch((err) => {
        console.error('[cron-companion] Retry resume check failed:', err?.message || err)
      })
    }, 60_000)
    if (retryTimer.unref) retryTimer.unref()
  }
}

export function stopCronScheduler() {
  for (const [id, timer] of timers) {
    clearTimeout(timer)
  }
  timers.clear()
  if (retryTimer) {
    clearInterval(retryTimer)
    retryTimer = null
  }
  schedulerOptions = {}
  console.log('[cron-companion] Scheduler stopped')
}

export function rescheduleJob(job, options = {}) {
  unscheduleJob(job.id)
  if (job.enabled) {
    scheduleJob(job, { ...schedulerOptions, ...options })
  }
}

export function unscheduleJob(taskId) {
  const existing = timers.get(taskId)
  if (existing) {
    clearTimeout(existing)
    timers.delete(taskId)
  }
}
