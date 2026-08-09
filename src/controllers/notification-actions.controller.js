/**
 * Notification actions — the single code path for acting on a notification.
 * ---------------------------------------------------------------------------
 * POST /api/notification-actions   { action, source? }
 *
 * SF2a ships session-bearer auth only (the in-app buttons in SF2b use it).
 * SF3 adds a signed action token as an alternative credential so the service
 * worker can call this with no app open; the re-validation below is written to
 * be credential-agnostic so that lands as an auth-resolution change only.
 *
 * SECURITY MODEL
 * The credential establishes *who is acting*. It authorises nothing. Every
 * request re-reads the user, the notification and the task from the database
 * and recomputes permission from those live rows — so role demotion,
 * reassignment, deactivation, a deleted notification, or a task that already
 * moved on all produce a denial even with a perfectly valid credential. This is
 * the PRD rule "Actionable notifications must re-validate permissions
 * server-side at the moment the action is taken, not only at send time".
 *
 * IDEMPOTENCY
 * The notification row is the idempotency record. A single conditional UPDATE
 * claims it; Postgres row-locking serialises concurrent taps so exactly one
 * caller wins. The winner applies the change and stores its response verbatim
 * in action_result inside the same transaction. Replays return that stored
 * result rather than re-applying.
 */

const pool = require('../config/db')
const { dispatchNotification, NOTIFICATION_TYPES } = require('../utils/notification-engine')
const { logAction, OUTCOMES } = require('../utils/notification-audit')
const { verifyActionToken, tokenAllowsAction } = require('../utils/notification-actions')

// checkProjectMilestone + getTaskWithDetails are exported by tasks.controller
// for reuse here; see the note at the bottom of that file.
const taskHelpers = require('./tasks.controller')

/* -------------------------------------------------------------------------- */
/* Response envelope — matches notifications.controller.js's local ok/fail     */
/* -------------------------------------------------------------------------- */

const ok = (res, data, message = 'OK', status = 200) =>
  res.status(status).json({ success: true, message, data })

const fail = (res, code, message, status, extra = {}) =>
  res.status(status).json({ success: false, message, data: { code, ...extra } })

/* -------------------------------------------------------------------------- */
/* Action catalogue                                                           */
/* -------------------------------------------------------------------------- */

const ACTIONS = {
  approve: {
    requiresStatus: 'in_review',
    nextStatus: 'completed',
    // Reviewer-side: admin/manager, or the project's own manager.
    permit: (actor, task) =>
      ['admin', 'manager'].includes(actor.role.toLowerCase()) ||
      actor.id === task.project_manager_id,
    denyReason: 'Only a manager or admin can approve a task submission.',
  },
  reject: {
    requiresStatus: 'in_review',
    nextStatus: 'in_progress',
    permit: (actor, task) =>
      ['admin', 'manager'].includes(actor.role.toLowerCase()) ||
      actor.id === task.project_manager_id,
    denyReason: 'Only a manager or admin can reject a task submission.',
  },
  accept: {
    requiresStatus: 'todo',
    nextStatus: 'in_progress',
    // Assignee-side: catches reassignment between send and tap.
    permit: (actor, task) => actor.id === task.assignee_id,
    denyReason: 'Only the task assignee can accept this assignment.',
  },
}

/**
 * Snooze durations. Snooze is not a task mutation — it defers the notification
 * — so these live outside ACTIONS and take a separate code path below.
 *
 * Permission is simply "it's your notification", already enforced by the
 * recipient check: you may always defer something addressed to you.
 */
const SNOOZE_ACTIONS = {
  snooze_1h: { label: '1 hour', minutes: 60 },
  snooze_3h: { label: '3 hours', minutes: 180 },
  snooze_tomorrow: { label: 'tomorrow morning', nextMorningHour: 9 },
}

const SNOOZE_NAMES = Object.keys(SNOOZE_ACTIONS)
const VALID_ACTIONS = [...Object.keys(ACTIONS), ...SNOOZE_NAMES]

