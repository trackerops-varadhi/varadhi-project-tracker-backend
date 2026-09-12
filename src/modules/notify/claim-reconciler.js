/**
 * Reconcile notification claims that were left pending.
 * ---------------------------------------------------------------------------
 * A notification action is two writes in two schemas:
 *
 *   work    moves the task           <- authoritative, happens first
 *   notify  claims the notification  <- bookkeeping, happens second
 *
 * Since the Phase 2 schema split those cannot share a transaction, so there is
 * a window where the first succeeds and the second does not. The action itself
 * is fine — the task moved — but this module's rows have not caught up: the
 * acting user's notification still reads `action_taken IS NULL`, and so do the
 * sibling rows sent to everyone else, which means live Approve/Reject buttons
 * for work that is already done.
 *
 * actions.controller records that window as an `applied_claim_pending` row in
 * notification_action_log. This file closes it.
 *
 * WHY NOT AN OUTBOX (yet)
 * An outbox would make the claim durable at the moment of the task write and
 * drain it asynchronously — strictly better, and the plan keeps it on the
 * table. It also needs a table, a worker and a delivery guarantee, which is
 * more machinery than one repairable window justifies today. This is the
 * smaller thing that makes the window closeable; the outbox is what replaces it
 * when a second service makes the window common rather than rare.
 *
 * SAFE TO RUN ANY TIME, ANY NUMBER OF TIMES.
 * Every write is guarded by `action_taken IS NULL`, so a row already claimed
 * (by a retry, by the user clicking again, by a previous reconcile) is skipped
 * rather than overwritten. Nothing here touches `tasks` — the task is already
 * correct by definition, and reading it is not this module's business.
 *
 * NOT WIRED TO CRON. ENABLE_CRON is false while reminder-cron is still
 * unmigrated, and a repair path that only runs under a switch that is currently
 * off would be a trap. Call it explicitly:
 *
 *     node -e "require('./src/modules/notify').reconcilePendingClaims().then(console.log)"
 */

const pool = require('../../platform/db').forSchema('notify')
const { logAction, OUTCOMES } = require('./audit')

/**
 * Find, and complete, every claim left pending.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.limit=100]   most rows to repair in one pass
 * @param {boolean} [opts.dryRun]      report what would be repaired, change nothing
 * @returns {Promise<{pending:number, reconciled:number, alreadyClaimed:number,
 *                    failed:number, details:Array}>}
 */
const reconcilePendingClaims = async ({ limit = 100, dryRun = false } = {}) => {
  // The pending set: an applied_claim_pending log row with no later log row
  // saying it was reconciled.
  const { rows: pending } = await pool.query(
    `SELECT l.id           AS log_id,
            l.notification_id,
            l.user_id,
            l.action,
            l.source,
            l.resource_id  AS task_id,
            l.detail,
            l.created_at
       FROM notification_action_log l
      WHERE l.outcome = $1
        AND NOT EXISTS (
              SELECT 1 FROM notification_action_log r
               WHERE r.notification_id = l.notification_id
                 AND r.outcome         = $2
                 AND r.created_at      > l.created_at
            )
      ORDER BY l.created_at ASC
      LIMIT $3`,
    [OUTCOMES.APPLIED_CLAIM_PENDING, OUTCOMES.CLAIM_RECONCILED, limit]
  )

  const result = {
    pending: pending.length, reconciled: 0, alreadyClaimed: 0, failed: 0, details: [],
  }
  if (!pending.length || dryRun) {
    result.details = pending.map((p) => ({
      notificationId: p.notification_id, action: p.action, taskId: p.task_id,
      pendingSince: p.created_at,
    }))
    return result
  }

  for (const row of pending) {
    const detail = row.detail || {}
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const claim = await client.query(
        `UPDATE notifications
            SET action_taken = $2, actioned_at = NOW(), action_source = $3,
                is_read = true, read_at = COALESCE(read_at, NOW())
          WHERE id = $1 AND user_id = $4 AND action_taken IS NULL
          RETURNING actioned_at`,
        [row.notification_id, row.action, row.source || 'reconcile', row.user_id]
      )

      if (claim.rowCount === 0) {
        // Someone got there first — the user clicked again, or an earlier pass
        // repaired it. Nothing to do, and the log row should stop showing up.
        await client.query('COMMIT')
        result.alreadyClaimed += 1
        await logAction({
          notificationId: row.notification_id, userId: row.user_id, action: row.action,
          source: 'reconcile', outcome: OUTCOMES.CLAIM_RECONCILED,
          resourceType: 'task', resourceId: row.task_id,
          detail: { reason: 'already_claimed', pendingLogId: row.log_id },
        })
        continue
      }

      const applied = {
        notificationId: row.notification_id,
        action: row.action,
        status: 'applied',
        taskId: row.task_id,
        taskStatus: detail.to || null,
        actionedAt: claim.rows[0].actioned_at,
        reconciled: true,
      }

      await client.query(
        `UPDATE notifications SET action_result = $1::jsonb WHERE id = $2`,
        [JSON.stringify(applied), row.notification_id]
      )

      // The siblings, same rule as the live path: retire their buttons, do not
      // mark them read, do not disturb a row that already carries an action.
      let siblings = { rowCount: 0 }
      if (detail.linkTo && detail.notificationType) {
        siblings = await client.query(
          `UPDATE notifications
              SET action_taken  = 'resolved',
                  actioned_at   = NOW(),
                  action_result = $1::jsonb
            WHERE link_to      = $2
              AND type         = $3
              AND id          <> $4
              AND action_taken IS NULL
            RETURNING id`,
          [
            JSON.stringify({
              status: 'resolved_by_other',
              action: row.action,
              byUserId: row.user_id,
              taskId: row.task_id,
              taskStatus: detail.to || null,
              reconciled: true,
            }),
            detail.linkTo, detail.notificationType, row.notification_id,
          ]
        )
      }

      await client.query('COMMIT')
      result.reconciled += 1
      result.details.push({
        notificationId: row.notification_id, action: row.action,
        taskId: row.task_id, siblingsResolved: siblings.rowCount,
      })

      await logAction({
        notificationId: row.notification_id, userId: row.user_id, action: row.action,
        source: 'reconcile', outcome: OUTCOMES.CLAIM_RECONCILED,
        resourceType: 'task', resourceId: row.task_id,
        detail: { siblingsResolved: siblings.rowCount, pendingLogId: row.log_id },
      })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      result.failed += 1
      // Left pending on purpose: no CLAIM_RECONCILED row is written, so the
      // next pass picks it up again. Repair retries; it never gives up quietly.
      console.error(
        `[claim-reconciler] failed notification=${row.notification_id}: ${err.message}`
      )
    } finally {
      client.release()
    }
  }

  return result
}

module.exports = { reconcilePendingClaims }
