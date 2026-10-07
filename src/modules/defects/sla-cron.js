/**
 * Defects — SLA sweep.
 * ---------------------------------------------------------------------------
 * Runs every 5 minutes and does two things:
 *
 *   1. At risk  — a live bug has burned through its configured fraction of the
 *                 resolution window. Warns the assignee (via their task) and
 *                 the reporter once, latched by sla_at_risk_notified_at.
 *   2. Breached — the resolution deadline has passed with no resolution.
 *                 Latches sla_breached so the record keeps the breach even
 *                 after the bug is eventually fixed, logs it to the bug's
 *                 activity timeline, and escalates to admins/managers.
 *
 * Every comparison is made by Postgres against the SERVER clock (NOW()), never
 * against this process's or a browser's idea of the time.
 *
 * WHAT CHANGED IN THE MODULE MOVE
 * Both sweeps used to join `projects` to read p.manager_id. The breach sweep
 * did it as `UPDATE bugs b FROM projects p ... p.id IS NOT DISTINCT FROM
 * b.project_id`, which silently excluded bugs with no project and needed a
 * second "orphans" statement to compensate. The join is gone: one UPDATE now
 * latches every breached bug regardless of project.
 *
 * ROLE WORKSPACES: project managers are no longer told — the Bugs Finder is
 * QC's. The assignee is warned with a link to their linked task, the reporter
 * and (for critical breaches) the admin/qc leads with a link to the bug.
 */

const cron = require('node-cron')

const repo = require('./repo')
const identity = require('../identity')
const notify = require('../notify')
const { formatSlaRemaining } = require('./sla')
const { BUG_ACTIONS, logBugActivity } = require('./workflow')

// Every 5 minutes. An SLA countdown measured in hours does not need a tighter
// sweep, and a breach notification five minutes late is still actionable.
const SCHEDULE = process.env.BUG_SLA_CRON_SCHEDULE || '*/5 * * * *'
const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata'

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
  const rows = await repo.findAtRiskBugs(200)
  if (rows.length === 0) return { scanned: 0, sent: 0 }

  let sent = 0
  for (const row of rows) {
    const key = `BUG-${row.bug_number}`
    const remaining = formatSlaRemaining(new Date(row.sla_resolution_due_at) - Date.now())

    // The developer works the bug through its task, so their warning links
    // there; the reporter (QC) gets the bug itself. Project managers no longer
    // use the Bugs module.
    if (row.assignee_id) {
      await notify.dispatch({
        userId: row.assignee_id,
        type: notify.TYPES.BUG_SLA_AT_RISK,
        title: 'Bug SLA at risk',
        message: `${key} "${row.title}" — ${remaining}.`,
        linkTo: row.linked_task_id ? `/tasks/${row.linked_task_id}` : '/tasks',
        priority: 'high',
        dedupeWindowMinutes: WINDOWS.atRisk,
      })
      sent += 1
    }
    if (row.reporter_id && row.reporter_id !== row.assignee_id) {
      await notify.dispatch({
        userId: row.reporter_id,
        type: notify.TYPES.BUG_SLA_AT_RISK,
        title: 'Bug SLA at risk',
        message: `${key} "${row.title}" — ${remaining}.`,
        linkTo: `/bugs/${row.id}`,
        priority: 'high',
        dedupeWindowMinutes: WINDOWS.atRisk,
      })
    }

    await logBugActivity({
      bugId: row.id,
      actorId: null,
      action: BUG_ACTIONS.SLA_AT_RISK,
      newValue: remaining,
    })

    // Latch so the warning fires once per SLA window, not once per tick.
    await repo.latchAtRisk(row.id)
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
  const breached = await repo.latchBreachedBugs()
  if (breached.length === 0) return { scanned: 0, sent: 0 }

  // Resolved once for the whole sweep rather than per critical bug, which is
  // what the legacy version did inside the loop. Bug leads are admin and qc.
  let leadIds = null
  const getLeadIds = async () => {
    if (leadIds === null) leadIds = await identity.getActiveUserIdsByRoles(['admin', 'qc'])
    return leadIds
  }

  let sent = 0
  for (const row of breached) {
    const key = `BUG-${row.bug_number}`
    const overdueBy = formatSlaRemaining(new Date(row.sla_resolution_due_at) - Date.now())

    // The assignee is told separately, with a link to their task.
    const recipients = new Set([row.reporter_id].filter(Boolean))

    // A breached critical defect goes to every bug lead (admin/qc) — that is
    // the escalation path.
    if (row.severity === 'critical') {
      for (const id of await getLeadIds()) recipients.add(id)
    }
    if (row.assignee_id) {
      recipients.delete(row.assignee_id)
      await notify.dispatch({
        userId: row.assignee_id,
        type: notify.TYPES.BUG_SLA_BREACHED,
        title: 'Bug SLA breached',
        message: `${key} "${row.title}" has missed its ${row.severity} resolution SLA — ${overdueBy}.`,
        linkTo: row.linked_task_id ? `/tasks/${row.linked_task_id}` : '/tasks',
        priority: 'urgent',
        dedupeWindowMinutes: WINDOWS.breach,
      })
    }

    if (recipients.size) {
      await notify.dispatchToUsers({
        userIds: [...recipients],
        type: notify.TYPES.BUG_SLA_BREACHED,
        title: 'Bug SLA breached',
        message: `${key} "${row.title}" has missed its ${row.severity} resolution SLA — ${overdueBy}.`,
        linkTo: `/bugs/${row.id}`,
        priority: 'urgent',
        dedupeWindowMinutes: WINDOWS.breach,
      })
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
      await notify.dispatchToRoles({
        roles: ['admin'],
        type: notify.TYPES.SYSTEM_CRON_FAILURE,
        title: 'Bug SLA sweep failed',
        message: `The Bugs Finder SLA sweep errored: ${err.message}`,
        linkTo: '/bugs',
        priority: 'high',
        dedupeWindowMinutes: 60,
      })
    } catch {
      /* the alert about the failure must not itself throw */
    }
    return null
  } finally {
    isRunning = false
  }
}

/** Register the schedule. Called once from server.js via the module's index. */
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
