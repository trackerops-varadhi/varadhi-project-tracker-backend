/**
 * Smart Notification Engine
 * ---------------------------------------------------------------------------
 * Single entry point for every notification the app sends.
 *
 *   dispatchNotification(userId, type, title, message, linkTo, priority, options)
 *
 * Responsibilities:
 *   1. Load (or lazily create) the user's notification preferences.
 *   2. Deduplicate — skip if an identical notification went out recently.
 *   3. Always write an in-app row to `notifications`.
 *   4. Fan out to push (if subscribed + enabled) and email (if enabled),
 *      respecting quiet hours.
 *
 * Never throws at the call site: a failing notification must not fail the
 * business action that triggered it. Errors are logged and returned in the
 * result object instead.
 */

const { EventEmitter } = require('events');
const dbModule = require('../config/db');

/**
 * Realtime extension point. No WebSocket/Supabase-realtime channel exists
 * yet — this is intentionally just an in-process EventEmitter so a future
 * realtime layer can `notificationEvents.on('notification', handler)`
 * without any change to dispatchNotification's callers. dispatchNotification
 * emits on this after every successful in-app write (see step 4 below).
 */
const notificationEvents = new EventEmitter();

/* -------------------------------------------------------------------------- */
/* Adapters — keep this file portable across small differences in your helpers */
/* -------------------------------------------------------------------------- */

// Works whether config/db.js exports { query }, { pool }, or the pool itself.
function runQuery(text, params = []) {
  if (typeof dbModule.query === 'function') return dbModule.query(text, params);
  if (dbModule.pool && typeof dbModule.pool.query === 'function') {
    return dbModule.pool.query(text, params);
  }
  throw new Error('notification-engine: could not resolve a query() from config/db.js');
}

// Works whether utils/sendEmail.js exports the function directly or named.
let mailer = null;
try {
  const mailModule = require('./sendEmail');
  mailer =
    typeof mailModule === 'function'
      ? mailModule
      : mailModule.sendEmail || mailModule.default || null;
} catch (err) {
  console.warn('[notifications] sendEmail util not available — email channel disabled.');
}

// web-push is optional. If it isn't installed or VAPID keys are missing,
// the push channel degrades to a no-op instead of crashing the server.
let webpush = null;
try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush = require('web-push');
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:support@varadhi.local',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  }
} catch (err) {
  webpush = null;
  console.warn('[notifications] web-push not configured — push channel disabled.');
}

