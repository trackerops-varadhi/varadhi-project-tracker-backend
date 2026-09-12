/**
 * Reminder sweeps — due-soon, overdue, and the two escalations.
 * ---------------------------------------------------------------------------
 * Moved here from utils/reminder-cron.js. It belongs to notify because every
 * one of its six sweeps ends in dispatchNotification, and because the custom
 * lead-time sweep reads `notification_preferences`, which this module owns.
 *
 * WHAT CHANGED IN THE MOVE, and what did not.
 *
 * The sweeps used to be SQL: `tasks LEFT JOIN projects`, and for two of them
 * `JOIN notification_preferences` and `LEFT JOIN users` as well — one pool, one
 * schema, four tables owned by three different modules. After the Phase 2 split
 * that query cannot run at all, which is why ENABLE_CRON has been false.
 *
 * Each sweep now asks work "which tasks are due when?" through its public
 * interface and decides for itself who to tell. Two joins in particular are
 * gone:
 *
 *   notification_preferences  did not move — it is notify's table. What
 *     changed is the direction. Instead of joining preferences to tasks and
 *     letting Postgres match lead_days against due dates, this module reads its
 *     OWN preferences, groups users by lead time, and asks work once per
 *     distinct lead time for the tasks due that many days out. Same result, and
 *     the query that spans two schemas no longer exists. It is also usually
 *     fewer round trips, because a handful of distinct lead-day values covers
 *     every user.
 *
 *   users.name             was a display lookup for the escalation text. It is
 *     now identity.getUserCards(), the same batched resolution every other
 *     cross-module display reference uses. Batched per sweep, not per row —
 *     the old version got the name for free in the join, and a naive port
 *     would have turned that into one query per overdue task.
 *
 * Behaviour is otherwise identical, deliberately: same six sweeps in the same
 * order, same dedupe windows, same message text, same admin alert when the
 * sweep itself throws. The date arithmetic still happens in Postgres under
 * CRON_TIMEZONE — "due tomorrow" is a calendar question, and answering it in JS
 * against a UTC server shifts the boundary by the offset.
 */

const cron = require('node-cron')

const pool = require('../../platform/db').forSchema('notify')
const {
  dispatchNotification,
  notifyByRoles,
  NOTIFICATION_TYPES,
} = require('./engine')

// work and identity are required lazily, inside the sweeps. notify <-> work is
// a require cycle (work notifies, this file reads tasks), so a top-level
// require sees a half-built module depending on load order — the same reason
// auth.middleware.js and actions.controller.js do it this way.
const work = () => require('../work')
const identity = () => require('../identity')

const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata'
const SCHEDULE = process.env.REMINDER_CRON_SCHEDULE || '0 * * * *'

const WINDOWS = {
  reminder: 20 * 60,   // once per day
  overdue: 24 * 60,    // once per day
  escalation: 24 * 60, // once per day, per manager, per task
}

// Guards against a slow sweep overlapping the next tick.
let isRunning = false
let task = null

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const hoursOverdue = (dueDate) =>
  Math.floor((Date.now() - new Date(dueDate).getTime()) / (1000 * 60 * 60))

