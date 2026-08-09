/**
 * Snooze re-delivery cron (Module 2)
 * ---------------------------------------------------------------------------
 * Drains `notification_snoozes`: when a snooze's wake_at passes, the original
 * notification is re-delivered and becomes actionable again.
 *
 * WHY THIS IS A SEPARATE CRON, NOT PART OF reminder-cron.js
 * Every sweep in reminder-cron.js is due-date driven ("due tomorrow",
 * "overdue by 48h"). A snooze is anchored to a *user action*, not a due date —
 * a snoozed task assignment may have no due date at all. Folding it in would
 * mean changing Module 7's sweep rules, which is out of bounds. It also needs
 * a 5-minute cadence: on reminder-cron's hourly tick a "snooze 1 hour" could
 * land 55 minutes late.
 *
 * reminder-cron.js is NOT imported or modified. Its structure (isRunning
 * overlap guard, cron.validate before scheduling, runXNow() export) is
 * mirrored here as a convention so the two behave alike operationally.
 *
 * ---------------------------------------------------------------------------
 * THE ONE EXCEPTION TO THE SF2a IDEMPOTENCY RULE
 * ---------------------------------------------------------------------------
 * SF2a established that `notifications.action_taken` is a permanent, one-way
 * claim: once set, the action is settled and replays return the stored result.
 *
 * Snooze deliberately breaks that, and it is the ONLY action that does.
 * Snoozing is not a terminal decision — it is "ask me again later". So:
 *
 *   1. Taking the snooze sets action_taken='snooze' (which correctly stops the
 *      buttons rendering and blocks a competing approve/reject in the window).
 *   2. When the snooze fires, this cron clears action_taken back to NULL, so
 *      the re-delivered notification is fully actionable again.
 *
 * The clear is guarded: it only ever reverts a row whose action_taken is still
 * exactly 'snooze'. If the user approved from another device while it was
 * snoozed, that terminal claim stands and the re-delivery is skipped entirely.
 */

const cron = require('node-cron');

const dbModule = require('../config/db');
const {
  dispatchNotification,
  NOTIFICATION_TYPES,
  notifyByRoles,
} = require('./notification-engine');

function runQuery(text, params = []) {
  if (typeof dbModule.query === 'function') return dbModule.query(text, params);
  if (dbModule.pool && typeof dbModule.pool.query === 'function') {
    return dbModule.pool.query(text, params);
  }
  throw new Error('snooze-cron: could not resolve a query() from config/db.js');
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata';

// Every 5 minutes: fine-grained enough that a 1-hour snooze is at most 5
// minutes late, cheap enough that the query is a no-op index scan when the
// queue is empty.
const SCHEDULE = process.env.SNOOZE_CRON_SCHEDULE || '*/5 * * * *';

// Safety valve so one tick can't fan out unboundedly after downtime.
const BATCH_LIMIT = Number(process.env.SNOOZE_CRON_BATCH) || 200;

let task = null;
let isRunning = false;

/* -------------------------------------------------------------------------- */
/* Sweep                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Deliver every snooze whose wake_at has passed.
 *
 * Each row is claimed with a conditional UPDATE before any work happens, so
 * two overlapping ticks (or two processes) can never double-deliver: only the
 * transition `delivered_at IS NULL -> NOW()` wins.
 */
async function deliverDueSnoozes() {
  const claimed = await runQuery(
    `UPDATE notification_snoozes
        SET delivered_at = NOW()
      WHERE id IN (
        SELECT id FROM notification_snoozes
         WHERE delivered_at IS NULL
           AND wake_at <= NOW()
         ORDER BY wake_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
    RETURNING id, notification_id, user_id`,
    [BATCH_LIMIT]
  );

  const rows = claimed.rows;
  if (!rows.length) return { scanned: 0, sent: 0, skipped: 0 };

  let sent = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const delivered = await redeliver(row);
      if (delivered) sent += 1;
      else skipped += 1;
    } catch (err) {
      // One bad row must not stop the batch. The snooze stays marked delivered
      // so it can't spin forever; the in-app notification itself is untouched.
      skipped += 1;
      console.error('[snooze-cron] re-delivery failed for', row.notification_id, '—', err.message);
    }
  }

  return { scanned: rows.length, sent, skipped };
}