// Module 2 action tokens are optional in exactly the same way. If the util is
// missing the engine keeps working; pushes simply ship without action buttons.
let actionTokens = null;
try {
  actionTokens = require('./notification-actions');
} catch (err) {
  console.warn('[notifications] action-token util not available — push actions disabled.');
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_DEDUPE_WINDOW_MINUTES = 5;

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// Priorities that punch through quiet hours.
const QUIET_HOURS_BYPASS = ['urgent'];

const DEFAULT_PREFERENCES = {
  push_enabled: true,
  email_enabled: false,
  quiet_hours_enabled: true,
  quiet_hours_start: '22:00:00',
  quiet_hours_end: '07:00:00',
  task_assigned: true,
  task_status_changed: true,
  comment_added: true,
  due_date_reminder: true,
  project_updates: true,
  // Added for enterprise-parity categories (Jira/ClickUp/Asana-style). All
  // default true so existing users see no behavior change until they opt out.
  task_reassigned: true,
  due_date_changed: true,
  priority_changed: true,
  mentions: true,
  review_requests: true,
  approvals: true,
  overdue: true,
  documents: true,
  system_notifications: true,
  // null = off; the fixed due-tomorrow/due-today sweeps still apply.
  reminder_lead_days: null,
};

// Canonical notification types. Keep controllers using these instead of
// free-form strings so dedupe and the frontend icon map stay in sync.
const NOTIFICATION_TYPES = {
  TASK_ASSIGNED: 'task_assigned',
  TASK_UPDATED: 'task_updated',
  TASK_STATUS_CHANGED: 'task_status_changed',
  TASK_COMMENT: 'task_comment',
  TASK_REMINDER: 'task_reminder',
  TASK_DUE_TODAY: 'task_due_today',
  TASK_OVERDUE: 'task_overdue',
  TASK_ESCALATION: 'task_escalation',
  TASK_REASSIGNED: 'task_reassigned',
  DUE_DATE_CHANGED: 'due_date_changed',
  PRIORITY_CHANGED: 'priority_changed',
  TASK_MENTION: 'task_mention',
  REVIEW_REQUESTED: 'review_requested',
  // Defined for forward-compat with an approval workflow that doesn't exist
  // in the schema yet (tasks have no 'approved'/'rejected' status). Not
  // dispatched anywhere today — see Module 7 audit notes.
  TASK_APPROVED: 'task_approved',
  TASK_REJECTED: 'task_rejected',
  // Same story — no 'blocked' status exists in the tasks table yet.
  TASK_BLOCKED: 'task_blocked',
  PROJECT_ASSIGNED: 'project_assigned',
  PROJECT_UPDATED: 'project_updated',
  PROJECT_ARCHIVED: 'project_archived',
  PROJECT_DELETED: 'project_deleted',
  PROJECT_MEMBER_REMOVED: 'project_member_removed',
  PROJECT_MANAGER_CHANGED: 'project_manager_changed',
  PROJECT_MILESTONE: 'project_milestone',
  DOCUMENT_UPLOADED: 'document_uploaded',
  USER_INVITED: 'user_invited',
  USER_REMOVED: 'user_removed',
  USER_ROLE_CHANGED: 'user_role_changed',
  SYSTEM: 'system',
  // Ops alerts. Only SYSTEM_CRON_FAILURE is actually dispatched today (from
  // reminder-cron.js's existing catch block) — the rest have no subsystem to
  // trigger them from yet (no backup job, no storage-quota tracking). Defined
  // now so the category/preference plumbing is ready when those land.
  SYSTEM_CRON_FAILURE: 'system_cron_failure',
  SYSTEM_EMAIL_FAILURE: 'system_email_failure',
  SYSTEM_PUSH_FAILURE: 'system_push_failure',
  SYSTEM_BACKUP_FAILURE: 'system_backup_failure',
  SYSTEM_STORAGE_WARNING: 'system_storage_warning',
  // Integration health (Modules 4 & 5). These are deliberately NOT mapped in
  // TYPE_CATEGORY_MAP below: each one means an integration the user explicitly
  // connected has stopped working, and a soft per-category preference must not
  // be able to silence that. The user would otherwise believe their calendar
  // is syncing when it silently is not — the exact failure the PRD calls out
  // ("OAuth token expiry/revocation silently breaking sync").
  CALENDAR_SYNC_FAILED: 'calendar_sync_failed',
  CALENDAR_CONFLICT_DETECTED: 'calendar_conflict_detected',
  TEAMS_WEBHOOK_DISABLED: 'teams_webhook_disabled',

  // Leave & time (Modules 6/7). These previously bypassed the engine
  // entirely — the controllers wrote to `notifications` with a raw
  // pool.query, so preferences, quiet hours, dedupe, push and Teams fan-out
  // were all skipped for them.
  LEAVE_REQUESTED: 'leave_requested',
  LEAVE_STATUS_CHANGED: 'leave_status_changed',
  TIME_LOGGED: 'time_logged',
};

// Maps a notification type to the opt-out category checkbox it belongs to
// (see notification_preferences columns). TASK_ESCALATION is deliberately
// left unmapped — it's the 48h manager safety-net and shouldn't be
// silenceable by a soft per-category preference, only by quiet hours (which
// 'urgent' priority already bypasses). TASK_OVERDUE is now gated by the
// 'overdue' category per the new spec (the escalation stays as the
// un-silenceable backstop).
const TYPE_CATEGORY_MAP = {
  [NOTIFICATION_TYPES.TASK_ASSIGNED]: 'task_assigned',
  [NOTIFICATION_TYPES.TASK_STATUS_CHANGED]: 'task_status_changed',
  [NOTIFICATION_TYPES.TASK_COMMENT]: 'comment_added',
  [NOTIFICATION_TYPES.TASK_REMINDER]: 'due_date_reminder',
  [NOTIFICATION_TYPES.TASK_DUE_TODAY]: 'due_date_reminder',
  [NOTIFICATION_TYPES.TASK_OVERDUE]: 'overdue',
  [NOTIFICATION_TYPES.TASK_REASSIGNED]: 'task_reassigned',
  [NOTIFICATION_TYPES.DUE_DATE_CHANGED]: 'due_date_changed',
  [NOTIFICATION_TYPES.PRIORITY_CHANGED]: 'priority_changed',
  [NOTIFICATION_TYPES.TASK_MENTION]: 'mentions',
  [NOTIFICATION_TYPES.REVIEW_REQUESTED]: 'review_requests',
  [NOTIFICATION_TYPES.TASK_APPROVED]: 'approvals',
  [NOTIFICATION_TYPES.TASK_REJECTED]: 'approvals',
  [NOTIFICATION_TYPES.PROJECT_ASSIGNED]: 'project_updates',
  [NOTIFICATION_TYPES.PROJECT_UPDATED]: 'project_updates',
  [NOTIFICATION_TYPES.PROJECT_ARCHIVED]: 'project_updates',
  [NOTIFICATION_TYPES.PROJECT_DELETED]: 'project_updates',
  [NOTIFICATION_TYPES.PROJECT_MEMBER_REMOVED]: 'project_updates',
  [NOTIFICATION_TYPES.PROJECT_MANAGER_CHANGED]: 'project_updates',
  [NOTIFICATION_TYPES.PROJECT_MILESTONE]: 'project_updates',
  [NOTIFICATION_TYPES.DOCUMENT_UPLOADED]: 'documents',
  [NOTIFICATION_TYPES.USER_INVITED]: 'system_notifications',
  [NOTIFICATION_TYPES.USER_REMOVED]: 'system_notifications',
  [NOTIFICATION_TYPES.USER_ROLE_CHANGED]: 'system_notifications',
  [NOTIFICATION_TYPES.SYSTEM_CRON_FAILURE]: 'system_notifications',
  [NOTIFICATION_TYPES.SYSTEM_EMAIL_FAILURE]: 'system_notifications',
  [NOTIFICATION_TYPES.SYSTEM_PUSH_FAILURE]: 'system_notifications',
  [NOTIFICATION_TYPES.SYSTEM_BACKUP_FAILURE]: 'system_notifications',
  [NOTIFICATION_TYPES.SYSTEM_STORAGE_WARNING]: 'system_notifications',
  // No dedicated leave/time preference columns exist on
  // notification_preferences, so these ride the existing system category
  // rather than silently ignoring the user's settings.
  [NOTIFICATION_TYPES.LEAVE_REQUESTED]: 'system_notifications',
  [NOTIFICATION_TYPES.LEAVE_STATUS_CHANGED]: 'system_notifications',
  [NOTIFICATION_TYPES.TIME_LOGGED]: 'system_notifications',
};

// Event types worth an email, per the spec — everything else stays in-app
// (+ push) only, even if the user has email enabled. Harmless today since
// the email channel is already a no-op (see sendEmailChannel), but this is
// exactly the gating that needs to exist before it's safe to wire a real
// mailer in — otherwise every notification would email indiscriminately.
const EMAIL_WORTHY_TYPES = new Set([
  NOTIFICATION_TYPES.TASK_ASSIGNED,
  NOTIFICATION_TYPES.REVIEW_REQUESTED,
  NOTIFICATION_TYPES.TASK_APPROVED,
  NOTIFICATION_TYPES.TASK_REJECTED,
  NOTIFICATION_TYPES.TASK_REMINDER,
  NOTIFICATION_TYPES.TASK_OVERDUE,
  NOTIFICATION_TYPES.PROJECT_ASSIGNED,
  NOTIFICATION_TYPES.USER_INVITED,
]);

// Event types worth a push, per the spec. Same story — push is already a
// no-op (no VAPID keys, no subscription flow), this just makes sure it does
// the right thing the moment it's wired up.
const PUSH_WORTHY_TYPES = new Set([
  NOTIFICATION_TYPES.TASK_ASSIGNED,
  NOTIFICATION_TYPES.TASK_MENTION,
  NOTIFICATION_TYPES.REVIEW_REQUESTED,
  NOTIFICATION_TYPES.TASK_DUE_TODAY,
  NOTIFICATION_TYPES.TASK_OVERDUE,
  NOTIFICATION_TYPES.TASK_APPROVED,
  NOTIFICATION_TYPES.TASK_REJECTED,
]);

const APP_URL = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000';

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read a user's preferences, creating the default row on first access.
 * @param {string} userId
 * @returns {Promise<object>}
 */
const PREFERENCE_COLUMNS = `user_id, push_enabled, email_enabled,
            quiet_hours_enabled, quiet_hours_start, quiet_hours_end,
            task_assigned, task_status_changed, comment_added,
            due_date_reminder, project_updates,
            task_reassigned, due_date_changed, priority_changed,
            mentions, review_requests, approvals, overdue,
            documents, system_notifications, reminder_lead_days`;

async function getPreferences(userId) {
  const { rows } = await runQuery(
    `SELECT ${PREFERENCE_COLUMNS}
       FROM notification_preferences
      WHERE user_id = $1`,
    [userId]
  );

  if (rows.length) return rows[0];

  const inserted = await runQuery(
    `INSERT INTO notification_preferences (user_id)
          VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING ${PREFERENCE_COLUMNS}`,
    [userId]
  );

  return inserted.rows[0] || { user_id: userId, ...DEFAULT_PREFERENCES };
}

/**
 * Upsert preferences. Only the keys present in `patch` are changed.
 * @param {string} userId
 * @param {{push_enabled?: boolean, email_enabled?: boolean, quiet_hours_start?: string, quiet_hours_end?: string}} patch
 */
const BOOLEAN_PREFERENCE_KEYS = [
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

async function updatePreferences(userId, patch) {
  const current = await getPreferences(userId);

  const next = { ...current };
  for (const key of BOOLEAN_PREFERENCE_KEYS) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key];
  }
  next.quiet_hours_start = patch.quiet_hours_start || current.quiet_hours_start;
  next.quiet_hours_end = patch.quiet_hours_end || current.quiet_hours_end;
  // Nullable — null explicitly turns the custom-lead-time reminder off
  // (falls back to the fixed due-tomorrow/due-today sweeps), so it needs its
  // own check rather than reusing the boolean-key loop above.
  next.reminder_lead_days =
    patch.reminder_lead_days === null || typeof patch.reminder_lead_days === 'number'
      ? patch.reminder_lead_days
      : current.reminder_lead_days;

  const { rows } = await runQuery(
    `INSERT INTO notification_preferences
            (user_id, push_enabled, email_enabled,
             quiet_hours_enabled, quiet_hours_start, quiet_hours_end,
             task_assigned, task_status_changed, comment_added,
             due_date_reminder, project_updates,
             task_reassigned, due_date_changed, priority_changed,
             mentions, review_requests, approvals, overdue,
             documents, system_notifications, reminder_lead_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (user_id) DO UPDATE
        SET push_enabled         = EXCLUDED.push_enabled,
            email_enabled        = EXCLUDED.email_enabled,
            quiet_hours_enabled  = EXCLUDED.quiet_hours_enabled,
            quiet_hours_start    = EXCLUDED.quiet_hours_start,
            quiet_hours_end      = EXCLUDED.quiet_hours_end,
            task_assigned        = EXCLUDED.task_assigned,
            task_status_changed  = EXCLUDED.task_status_changed,
            comment_added        = EXCLUDED.comment_added,
            due_date_reminder    = EXCLUDED.due_date_reminder,
            project_updates      = EXCLUDED.project_updates,
            task_reassigned      = EXCLUDED.task_reassigned,
            due_date_changed     = EXCLUDED.due_date_changed,
            priority_changed     = EXCLUDED.priority_changed,
            mentions             = EXCLUDED.mentions,
            review_requests      = EXCLUDED.review_requests,
            approvals            = EXCLUDED.approvals,
            overdue              = EXCLUDED.overdue,
            documents            = EXCLUDED.documents,
            system_notifications = EXCLUDED.system_notifications,
            reminder_lead_days   = EXCLUDED.reminder_lead_days,
            updated_at           = NOW()
     RETURNING ${PREFERENCE_COLUMNS}, created_at, updated_at`,
    [
      userId,
      next.push_enabled,
      next.email_enabled,
      next.quiet_hours_enabled,
      next.quiet_hours_start,
      next.quiet_hours_end,
      next.task_assigned,
      next.task_status_changed,
      next.comment_added,
      next.due_date_reminder,
      next.project_updates,
      next.task_reassigned,
      next.due_date_changed,
      next.priority_changed,
      next.mentions,
      next.review_requests,
      next.approvals,
      next.overdue,
      next.documents,
      next.system_notifications,
      next.reminder_lead_days,
    ]
  );

  return rows[0];
}

