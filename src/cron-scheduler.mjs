/**
 * Companion cron scheduler — setTimeout-based persistent timer.
 *
 * When a timer fires, the companion does NOT execute AI (it can't).
 * Instead, it marks the task as "pending" in the cron store.
 * The extension polls /api/cron/pending on startup and catches up.
 */

import { getJobs, addPendingRun } from './cron-store.mjs'

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const timers = new Map()

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

function scheduleJob(job) {
  if (!job.enabled) return

  const delay = computeDelay(job.schedule)

  const timer = setTimeout(async () => {
    console.log(`[cron-companion] Timer fired for "${job.name}" (${job.id}), marking as pending`)
    try {
      await addPendingRun(job.id)
    } catch (err) {
      console.error(`[cron-companion] Failed to mark pending for ${job.id}:`, err.message)
    }
    // Re-schedule for next occurrence
    scheduleJob(job)
  }, delay)

  // Prevent timer from keeping the process alive
  if (timer.unref) timer.unref()

  timers.set(job.id, timer)

  const nextRun = new Date(Date.now() + delay)
  console.log(`[cron-companion] Scheduled "${job.name}" — next: ${nextRun.toLocaleString()}`)
}

export function startCronScheduler() {
  const jobs = getJobs()
  for (const job of jobs) {
    if (job.enabled) {
      scheduleJob(job)
    }
  }
  console.log(`[cron-companion] Scheduler started with ${jobs.filter((j) => j.enabled).length} job(s)`)
}

export function stopCronScheduler() {
  for (const [id, timer] of timers) {
    clearTimeout(timer)
  }
  timers.clear()
  console.log('[cron-companion] Scheduler stopped')
}

export function rescheduleJob(job) {
  unscheduleJob(job.id)
  if (job.enabled) {
    scheduleJob(job)
  }
}

export function unscheduleJob(taskId) {
  const existing = timers.get(taskId)
  if (existing) {
    clearTimeout(existing)
    timers.delete(taskId)
  }
}