/**
 * Wake time for a snooze. `snooze_tomorrow` targets 09:00 the next day in
 * server local time — the same clock quiet-hours already uses
 * (notification-engine.js#isWithinQuietHours), so the two stay consistent even
 * though neither is user-timezone aware yet.
 */
function computeWakeAt(name, now = new Date()) {
  const spec = SNOOZE_ACTIONS[name]
  if (!spec) return null
  if (spec.minutes) return new Date(now.getTime() + spec.minutes * 60 * 1000)

  const wake = new Date(now)
  wake.setDate(wake.getDate() + 1)
  wake.setHours(spec.nextMorningHour, 0, 0, 0)
  return wake
}

/* -------------------------------------------------------------------------- */
/* Credential resolution                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Two credentials, one code path.
 *
 *  - Session bearer: the route's `protect` middleware already ran and attached
 *    req.user (a live DB row).
 *  - Action token (SF3): minted at dispatch and embedded in the push payload,
 *    so the service worker can act with no app open. This path does NOT go
 *    through `protect`, which is exactly why the user is re-read below.
 *
 * Either way the identity is re-resolved from the database here. The token
 * never carries a role, and its `acts` allow-list only narrows what may be
 * attempted — the real permission decision happens against live task/project
 * rows further down.
 *
 * Returns { actor, viaToken, claims } or { error: {code, message, status} }.
 */
async function resolveActor(req) {
  const rawToken = req.body ? req.body.token : null
  let userId = req.user && req.user.id
  let claims = null

  if (!userId && rawToken) {
    const verdict = verifyActionToken(rawToken)
    if (!verdict.ok) {
      return {
        error: {
          code: verdict.code,
          message:
            verdict.code === 'action_token_expired'
              ? 'This notification action has expired. Open the task to continue.'
              : 'This action link is not valid.',
          status: 401,
        },
      }
    }
    claims = verdict.claims
    userId = claims.sub
  }

  if (!userId) {
    return { error: { code: 'unauthenticated', message: 'Authentication required.', status: 401 } }
  }

  const { rows } = await pool.query(
    'SELECT id, name, email, role, status FROM users WHERE id = $1',
    [userId]
  )
  const actor = rows[0]

  if (!actor) {
    return { error: { code: 'not_permitted', message: 'Acting user no longer exists.', status: 403 } }
  }
  if (actor.status !== 'active') {
    return {
      error: { code: 'not_permitted', message: 'Your account is not active.', status: 403 },
      actor,
    }
  }
  return { actor, viaToken: !!claims, claims }
}

/* -------------------------------------------------------------------------- */
/* POST /api/notification-actions                                             */
/* -------------------------------------------------------------------------- */

