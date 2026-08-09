/**
 * Teams fan-out subscriber (Module 5).
 * ---------------------------------------------------------------------------
 * Bridges the notification engine to Teams channels by subscribing to
 * `notificationEvents` — the in-process EventEmitter that notification-engine.js
 * declares at line 30 as its "realtime extension point" and which, until now,
 * had zero subscribers.
 *
 * WHY THIS, RATHER THAN CALLING TEAMS FROM EACH CONTROLLER. Subscribing means
 * Teams delivery works for every notification the system already dispatches —
 * assignments, status changes, comments, reminders, escalations — without
 * editing a single controller. It also means the PRD's Module 7 rule holds
 * automatically: "The engine is the single dispatch point... individual
 * modules register as delivery channels but do not independently decide
 * notification logic." Teams sits strictly downstream of preferences, category
 * opt-outs, dedupe and quiet hours, because the event only fires once the
 * engine has already made those decisions.
 *
 * ISOLATION IS THE CRITICAL PROPERTY. An EventEmitter listener that throws
 * synchronously would propagate into dispatchNotification, and an async one
 * that rejects becomes an unhandled rejection that can take the process down.
 * Neither is acceptable: a misconfigured Teams webhook must never break in-app
 * notifications. So the listener is fire-and-forget with a terminal .catch()
 * and never returns its promise to the emitter.
 *
 * DE-DUPLICATION ACROSS RECIPIENTS. dispatchToMany fires one event per
 * recipient, but a Teams channel wants ONE post per project event, not one per
 * team member. A short-lived in-memory ledger keyed on the event's identity
 * collapses that fan-in — otherwise assigning a task on a six-person project
 * would post the same card six times.
 */

const pool = require('../config/db')
const { notificationEvents } = require('./notification-engine')
const { fanOutNotification } = require('./teams-delivery')

/**
 * How long the same (type, link) counts as one channel event.
 * 30s comfortably covers a dispatchToMany loop while being far shorter than
 * any legitimate repeat of the same event.
 */
const CHANNEL_DEDUPE_MS = 30_000

/** Bounded so a burst cannot grow the map without limit. */
const MAX_LEDGER_ENTRIES = 500

const ledger = new Map() // key -> timestamp

let subscribed = false
let listener = null

function ledgerKey(notification) {
  return `${notification.type}::${notification.link_to || notification.linkTo || ''}`
}

/** True if this channel event was already posted moments ago. */
function isRecentlyPosted(notification, now = Date.now()) {
  const key = ledgerKey(notification)
  const seenAt = ledger.get(key)

  if (seenAt && now - seenAt < CHANNEL_DEDUPE_MS) return true

  ledger.set(key, now)

  // Opportunistic eviction — no timer, so this cannot hold the event loop open.
  if (ledger.size > MAX_LEDGER_ENTRIES) {
    for (const [k, ts] of ledger) {
      if (now - ts >= CHANNEL_DEDUPE_MS) ledger.delete(k)
      if (ledger.size <= MAX_LEDGER_ENTRIES) break
    }
  }
  return false
}

/**
 * Enrich a notification with the project context a card needs.
 *
 * The notifications table stores only a link like `/tasks/<uuid>`, but a
 * useful card names the project and the due date, and — more importantly —
 * routing depends on project_id, since webhooks are configured per project.
 *
 * Returns `{}` rather than throwing on any failure: a card with fewer facts is
 * a far better outcome than a dropped notification.
 */
async function resolveContext(notification) {
  const link = notification.link_to || notification.linkTo || ''
  const taskMatch = link.match(/\/tasks\/([0-9a-fA-F-]{36})/)
  const projectMatch = link.match(/\/projects\/([0-9a-fA-F-]{36})/)

  try {
    if (taskMatch) {
      const { rows } = await pool.query(
        `SELECT t.id, t.title, t.due_date, t.status, t.priority, t.project_id,
                p.name AS project_name,
                u.name AS assignee_name
           FROM tasks t
           LEFT JOIN projects p ON p.id = t.project_id
           LEFT JOIN users u ON u.id = t.assignee_id
          WHERE t.id = $1`,
        [taskMatch[1]]
      )
      const t = rows[0]
      if (!t) return {}
      return {
        projectId: t.project_id,
        projectName: t.project_name,
        taskTitle: t.title,
        dueDate: t.due_date,
        toStatus: t.status,
        assigneeName: t.assignee_name,
      }
    }

    if (projectMatch) {
      const { rows } = await pool.query(
        `SELECT id, name FROM projects WHERE id = $1`,
        [projectMatch[1]]
      )
      const p = rows[0]
      if (!p) return {}
      return { projectId: p.id, projectName: p.name }
    }
  } catch (err) {
    console.error('[teams-fanout] context lookup failed:', err.message)
  }

  return {}
}

/**
 * Handle one dispatched notification. Exported so tests can drive it directly
 * without going through the emitter.
 */
async function handleNotification(payload, deps = {}) {
  const notification = payload?.notification
  if (!notification || !notification.type) return { skipped: 'no_notification' }

  // Integration-health notifications must not loop back into the channel that
  // is failing — a disabled-webhook alert posted to the disabled webhook is
  // both useless and, if delivery half-works, a feedback loop.
  if (
    notification.type === 'teams_webhook_disabled' ||
    notification.type === 'calendar_sync_failed' ||
    notification.type === 'calendar_conflict_detected'
  ) {
    return { skipped: 'integration_health' }
  }

  if (isRecentlyPosted(notification, deps.now ? deps.now() : Date.now())) {
    return { skipped: 'already_posted' }
  }

  const context = deps.context || (await resolveContext(notification))
  return fanOutNotification(notification, context, deps)
}

/**
 * Subscribe to the engine. Call once from server.js.
 *
 * Idempotent: a second call is a no-op rather than a second listener, which
 * would double-post every card.
 */
function startTeamsFanout() {
  if (subscribed) return

  listener = (payload) => {
    // Fire-and-forget with a terminal catch. Deliberately NOT awaited and
    // deliberately not returned — see the isolation note in the header.
    handleNotification(payload).catch((err) => {
      console.error('[teams-fanout] handler failed:', err.message)
    })
  }

  notificationEvents.on('notification', listener)
  subscribed = true
  console.log('[teams-fanout] subscribed to notification events')
}

function stopTeamsFanout() {
  if (listener) notificationEvents.off('notification', listener)
  listener = null
  subscribed = false
}

function __resetLedger() {
  ledger.clear()
}

module.exports = {
  startTeamsFanout,
  stopTeamsFanout,
  handleNotification,
  resolveContext,
  isRecentlyPosted,
  __resetLedger,
  CHANNEL_DEDUPE_MS,
}
