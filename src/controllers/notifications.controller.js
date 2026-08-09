/**
 * Notifications controller
 * ---------------------------------------------------------------------------
 * Inbox, read-state, preferences and push subscription management.
 * All responses follow the project envelope: { success, message, data }.
 */

const dbModule = require('../config/db');
const engine = require('../utils/notification-engine');

function runQuery(text, params = []) {
  if (typeof dbModule.query === 'function') return dbModule.query(text, params);
  if (dbModule.pool && typeof dbModule.pool.query === 'function') {
    return dbModule.pool.query(text, params);
  }
  throw new Error('notifications.controller: could not resolve a query() from config/db.js');
}

function ok(res, data, message = 'Success', status = 200) {
  return res.status(status).json({ success: true, message, data });
}

function fail(res, message, status = 400, data = null) {
  return res.status(status).json({ success: false, message, data });
}

// Accepts '22:00' or '22:00:00'.
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * The server's own wall clock as 'HH:MM'.
 *
 * notification-engine.js#isWithinQuietHours compares the saved window against
 * `new Date().getHours()` — the *server's* local time, which on a hosted box
 * is usually not the viewer's. Returning this lets the settings UI say whether
 * quiet hours are active right now without guessing from the browser clock.
 * Read-only: it changes nothing about what is dispatched, or to whom.
 */
function serverClock(now = new Date()) {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Inbox                                                                      */
/* -------------------------------------------------------------------------- */

/** GET /api/notifications?page=1&limit=20&unreadOnly=true */
async function getNotifications(req, res, next) {
  try {
    const userId = req.user.id;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;
    const unreadOnly = req.query.unreadOnly === 'true';

    const filter = unreadOnly ? 'AND is_read = false' : '';

    const [list, counts] = await Promise.all([
      runQuery(
        `SELECT id, type, title, message, link_to, priority, is_read, read_at, created_at,
                actions, action_taken, actioned_at, action_result
           FROM notifications
          WHERE user_id = $1 ${filter}
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      runQuery(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_read = false)::int AS unread
           FROM notifications
          WHERE user_id = $1`,
        [userId]
      ),
    ]);

    const { total, unread } = counts.rows[0];

    return ok(res, {
      notifications: list.rows,
      unreadCount: unread,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    }, 'Notifications fetched successfully');
  } catch (err) {
    return next(err);
  }
}

/** GET /api/notifications/unread-count */
async function getUnreadCount(req, res, next) {
  try {
    const { rows } = await runQuery(
      `SELECT COUNT(*)::int AS unread
         FROM notifications
        WHERE user_id = $1 AND is_read = false`,
      [req.user.id]
    );
    return ok(res, { unreadCount: rows[0].unread }, 'Unread count fetched successfully');
  } catch (err) {
    return next(err);
  }
}

/** PATCH /api/notifications/:id/read */
async function markAsRead(req, res, next) {
  try {
    const { rows } = await runQuery(
      `UPDATE notifications
          SET is_read = true, read_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING id, is_read, read_at`,
      [req.params.id, req.user.id]
    );

    if (!rows.length) return fail(res, 'Notification not found', 404);

    return ok(res, rows[0], 'Notification marked as read');
  } catch (err) {
    return next(err);
  }
}

/** PATCH /api/notifications/read-all */
async function markAllAsRead(req, res, next) {
  try {
    const { rowCount } = await runQuery(
      `UPDATE notifications
          SET is_read = true, read_at = NOW()
        WHERE user_id = $1 AND is_read = false`,
      [req.user.id]
    );
    return ok(res, { updated: rowCount }, 'All notifications marked as read');
  } catch (err) {
    return next(err);
  }
}

/** DELETE /api/notifications/:id */
async function deleteNotification(req, res, next) {
  try {
    const { rowCount } = await runQuery(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (!rowCount) return fail(res, 'Notification not found', 404);

    return ok(res, { id: req.params.id }, 'Notification deleted');
  } catch (err) {
    return next(err);
  }
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

/** GET /api/notifications/preferences */
async function getPreferences(req, res, next) {
  try {
    const preferences = await engine.getPreferences(req.user.id);
    return ok(
      res,
      { preferences, serverTime: serverClock() },
      'Notification preferences fetched successfully'
    );
  } catch (err) {
    return next(err);
  }
}

// Simple boolean toggles — validated identically, so loop instead of repeating.
const BOOLEAN_FIELDS = [
  'push_enabled',
  'email_enabled',
  'quiet_hours_enabled',
  'task_assigned',
  'task_status_changed',
  'comment_added',
  'due_date_reminder',
  'project_updates',
  'task_reassigned',
  'due_date_changed',
  'priority_changed',
  'mentions',
  'review_requests',
  'approvals',
  'overdue',
  'documents',
  'system_notifications',
];

/** PUT /api/notifications/preferences */
async function updatePreferences(req, res, next) {
  try {
    const body = req.body || {};
    const { quiet_hours_start, quiet_hours_end } = body;
    const patch = {};

    for (const field of BOOLEAN_FIELDS) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== 'boolean') {
          return fail(res, `${field} must be true or false`);
        }
        patch[field] = body[field];
      }
    }

    if (quiet_hours_start !== undefined) {
      if (!TIME_PATTERN.test(quiet_hours_start)) {
        return fail(res, 'quiet_hours_start must be a time in HH:MM format');
      }
      patch.quiet_hours_start = quiet_hours_start;
    }

    if (quiet_hours_end !== undefined) {
      if (!TIME_PATTERN.test(quiet_hours_end)) {
        return fail(res, 'quiet_hours_end must be a time in HH:MM format');
      }
      patch.quiet_hours_end = quiet_hours_end;
    }

    if (body.reminder_lead_days !== undefined) {
      const leadDays = body.reminder_lead_days;
      // 0/1 are already covered by the fixed due-today/due-tomorrow sweeps —
      // reject them here rather than silently accepting a value that would
      // never fire (the cron sweep excludes 0/1 to avoid duplicate reminders).
      const valid =
        leadDays === null || (Number.isInteger(leadDays) && leadDays >= 2 && leadDays <= 30);
      if (!valid) {
        return fail(res, 'reminder_lead_days must be null, or an integer between 2 and 30');
      }
      patch.reminder_lead_days = leadDays;
    }

    if (!Object.keys(patch).length) {
      return fail(res, 'No valid preference fields were provided');
    }

    const preferences = await engine.updatePreferences(req.user.id, patch);
    return ok(
      res,
      { preferences, serverTime: serverClock() },
      'Notification preferences updated successfully'
    );
  } catch (err) {
    return next(err);
  }
}

