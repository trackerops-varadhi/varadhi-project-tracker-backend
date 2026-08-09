/**
 * Microsoft Teams webhook API (Module 5).
 *
 * THE ONE RULE THAT SHAPES THIS FILE: the webhook URL is a bearer credential.
 * Anyone who holds it can post to the channel as this application. So it is
 * accepted once, encrypted immediately, and never returned by any endpoint
 * here — not in a list, not in a detail view, not to the admin who created it,
 * not even masked beyond the origin hint. Every response goes through
 * toPublicWebhook(), which cannot leak it because it never reads the column.
 *
 * Role gating is `restrictTo('admin','manager')` in the route file, matching
 * the PRD's "Only users with Project Admin or higher role may configure or
 * modify webhook integrations" and the existing convention in
 * projects.routes.js / users.routes.js.
 */

const pool = require('../config/db')
const { successResponse, errorResponse } = require('../utils/response')
const { encrypt, maskSecret, isEncryptionAvailable } = require('../utils/crypto')
const { sendTestMessage, FAILURE_THRESHOLD } = require('../utils/teams-delivery')
const { NOTIFICATION_TYPES } = require('../utils/notification-engine')

/**
 * Event types a webhook may subscribe to.
 *
 * An explicit allow-list, not "any string": event_types feeds a `= ANY(...)`
 * lookup on the fan-out hot path, and letting arbitrary values in would mean
 * silent no-op subscriptions that look configured but never fire.
 * Ordered to match the reference design's "Supported Notification Types" panel.
 */
const SUPPORTED_EVENT_TYPES = [
  { value: NOTIFICATION_TYPES.TASK_ASSIGNED, label: 'Task Assigned' },
  { value: NOTIFICATION_TYPES.TASK_UPDATED, label: 'Task Updated' },
  { value: NOTIFICATION_TYPES.TASK_STATUS_CHANGED, label: 'Task Status Changed' },
  { value: NOTIFICATION_TYPES.TASK_COMMENT, label: 'Comment Added' },
  { value: NOTIFICATION_TYPES.TASK_REMINDER, label: 'Deadline Approaching' },
  { value: NOTIFICATION_TYPES.TASK_DUE_TODAY, label: 'Task Due Today' },
  { value: NOTIFICATION_TYPES.TASK_OVERDUE, label: 'Task Overdue' },
  { value: NOTIFICATION_TYPES.TASK_ESCALATION, label: 'Escalation' },
  { value: NOTIFICATION_TYPES.REVIEW_REQUESTED, label: 'Approval Request' },
  { value: NOTIFICATION_TYPES.PROJECT_MILESTONE, label: 'Milestone Reached' },
  { value: NOTIFICATION_TYPES.PROJECT_UPDATED, label: 'Project Updated' },
  { value: NOTIFICATION_TYPES.DOCUMENT_UPLOADED, label: 'Document Uploaded' },
]
const SUPPORTED_VALUES = new Set(SUPPORTED_EVENT_TYPES.map((e) => e.value))

/**
 * Validate a webhook URL before storing it.
 *
 * HTTPS is mandatory — the URL is a credential and posting a card over plain
 * HTTP would put it on the wire in clear text.
 *
 * The host check accepts Microsoft's connector domains AND Power Automate /
 * Logic Apps endpoints, because Microsoft is deprecating Office 365
 * Connectors in favour of Workflows; rejecting the replacement would make the
 * feature obsolete on Microsoft's own timetable. In non-production the check
 * relaxes to any HTTPS host so the flow is testable against a local receiver.
 */
function validateWebhookUrl(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, message: 'A webhook URL is required.' }
  }

  let url
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, message: 'That is not a valid URL.' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, message: 'The webhook URL must use HTTPS.' }
  }

  const host = url.hostname.toLowerCase()
  const allowed =
    host.endsWith('.webhook.office.com') ||
    host.endsWith('.office.com') ||
    host.endsWith('.logic.azure.com') ||
    host.endsWith('.azure.com') ||
    host.endsWith('.microsoft.com')

  if (!allowed && process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      message:
        'That does not look like a Microsoft Teams webhook URL. Expected a *.webhook.office.com or Power Automate (*.logic.azure.com) address.',
    }
  }

  return { ok: true, url: url.toString() }
}

/** The ONLY shape a webhook is ever returned in. Cannot leak the URL. */
function toPublicWebhook(row, extra = {}) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name || null,
    name: row.name,
    urlHint: row.url_hint,
    eventTypes: row.event_types || [],
    enabled: row.enabled,
    summaryDigest: row.summary_digest,
    failureCount: row.failure_count,
    disabledReason: row.disabled_reason,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    createdAt: row.created_at,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// GET /api/teams/event-types
