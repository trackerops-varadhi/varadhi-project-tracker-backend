/**
 * Reminder & escalation cron
 * ---------------------------------------------------------------------------
 * Runs at the top of every hour and produces these notifications:
 *
 *   1. Reminder    — task due tomorrow                       -> assignee
 *   2. Due today   — task due today                          -> assignee
 *   3. Overdue     — past due and not completed               -> assignee + project manager
 *   4. Escalation  — overdue by more than 48 hours            -> project manager
 *
 * The engine's 5-minute dedupe window is too short for an hourly job, so each
 * sweep passes its own window: a reminder can only fire once per ~20 hours and
 * an overdue alert once per 24 hours, no matter how often the job runs.
 *
 * ---------------------------------------------------------------------------
 * SCHEMA ASSUMPTIONS — edit COLUMNS below to match your tables if they differ.
 * ---------------------------------------------------------------------------
 */

const cron = require('node-cron');

const dbModule = require('../config/db');
const {
  dispatchNotification,
  notifyByRoles,
  NOTIFICATION_TYPES,
} = require('./notification-engine');

function runQuery(text, params = []) {
  if (typeof dbModule.query === 'function') return dbModule.query(text, params);
  if (dbModule.pool && typeof dbModule.pool.query === 'function') {
    return dbModule.pool.query(text, params);
  }
  throw new Error('reminder-cron: could not resolve a query() from config/db.js');
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const COLUMNS = {
  tasksTable: 'tasks',
  taskDueDate: 'due_date',
  taskAssignee: 'assignee_id',
  taskProject: 'project_id',
  taskStatus: 'status',
  taskTitle: 'title',

  projectsTable: 'projects',
  projectName: 'name',
  // Column on `projects` holding the manager/owner user id.
  projectManager: 'manager_id',
};

const COMPLETED_STATUSES = ['completed', 'done'];

// Cron timezone. Reminders are "due tomorrow" relative to this zone.
const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata';

// Top of every hour.
const SCHEDULE = process.env.REMINDER_CRON_SCHEDULE || '0 * * * *';

const WINDOWS = {
  reminder: 20 * 60, // once per day
  overdue: 24 * 60, // once per day
  escalation: 24 * 60, // once per day, per manager, per task
};

// Guards against a slow sweep overlapping the next tick.
let isRunning = false;
let task = null;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const completedList = COMPLETED_STATUSES.map((s) => `'${s}'`).join(', ');

function hoursOverdue(dueDate) {
  return Math.floor((Date.now() - new Date(dueDate).getTime()) / (1000 * 60 * 60));
}

function formatOverdue(hours) {
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/* -------------------------------------------------------------------------- */
/* Sweep 1 — due tomorrow                                                     */
/* -------------------------------------------------------------------------- */

async function sendDueTomorrowReminders() {
  const { rows } = await runQuery(
    `SELECT t.id,
            t.${COLUMNS.taskTitle}    AS title,
            t.${COLUMNS.taskDueDate}  AS due_date,
            t.${COLUMNS.taskAssignee} AS assignee_id,
            p.${COLUMNS.projectName}  AS project_name
       FROM ${COLUMNS.tasksTable} t
       LEFT JOIN ${COLUMNS.projectsTable} p ON p.id = t.${COLUMNS.taskProject}
      WHERE t.${COLUMNS.taskAssignee} IS NOT NULL
        AND t.${COLUMNS.taskDueDate} IS NOT NULL
        AND t.${COLUMNS.taskStatus} NOT IN (${completedList})
        AND (t.${COLUMNS.taskDueDate} AT TIME ZONE $1)::date
            = ((NOW() AT TIME ZONE $1)::date + INTERVAL '1 day')::date`,
    [TIMEZONE]
  );

  let sent = 0;
  for (const row of rows) {
    const project = row.project_name ? ` in ${row.project_name}` : '';
    const result = await dispatchNotification(
      row.assignee_id,
      NOTIFICATION_TYPES.TASK_REMINDER,
      'Task due tomorrow',
      `"${row.title}"${project} is due tomorrow.`,
      `/tasks/${row.id}`,
      'normal',
      { dedupeWindowMinutes: WINDOWS.reminder }
    );
    if (result.delivered) sent += 1;
  }

  return { scanned: rows.length, sent };
}

/* -------------------------------------------------------------------------- */
/* Sweep 2 — due today                                                       */
/* -------------------------------------------------------------------------- */

async function sendDueTodayReminders() {
  const { rows } = await runQuery(
    `SELECT t.id,
            t.${COLUMNS.taskTitle}    AS title,
            t.${COLUMNS.taskDueDate}  AS due_date,
            t.${COLUMNS.taskAssignee} AS assignee_id,
            p.${COLUMNS.projectName}  AS project_name
       FROM ${COLUMNS.tasksTable} t
       LEFT JOIN ${COLUMNS.projectsTable} p ON p.id = t.${COLUMNS.taskProject}
      WHERE t.${COLUMNS.taskAssignee} IS NOT NULL
        AND t.${COLUMNS.taskDueDate} IS NOT NULL
        AND t.${COLUMNS.taskStatus} NOT IN (${completedList})
        AND (t.${COLUMNS.taskDueDate} AT TIME ZONE $1)::date
            = (NOW() AT TIME ZONE $1)::date`,
    [TIMEZONE]
  );

  let sent = 0;
  for (const row of rows) {
    const project = row.project_name ? ` in ${row.project_name}` : '';
    const result = await dispatchNotification(
      row.assignee_id,
      NOTIFICATION_TYPES.TASK_DUE_TODAY,
      'Task due today',
      `"${row.title}"${project} is due today.`,
      `/tasks/${row.id}`,
      'high',
      { dedupeWindowMinutes: WINDOWS.reminder }
    );
    if (result.delivered) sent += 1;
  }

  return { scanned: rows.length, sent };
}

/* -------------------------------------------------------------------------- */
/* Sweep 2b — custom per-user lead time (US-6 / AC-34)                       */
/* -------------------------------------------------------------------------- */

// 0/1 are excluded — those exact cases are already covered by the due-today
// and due-tomorrow sweeps above, so including them here would double-notify
// a user who happens to set their custom lead time to 1 day.
async function sendCustomLeadTimeReminders() {
  const { rows } = await runQuery(
    `SELECT t.id,
            t.${COLUMNS.taskTitle}    AS title,
            t.${COLUMNS.taskDueDate}  AS due_date,
            t.${COLUMNS.taskAssignee} AS assignee_id,
            p.${COLUMNS.projectName}  AS project_name,
            np.reminder_lead_days     AS lead_days
       FROM ${COLUMNS.tasksTable} t
       LEFT JOIN ${COLUMNS.projectsTable} p ON p.id = t.${COLUMNS.taskProject}
       JOIN notification_preferences np ON np.user_id = t.${COLUMNS.taskAssignee}
      WHERE t.${COLUMNS.taskAssignee} IS NOT NULL
        AND t.${COLUMNS.taskDueDate} IS NOT NULL
        AND t.${COLUMNS.taskStatus} NOT IN (${completedList})
        AND np.reminder_lead_days IS NOT NULL
        AND np.reminder_lead_days NOT IN (0, 1)
        AND (t.${COLUMNS.taskDueDate} AT TIME ZONE $1)::date
            = ((NOW() AT TIME ZONE $1)::date + (np.reminder_lead_days || ' days')::interval)::date`,
    [TIMEZONE]
  );

  let sent = 0;
  for (const row of rows) {
    const project = row.project_name ? ` in ${row.project_name}` : '';
    const result = await dispatchNotification(
      row.assignee_id,
      NOTIFICATION_TYPES.TASK_REMINDER,
      'Upcoming deadline',
      `"${row.title}"${project} is due in ${row.lead_days} days.`,
      `/tasks/${row.id}`,
      'normal',
      { dedupeWindowMinutes: WINDOWS.reminder }
    );
    if (result.delivered) sent += 1;
  }

  return { scanned: rows.length, sent };
}

/* -------------------------------------------------------------------------- */
/* Sweep 3 — overdue                                                          */
/* -------------------------------------------------------------------------- */

async function sendOverdueAlerts() {
  const { rows } = await runQuery(
    `SELECT t.id,
            t.${COLUMNS.taskTitle}     AS title,
            t.${COLUMNS.taskDueDate}   AS due_date,
            t.${COLUMNS.taskAssignee}  AS assignee_id,
            p.${COLUMNS.projectName}   AS project_name,
            p.${COLUMNS.projectManager} AS manager_id
       FROM ${COLUMNS.tasksTable} t
       LEFT JOIN ${COLUMNS.projectsTable} p ON p.id = t.${COLUMNS.taskProject}
      WHERE t.${COLUMNS.taskAssignee} IS NOT NULL
        AND t.${COLUMNS.taskDueDate} IS NOT NULL
        AND t.${COLUMNS.taskDueDate} < NOW()
        AND t.${COLUMNS.taskStatus} NOT IN (${completedList})`
  );

  let sent = 0;
  for (const row of rows) {
    const late = formatOverdue(hoursOverdue(row.due_date));
    const project = row.project_name ? ` in ${row.project_name}` : '';
    const result = await dispatchNotification(
      row.assignee_id,
      NOTIFICATION_TYPES.TASK_OVERDUE,
      'Task overdue',
      `"${row.title}"${project} is ${late} past its due date.`,
      `/tasks/${row.id}`,
      'high',
      { dedupeWindowMinutes: WINDOWS.overdue }
    );
    if (result.delivered) sent += 1;

    // Manager visibility as soon as something is overdue, not just after the
    // 48h escalation. Skip if they're also the assignee (no point telling
    // someone twice) or if the project has no manager set.
    if (row.manager_id && row.manager_id !== row.assignee_id) {
      await dispatchNotification(
        row.manager_id,
        NOTIFICATION_TYPES.TASK_OVERDUE,
        'Team task overdue',
        `"${row.title}"${project} is ${late} past its due date.`,
        `/tasks/${row.id}`,
        'high',
        { dedupeWindowMinutes: WINDOWS.overdue }
      );
    }
  }

  return { scanned: rows.length, sent };
}

/* -------------------------------------------------------------------------- */
/* Sweep 4 — escalate to the project manager after 48h                        */
/* -------------------------------------------------------------------------- */

async function escalateStaleTasks() {
  const { rows } = await runQuery(
    `SELECT t.id,
            t.${COLUMNS.taskTitle}     AS title,
            t.${COLUMNS.taskDueDate}   AS due_date,
            t.${COLUMNS.taskAssignee}  AS assignee_id,
            p.${COLUMNS.projectName}   AS project_name,
            p.${COLUMNS.projectManager} AS manager_id,
            u.name                     AS assignee_name
       FROM ${COLUMNS.tasksTable} t
       JOIN ${COLUMNS.projectsTable} p ON p.id = t.${COLUMNS.taskProject}
       LEFT JOIN users u ON u.id = t.${COLUMNS.taskAssignee}
      WHERE t.${COLUMNS.taskDueDate} IS NOT NULL
        AND t.${COLUMNS.taskDueDate} < NOW() - INTERVAL '48 hours'
        AND t.${COLUMNS.taskStatus} NOT IN (${completedList})
        AND p.${COLUMNS.projectManager} IS NOT NULL`
  );

  let sent = 0;
  for (const row of rows) {
    // No point telling the manager about their own task twice.
    if (row.manager_id === row.assignee_id) continue;

    const late = formatOverdue(hoursOverdue(row.due_date));
    const who = row.assignee_name ? ` Assigned to ${row.assignee_name}.` : ' Unassigned.';
    const result = await dispatchNotification(
      row.manager_id,
      NOTIFICATION_TYPES.TASK_ESCALATION,
      'Task overdue by more than 48 hours',
      `"${row.title}" in ${row.project_name} is ${late} past due.${who}`,
      `/tasks/${row.id}`,
      'urgent',
      { dedupeWindowMinutes: WINDOWS.escalation }
    );
    if (result.delivered) sent += 1;
  }

  return { scanned: rows.length, sent };
}

/* -------------------------------------------------------------------------- */
/* Sweep 5 — final escalation to all Admins after 72h                        */
/* -------------------------------------------------------------------------- */

async function escalateToAdmin() {
  const { rows } = await runQuery(
    `SELECT t.id,
            t.${COLUMNS.taskTitle}    AS title,
            t.${COLUMNS.taskDueDate}  AS due_date,
            t.${COLUMNS.taskAssignee} AS assignee_id,
            p.${COLUMNS.projectName}  AS project_name,
            u.name                    AS assignee_name
       FROM ${COLUMNS.tasksTable} t
       LEFT JOIN ${COLUMNS.projectsTable} p ON p.id = t.${COLUMNS.taskProject}
       LEFT JOIN users u ON u.id = t.${COLUMNS.taskAssignee}
      WHERE t.${COLUMNS.taskDueDate} IS NOT NULL
        AND t.${COLUMNS.taskDueDate} < NOW() - INTERVAL '72 hours'
        AND t.${COLUMNS.taskStatus} NOT IN (${completedList})`
  );

  let sent = 0;
  for (const row of rows) {
    const late = formatOverdue(hoursOverdue(row.due_date));
    const project = row.project_name ? ` in ${row.project_name}` : '';
    const who = row.assignee_name ? ` Assigned to ${row.assignee_name}.` : ' Unassigned.';
    const results = await notifyByRoles(
      ['admin'],
      NOTIFICATION_TYPES.TASK_ESCALATION,
      'Final escalation: task overdue by more than 72 hours',
      `"${row.title}"${project} is ${late} past due.${who}`,
      `/tasks/${row.id}`,
      'urgent',
      { dedupeWindowMinutes: WINDOWS.escalation }
    );
    sent += results.filter((r) => r.delivered).length;
  }

  return { scanned: rows.length, sent };
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

/** Run all three sweeps once. Safe to call manually (tests, admin endpoint). */
async function runRemindersNow() {
  if (isRunning) {
    console.warn('[reminder-cron] previous run still in progress — skipping this tick.');
    return { skipped: true };
  }

  isRunning = true;
  const startedAt = Date.now();

  try {
    const reminders = await sendDueTomorrowReminders();
    const dueToday = await sendDueTodayReminders();
    const customLeadTime = await sendCustomLeadTimeReminders();
    const overdue = await sendOverdueAlerts();
    const escalations = await escalateStaleTasks();
    const adminEscalations = await escalateToAdmin();

    const summary = {
      reminders,
      dueToday,
      customLeadTime,
      overdue,
      escalations,
      adminEscalations,
      durationMs: Date.now() - startedAt,
    };

    console.log(
      `[reminder-cron] due-tomorrow ${reminders.sent}/${reminders.scanned} · ` +
        `due-today ${dueToday.sent}/${dueToday.scanned} · ` +
        `custom-lead-time ${customLeadTime.sent}/${customLeadTime.scanned} · ` +
        `overdue ${overdue.sent}/${overdue.scanned} · ` +
        `escalated ${escalations.sent}/${escalations.scanned} · ` +
        `admin-escalated ${adminEscalations.sent}/${adminEscalations.scanned} · ${summary.durationMs}ms`
    );

    return summary;
  } catch (err) {
    console.error('[reminder-cron] run failed:', err.message);
    // Ops visibility: tell admins the sweep itself broke. Cron runs at most
    // once/hour, so there's no cascade-spam risk here the way there would be
    // wiring this into every single per-notification failure path.
    try {
      await notifyByRoles(
        ['admin'],
        NOTIFICATION_TYPES.SYSTEM_CRON_FAILURE,
        'Reminder cron failed',
        `The hourly reminder sweep failed: ${err.message}`,
        null,
        'urgent',
        { skipDedupe: true, ignoreQuietHours: true }
      );
    } catch (alertErr) {
      console.error('[reminder-cron] failed to notify admins of cron failure:', alertErr.message);
    }
    return { error: err.message };
  } finally {
    isRunning = false;
  }
}

/** Register the hourly schedule. Call once from server.js. */
function startReminderCron() {
  if (task) return task;

  if (!cron.validate(SCHEDULE)) {
    console.error(`[reminder-cron] invalid schedule "${SCHEDULE}" — cron not started.`);
    return null;
  }

  task = cron.schedule(SCHEDULE, runRemindersNow, {
    scheduled: true,
    timezone: TIMEZONE,
  });

  console.log(`[reminder-cron] scheduled "${SCHEDULE}" (${TIMEZONE})`);
  return task;
}

function stopReminderCron() {
  if (task) {
    task.stop();
    task = null;
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
};