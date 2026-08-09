/**
 * Failed-push retry queue (AC-10, second half).
 *
 * WHAT THIS DOES NOT TOUCH. Retry operates strictly downstream of every
 * routing decision. By the time a record lands here the engine has already
 * applied category preferences, quiet hours, the urgent bypass and dedupe, and
 * has already written the in-app row. A retry re-sends *that same already
 * authorised payload* to the same subscription — it never re-evaluates
 * recipients, never re-runs dedupe, and never creates a second notification.
 * So preferences cannot be bypassed by retrying: a notification the rules
 * suppressed was never enqueued in the first place.
 *
 * TRANSIENT vs PERMANENT is the whole design. Retrying a permanent failure
 * wastes work and, worse, can hammer a push service into rate-limiting the
 * whole application. Only failures that plausibly succeed later are queued.
 */

const pool = require('../config/db')

/** Bounded: 5 attempts over roughly 30 minutes, then give up loudly. */
const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 60_000 // 1 min, doubling
const MAX_DELAY_MS = 16 * 60_000 // cap at 16 min

/** Never queue more than this many retries per user — a flood guard. */
const MAX_PENDING_PER_USER = 50

/**
 * Should this failure be retried?
 *
 *   404 / 410  subscription is gone. The engine already deletes it; retrying
 *              would resurrect a dead endpoint. PERMANENT.
 *   400 / 401  malformed payload or bad VAPID credentials. Identical on retry.
 *   403        VAPID key mismatch for this endpoint. Identical on retry.
 *   413        payload too large. Identical on retry — must be fixed, not retried.
 *   429        rate limited. TRANSIENT, and precisely what backoff exists for.
 *   5xx        push service trouble. TRANSIENT.
 *   no status  network/DNS/timeout — never reached the service. TRANSIENT.
 */
function isTransient(err) {
  const status = err?.statusCode ?? err?.status ?? null
  if (status === null || status === undefined) return true // transport failure
  if (status === 429) return true
  if (status >= 500 && status <= 599) return true
  return false
}

function backoffMs(attempts) {
  return Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS)
}

/**
 * Record a transient delivery failure for later retry.
 *
 * Idempotent per (notification, subscription): a repeat failure for the same
 * pair updates the existing row. That unique index is what makes it impossible
 * to queue the same notification twice for the same device.
 */