// ---------------------------------------------------------------------------
exports.getEventTypes = async (req, res) => {
  try {
    return successResponse(res, {
      eventTypes: SUPPORTED_EVENT_TYPES,
      failureThreshold: FAILURE_THRESHOLD,
      encryptionAvailable: isEncryptionAvailable(),
    })
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/teams/webhooks
// ---------------------------------------------------------------------------
exports.getWebhooks = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT w.*, p.name AS project_name,
              (SELECT COUNT(*) FROM teams_delivery_log l
                WHERE l.webhook_id = w.id AND l.status = 'sent')::int AS sent_count,
              (SELECT COUNT(*) FROM teams_delivery_log l
                WHERE l.webhook_id = w.id AND l.status IN ('failed','exhausted'))::int AS failed_count
         FROM teams_webhooks w
         LEFT JOIN projects p ON p.id = w.project_id
        ORDER BY w.created_at DESC`
    )

    const webhooks = rows.map((r) =>
      toPublicWebhook(r, { sentCount: r.sent_count, failedCount: r.failed_count })
    )
    return successResponse(res, { webhooks })
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/teams/webhooks
// ---------------------------------------------------------------------------
exports.createWebhook = async (req, res) => {
  try {
    if (!isEncryptionAvailable()) {
      return errorResponse(
        res,
        'Teams integration is unavailable: the server has no encryption key configured. Contact your administrator.',
        503
      )
    }

    const { webhookUrl, projectId, name, eventTypes, summaryDigest } = req.body || {}

    const validated = validateWebhookUrl(webhookUrl)
    if (!validated.ok) return errorResponse(res, validated.message, 400)

    if (eventTypes !== undefined) {
      if (!Array.isArray(eventTypes) || eventTypes.some((t) => !SUPPORTED_VALUES.has(t))) {
        return errorResponse(res, 'One or more event types are not supported.', 400)
      }
    }
    if (summaryDigest && !['off', 'daily', 'weekly'].includes(summaryDigest)) {
      return errorResponse(res, 'Invalid summary digest option.', 400)
    }

    if (projectId) {
      const { rows: p } = await pool.query(`SELECT id FROM projects WHERE id = $1`, [projectId])
      if (!p[0]) return errorResponse(res, 'Project not found.', 404)
    }

    const ciphertext = encrypt(validated.url)
    if (!ciphertext) return errorResponse(res, 'Unable to secure the webhook URL; it was not saved.', 500)

    const hint = maskSecret(validated.url)

    const { rows } = await pool.query(
      `INSERT INTO teams_webhooks
         (project_id, name, webhook_url, url_hint, event_types, summary_digest, created_by)
       VALUES ($1,$2,$3,$4,
               COALESCE($5::text[], ARRAY['task_assigned','task_status_changed','task_comment','task_reminder','review_requested']::text[]),
               COALESCE($6,'off'), $7)
       RETURNING *`,
      [
        projectId || null,
        name || null,
        ciphertext,
        hint,
        Array.isArray(eventTypes) ? eventTypes : null,
        summaryDigest || null,
        req.user.id,
      ]
    )

    return successResponse(res, { webhook: toPublicWebhook(rows[0]) }, 'Teams webhook connected.', 201)
  } catch (err) {
    // A duplicate is a user error, not a server error — the generic 500 would
    // be both wrong and confusing.
    if (err.code === '23505') {
      return errorResponse(res, 'That webhook is already configured for this project.', 409)
    }
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// PUT /api/teams/webhooks/:id
// ---------------------------------------------------------------------------
exports.updateWebhook = async (req, res) => {
  try {
    const { name, eventTypes, enabled, summaryDigest, webhookUrl } = req.body || {}

    const { rows: existing } = await pool.query(
      `SELECT * FROM teams_webhooks WHERE id = $1`,
      [req.params.id]
    )
    if (!existing[0]) return errorResponse(res, 'Webhook not found.', 404)

    if (eventTypes !== undefined) {
      if (!Array.isArray(eventTypes) || eventTypes.some((t) => !SUPPORTED_VALUES.has(t))) {
        return errorResponse(res, 'One or more event types are not supported.', 400)
      }
    }
    if (summaryDigest && !['off', 'daily', 'weekly'].includes(summaryDigest)) {
      return errorResponse(res, 'Invalid summary digest option.', 400)
    }

    // Rotating the URL is supported (the PRD asks for easy rotate/revoke), and
    // it resets the failure streak: a new URL deserves a clean slate.
    let ciphertext = null
    let hint = null
    if (webhookUrl) {
      const validated = validateWebhookUrl(webhookUrl)
      if (!validated.ok) return errorResponse(res, validated.message, 400)
      ciphertext = encrypt(validated.url)
      if (!ciphertext) return errorResponse(res, 'Unable to secure the webhook URL; it was not saved.', 500)
      hint = maskSecret(validated.url)
    }

    const { rows } = await pool.query(
      `UPDATE teams_webhooks SET
         name            = COALESCE($2, name),
         event_types     = COALESCE($3::text[], event_types),
         enabled         = COALESCE($4, enabled),
         summary_digest  = COALESCE($5, summary_digest),
         webhook_url     = COALESCE($6, webhook_url),
         url_hint        = COALESCE($7, url_hint),
         failure_count   = CASE WHEN $6 IS NOT NULL OR $4 = TRUE THEN 0 ELSE failure_count END,
         disabled_reason = CASE WHEN $4 = TRUE THEN NULL ELSE disabled_reason END,
         updated_at      = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        req.params.id,
        name ?? null,
        Array.isArray(eventTypes) ? eventTypes : null,
        typeof enabled === 'boolean' ? enabled : null,
        summaryDigest || null,
        ciphertext,
        hint,
      ]
    )

    return successResponse(res, { webhook: toPublicWebhook(rows[0]) }, 'Webhook updated.')
  } catch (err) {
    if (err.code === '23505') {
      return errorResponse(res, 'That webhook is already configured for this project.', 409)
    }
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/teams/webhooks/:id  (AC-25)
// ---------------------------------------------------------------------------
exports.deleteWebhook = async (req, res) => {
  try {
    // Delivery history CASCADEs — see the note in migrate-module45.js on why
    // this differs from notification_action_log's ON DELETE SET NULL.
    const { rows } = await pool.query(
      `DELETE FROM teams_webhooks WHERE id = $1 RETURNING id`,
      [req.params.id]
    )
    if (!rows[0]) return errorResponse(res, 'Webhook not found.', 404)
    return successResponse(res, { id: rows[0].id }, 'Webhook revoked. No further messages will be sent.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/teams/webhooks/:id/test
// ---------------------------------------------------------------------------
exports.testWebhook = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT w.*, p.name AS project_name
         FROM teams_webhooks w
         LEFT JOIN projects p ON p.id = w.project_id
        WHERE w.id = $1`,
      [req.params.id]
    )
    const webhook = rows[0]
    if (!webhook) return errorResponse(res, 'Webhook not found.', 404)

    // A test on a disabled webhook is how an admin verifies a fix, so it is
    // run against a temporarily-enabled copy rather than refused outright.
    const result = await sendTestMessage(
      { ...webhook, enabled: true },
      { projectName: webhook.project_name, actorName: req.user.name }
    )

    if (!result.ok) {
      return errorResponse(
        res,
        result.reason === 'decrypt_failed'
          ? 'The stored webhook URL could not be read. Re-enter it to continue.'
          : `Teams rejected the test message${result.status ? ` (HTTP ${result.status})` : ''}. Check that the connector still exists.`,
        502
      )
    }

    // A successful test proves the channel is reachable, so clear any
    // auto-disable that a past outage left behind.
    await pool.query(
      `UPDATE teams_webhooks
          SET enabled = TRUE, failure_count = 0, disabled_reason = NULL,
              last_success_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [webhook.id]
    )

    return successResponse(res, { ok: true, status: result.status }, 'Test message posted to the channel.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/teams/webhooks/:id/health
// ---------------------------------------------------------------------------
exports.getWebhookHealth = async (req, res) => {
  try {
    const { rows: whRows } = await pool.query(
      `SELECT * FROM teams_webhooks WHERE id = $1`,
      [req.params.id]
    )
    if (!whRows[0]) return errorResponse(res, 'Webhook not found.', 404)

    const { rows: deliveries } = await pool.query(
      `SELECT id, event_type, card_kind, status, http_status, attempts, error, created_at
         FROM teams_delivery_log
        WHERE webhook_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.params.id]
    )

    const { rows: agg } = await pool.query(
      `SELECT
         COUNT(*)::int                                              AS total,
         COUNT(*) FILTER (WHERE status = 'sent')::int                AS sent,
         COUNT(*) FILTER (WHERE status IN ('failed','exhausted'))::int AS failed,
         COUNT(*) FILTER (WHERE status = 'pending')::int             AS pending
       FROM teams_delivery_log WHERE webhook_id = $1`,
      [req.params.id]
    )

    const stats = agg[0] || { total: 0, sent: 0, failed: 0, pending: 0 }
    return successResponse(res, {
      webhook: toPublicWebhook(whRows[0]),
      stats: {
        ...stats,
        successRate: stats.total ? Math.round((stats.sent / stats.total) * 100) : null,
      },
      // `error` is a Teams/network message; it never contains the URL, which
      // is only ever held in a local variable inside teams-delivery.js.
      deliveries: deliveries.map((d) => ({
        id: d.id,
        eventType: d.event_type,
        cardKind: d.card_kind,
        status: d.status,
        httpStatus: d.http_status,
        attempts: d.attempts,
        error: d.error,
        createdAt: d.created_at,
      })),
    })
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.__internals = { validateWebhookUrl, toPublicWebhook, SUPPORTED_EVENT_TYPES }
