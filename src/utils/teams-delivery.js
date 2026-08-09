/**
 * Teams webhook delivery (Module 5).
 * ---------------------------------------------------------------------------
 * Posts Adaptive Cards to Incoming Webhook URLs, with the same
 * transient-vs-permanent discipline push-retry.js established for web push.
 * That distinction is the whole design there and it applies verbatim here:
 * retrying a permanent failure wastes work and can get the application
 * rate-limited by the very service it is trying to reach.
 *
 * WHAT IS DIFFERENT FROM PUSH RETRY. A dead push subscription belongs to one
 * device and is pruned silently. A dead webhook belongs to a CHANNEL that a
 * whole team is watching, so repeated permanent failure escalates: the webhook
 * is auto-disabled and the admin who configured it is notified (AC-23). Left
 * alone, a broken connector would fail quietly forever while a project team
 * assumed they were being kept informed.
 *
 * THE URL IS A CREDENTIAL. Anyone holding an Incoming Webhook URL can post to
 * that channel as the app. So it is decrypted here, at the moment of posting,
 * and nowhere else — it never enters a response body, a log line, an error
 * message, or the delivery-log payload. Every failure path in this file logs
 * the webhook's UUID, never its URL.
 */

const pool = require('../config/db')
const { decrypt } = require('./crypto')
const { cardForNotification, testCard } = require('./teams-cards')

/** Bounded: 4 attempts over roughly 15 minutes. */
const MAX_ATTEMPTS = 4
const BASE_DELAY_MS = 60_000
const MAX_DELAY_MS = 8 * 60_000

/**
 * Consecutive failures before a webhook is auto-disabled (AC-23).
 * Deliberately higher than MAX_ATTEMPTS: one bad afternoon for the Teams
 * service should not disable a channel a team depends on. It takes a sustained
 * pattern of failure across separate events.
 */
const FAILURE_THRESHOLD = 10

const HTTP_TIMEOUT_MS = 10_000

/**
 * Should this failure be retried?
 *
 *   404 / 410  the connector was deleted in Teams. Permanent — and precisely
 *              the AC-23 case that should count toward auto-disable.
 *   400        malformed card. Identical on retry; must be fixed, not retried.
 *   401 / 403  the URL's token was revoked. Permanent.
 *   413        payload too large. Identical on retry.
 *   429        throttled — transient, and what backoff exists for.
 *   5xx        Teams-side trouble. Transient.
 *   no status  network/DNS/timeout, never reached Teams. Transient.
 */
function isTransient(err) {
  const status = err?.statusCode ?? err?.status ?? err?.response?.status ?? null
  if (status === null || status === undefined) return true
  if (status === 429) return true
  if (status >= 500 && status <= 599) return true
  return false
}

function backoffMs(attempts) {
  return Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS)
}

/**
 * Strip the internal metadata before the payload crosses the wire.
 * `__meta` is ours; Teams rejects unknown top-level keys on some card paths.
 */
function wirePayload(card) {
  if (!card) return null
  const { __meta, ...rest } = card
  return rest
}

/** Default sender. Resolved lazily so the module loads without axios present. */
async function defaultHttpPost(url, body) {
  const axios = require('axios')
  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: HTTP_TIMEOUT_MS,
    // Teams answers 200 with the literal body "1" on success; anything 4xx/5xx
    // must throw so the retry classifier sees it.
    validateStatus: (s) => s >= 200 && s < 300,
  })
  return { status: res.status, body: res.data }
}

/**
 * Post one card to one webhook, recording the outcome.
 *
 * @param {object} webhook  row from teams_webhooks (webhook_url still encrypted)
 * @param {object} card     from teams-cards.js
 * @param {object} deps     { http } injectable, mirroring push-retry's { send }
 * @returns {{ok: boolean, status?: number, logId?: string, reason?: string}}
 */
