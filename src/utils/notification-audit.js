/**
 * Notification audit log
 * ---------------------------------------------------------------------------
 * Satisfies the Module 2 business rule "Notification delivery and action events
 * are logged for audit and analytics purposes".
 *
 * FAILURE-SAFE BY CONTRACT: every function here swallows its own errors and
 * resolves. Auditing must never be able to turn a successful action into a 500,
 * and must never roll back the mutation it is recording. This mirrors the
 * notifySafely() convention in tasks.controller.js.
 *
 * Accepts an optional pg client so a caller inside a transaction can have the
 * audit row committed atomically with the action; omit it and the row is
 * written on the pool, independent of any surrounding transaction.
 */

const pool = require('../config/db')

/** Recognised outcomes — kept loose (VARCHAR, no CHECK) so new ones don't need a migration. */
const OUTCOMES = {
  APPLIED: 'applied',
  ALREADY_APPLIED: 'already_applied',
  SUPERSEDED: 'superseded',
  DENIED: 'denied',
  CONFLICT: 'conflict',
  EXPIRED: 'expired',
  INVALID: 'invalid',
  NOT_FOUND: 'not_found',
  RATE_LIMITED: 'rate_limited',
  SENT: 'sent',
  FAILED: 'failed',
}

/**
 * @param {object}  entry
 * @param {string?} entry.notificationId
 * @param {string?} entry.userId
 * @param {string}  entry.action        approve|reject|accept|snooze|delivered|...
 * @param {string?} entry.source        push|in_app|engine
 * @param {string}  entry.outcome       one of OUTCOMES
 * @param {string?} entry.resourceType
 * @param {string?} entry.resourceId
 * @param {object?} entry.detail        arbitrary JSON context
 * @param {object?} client              optional pg client (to join a transaction)
 */
const INSERT_SQL = `
  INSERT INTO notification_action_log
    (notification_id, user_id, action, source, outcome, resource_type, resource_id, detail)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`

async function logAction(entry, client = null) {
  const runner = client || pool
  const params = (notificationId, detail) => [
    notificationId,
    entry.userId || null,
    entry.action,
    entry.source || null,
    entry.outcome,
    entry.resourceType || null,
    entry.resourceId || null,
    detail ? JSON.stringify(detail) : null,
  ]

  try {
    await runner.query(INSERT_SQL, params(entry.notificationId || null, entry.detail))
  } catch (err) {
    // 23503 = foreign_key_violation. The referenced notification (or user) was
    // deleted before we got here — which is itself an auditable event, and the
    // one we'd most regret losing. Retry once with the FK nulled and the id
    // preserved in `detail` so the record survives.
    //
    // Note this cannot use `client`: inside a transaction the failed statement
    // has already aborted it, so the retry goes to the pool independently.
    if (err.code === '23503') {
      try {
        await pool.query(
          INSERT_SQL,
          params(null, {
            ...(entry.detail || {}),
            orphaned: true,
            notificationId: entry.notificationId || null,
          })
        )
        return
      } catch (retryErr) {
        console.error('[notification-audit] orphan retry failed:', retryErr.message)
        return
      }
    }
    // Deliberately swallowed — see the file header.
    console.error('[notification-audit] logAction failed:', err.message)
  }
}

/** Convenience wrapper for delivery-side events (channel sent/failed). */
async function logDelivery({ notificationId, userId, channel, outcome, detail }, client = null) {
  return logAction(
    {
      notificationId,
      userId,
      action: 'delivered',
      source: channel || 'engine',
      outcome,
      detail,
    },
    client
  )
}

module.exports = { logAction, logDelivery, OUTCOMES }