/**
 * Re-dispatch one snoozed notification.
 * @returns {Promise<boolean>} true if a fresh notification was dispatched
 */
async function redeliver({ notification_id: notificationId, user_id: userId }) {
  // Reverse the snooze claim — see the header. Guarded on action_taken still
  // being 'snooze': if the user approved/rejected elsewhere in the meantime,
  // that terminal claim wins and rowCount is 0.
  const reopened = await runQuery(
    `UPDATE notifications
        SET action_taken = NULL,
            actioned_at = NULL,
            action_result = NULL,
            action_source = NULL,
            is_read = false,
            read_at = NULL
      WHERE id = $1
        AND user_id = $2
        AND action_taken = 'snooze'
    RETURNING id, type, title, message, link_to, priority, actions`,
    [notificationId, userId]
  );

  if (!reopened.rowCount) {
    // Either the notification was deleted, or a terminal action settled it
    // while snoozed. Both are correct reasons not to nag the user again.
    return false;
  }

  const n = reopened.rows[0];

  await dispatchNotification(
    userId,
    n.type,
    n.title,
    n.message,
    n.link_to,
    n.priority || 'normal',
    {
      // MANDATORY. The engine's default 5-minute dedupe window keys on
      // (user_id, type, link_to) — the re-delivery is by definition a
      // duplicate of the notification being snoozed, so without this it would
      // be silently swallowed and the snooze would simply lose the reminder.
      skipDedupe: true,
      // Carry the original buttons through so the re-delivered notification is
      // actionable again rather than arriving as a dead copy.
      actions: Array.isArray(n.actions) ? n.actions : undefined,
    }
  );

  return true;
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

/** Run the sweep once. Safe to call manually (tests, admin endpoint). */
async function runSnoozesNow() {
  if (isRunning) {
    console.warn('[snooze-cron] previous run still in progress — skipping this tick.');
    return { skipped: true };
  }

  isRunning = true;
  const startedAt = Date.now();

  try {
    const result = await deliverDueSnoozes();
    const summary = { ...result, durationMs: Date.now() - startedAt };

    // Stay quiet on empty ticks: this runs 288 times a day and the queue is
    // usually empty. reminder-cron logs every tick because it runs hourly.
    if (result.scanned > 0) {
      console.log(
        `[snooze-cron] woke ${result.sent}/${result.scanned}` +
          (result.skipped ? ` · skipped ${result.skipped}` : '') +
          ` · ${summary.durationMs}ms`
      );
    }

    return summary;
  } catch (err) {
    console.error('[snooze-cron] run failed:', err.message);
    try {
      await notifyByRoles(
        ['admin'],
        NOTIFICATION_TYPES.SYSTEM_CRON_FAILURE,
        'Snooze cron failed',
        `The snooze re-delivery sweep failed: ${err.message}`,
        null,
        'urgent',
        { skipDedupe: true, ignoreQuietHours: true }
      );
    } catch (alertErr) {
      console.error('[snooze-cron] failed to notify admins of cron failure:', alertErr.message);
    }
    return { error: err.message };
  } finally {
    isRunning = false;
  }
}

/** Register the schedule. Call once from server.js. */
function startSnoozeCron() {
  if (task) return task;

  if (!cron.validate(SCHEDULE)) {
    console.error(`[snooze-cron] invalid schedule "${SCHEDULE}" — cron not started.`);
    return null;
  }

  task = cron.schedule(SCHEDULE, runSnoozesNow, {
    scheduled: true,
    timezone: TIMEZONE,
  });

  console.log(`[snooze-cron] scheduled "${SCHEDULE}" (${TIMEZONE})`);
  return task;
}

function stopSnoozeCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = {
  startSnoozeCron,
  stopSnoozeCron,
  runSnoozesNow,
  deliverDueSnoozes,
};