/* -------------------------------------------------------------------------- */
/* Quiet hours                                                                */
/* -------------------------------------------------------------------------- */

/** '22:00' or '22:00:00' -> minutes since midnight. Returns null if unparseable. */
function timeToMinutes(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Quiet hours wrap around midnight (22:00 -> 07:00), so the comparison
 * differs depending on whether start < end.
 * @param {object} preferences
 * @param {Date} [now]
 */
function isWithinQuietHours(preferences, now = new Date()) {
  if (preferences.quiet_hours_enabled === false) return false;

  const start = timeToMinutes(preferences.quiet_hours_start);
  const end = timeToMinutes(preferences.quiet_hours_end);
  if (start === null || end === null || start === end) return false;

  const current = now.getHours() * 60 + now.getMinutes();

  // Overnight window, e.g. 22:00 -> 07:00
  if (start > end) return current >= start || current < end;

  // Same-day window, e.g. 09:00 -> 17:00
  return current >= start && current < end;
}

/* -------------------------------------------------------------------------- */
/* Deduplication                                                              */
/* -------------------------------------------------------------------------- */

/**
 * True if an identical notification (same user + type + link) already went out
 * inside the window. `link_to` is compared with IS NOT DISTINCT FROM so two
 * NULLs count as a match.
 */
async function isDuplicate(userId, type, linkTo, windowMinutes) {
  const { rows } = await runQuery(
    `SELECT 1
       FROM notifications
      WHERE user_id = $1
        AND type = $2
        AND link_to IS NOT DISTINCT FROM $3
        AND created_at > NOW() - ($4 || ' minutes')::interval
      LIMIT 1`,
    [userId, type, linkTo, String(windowMinutes)]
  );
  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Channels                                                                   */
/* -------------------------------------------------------------------------- */

async function writeInApp({ userId, type, title, message, linkTo, priority, actions }) {
  // `actions` is persisted as a snapshot of the buttons offered at creation
  // time rather than derived from `type` on read, so notifications written
  // before Module 2 shipped never retroactively gain action buttons.
  const { rows } = await runQuery(
    `INSERT INTO notifications (user_id, type, title, message, link_to, priority, actions)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, user_id, type, title, message, link_to, priority, is_read, created_at, actions`,
    [userId, type, title, message, linkTo, priority, actions ? JSON.stringify(actions) : null]
  );
  return rows[0];
}

async function sendPush(userId, payload, options = {}) {
  if (!webpush) return { sent: 0, reason: 'push_not_configured' };

  const { rows: subscriptions } = await runQuery(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId]
  );
  if (!subscriptions.length) return { sent: 0, reason: 'no_subscriptions' };

  let sent = 0;
  const staleIds = [];
  // Per-subscription transient failures, surfaced so the caller can queue them
  // for retry (AC-10). Purely additive: routing, recipients and dedupe are
  // untouched — this only reports what already happened.
  const failures = [];

  // TTL bounds how long a push service holds an undelivered message; urgency
  // lets the OS defer low-priority ones on battery saver. Neither changes who
  // gets notified or when we decide to notify them.
  const sendOptions = {
    TTL: options.ttl || 3600,
    urgency: options.urgency || 'normal',
  };

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          sendOptions
        );
        sent += 1;
      } catch (err) {
        // 404/410 mean the browser dropped the subscription — clean it up.
        if (err.statusCode === 404 || err.statusCode === 410) {
          staleIds.push(sub.id);
        } else {
          console.error('[notifications] push failed:', err.message);
          failures.push({ subscriptionId: sub.id, error: err });
        }
      }
    })
  );

  if (staleIds.length) {
    await runQuery(`DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])`, [staleIds]);
  }

  return { sent, removed: staleIds.length, failures };
}