async function postToWebhook(webhook, card, deps = {}, meta = {}) {
  const http = deps.http || defaultHttpPost

  if (!webhook || !webhook.enabled) {
    return { ok: false, reason: 'webhook_disabled' }
  }

  const url = decrypt(webhook.webhook_url)
  if (!url) {
    // Undecryptable means the key rotated or the row was tampered with. Do not
    // guess and do not post — a webhook URL is not something to be approximate
    // about.
    await disableWebhook(webhook, 'Stored webhook URL could not be decrypted.', deps)
    return { ok: false, reason: 'decrypt_failed' }
  }

  const cardKind = card?.__meta?.cardKind || meta.cardKind || 'generic'

  // Log the attempt first, so a crash mid-post still leaves evidence.
  const { rows: logRows } = await pool.query(
    `INSERT INTO teams_delivery_log
       (webhook_id, event_type, card_kind, status, attempts, payload)
     VALUES ($1,$2,$3,'pending',1,$4::jsonb)
     RETURNING id`,
    [webhook.id, meta.eventType || null, cardKind, JSON.stringify(wirePayload(card) || {})]
  )
  const logId = logRows[0].id

  try {
    const res = await http(url, wirePayload(card))

    await pool.query(
      `UPDATE teams_delivery_log
          SET status='sent', http_status=$2, updated_at=NOW()
        WHERE id=$1`,
      [logId, res?.status || 200]
    )
    // A success clears the failure streak — the threshold counts CONSECUTIVE
    // failures, so an intermittently flaky channel is never auto-disabled.
    await pool.query(
      `UPDATE teams_webhooks
          SET failure_count=0, last_success_at=NOW(), updated_at=NOW()
        WHERE id=$1`,
      [webhook.id]
    )

    return { ok: true, status: res?.status || 200, logId }
  } catch (err) {
    const status = err?.statusCode ?? err?.status ?? err?.response?.status ?? null
    const transient = isTransient(err)
    const message = String(err?.message || '').slice(0, 500)

    // `transient` is passed as its own boolean parameter rather than
    // re-comparing $2. Reusing the status parameter inside the CASE made
    // Postgres deduce two different types for one placeholder ("inconsistent
    // types deduced for parameter $2") and the UPDATE failed outright — which
    // meant a failed delivery was never recorded at all.
    await pool.query(
      `UPDATE teams_delivery_log
          SET status=$2, http_status=$3, error=$4,
              next_attempt_at = CASE WHEN $6
                                     THEN NOW() + ($5 || ' milliseconds')::interval
                                     ELSE NULL END,
              updated_at=NOW()
        WHERE id=$1`,
      [logId, transient ? 'pending' : 'failed', status, message, String(backoffMs(1)), transient]
    )

    const { rows: whRows } = await pool.query(
      `UPDATE teams_webhooks
          SET failure_count = failure_count + 1, last_failure_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING failure_count`,
      [webhook.id]
    )
    const failureCount = whRows[0]?.failure_count ?? 0

    // A permanent 404/410 means the connector is gone; there is nothing to
    // wait for, so disable immediately rather than burning the whole threshold.
    const connectorGone = status === 404 || status === 410
    if (connectorGone || failureCount >= FAILURE_THRESHOLD) {
      await disableWebhook(
        webhook,
        connectorGone
          ? 'The Teams connector no longer exists (the channel or webhook was removed).'
          : `Delivery failed ${failureCount} times in a row. Last error: ${message}`,
        deps
      )
    }

    console.error(
      `[teams-delivery] post failed for webhook ${webhook.id} ` +
      `(status ${status ?? 'n/a'}, streak ${failureCount}): ${message}`
    )
    return { ok: false, status, reason: transient ? 'transient' : 'permanent', logId }
  }
}

/**
 * Turn a webhook off and tell the person who set it up (AC-23).
 */
async function disableWebhook(webhook, reason, deps = {}) {
  await pool.query(
    `UPDATE teams_webhooks
        SET enabled = FALSE, disabled_reason = $2, updated_at = NOW()
      WHERE id = $1`,
    [webhook.id, String(reason || '').slice(0, 500)]
  ).catch(() => {})

  if (!webhook.created_by) return

  try {
    // Required lazily: notification-engine requires this module's siblings, and
    // a top-level require here would close a cycle through the fan-out.
    const { dispatchNotification, NOTIFICATION_TYPES } = require('./notification-engine')
    await dispatchNotification(
      webhook.created_by,
      NOTIFICATION_TYPES.TEAMS_WEBHOOK_DISABLED,
      'Teams webhook disabled',
      `The Microsoft Teams webhook${webhook.name ? ` "${webhook.name}"` : ''} was disabled automatically. ${reason}`,
      '/teams',
      'high',
      { dedupeWindowMinutes: 720 }
    )
  } catch (err) {
    console.error('[teams-delivery] failed to notify about disabled webhook:', err.message)
  }
}

/**
 * Which enabled webhooks want this event, for this project.
 *
 * A NULL project_id means a global webhook that receives every project's
 * events — useful for an org-wide "all activity" channel.
 */
async function findWebhooksFor(projectId, eventType) {
  const { rows } = await pool.query(
    `SELECT * FROM teams_webhooks
      WHERE enabled = TRUE
        AND $2 = ANY(event_types)
        AND (project_id = $1 OR project_id IS NULL)`,
    [projectId || null, eventType]
  )
  return rows
}

/**
 * Fan a dispatched notification out to every subscribed channel.
 *
 * AC-22 lives in findWebhooksFor's `$2 = ANY(event_types)` clause: a webhook
 * that has not opted into this event type is simply never selected, so no
 * message is posted for it.
 *
 * Never throws. This runs off an EventEmitter with no error handling upstream,
 * and an unhandled rejection here would be an unhandled rejection in the
 * notification dispatch path — which must never fail because of a downstream
 * channel.
 */