const formatOverdue = (hours) => {
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

const inProject = (name) => (name ? ` in ${name}` : '')

/** Assignee display names for a batch of rows, resolved through identity. */
const assigneeNames = async (rows) => {
  const ids = [...new Set(rows.map((r) => r.assignee_id).filter(Boolean))]
  if (!ids.length) return new Map()
  const cards = await identity().getUserCards(ids)
  return new Map([...cards].map(([id, c]) => [id, c.name]))
}

/* ── Sweep 1 — due tomorrow ───────────────────────────────────────────────── */

async function sendDueTomorrowReminders() {
  const rows = await work().findTasksDueInDays(1, TIMEZONE)
  let sent = 0
  for (const row of rows) {
    const result = await dispatchNotification(
      row.assignee_id,
      NOTIFICATION_TYPES.TASK_REMINDER,
      'Task due tomorrow',
      `"${row.title}"${inProject(row.project_name)} is due tomorrow.`,
      `/tasks/${row.id}`,
      'normal',
      { dedupeWindowMinutes: WINDOWS.reminder }
    )
    if (result.delivered) sent += 1
  }
  return { scanned: rows.length, sent }
}

/* ── Sweep 2 — due today ──────────────────────────────────────────────────── */

async function sendDueTodayReminders() {
  const rows = await work().findTasksDueInDays(0, TIMEZONE)
  let sent = 0
  for (const row of rows) {
    const result = await dispatchNotification(
      row.assignee_id,
      NOTIFICATION_TYPES.TASK_REMINDER,
      'Task due today',
      `"${row.title}"${inProject(row.project_name)} is due today.`,
      `/tasks/${row.id}`,
      'high',
      { dedupeWindowMinutes: WINDOWS.reminder }
    )
    if (result.delivered) sent += 1
  }
  return { scanned: rows.length, sent }
}

/* ── Sweep 3 — custom lead time ───────────────────────────────────────────── */

/**
 * The sweep that used to join across the boundary.
 *
 * Reads notify's own preferences, groups users by lead time, then asks work
 * once per distinct lead time. 0 and 1 are excluded because sweeps 1 and 2
 * already cover due-today and due-tomorrow; leaving them in would send two
 * notifications for the same task.
 */
async function sendCustomLeadTimeReminders() {
  const { rows: prefs } = await pool.query(
    `SELECT user_id, reminder_lead_days
       FROM notification_preferences
      WHERE reminder_lead_days IS NOT NULL
        AND reminder_lead_days NOT IN (0, 1)`
  )

  if (!prefs.length) return { scanned: 0, sent: 0 }

  // lead days -> the users who chose that many
  const byLeadDays = new Map()
  for (const p of prefs) {
    const days = Number(p.reminder_lead_days)
    if (!Number.isFinite(days) || days <= 1) continue
    if (!byLeadDays.has(days)) byLeadDays.set(days, new Set())
    byLeadDays.get(days).add(p.user_id)
  }

  let scanned = 0
  let sent = 0

  for (const [days, userIds] of byLeadDays) {
    const due = await work().findTasksDueInDays(days, TIMEZONE)
    // work answered for everyone due that day; only these users asked for it.
    const mine = due.filter((r) => userIds.has(r.assignee_id))
    scanned += mine.length

    for (const row of mine) {
      const result = await dispatchNotification(
        row.assignee_id,
        NOTIFICATION_TYPES.TASK_REMINDER,
        'Upcoming deadline',
        `"${row.title}"${inProject(row.project_name)} is due in ${days} days.`,
        `/tasks/${row.id}`,
        'normal',
        { dedupeWindowMinutes: WINDOWS.reminder }
      )
      if (result.delivered) sent += 1
    }
  }

  return { scanned, sent }
}

/* ── Sweep 4 — overdue ────────────────────────────────────────────────────── */

async function sendOverdueAlerts() {
  const rows = await work().findOverdueTasks()
  let sent = 0
  for (const row of rows) {
    const late = formatOverdue(hoursOverdue(row.due_date))
    const project = inProject(row.project_name)

    const result = await dispatchNotification(
      row.assignee_id,
      NOTIFICATION_TYPES.TASK_OVERDUE,
      'Task overdue',
      `"${row.title}"${project} is ${late} past its due date.`,
      `/tasks/${row.id}`,
      'high',
      { dedupeWindowMinutes: WINDOWS.overdue }
    )
    if (result.delivered) sent += 1

    // Manager visibility as soon as something is overdue, not just after the
    // 48h escalation. Skip if they're also the assignee, or if there's no
    // manager set.
    if (row.manager_id && row.manager_id !== row.assignee_id) {
      await dispatchNotification(
        row.manager_id,
        NOTIFICATION_TYPES.TASK_OVERDUE,
        'Team task overdue',
        `"${row.title}"${project} is ${late} past its due date.`,
        `/tasks/${row.id}`,
        'high',
        { dedupeWindowMinutes: WINDOWS.overdue }
      )
    }
  }
  return { scanned: rows.length, sent }
}

/* ── Sweep 5 — escalate to the project manager after 48h ──────────────────── */

async function escalateStaleTasks() {
  const rows = await work().findTasksOverdueByHours(48, { requireManager: true })
  const names = await assigneeNames(rows)

  let sent = 0
  for (const row of rows) {
    // No point telling the manager about their own task twice.
    if (row.manager_id === row.assignee_id) continue

    const late = formatOverdue(hoursOverdue(row.due_date))
    const name = names.get(row.assignee_id)
    const who = name ? ` Assigned to ${name}.` : ' Unassigned.'

    const result = await dispatchNotification(
      row.manager_id,
      NOTIFICATION_TYPES.TASK_ESCALATION,
      'Task overdue by more than 48 hours',
      `"${row.title}" in ${row.project_name} is ${late} past due.${who}`,
      `/tasks/${row.id}`,
      'urgent',
      { dedupeWindowMinutes: WINDOWS.escalation }
    )
    if (result.delivered) sent += 1
  }
  return { scanned: rows.length, sent }
}

/* ── Sweep 6 — final escalation to every admin after 72h ──────────────────── */

async function escalateToAdmin() {
  // requireManager:false — a project with no manager still has to reach an
  // admin. This is the escalation that exists because nothing else worked.
  const rows = await work().findTasksOverdueByHours(72, { requireManager: false })
  const names = await assigneeNames(rows)

  let sent = 0
  for (const row of rows) {
    const late = formatOverdue(hoursOverdue(row.due_date))
    const name = names.get(row.assignee_id)
    const who = name ? ` Assigned to ${name}.` : ' Unassigned.'

    const results = await notifyByRoles(
      ['admin'],
      NOTIFICATION_TYPES.TASK_ESCALATION,
      'Final escalation: task overdue by more than 72 hours',
      `"${row.title}"${inProject(row.project_name)} is ${late} past due.${who}`,
      `/tasks/${row.id}`,
      'urgent',
      { dedupeWindowMinutes: WINDOWS.escalation }
    )
    sent += results.filter((r) => r.delivered).length
  }
  return { scanned: rows.length, sent }
}

/* ── Runner ───────────────────────────────────────────────────────────────── */

/** Run all six sweeps once. Safe to call manually (tests, admin endpoint). */
async function runRemindersNow() {
  if (isRunning) {
    console.warn('[reminder-cron] previous run still in progress — skipping this tick.')
    return { skipped: true }
  }

  isRunning = true
  const startedAt = Date.now()

  try {
    const reminders = await sendDueTomorrowReminders()
    const dueToday = await sendDueTodayReminders()
    const customLeadTime = await sendCustomLeadTimeReminders()
    const overdue = await sendOverdueAlerts()
    const escalations = await escalateStaleTasks()
    const adminEscalations = await escalateToAdmin()

    const summary = {
      reminders, dueToday, customLeadTime, overdue, escalations, adminEscalations,
      durationMs: Date.now() - startedAt,
    }

    console.log(
      `[reminder-cron] due-tomorrow ${reminders.sent}/${reminders.scanned} · ` +
      `due-today ${dueToday.sent}/${dueToday.scanned} · ` +
      `custom-lead-time ${customLeadTime.sent}/${customLeadTime.scanned} · ` +
      `overdue ${overdue.sent}/${overdue.scanned} · ` +
      `escalated ${escalations.sent}/${escalations.scanned} · ` +
      `admin-escalated ${adminEscalations.sent}/${adminEscalations.scanned} · ` +
      `${summary.durationMs}ms`
    )

    return summary
  } catch (err) {
    console.error('[reminder-cron] run failed:', err.message)
    // Ops visibility: tell admins the sweep itself broke. Cron runs at most
    // once/hour, so there is no cascade-spam risk here.
    try {
      await notifyByRoles(
        ['admin'],
        NOTIFICATION_TYPES.SYSTEM_CRON_FAILURE,
        'Reminder cron failed',
        `The hourly reminder sweep failed: ${err.message}`,
        null,
        'urgent',
        { skipDedupe: true, ignoreQuietHours: true }
      )
    } catch (alertErr) {
      console.error('[reminder-cron] failed to notify admins of cron failure:', alertErr.message)
    }
    return { error: err.message }
  } finally {
    isRunning = false
  }
}

/** Register the hourly schedule. Started by the platform via notify's jobs. */
function startReminderCron() {
  if (task) return task

  if (!cron.validate(SCHEDULE)) {
    console.error(`[reminder-cron] invalid schedule "${SCHEDULE}" — cron not started.`)
    return null
  }

  task = cron.schedule(SCHEDULE, runRemindersNow, { scheduled: true, timezone: TIMEZONE })
  console.log(`[reminder-cron] scheduled "${SCHEDULE}" (${TIMEZONE})`)
  return task
}

function stopReminderCron() {
  if (task) {
    task.stop()
    task = null
  }
}

module.exports = {
  startReminderCron,
  stopReminderCron,
  runRemindersNow,
  sendDueTomorrowReminders,
  sendDueTodayReminders,
  sendCustomLeadTimeReminders,
  sendOverdueAlerts,
  escalateStaleTasks,
  escalateToAdmin,
  SCHEDULE,
  TIMEZONE,
  WINDOWS,
}
