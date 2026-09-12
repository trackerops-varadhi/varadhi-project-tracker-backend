// PUBLIC INTERFACE — notify
//
// Tables: notifications · notification_preferences · notification_snoozes ·
// notification_action_log · notification_logs · push_subscriptions ·
// push_delivery_retries
//
// The only file outside this directory that anything else may require.
//
// This module is the single fan-out point for every notification in the system:
// in-app row + web push + email, with dedupe, category opt-out and quiet hours
// applied once, here. Nineteen call sites depend on that being true — a module
// that INSERTs into `notifications` itself silently bypasses all of it.

const engine = require('./engine')
const snoozeCron = require('./snooze-cron')
const pushRetry = require('./push-retry')

exports.mount = [
  { path: '/api/notifications', router: require('./notifications.routes') },
  { path: '/api/notification-actions', router: require('./actions.routes') },
]

/* ── Background jobs ────────────────────────────────────────────────────── */
//
// Two sweeps, both draining a database table used as a work queue:
//   snooze     — wakes notifications whose snooze window has elapsed
//   push-retry — redelivers pushes that failed transiently, with backoff
// push-retry exposes no stop(): unlike the other sweeps it never exported one.
// Left as-is rather than inventing one — the process exits without a graceful
// shutdown handler anyway, which is its own item on the Phase 3 list.
exports.jobs = [
  { name: 'snooze', start: snoozeCron.startSnoozeCron, stop: snoozeCron.stopSnoozeCron },
  { name: 'push-retry', start: pushRetry.startPushRetryCron },
]

/* ══════════════════════════════════════════════════════════════════════════ */
/* Dispatch — the object-argument surface                                     */
/* ══════════════════════════════════════════════════════════════════════════ */
//
// The engine takes seven positional arguments and call sites routinely passed
// `null` placeholders to reach `priority`. A boundary is where that gets fixed,
// so this interface takes one object. Migrated modules use these.

/**
 * Send one notification to one user.
 * Never throws — the engine wraps its whole body and returns
 * `{ delivered: false, skipped: 'error' }` on failure, so a notification
 * problem can never turn a successful mutation into a 500.
 */
exports.dispatch = async ({
  userId, type, title, message, linkTo = null, priority = 'normal', ...options
}) => engine.dispatchNotification(userId, type, title, message, linkTo, priority, options)

/**
 * Send one notification to every active user holding any of `roles`.
 * Filters to status='active' and includes admins — both of which raw
 * per-controller INSERTs used to get wrong.
 */
exports.dispatchToRoles = async ({
  roles, type, title, message, linkTo = null, priority = 'normal', ...options
}) => engine.notifyByRoles(roles, type, title, message, linkTo, priority, options)

/**
 * Send one notification to an explicit list of users.
 *
 * `excludeUserId` is the common option — the actor should not be notified
 * about their own action. The engine emits one event per recipient, and
 * teams-fanout collapses those back to a single Teams card via its 30-second
 * ledger, so a broadcast does not become a card storm.
 */
exports.dispatchToUsers = async ({
  userIds, type, title, message, linkTo = null, priority = 'normal', ...options
}) => engine.dispatchToMany(userIds, type, title, message, linkTo, priority, options)

// Constants, not behaviour — the one exception to the all-async rule. These are
// a shared vocabulary (the frontend maps them to icons, the engine dedupes on
// them), so they travel with the interface rather than being re-declared.
exports.TYPES = engine.NOTIFICATION_TYPES
exports.PRIORITIES = engine.PRIORITIES

/* ══════════════════════════════════════════════════════════════════════════ */
/* Raw engine surface — for modules not yet migrated                          */
/* ══════════════════════════════════════════════════════════════════════════ */
//
// calendar-sync, calendar-cron, teams-cron, teams-delivery, teams-fanout,
// reminder-cron and teams.controller all still call the engine with its
// original positional signature. Re-exported here so they go through the
// interface instead of reaching into modules/notify/engine.js directly.
//
// TEMPORARY. Each of these disappears as its module migrates and switches to
// the object-argument surface above. Nothing new should use them.

exports.dispatchNotification = engine.dispatchNotification
exports.dispatchToMany = engine.dispatchToMany
exports.notifyByRoles = engine.notifyByRoles
exports.NOTIFICATION_TYPES = engine.NOTIFICATION_TYPES

/**
 * The one EventEmitter in the codebase, and its one subscriber is
 * utils/teams-fanout.js.
 *
 * Emitted after every successful in-app write, which is what puts Teams
 * delivery downstream of preferences, dedupe and quiet hours for free — rather
 * than every controller having to remember to call Teams too. Moves into the
 * integrations module when that migrates.
 */
exports.notificationEvents = engine.notificationEvents

/* ── Test seams ─────────────────────────────────────────────────────────── */
//
// Exposed for scripts/push-retry.test.js, which drives a sweep directly rather
// than waiting for a tick, and injects a sender so nothing leaves the machine.
exports.runPushRetriesNow = pushRetry.runPushRetriesNow
exports.enqueueRetry = pushRetry.enqueueRetry
exports.runSnoozesNow = snoozeCron.runSnoozesNow