/* -------------------------------------------------------------------------- */
/* Module 2 push extras — all additive, none affect routing                   */
/* -------------------------------------------------------------------------- */

// Served from the frontend's public/ (added in SF5). Harmless before then:
// a missing icon just falls back to the browser default.
const PUSH_ICON = '/icons/icon-192.png';
const PUSH_BADGE = '/icons/badge-72.png';
const PUSH_BODY_MAX = 200;

function truncateForPush(text) {
  if (!text) return text;
  const s = String(text);
  return s.length <= PUSH_BODY_MAX ? s : `${s.slice(0, PUSH_BODY_MAX - 1).trimEnd()}…`;
}

/**
 * Prefers the action set stored on the row (the snapshot taken at creation
 * time), falling back to the type's default. Returns [] when the notification
 * offers no actions, which keeps the payload exactly as it was pre-Module 2.
 */
function buildPushActions(notification, type) {
  const stored = notification && notification.actions;
  if (Array.isArray(stored) && stored.length) {
    // Notification.maxActions is 2 on Chrome/Android, 0 on iOS Safari.
    return stored.slice(0, 2).map((a) => ({ action: a.action, title: a.title }));
  }
  if (!actionTokens) return [];
  const names = actionTokens.ACTIONS_FOR_TYPE[type];
  if (!Array.isArray(names) || !names.length) return [];
  return names.slice(0, 2).map((name) => ({ action: name, title: name }));
}