async function enqueueRetry({
  notificationId,
  userId,
  subscriptionId,
  payload,
  sendOptions,
  error,
}) {
  if (!notificationId || !userId || !subscriptionId) return null
  if (!isTransient(error)) return null

  // Flood guard: a user whose device is persistently unreachable must not
  // accumulate an unbounded queue.
  const { rows: [{ count }] } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM push_delivery_retries
      WHERE user_id = $1 AND status = 'pending'`,
    [userId]
  )
  if (count >= MAX_PENDING_PER_USER) {
    console.warn(
      `[push-retry] queue full for user ${userId} (${count}); dropping retry for notification ${notificationId}`
    )
    return null
  }

  const status = error?.statusCode ?? error?.status ?? null

  const { rows } = await pool.query(
    `INSERT INTO push_delivery_retries
       (notification_id, user_id, subscription_id, payload, send_options,
        attempts, next_attempt_at, last_error, last_status, status)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,1,NOW() + ($6 || ' milliseconds')::interval,$7,$8,'pending')
     ON CONFLICT (notification_id, subscription_id) DO UPDATE
        SET attempts        = push_delivery_retries.attempts + 1,
            next_attempt_at = NOW() + ($6 || ' milliseconds')::interval,
            last_error      = EXCLUDED.last_error,
            last_status     = EXCLUDED.last_status,
            updated_at      = NOW()
     RETURNING id, attempts`,
    [
      notificationId,
      userId,
      subscriptionId,
      JSON.stringify(payload || {}),
      JSON.stringify(sendOptions || {}),
      String(backoffMs(0)),
      error?.message ? String(error.message).slice(0, 500) : null,
      status,
    ]
  )
  return rows[0] || null
}

/**
 * Drain due retries.
 *
 * Claims rows with FOR UPDATE SKIP LOCKED so two workers can never send the
 * same row — the same pattern snooze-cron.js uses.
 */
async function runPushRetriesNow(deps = {}) {
  // Injectable for tests; defaults to the real sender.
  const send = deps.send || defaultSend
  const now = deps.now || (() => new Date())

  const result = { claimed: 0, sent: 0, retried: 0, exhausted: 0, dropped: 0 }

  const client = await pool.connect()
  let due = []
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, notification_id, user_id, subscription_id, payload, send_options, attempts
         FROM push_delivery_retries
        WHERE status = 'pending' AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at ASC
        LIMIT 100
        FOR UPDATE SKIP LOCKED`
    )
    due = rows
    if (due.length) {
      await client.query(
        `UPDATE push_delivery_retries SET status = 'sending', updated_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [due.map((r) => r.id)]
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[push-retry] claim failed:', err.message)
    client.release()
    return result
  }
  client.release()

  result.claimed = due.length

  for (const row of due) {
    // The subscription may have been removed since the failure (user disabled
    // push, or the engine pruned it as stale). Nothing to retry.
    const { rows: subs } = await pool.query(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE id = $1`,
      [row.subscription_id]
    )
    if (!subs.length) {
      await pool.query(
        `UPDATE push_delivery_retries
            SET status='dropped', last_error='subscription no longer exists', updated_at=NOW()
          WHERE id=$1`,
        [row.id]
      )
      result.dropped += 1
      continue
    }

    try {
      await send(subs[0], row.payload, row.send_options || {})
      await pool.query(
        `UPDATE push_delivery_retries SET status='sent', updated_at=NOW() WHERE id=$1`,
        [row.id]
      )
      result.sent += 1
    } catch (err) {
      const attempts = row.attempts + 1
      const transient = isTransient(err)

      if (!transient) {
        await pool.query(
          `UPDATE push_delivery_retries
              SET status='failed', attempts=$2, last_error=$3, last_status=$4, updated_at=NOW()
            WHERE id=$1`,
          [row.id, attempts, String(err.message || '').slice(0, 500), err?.statusCode ?? null]
        )
        console.error(
          `[push-retry] permanent failure for notification ${row.notification_id} ` +
          `(user ${row.user_id}, status ${err?.statusCode ?? 'n/a'}): ${err.message}`
        )
        result.dropped += 1
        continue
      }

      if (attempts >= MAX_ATTEMPTS) {
        await pool.query(
          `UPDATE push_delivery_retries
              SET status='exhausted', attempts=$2, last_error=$3, updated_at=NOW()
            WHERE id=$1`,
          [row.id, attempts, String(err.message || '').slice(0, 500)]
        )
        // Deliberately loud: this is the end of the line for a push the user
        // was supposed to receive. The in-app row still exists, so nothing is
        // lost — but it warrants attention.
        console.error(
          `[push-retry] GIVING UP after ${attempts} attempts — notification ${row.notification_id} ` +
          `never delivered to subscription ${row.subscription_id} (user ${row.user_id}). ` +
          `Last error: ${err.message}. The in-app notification remains available.`
        )
        result.exhausted += 1
        continue
      }

      await pool.query(
        `UPDATE push_delivery_retries
            SET status='pending', attempts=$2,
                next_attempt_at = NOW() + ($3 || ' milliseconds')::interval,
                last_error=$4, last_status=$5, updated_at=NOW()
          WHERE id=$1`,
        [row.id, attempts, String(backoffMs(attempts)), String(err.message || '').slice(0, 500),
         err?.statusCode ?? null]
      )
      result.retried += 1
    }
  }

  if (result.claimed) {
    console.log(
      `[push-retry] claimed ${result.claimed} · sent ${result.sent} · requeued ${result.retried} ` +
      `· exhausted ${result.exhausted} · dropped ${result.dropped}`
    )
  }
  return result
}

/** Real sender, resolved lazily so the module loads without web-push present. */
async function defaultSend(sub, payload, sendOptions) {
  let webpush
  try {
    webpush = require('web-push')
  } catch {
    const e = new Error('web-push unavailable')
    e.statusCode = 500 // transient: a deploy may restore it
    throw e
  }
  return webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload),
    sendOptions
  )
}

let task = null
let isRunning = false

/** Every 2 minutes, mirroring snooze-cron.js's overlap guard. */
function startPushRetryCron() {
  if (task) return task
  const cron = require('node-cron')
  task = cron.schedule(
    '*/2 * * * *',
    async () => {
      if (isRunning) return
      isRunning = true
      try {
        await runPushRetriesNow()
      } catch (err) {
        console.error('[push-retry] sweep failed:', err.message)
      } finally {
        isRunning = false
      }
    },
    { timezone: process.env.CRON_TIMEZONE || 'Asia/Kolkata' }
  )
  console.log('[push-retry] scheduled "*/2 * * * *"')
  return task
}

module.exports = {
  enqueueRetry,
  runPushRetriesNow,
  startPushRetryCron,
  isTransient,
  backoffMs,
  MAX_ATTEMPTS,
  MAX_PENDING_PER_USER,
}
