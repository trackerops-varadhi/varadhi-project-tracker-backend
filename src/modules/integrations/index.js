// PUBLIC INTERFACE — integrations (calendar sync · Microsoft Teams)
//
// Tables: calendar_connections · calendar_sync_settings · calendar_event_links ·
// calendar_sync_conflicts · teams_webhooks · teams_delivery_log
//
// The only file outside this directory that anything else may require.
//
// DEPENDENCY DIRECTION — the point of this module's final shape:
// integrations depends on work, notify and identity. Nothing depends on
// integrations. work used to call this module's markSourceDirty/purgeSource
// directly; it now emits `task.changed` / `task.deleted` and work-subscriber.js
// listens. Delete this whole directory and the tracker still runs — tasks
// simply stop being mirrored onto calendars and Teams channels, which is
// exactly what "integration" should mean.

const calendarCron = require('./calendar-cron')
const teamsCron = require('./teams-cron')
const teamsFanout = require('./teams-fanout')
const workSubscriber = require('./work-subscriber')

exports.mount = [
  { path: '/api/calendar', router: require('./calendar.routes') },
  { path: '/api/teams', router: require('./teams.routes') },
]

/* ── Background jobs ────────────────────────────────────────────────────── */
//
// Both are polling sweeps, and both sit behind ENABLE_CRON.
//   calendar — 5-minutely push/pull reconciliation. Polling rather than
//              provider push channels, which would need a publicly reachable
//              callback URL.
//   teams    — 2-minutely delivery retries plus the hourly digest tick.
exports.jobs = [
  { name: 'calendar-sync', start: calendarCron.startCalendarCron, stop: calendarCron.stopCalendarCron },
  { name: 'teams', start: teamsCron.startTeamsCron, stop: teamsCron.stopTeamsCron },
]

/* ── Event subscriptions ────────────────────────────────────────────────── */

/**
 * Register this module's event listeners.
 *
 * Deliberately SEPARATE from `jobs` and NOT gated by ENABLE_CRON. These fire on
 * the request path, not on a schedule:
 *
 *   teams-fanout     listens to notify's emitter, so a notification reaches the
 *                    right Teams channel as it is dispatched.
 *   work-subscriber  listens to work's task events, so a deleted task's calendar
 *                    event is reaped before the row goes, and to
 *                    project.deleted, which removes the project's Teams
 *                    webhooks and the calendar events of its milestone and
 *                    of every task deleted with it.
 *
 * Turning the sweeps off must not silently stop either. startTeamsFanout was
 * already outside the cron switch in server.js for this reason; this formalises
 * that rather than changing it.
 *
 * Both are idempotent.
 */
exports.subscribe = () => {
  teamsFanout.startTeamsFanout()
  workSubscriber.startWorkSubscriptions()
}

exports.unsubscribe = () => {
  teamsFanout.stopTeamsFanout()
  workSubscriber.stopWorkSubscriptions()
}

/* ── Test seams ─────────────────────────────────────────────────────────── */
//
// scripts/calendar-sync.test.js and teams-webhook.test.js drive these directly
// rather than waiting for a tick, injecting a mock provider / http client so
// nothing leaves the machine.
exports.runCalendarSyncNow = calendarCron.runCalendarCronNow
exports.runTeamsDigestNow = teamsCron.runTeamsDigestNow

/* ── What this module consumes ───────────────────────────────────────────── */
//
// GENERATED, and checked by `npm run lint:contracts`. Every name here is read
// from another module's index.js, so this list IS this module's half of the
// future HTTP contract: extract it and these become the calls its client makes.
// Do not hand-edit — change the code, then run `npm run lint:contracts -- --write`.
exports.consumes = {
  identity: ['getUserCards'],
  notify: ['NOTIFICATION_TYPES', 'dispatchNotification', 'notificationEvents', 'notifyByRoles'],
  work: ['events', 'getProjectCards', 'getSyncableMilestonesForUser', 'getSyncableTasksForUser', 'getTaskDigestCounts', 'getTaskSummary', 'getUpcomingTasksForUser', 'projectExists', 'setTaskDueDate'],
}
