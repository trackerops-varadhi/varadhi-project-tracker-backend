/**
 * Bugs Finder — SLA sweep.
 * ---------------------------------------------------------------------------
 * Runs every 5 minutes and does two things:
 *
 *   1. At risk  — a live bug has burned through its configured fraction of the
 *                 resolution window. Warns the assignee (and the project
 *                 manager) once, latched by sla_at_risk_notified_at.
 *   2. Breached — the resolution deadline has passed with no resolution.
 *                 Latches sla_breached so the record keeps the breach even
 *                 after the bug is eventually fixed, logs it to the bug's
 *                 activity timeline, and escalates to admins/managers.
 *
 * Every comparison is made by Postgres against the SERVER clock (NOW()), never
 * against this process's or a browser's idea of the time — the requirement in
 * §7 of the spec.
 *
 * Follows the same shape as reminder-cron.js: an `isRunning` guard against
 * overlapping ticks, a validated schedule, and start/stop exports called from
 * server.js under the shared ENABLE_CRON switch.
 */

const cron = require('node-cron')

const pool = require('../config/db')
const {
  dispatchNotification,
  dispatchToMany,
  NOTIFICATION_TYPES,
} = require('./notification-engine')
const { formatSlaRemaining } = require('./bug-sla')
const { BUG_ACTIONS, logBugActivity } = require('./bug-workflow')

// Every 5 minutes. An SLA countdown measured in hours does not need a tighter
// sweep, and a breach notification five minutes late is still actionable.
const SCHEDULE = process.env.BUG_SLA_CRON_SCHEDULE || '*/5 * * * *'
const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata'

// Statuses whose resolution clock is still running.
const LIVE_STATUSES = `('open','assigned','in_progress','reopened')`

// Long dedupe windows: the latch columns already make each alert fire once, but
// these are the belt-and-braces guard if a latch write ever fails.
const WINDOWS = {
  atRisk: 12 * 60,
  breach: 24 * 60,
}

let isRunning = false
let task = null

/* -------------------------------------------------------------------------- */
/* Sweep 1 — approaching the deadline                                         */
/* -------------------------------------------------------------------------- */

async function sweepAtRisk() {
  // The threshold comes from bug_sla_rules per severity, so an admin changing
  // it takes effect on the next tick without a code change.
  const { rows } = await pool.query(
    `SELECT b.id, b.bug_number, b.title, b.severity, b.assignee_id,
            b.sla_resolution_due_at, p.manager_id
       FROM bugs b
       LEFT JOIN projects p ON b.project_id = p.id
      WHERE b.status IN ${LIVE_STATUSES}
        AND b.sla_breached = FALSE
        AND b.sla_at_risk_notified_at IS NULL
        AND b.sla_resolution_due_at IS NOT NULL
        AND b.sla_resolution_due_at > NOW()
        AND NOW() >= b.sla_started_at + (
              (b.sla_resolution_due_at - b.sla_started_at) *
              COALESCE((SELECT at_risk_threshold FROM bug_sla_rules WHERE severity = b.severity), 0.75))
      LIMIT 200`
  )

  let sent = 0
  for (const row of rows) {
    const key = `BUG-${row.bug_number}`
    const remaining = formatSlaRemaining(new Date(row.sla_resolution_due_at) - Date.now())

    const recipients = [row.assignee_id, row.manager_id].filter(Boolean)
    if (recipients.length) {
      await dispatchToMany(
        recipients,
        NOTIFICATION_TYPES.BUG_SLA_AT_RISK,
        'Bug SLA at risk',
        `${key} "${row.title}" — ${remaining}.`,
        `/bugs/${row.id}`,
        'high',
        { dedupeWindowMinutes: WINDOWS.atRisk }
      )
      sent += 1
    }

    await logBugActivity({
      bugId: row.id,
      actorId: null,
      action: BUG_ACTIONS.SLA_AT_RISK,
      newValue: remaining,
    })

    // Latch so the warning fires once per SLA window, not once per tick.
    await pool.query('UPDATE bugs SET sla_at_risk_notified_at = NOW() WHERE id = $1', [row.id])
  }

  return { scanned: rows.length, sent }
}

/* -------------------------------------------------------------------------- */
/* Sweep 2 — deadline passed                                                  */
/* -------------------------------------------------------------------------- */