function mintActionToken(notification, userId, linkTo, pushActions) {
  if (!actionTokens) return null;
  const match = linkTo
    ? String(linkTo).match(/\/tasks\/([0-9a-f-]{36})/i)
    : null;
  return actionTokens.buildActionToken({
    notificationId: notification.id,
    userId,
    taskId: match ? match[1] : null,
    actions: pushActions.map((a) => a.action),
  });
}

async function sendEmailChannel(user, { title, message, linkTo }) {
  if (!mailer || !user || !user.email) return { sent: false, reason: 'mailer_unavailable' };

  const url = linkTo ? `${APP_URL}${linkTo}` : APP_URL;
  const name = user.name || user.full_name || 'there';

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
      <h2 style="margin:0 0 12px;font-size:18px">${title}</h2>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155">Hi ${name},<br/>${message}</p>
      <a href="${url}" style="display:inline-block;padding:10px 18px;background:#0f172a;color:#fff;text-decoration:none;border-radius:6px;font-size:14px">Open in Varadhi Tracker</a>
      <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">Change what you get emailed about in Settings &rsaquo; Notifications.</p>
    </div>`;

  try {
    await mailer({
      to: user.email,
      subject: title,
      text: `${message}\n\n${url}`,
      html,
    });
    return { sent: true };
  } catch (err) {
    console.error('[notifications] email failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

/* -------------------------------------------------------------------------- */
/* Main dispatcher                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} userId          recipient
 * @param {string} type            one of NOTIFICATION_TYPES
 * @param {string} title           short headline
 * @param {string} message         body text
 * @param {string|null} linkTo     in-app path, e.g. '/tasks/abc-123'
 * @param {string} priority        low | normal | high | urgent
 * @param {object} [options]
 * @param {number} [options.dedupeWindowMinutes=5]
 * @param {boolean} [options.skipDedupe=false]
 * @param {boolean} [options.ignoreQuietHours=false]
 * @param {Array<{action:string,title:string}>} [options.actions]
 *        Module 2: inline action buttons offered on this notification.
 *        Stored on the row; does not affect routing, dedupe or delivery.
 * @returns {Promise<{delivered: boolean, skipped?: string, notification?: object, channels?: object}>}
 */
async function dispatchNotification(
  userId,
  type,
  title,
  message,
  linkTo = null,
  priority = 'normal',
  options = {}
) {
  try {
    if (!userId || !type || !title) {
      return { delivered: false, skipped: 'invalid_arguments' };
    }

    const safePriority = PRIORITIES.includes(priority) ? priority : 'normal';
    const dedupeWindow =
      typeof options.dedupeWindowMinutes === 'number'
        ? options.dedupeWindowMinutes
        : DEFAULT_DEDUPE_WINDOW_MINUTES;

    // 1. Deduplicate
    if (!options.skipDedupe && dedupeWindow > 0) {
      const duplicate = await isDuplicate(userId, type, linkTo, dedupeWindow);
      if (duplicate) {
        return { delivered: false, skipped: 'duplicate' };
      }
    }

    // 2. Preferences + recipient
    const [preferences, userResult] = await Promise.all([
      getPreferences(userId),
      runQuery(`SELECT id, name, email FROM users WHERE id = $1`, [userId]),
    ]);
    const user = userResult.rows[0];

    // 3. Category opt-out — e.g. user turned off "task assigned" notifications.
    const category = TYPE_CATEGORY_MAP[type];
    if (category && preferences[category] === false) {
      return { delivered: false, skipped: 'category_disabled' };
    }

    // 4. In-app is unconditional — it is the audit log.
    const notification = await writeInApp({
      userId,
      type,
      title,
      message,
      linkTo,
      priority: safePriority,
      // Optional, Module 2. Purely additive: callers that don't pass it get
      // NULL and behave exactly as before.
      actions: Array.isArray(options.actions) ? options.actions : null,
    });

    // Realtime extension point — see notificationEvents above. No-op until
    // something subscribes; safe to leave firing unconditionally.
    notificationEvents.emit('notification', { userId, notification });

    // 5. Quiet hours gate for the interruptive channels only.
    const quiet =
      !options.ignoreQuietHours &&
      !QUIET_HOURS_BYPASS.includes(safePriority) &&
      isWithinQuietHours(preferences);

    const channels = { in_app: true, push: false, email: false, quiet_hours: quiet };

    // Push/email are further gated by event type — only "important" events
    // per the spec are worth interrupting someone for, on top of them having
    // the channel enabled at all. Both channels are currently no-ops
    // regardless (no VAPID keys; sendEmail.js has no matching export) — this
    // gate just makes sure that's still true, correctly, once they're wired up.
    if (!quiet && preferences.push_enabled && PUSH_WORTHY_TYPES.has(type)) {
      // Module 2: attach inline actions + the credential the service worker
      // needs to act on them without the app open. All of this is additive —
      // when there are no actions the payload is byte-identical to before,
      // apart from the icon/badge, and nothing here affects who is notified.
      const pushActions = buildPushActions(notification, type);
      const actionToken = pushActions.length
        ? mintActionToken(notification, userId, linkTo, pushActions)
        : null;

      // Named so a retry can re-send the byte-identical payload rather than
      // rebuilding (and possibly re-minting) it later.
      const pushPayload = {
        title,
        // Web push payloads cap around 4KB after encryption and task titles
        // run to 500 chars. An oversize payload throws 413, which sendPush
        // only console.errors — the notification would vanish silently. Trim
        // the body when actions are riding along.
        body: pushActions.length ? truncateForPush(message) : message,
        url: linkTo ? `${APP_URL}${linkTo}` : APP_URL,
        type,
        priority: safePriority,
        notificationId: notification.id,
        icon: PUSH_ICON,
        badge: PUSH_BADGE,
        ...(pushActions.length ? { actions: pushActions } : {}),
        ...(actionToken ? { actionToken } : {}),
      };

      const pushResult = await sendPush(userId, pushPayload, {
        ttl: 3600,
        urgency: safePriority === 'urgent' ? 'high' : 'normal',
      });
      channels.push = pushResult.sent > 0;

      // Queue transient delivery failures for retry (AC-10). This runs AFTER
      // every routing decision — category gate, quiet hours, dedupe and the
      // in-app write have all already happened — so a retry re-sends an
      // already-authorised payload to the same device and can neither bypass a
      // preference nor create a second notification. Guarded require and a
      // swallowed catch, matching this file's convention: a retry-queue
      // problem must never turn a delivered notification into a failure.
      if (pushResult.failures && pushResult.failures.length) {
        try {
          const { enqueueRetry } = require('./push-retry');
          await Promise.all(
            pushResult.failures.map((f) =>
              enqueueRetry({
                notificationId: notification.id,
                userId,
                subscriptionId: f.subscriptionId,
                payload: pushPayload,
                sendOptions: { TTL: 3600, urgency: safePriority === 'urgent' ? 'high' : 'normal' },
                error: f.error,
              })
            )
          );
        } catch (err) {
          console.error('[notifications] could not queue push retry:', err.message);
        }
      }
    }

    if (!quiet && preferences.email_enabled && EMAIL_WORTHY_TYPES.has(type) && user) {
      const emailResult = await sendEmailChannel(user, { title, message, linkTo });
      channels.email = emailResult.sent;
    }

    return { delivered: true, notification, channels };
  } catch (err) {
    // A notification failure must never break the action that triggered it.
    console.error('[notifications] dispatch failed:', err.message);
    return { delivered: false, skipped: 'error', error: err.message };
  }
}

/**
 * Fan the same notification out to several users, de-duplicating the list and
 * optionally skipping the actor who caused the event.
 */
async function dispatchToMany(userIds, type, title, message, linkTo, priority, options = {}) {
  const unique = [...new Set((userIds || []).filter(Boolean))].filter(
    (id) => id !== options.excludeUserId
  );
  return Promise.all(
    unique.map((id) =>
      dispatchNotification(id, type, title, message, linkTo, priority, options)
    )
  );
}

/**
 * Fan a notification out to every active user holding one of `roles`
 * (e.g. ['admin'] or ['admin', 'manager']). New shared helper for the admin-
 * and manager-facing rules that need "everyone with this role" targeting —
 * tasks.controller.js already had its own local version of this for the
 * admin+manager broadcast; that one is left as-is since it already works.
 */
async function notifyByRoles(roles, type, title, message, linkTo, priority, options = {}) {
  const { rows } = await runQuery(`SELECT id FROM users WHERE role = ANY($1) AND status = 'active'`, [
    roles,
  ]);
  return dispatchToMany(
    rows.map((r) => r.id),
    type,
    title,
    message,
    linkTo,
    priority,
    options
  );
}

module.exports = {
  dispatchNotification,
  dispatchToMany,
  notifyByRoles,
  getPreferences,
  updatePreferences,
  isWithinQuietHours,
  timeToMinutes,
  notificationEvents,
  NOTIFICATION_TYPES,
  TYPE_CATEGORY_MAP,
  EMAIL_WORTHY_TYPES,
  PUSH_WORTHY_TYPES,
  PRIORITIES,
  DEFAULT_DEDUPE_WINDOW_MINUTES,
};