/* -------------------------------------------------------------------------- */
/* Push subscriptions (optional — only active when VAPID keys are set)        */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/notifications/push/public-key
 *
 * The browser needs the VAPID public key to create a subscription. Serving it
 * from here (rather than duplicating it into a NEXT_PUBLIC_* frontend env var)
 * keeps the keypair defined in exactly one place, and lets the UI detect the
 * "push not configured on this server" case instead of failing opaquely.
 */
async function getPushPublicKey(req, res, next) {
  try {
    const publicKey = process.env.VAPID_PUBLIC_KEY || null;
    return ok(
      res,
      { publicKey, configured: Boolean(publicKey) },
      'Push public key fetched successfully'
    );
  } catch (err) {
    return next(err);
  }
}

/** POST /api/notifications/push/subscribe */
async function subscribeToPush(req, res, next) {
  try {
    const { endpoint, keys } = req.body || {};

    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return fail(res, 'A valid push subscription with endpoint and keys is required');
    }

    const { rows } = await runQuery(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
              SET user_id    = EXCLUDED.user_id,
                  p256dh     = EXCLUDED.p256dh,
                  auth       = EXCLUDED.auth,
                  -- Refresh on re-subscribe too, or the row keeps the UA of
                  -- whichever browser happened to register the endpoint first.
                  user_agent = EXCLUDED.user_agent
        RETURNING id, endpoint, created_at`,
      [req.user.id, endpoint, keys.p256dh, keys.auth, req.headers['user-agent'] || null]
    );

    return ok(res, rows[0], 'Push subscription saved', 201);
  } catch (err) {
    return next(err);
  }
}

/** DELETE /api/notifications/push/subscribe */
async function unsubscribeFromPush(req, res, next) {
  try {
    const { endpoint } = req.body || {};

    if (endpoint) {
      await runQuery(
        `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
        [req.user.id, endpoint]
      );
    } else {
      await runQuery(`DELETE FROM push_subscriptions WHERE user_id = $1`, [req.user.id]);
    }

    return ok(res, null, 'Push subscription removed');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  getPreferences,
  updatePreferences,
  getPushPublicKey,
  subscribeToPush,
  unsubscribeFromPush,
};