async function performAction(req, res, next) {
  try {
    const { action, source } = req.body || {}
    const actionSource = source === 'push' ? 'push' : 'in_app'

    if (!action || !VALID_ACTIONS.includes(action)) {
      return fail(res, 'invalid_action',
        `Unknown action. Expected one of: ${VALID_ACTIONS.join(', ')}.`, 400)
    }

    // --- 1. Who is acting (re-read from the DB, never trusted from the token)
    const { actor, error: actorError, viaToken, claims } = await resolveActor(req)
    if (actorError) {
      await logAction({
        notificationId: (req.body && req.body.notificationId) || null,
        userId: actor ? actor.id : null, action,
        source: actionSource, outcome: OUTCOMES.DENIED,
        detail: { reason: actorError.code },
      })
      return fail(res, actorError.code, actorError.message, actorError.status)
    }

    // A token is bound to the notification it was minted for. The SW may omit
    // notificationId entirely and let the token supply it; if it sends one, it
    // must match — a token can never be pointed at a different notification.
    let notificationId = req.body ? req.body.notificationId : null
    if (viaToken) {
      if (notificationId && notificationId !== claims.nid) {
        await logAction({
          notificationId, userId: actor.id, action, source: actionSource,
          outcome: OUTCOMES.DENIED, detail: { reason: 'token_notification_mismatch' },
        })
        return fail(res, 'not_permitted', 'This action link does not match that notification.', 403)
      }
      notificationId = claims.nid

      // The allow-list narrows what may be attempted. It grants nothing —
      // permission is still recomputed from live rows in step 5.
      if (!tokenAllowsAction(claims, action)) {
        await logAction({
          notificationId, userId: actor.id, action, source: actionSource,
          outcome: OUTCOMES.DENIED, detail: { reason: 'action_not_in_token', allowed: claims.acts },
        })
        return fail(res, 'not_permitted', 'That action is not available from this notification.', 403)
      }
    }

    if (!notificationId) {
      return fail(res, 'invalid_action', 'notificationId is required.', 400)
    }

    // --- 2. The notification. 404 if gone; 403 if it isn't the actor's.
    const nRes = await pool.query(
      `SELECT id, user_id, type, link_to, actions, action_taken, actioned_at, action_result
         FROM notifications WHERE id = $1`,
      [notificationId]
    )
    const notification = nRes.rows[0]

    if (!notification) {
      await logAction({ notificationId, userId: actor.id, action, source: actionSource,
        outcome: OUTCOMES.NOT_FOUND })
      return fail(res, 'notification_not_found', 'Notification not found.', 404)
    }
    if (notification.user_id !== actor.id) {
      await logAction({ notificationId, userId: actor.id, action, source: actionSource,
        outcome: OUTCOMES.DENIED, detail: { reason: 'not_recipient' } })
      return fail(res, 'not_permitted', 'This notification is not addressed to you.', 403)
    }

    // --- 3. Fast replay path. The authoritative check is the conditional
    //        UPDATE below; this just avoids pointless work on the common case.
    if (notification.action_taken) {
      return replayResponse(res, notification, action, actor, actionSource)
    }

    // --- 3b. Snooze: defer the notification rather than mutating a task.
    //         Handled before task resolution because a snoozed notification
    //         needn't refer to a task at all.
    if (SNOOZE_NAMES.includes(action)) {
      return snoozeNotification({
        res, notification, actor, action, actionSource,
      })
    }

    // --- 4. The target task, resolved from link_to (/tasks/<uuid>).
    const taskId = extractTaskId(notification.link_to)
    if (!taskId) {
      return fail(res, 'conflict', 'This notification has no actionable target.', 409)
    }

    const tRes = await pool.query(
      `SELECT t.id, t.title, t.status, t.assignee_id, t.project_id,
              p.manager_id AS project_manager_id
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1`,
      [taskId]
    )
    const task = tRes.rows[0]
    if (!task) {
      await logAction({ notificationId, userId: actor.id, action, source: actionSource,
        outcome: OUTCOMES.NOT_FOUND, resourceType: 'task', resourceId: taskId })
      return fail(res, 'notification_not_found', 'The task this notification refers to no longer exists.', 404)
    }

    const spec = ACTIONS[action]

    // --- 5. Permission, recomputed from the live rows.
    if (!spec.permit(actor, task)) {
      await logAction({ notificationId, userId: actor.id, action, source: actionSource,
        outcome: OUTCOMES.DENIED, resourceType: 'task', resourceId: task.id,
        detail: { reason: 'permission', role: actor.role } })
      return fail(res, 'not_permitted', spec.denyReason, 403)
    }

    // --- 6. Current status. Already in the destination state => superseded,
    //        not an error: the outcome the user wanted is already true.
    if (task.status !== spec.requiresStatus) {
      const outcome = task.status === spec.nextStatus ? OUTCOMES.SUPERSEDED : OUTCOMES.CONFLICT
      await logAction({ notificationId, userId: actor.id, action, source: actionSource,
        outcome, resourceType: 'task', resourceId: task.id,
        detail: { expected: spec.requiresStatus, actual: task.status } })

      if (outcome === OUTCOMES.SUPERSEDED) {
        return ok(res, {
          notificationId, action, status: 'superseded',
          taskId: task.id, taskStatus: task.status, actionedAt: null,
        }, 'This was already done.')
      }
      return fail(res, 'conflict',
        `This task is "${task.status.replace('_', ' ')}", not "${spec.requiresStatus.replace('_', ' ')}", so it can no longer be ${action}d.`,
        409, { currentStatus: task.status })
    }

    // --- 7. Claim + apply, atomically.
    const client = await pool.connect()
    let applied
    try {
      await client.query('BEGIN')

      const claim = await client.query(
        `UPDATE notifications
            SET action_taken = $2, actioned_at = NOW(), action_source = $3,
                is_read = true, read_at = COALESCE(read_at, NOW())
          WHERE id = $1 AND user_id = $4 AND action_taken IS NULL
          RETURNING actioned_at`,
        [notificationId, action, actionSource, actor.id]
      )

      if (claim.rowCount === 0) {
        // Lost the race — another request claimed it between step 3 and here.
        await client.query('ROLLBACK')
        const fresh = await pool.query(
          `SELECT id, action_taken, actioned_at, action_result FROM notifications WHERE id = $1`,
          [notificationId]
        )
        return replayResponse(res, fresh.rows[0], action, actor, actionSource)
      }

      // Re-assert the status inside the transaction so a concurrent status
      // change can't slip between the step-6 read and this write.
      const upd = await client.query(
        `UPDATE tasks
            SET status = $1,
                completed_at = $2,
                updated_at = NOW()
          WHERE id = $3 AND status = $4
          RETURNING id, status`,
        [
          spec.nextStatus,
          spec.nextStatus === 'completed' ? new Date() : null,
          task.id,
          spec.requiresStatus,
        ]
      )

      if (upd.rowCount === 0) {
        await client.query('ROLLBACK')
        await logAction({ notificationId, userId: actor.id, action, source: actionSource,
          outcome: OUTCOMES.CONFLICT, resourceType: 'task', resourceId: task.id,
          detail: { reason: 'status_changed_during_transaction' } })
        return fail(res, 'conflict',
          'The task changed while your action was being applied. Please reload and try again.',
          409, { currentStatus: null })
      }

      applied = {
        notificationId,
        action,
        status: 'applied',
        taskId: task.id,
        taskStatus: upd.rows[0].status,
        actionedAt: claim.rows[0].actioned_at,
      }

      // Store the response verbatim — this is what a replay returns.
      await client.query(
        `UPDATE notifications SET action_result = $1::jsonb WHERE id = $2`,
        [JSON.stringify(applied), notificationId]
      )

      // --- Resolve the SIBLING rows for this same event. -------------------
      //
      // dispatchToMany writes one row per recipient, so a review request to
      // four managers plus an admin is five independent rows with five ids.
      // Claiming one leaves the rest reading action_taken = NULL, and every
      // other reviewer keeps seeing live Approve/Reject buttons for work that
      // is already done. Refreshing cannot help them: the server genuinely
      // still says "pending" for their row.
      //
      // Their outcome is decided the moment this transaction commits, so mark
      // them resolved here, inside it. Marked 'resolved' rather than the
      // action name — they did not approve it, someone else did, and the audit
      // log plus action_result record who. The UI reads action_taken only to
      // decide "still actionable?", so this is enough to retire the buttons.
      //
      // Deliberately NOT touched:
      //   * is_read — being informed is not the same as having read it.
      //   * rows already carrying an action_taken (a concurrent snooze).
      //   * rows of a different type or for a different task.
      const siblings = await client.query(
        `UPDATE notifications
            SET action_taken  = 'resolved',
                actioned_at   = NOW(),
                action_result = $1::jsonb
          WHERE link_to      = $2
            AND type         = $3
            AND id          <> $4
            AND action_taken IS NULL
          RETURNING id, user_id`,
        [
          JSON.stringify({
            status: 'resolved_by_other',
            action,
            byUserId: actor.id,
            byUserName: actor.name || null,
            taskId: task.id,
            taskStatus: upd.rows[0].status,
          }),
          notification.link_to,
          notification.type,
          notificationId,
        ]
      )
      applied.siblingsResolved = siblings.rowCount

      await logAction({
        notificationId, userId: actor.id, action, source: actionSource,
        outcome: OUTCOMES.APPLIED, resourceType: 'task', resourceId: task.id,
        detail: { from: spec.requiresStatus, to: spec.nextStatus },
      }, client)

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }

    // --- 8. Notify, after the commit. Failures here must never undo the action,
    //        so this uses the same swallow-and-log convention as tasks.controller.
    await notifyOutcome({ action, actor, task, spec }).catch((err) =>
      console.error('[notification-actions] post-action notify failed:', err.message)
    )

    return ok(res, applied, messageFor(action, task.title))
  } catch (err) {
    return next(err)
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Defer a notification: queue a wake-up and mark the row snoozed.
 *
 * ── THE ONE EXCEPTION TO THE SF2a IDEMPOTENCY RULE ─────────────────────────
 * Everywhere else, `action_taken` is a permanent one-way claim: once set the
 * action is settled and replays return the stored result. Snooze is the single
 * action that is deliberately REVERSIBLE, because it means "ask me again
 * later", not "this is decided".
 *
 * Here we set action_taken='snooze' (which stops the buttons rendering and
 * blocks a competing approve/reject while it is parked). snooze-cron.js later
 * clears it back to NULL when wake_at passes, and the re-delivered
 * notification is actionable again. That reversal is guarded on the value
 * still being exactly 'snooze', so a terminal action taken meanwhile wins.
 *
 * The claim itself is still atomic and race-safe — two simultaneous snoozes
 * produce one queue row, exactly like every other action.
 */
async function snoozeNotification({ res, notification, actor, action, actionSource }) {
  const wakeAt = computeWakeAt(action)
  if (!wakeAt) {
    return fail(res, 'invalid_action', 'Unknown snooze duration.', 400)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const claim = await client.query(
      `UPDATE notifications
          SET action_taken = 'snooze', actioned_at = NOW(), action_source = $2,
              is_read = true, read_at = COALESCE(read_at, NOW())
        WHERE id = $1 AND user_id = $3 AND action_taken IS NULL
        RETURNING actioned_at`,
      [notification.id, actionSource, actor.id]
    )

    if (claim.rowCount === 0) {
      await client.query('ROLLBACK')
      const fresh = await pool.query(
        `SELECT id, action_taken, actioned_at, action_result FROM notifications WHERE id = $1`,
        [notification.id]
      )
      return replayResponse(res, fresh.rows[0], action, actor, actionSource)
    }

    await client.query(
      `INSERT INTO notification_snoozes (notification_id, user_id, wake_at)
       VALUES ($1, $2, $3)`,
      [notification.id, actor.id, wakeAt]
    )

    const applied = {
      notificationId: notification.id,
      action,
      status: 'applied',
      taskId: extractTaskId(notification.link_to),
      taskStatus: null,
      actionedAt: claim.rows[0].actioned_at,
      wakeAt: wakeAt.toISOString(),
    }

    await client.query(
      `UPDATE notifications SET action_result = $1::jsonb WHERE id = $2`,
      [JSON.stringify(applied), notification.id]
    )

    await logAction({
      notificationId: notification.id, userId: actor.id, action, source: actionSource,
      outcome: OUTCOMES.APPLIED, resourceType: 'notification', resourceId: notification.id,
      detail: { wakeAt: wakeAt.toISOString(), reversible: true },
    }, client)

    await client.query('COMMIT')

    return ok(res, applied, `Snoozed until ${SNOOZE_ACTIONS[action].label}.`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

function extractTaskId(linkTo) {
  if (!linkTo) return null
  const m = String(linkTo).match(
    /\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  )
  return m ? m[1] : null
}

function messageFor(action, title) {
  if (action === 'approve') return `Approved "${title}".`
  if (action === 'reject') return `Sent "${title}" back for changes.`
  return `Accepted "${title}".`
}

/**
 * A replayed action returns the stored result rather than re-applying.
 * A *different* action on an already-actioned notification is a genuine
 * conflict (Approve on one device, Reject on another).
 */
async function replayResponse(res, notification, action, actor, source) {
  if (notification.action_taken === action) {
    logAction({
      notificationId: notification.id, userId: actor.id, action, source,
      outcome: OUTCOMES.ALREADY_APPLIED,
    })
    const stored = notification.action_result || {
      notificationId: notification.id,
      action,
      taskId: null,
      taskStatus: null,
      actionedAt: notification.actioned_at,
    }
    return ok(res, { ...stored, status: 'already_applied' }, 'This was already done.')
  }

  logAction({
    notificationId: notification.id, userId: actor.id, action, source,
    outcome: OUTCOMES.CONFLICT, detail: { alreadyTaken: notification.action_taken },
  })
  return fail(res, 'already_actioned_differently',
    `This notification was already actioned ("${notification.action_taken}").`,
    409, { actionTaken: notification.action_taken, actionedAt: notification.actioned_at })
}

/**
 * Post-action notifications. Reuses the existing dispatcher and the already-
 * configured TASK_APPROVED / TASK_REJECTED types — both are already present in
 * TYPE_CATEGORY_MAP (-> the `approvals` preference), PUSH_WORTHY_TYPES and
 * EMAIL_WORTHY_TYPES, so this lights up the existing pipeline without touching
 * any Module 7 rule.
 */
async function notifyOutcome({ action, actor, task, spec }) {
  if (action === 'approve' || action === 'reject') {
    if (task.assignee_id && task.assignee_id !== actor.id) {
      await dispatchNotification(
        task.assignee_id,
        action === 'approve' ? NOTIFICATION_TYPES.TASK_APPROVED : NOTIFICATION_TYPES.TASK_REJECTED,
        action === 'approve' ? 'Task approved' : 'Changes requested',
        action === 'approve'
          ? `${actor.name} approved: ${task.title}`
          : `${actor.name} sent "${task.title}" back for changes.`,
        `/tasks/${task.id}`,
        'high'
      )
    }
  } else if (action === 'accept') {
    // Mirrors updateTaskStatus's employee branch: admins + managers get told.
    await notifyAdminsAndManagers(
      actor.id,
      NOTIFICATION_TYPES.TASK_STATUS_CHANGED,
      'Task Status Updated',
      `${actor.name} started "${task.title}"`,
      `/tasks/${task.id}`,
      'low'
    )
  }

  // approve -> completed can complete a project; same 25/50/75/100% rule the
  // rest of the app uses. Reused, not reimplemented.
  if (spec.nextStatus === 'completed' && typeof taskHelpers.checkProjectMilestone === 'function') {
    await taskHelpers.checkProjectMilestone(task.project_id, actor.id)
  }
}

/** Local copy of tasks.controller's fan-out — kept here to avoid widening that file's exports further. */
async function notifyAdminsAndManagers(excludeUserId, type, title, message, linkTo, priority) {
  const { dispatchToMany } = require('../utils/notification-engine')
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role IN ('admin','manager') AND status = 'active'`
  )
  const ids = rows.map((r) => r.id).filter((id) => id !== excludeUserId)
  if (!ids.length) return
  await dispatchToMany(ids, type, title, message, linkTo, priority)
}

module.exports = {
  performAction,
  ACTIONS,
  SNOOZE_ACTIONS,
  SNOOZE_NAMES,
  VALID_ACTIONS,
  extractTaskId,
  computeWakeAt,
}
