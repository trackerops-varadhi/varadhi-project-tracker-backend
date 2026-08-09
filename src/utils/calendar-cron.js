/**
 * Calendar sync sweep (Module 4).
 * ---------------------------------------------------------------------------
 * Five-minutely, which is not arbitrary: the PRD sets "Sync Latency (task
 * change to calendar update) ≤ 5 minutes" as a KPI and states plainly that
 * "Real-time sync is near-real-time (polling/webhook-based), not
 * instantaneous". A 5-minute cadence is the loosest schedule that still meets
 * the stated target.
 *
 * Polling rather than provider push channels (Google watch / Graph
 * subscriptions) is a deliberate v1 choice: those require a publicly
 * reachable HTTPS callback plus channel renewal bookkeeping, and they would
 * make the feature undeployable in any environment without one. The delta
 * cursor (sync_token) means each poll is incremental, not a full re-list.
 *
 * Structure mirrors snooze-cron.js exactly — module-level `task`, an
 * `isRunning` overlap guard, cron.validate() before scheduling, and the same
 * admin alert on failure. It is started from server.js under the SAME
 * ENABLE_CRON switch as every other sweep; a second flag would mean
 * ENABLE_CRON=false no longer stops all background work, which is exactly the
 * property the existing comment in server.js:78-80 is protecting.
 */

const cron = require('node-cron')
const { runCalendarSyncNow } = require('./calendar-sync')
const { notifyByRoles, NOTIFICATION_TYPES } = require('./notification-engine')

const SCHEDULE = process.env.CALENDAR_CRON_SCHEDULE || '*/5 * * * *'
const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata'

let task = null
let isRunning = false

/**
 * One sweep. Never throws — a cron callback that rejects would take the
 * scheduler down with it.
 */
async function runCalendarCronNow(deps = {}) {
  if (isRunning) {
    console.log('[calendar-cron] previous sweep still running; skipping this tick.')
    return { skipped: 'already_running' }
  }
  isRunning = true
  const startedAt = Date.now()

  try {
    const summary = await runCalendarSyncNow(deps)
    return { ...summary, durationMs: Date.now() - startedAt }
  } catch (err) {
    console.error('[calendar-cron] sweep failed:', err.message)
    // Same ops-alert idiom as reminder-cron.js / snooze-cron.js: skipDedupe so
    // a recurring failure keeps being reported, ignoreQuietHours because a
    // broken integration at 3am is still broken at 9am.
    try {
      await notifyByRoles(
        ['admin'],
        NOTIFICATION_TYPES.SYSTEM_CRON_FAILURE,
        'Calendar sync cron failed',
        `The calendar sync sweep failed: ${err.message}`,
        null,
        'urgent',
        { skipDedupe: true, ignoreQuietHours: true }
      )
    } catch (alertErr) {
      console.error('[calendar-cron] failed to notify admins of cron failure:', alertErr.message)
    }
    return { error: err.message }
  } finally {
    isRunning = false
  }
}

/** Register the schedule. Call once from server.js. */
function startCalendarCron() {
  if (task) return task

  if (!cron.validate(SCHEDULE)) {
    console.error(`[calendar-cron] invalid schedule "${SCHEDULE}" — cron not started.`)
    return null
  }

  task = cron.schedule(SCHEDULE, () => runCalendarCronNow(), {
    scheduled: true,
    timezone: TIMEZONE,
  })

  console.log(`[calendar-cron] scheduled "${SCHEDULE}" (${TIMEZONE})`)
  return task
}

function stopCalendarCron() {
  if (task) {
    task.stop()
    task = null
  }
}

module.exports = {
  startCalendarCron,
  stopCalendarCron,
  runCalendarCronNow,
  SCHEDULE,
}