async function sweepBreached() {
  // Latch and select in one statement: a bug can only be picked up by the
  // RETURNING clause on the tick that first flips its flag, so two overlapping
  // runs can never both notify for the same breach.
  const { rows } = await pool.query(
    `UPDATE bugs b
        SET sla_breached = TRUE,
            sla_breached_at = NOW(),
            updated_at = NOW()
       FROM projects p
      WHERE b.status IN ${LIVE_STATUSES}
        AND b.sla_breached = FALSE
        AND b.sla_resolution_due_at IS NOT NULL
        AND b.sla_resolution_due_at < NOW()
        AND p.id IS NOT DISTINCT FROM b.project_id
      RETURNING b.id, b.bug_number, b.title, b.severity, b.assignee_id,
                b.reporter_id, b.sla_resolution_due_at, p.manager_id`
  )

  // The join above drops bugs with no project. Sweep those separately rather
  // than letting an unassigned-project bug silently never breach.
  const orphans = await pool.query(
    `UPDATE bugs
        SET sla_breached = TRUE, sla_breached_at = NOW(), updated_at = NOW()
      WHERE status IN ${LIVE_STATUSES}
        AND sla_breached = FALSE
        AND project_id IS NULL
        AND sla_resolution_due_at IS NOT NULL
        AND sla_resolution_due_at < NOW()
      RETURNING id, bug_number, title, severity, assignee_id, reporter_id,
                sla_resolution_due_at, NULL::uuid AS manager_id`
  )

  const breached = [...rows, ...orphans.rows]
  let sent = 0

  for (const row of breached) {
    const key = `BUG-${row.bug_number}`
    const overdueBy = formatSlaRemaining(new Date(row.sla_resolution_due_at) - Date.now())

    const recipients = new Set([row.assignee_id, row.reporter_id, row.manager_id].filter(Boolean))

    // A breached critical defect goes to every admin/manager, not just the
    // project's own manager — that is the escalation path in §17.
    if (row.severity === 'critical') {
      const { rows: leads } = await pool.query(
        `SELECT id FROM users WHERE role IN ('admin','manager') AND status = 'active'`
      )
      for (const l of leads) recipients.add(l.id)
    }

    if (recipients.size) {
      await dispatchToMany(
        [...recipients],
        NOTIFICATION_TYPES.BUG_SLA_BREACHED,
        'Bug SLA breached',
        `${key} "${row.title}" has missed its ${row.severity} resolution SLA — ${overdueBy}.`,
        `/bugs/${row.id}`,
        'urgent',
        { dedupeWindowMinutes: WINDOWS.breach }
      )
      sent += 1
    }

    await logBugActivity({
      bugId: row.id,
      actorId: null,
      action: BUG_ACTIONS.SLA_BREACHED,
      newValue: overdueBy,
      detail: { severity: row.severity, dueAt: row.sla_resolution_due_at },
    })
  }

  return { scanned: breached.length, sent }
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

async function runBugSlaSweepNow() {
  if (isRunning) {
    console.warn('[bug-sla-cron] previous sweep still running — skipping this tick.')
    return null
  }
  isRunning = true

  try {
    const atRisk = await sweepAtRisk()
    const breached = await sweepBreached()

    if (atRisk.sent || breached.sent) {
      console.log(
        `[bug-sla-cron] at-risk ${atRisk.sent}/${atRisk.scanned}, breached ${breached.sent}/${breached.scanned}`
      )
    }
    return { atRisk, breached }
  } catch (err) {
    console.error('[bug-sla-cron] sweep failed:', err.message)
    // Same ops-alert path reminder-cron.js uses for its own failures, so a
    // silently dead SLA sweep is visible rather than invisible.
    try {
      const { notifyByRoles } = require('./notification-engine')
      await notifyByRoles(
        ['admin'],
        NOTIFICATION_TYPES.SYSTEM_CRON_FAILURE,
        'Bug SLA sweep failed',
        `The Bugs Finder SLA sweep errored: ${err.message}`,
        '/bugs',
        'high',
        { dedupeWindowMinutes: 60 }
      )
    } catch {
      /* the alert about the failure must not itself throw */
    }
    return null
  } finally {
    isRunning = false
  }
}

/** Register the schedule. Called once from server.js. */
function startBugSlaCron() {
  if (task) return task

  if (!cron.validate(SCHEDULE)) {
    console.error(`[bug-sla-cron] invalid schedule "${SCHEDULE}" — cron not started.`)
    return null
  }

  task = cron.schedule(SCHEDULE, runBugSlaSweepNow, { scheduled: true, timezone: TIMEZONE })
  console.log(`[bug-sla-cron] scheduled "${SCHEDULE}" (${TIMEZONE})`)
  return task
}

function stopBugSlaCron() {
  if (task) {
    task.stop()
    task = null
  }
}

module.exports = {
  startBugSlaCron,
  stopBugSlaCron,
  runBugSlaSweepNow,
  sweepAtRisk,
  sweepBreached,
}