async function fanOutNotification(notification, context = {}, deps = {}) {
  const result = { matched: 0, sent: 0, failed: 0 }

  try {
    if (!notification || !notification.type) return result

    const webhooks = await findWebhooksFor(context.projectId, notification.type)
    result.matched = webhooks.length
    if (!webhooks.length) return result

    const card = cardForNotification(notification, context)

    for (const webhook of webhooks) {
      const posted = await postToWebhook(webhook, card, deps, {
        eventType: notification.type,
      })
      if (posted.ok) result.sent += 1
      else result.failed += 1
    }
  } catch (err) {
    console.error('[teams-delivery] fan-out failed:', err.message)
  }

  return result
}

/**
 * Retry the transient failures parked as 'pending'.
 * Claimed with FOR UPDATE SKIP LOCKED, the same pattern push-retry.js and
 * snooze-cron.js use, so two workers can never resend the same row.
 */
async function runTeamsRetriesNow(deps = {}) {
  const http = deps.http || defaultHttpPost
  const result = { claimed: 0, sent: 0, retried: 0, exhausted: 0 }

  const client = await pool.connect()
  let due = []
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT l.*, w.webhook_url, w.enabled, w.id AS wh_id, w.name, w.created_by
         FROM teams_delivery_log l
         JOIN teams_webhooks w ON w.id = l.webhook_id
        WHERE l.status = 'pending'
          AND l.next_attempt_at IS NOT NULL
          AND l.next_attempt_at <= NOW()
          AND w.enabled = TRUE
        ORDER BY l.next_attempt_at ASC
        LIMIT 50
        FOR UPDATE OF l SKIP LOCKED`
    )
    due = rows
    if (due.length) {
      await client.query(
        `UPDATE teams_delivery_log SET status='pending', next_attempt_at=NULL, updated_at=NOW()
          WHERE id = ANY($1::uuid[])`,
        [due.map((r) => r.id)]
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[teams-delivery] retry claim failed:', err.message)
    client.release()
    return result
  }
  client.release()

  result.claimed = due.length

  for (const row of due) {
    const url = decrypt(row.webhook_url)
    const attempts = row.attempts + 1

    if (!url) {
      await pool.query(
        `UPDATE teams_delivery_log SET status='dropped', error='URL undecryptable', updated_at=NOW() WHERE id=$1`,
        [row.id]
      )
      continue
    }

    if (attempts > MAX_ATTEMPTS) {
      await pool.query(
        `UPDATE teams_delivery_log SET status='exhausted', attempts=$2, updated_at=NOW() WHERE id=$1`,
        [row.id, attempts]
      )
      result.exhausted += 1
      continue
    }

    try {
      const res = await http(url, row.payload)
      await pool.query(
        `UPDATE teams_delivery_log
            SET status='sent', http_status=$2, attempts=$3, error=NULL, updated_at=NOW()
          WHERE id=$1`,
        [row.id, res?.status || 200, attempts]
      )
      await pool.query(
        `UPDATE teams_webhooks SET failure_count=0, last_success_at=NOW() WHERE id=$1`,
        [row.wh_id]
      )
      result.sent += 1
    } catch (err) {
      const transient = isTransient(err)
      const status = err?.statusCode ?? err?.response?.status ?? null

      if (!transient || attempts >= MAX_ATTEMPTS) {
        await pool.query(
          `UPDATE teams_delivery_log
              SET status=$2, attempts=$3, http_status=$4, error=$5, next_attempt_at=NULL, updated_at=NOW()
            WHERE id=$1`,
          [row.id, transient ? 'exhausted' : 'failed', attempts, status, String(err.message || '').slice(0, 500)]
        )
        if (transient) result.exhausted += 1
      } else {
        await pool.query(
          `UPDATE teams_delivery_log
              SET status='pending', attempts=$2, http_status=$3, error=$4,
                  next_attempt_at = NOW() + ($5 || ' milliseconds')::interval, updated_at=NOW()
            WHERE id=$1`,
          [row.id, attempts, status, String(err.message || '').slice(0, 500), String(backoffMs(attempts))]
        )
        result.retried += 1
      }
    }
  }

  if (result.claimed) {
    console.log(
      `[teams-delivery] retries claimed ${result.claimed} · sent ${result.sent} ` +
      `· requeued ${result.retried} · exhausted ${result.exhausted}`
    )
  }
  return result
}

/** Send the connectivity probe behind the "Send test message" button. */
async function sendTestMessage(webhook, context = {}, deps = {}) {
  const card = testCard({ projectName: context.projectName, actorName: context.actorName })
  return postToWebhook(webhook, card, deps, { eventType: 'test' })
}

module.exports = {
  postToWebhook,
  fanOutNotification,
  findWebhooksFor,
  runTeamsRetriesNow,
  sendTestMessage,
  disableWebhook,
  isTransient,
  backoffMs,
  wirePayload,
  MAX_ATTEMPTS,
  FAILURE_THRESHOLD,
}
