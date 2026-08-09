

const pool = require('../config/db')
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response')
const { dispatchNotification, dispatchToMany, NOTIFICATION_TYPES } = require('../utils/notification-engine')
const {
  parseBaseUpdatedAt,
  classifyFailedGuardedUpdate,
  buildConflictPayload,
  matchesClause,
  toTimestampParam,
} = require('../utils/concurrency')
// Module 4. Both of these are wrapped in notifySafely at every call site — a
// calendar that is unreachable must never turn a successful task edit into a
// 500, exactly as a failed notification never does.
const { markSourceDirty, purgeSource } = require('../utils/calendar-sync')

const getTaskWithDetails = async (taskId) => {
  const result = await pool.query(`
    SELECT t.*,
      a.id AS assignee_id, a.name AS assignee_name, a.email AS assignee_email, a.avatar AS assignee_avatar,
      r.id AS reporter_id, r.name AS reporter_name,
      p.id AS project_id, p.name AS project_name
    FROM tasks t
    LEFT JOIN users a ON t.assignee_id = a.id
    LEFT JOIN users r ON t.reporter_id = r.id
    LEFT JOIN projects p ON t.project_id = p.id
    WHERE t.id = $1
  `, [taskId])
  if (!result.rows[0]) return null
  const t = result.rows[0]
  const comments = await pool.query(`
    SELECT c.*, u.name AS author_name, u.avatar AS author_avatar
    FROM comments c JOIN users u ON c.author_id = u.id
    WHERE c.task_id = $1 ORDER BY c.created_at ASC
  `, [taskId])
  return {
    id: t.id, title: t.title, description: t.description,
    userStory: t.user_story,
    acceptanceCriteria: t.acceptance_criteria,
    status: t.status, priority: t.priority, type: t.type,
    dueDate: t.due_date, estimatedHours: t.estimated_hours,
    actualHours: t.actual_hours, tags: t.tags || [],
    createdAt: t.created_at, updatedAt: t.updated_at,
    completedAt: t.completed_at,
    project: { id: t.project_id, name: t.project_name },
    assignee: t.assignee_id ? { id: t.assignee_id, name: t.assignee_name, email: t.assignee_email, avatar: t.assignee_avatar } : null,
    reporter: t.reporter_id ? { id: t.reporter_id, name: t.reporter_name } : null,
    comments: comments.rows.map(c => ({
      id: c.id, content: c.content, createdAt: c.created_at,
      author: { id: c.author_id, name: c.author_name, avatar: c.author_avatar }
    }))
  }
}

exports.getAllTasks = async (req, res) => {
  try {
    const currentUser = req.user

    const { status, priority, type, assigneeId, projectId, search, page = 1, limit = 10 } = req.query
    let where = 'WHERE 1=1'
    const params = []
    // Employee can see only assigned tasks
    if (currentUser.role.toLowerCase() === 'employee') {
      params.push(currentUser.id)
      where += ` AND t.assignee_id = $${params.length}`
    }
    if (status) { params.push(status); where += ` AND t.status = $${params.length}` }
    if (priority) { params.push(priority); where += ` AND t.priority = $${params.length}` }
    if (type) { params.push(type); where += ` AND t.type = $${params.length}` }
    if (assigneeId) { params.push(assigneeId); where += ` AND t.assignee_id = $${params.length}` }
    if (projectId) { params.push(projectId); where += ` AND t.project_id = $${params.length}` }
    if (search) { params.push(`%${search}%`); where += ` AND t.title ILIKE $${params.length}` }
    const countResult = await pool.query(`SELECT COUNT(*) FROM tasks t ${where}`, params)
    const total = parseInt(countResult.rows[0].count)
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit))
    const ids = await pool.query(
      `SELECT t.id FROM tasks t ${where} ORDER BY t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    const tasks = await Promise.all(ids.rows.map(r => getTaskWithDetails(r.id)))
    return paginatedResponse(res, tasks, total, page, limit)
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.getTaskById = async (req, res) => {
  try {
    const task = await getTaskWithDetails(req.params.id)
    if (!task) return errorResponse(res, 'Task not found.', 404)
    return successResponse(res, task)
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.getTasksByProject = async (req, res) => {
  try {
    const result = await pool.query('SELECT id FROM tasks WHERE project_id = $1 ORDER BY created_at DESC', [req.params.id])
    const tasks = await Promise.all(result.rows.map(r => getTaskWithDetails(r.id)))
    return successResponse(res, tasks)
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.createTask = async (req, res) => {
  try {
          // Only Admin and Manager can create tasks
      if (req.user.role.toLowerCase() === 'employee') {
        return errorResponse(
          res,
          'You are not authorized to create tasks.',
          403
        )
      }
    const { title, description, userStory, acceptanceCriteria, status, priority, type, projectId, assigneeId, dueDate, estimatedHours, tags } = req.body
    if (!title) return errorResponse(res, 'Task title is required.')
    if (!projectId) return errorResponse(res, 'Project is required.')

    const finalStatus = status || 'todo'
    // Compute completed_at in JS and bind it as its own parameter ($12).
    // This keeps $3 (status) used in a single context, avoiding the
    // "inconsistent types deduced for parameter $3" enum inference error.
    const completedAt = finalStatus === 'completed' ? new Date() : null

    const result = await pool.query(
      `INSERT INTO tasks (
        title,
        description,
        user_story,
        acceptance_criteria,
        status,
        priority,
        type,
        project_id,
        assignee_id,
        reporter_id,
        due_date,
        estimated_hours,
        tags,
        completed_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
      )
      RETURNING id`,
      [
        title,
        description,
        userStory || null,
        acceptanceCriteria || null,
        finalStatus,
        priority || 'medium',
        type || 'feature',
        projectId,
        assigneeId || null,
        req.user.id,
        dueDate || null,
        estimatedHours || null,
        tags || [],
        completedAt,
      ]
    )
    // Create notification for assignee
    if (assigneeId && assigneeId !== req.user.id) {
      await notifySafely(async () => {
        await dispatchNotification(
          assigneeId,
          NOTIFICATION_TYPES.TASK_ASSIGNED,
          'New Task Assigned',
          `You have been assigned: ${title}`,
          `/tasks/${result.rows[0].id}`,
          'high',
          // Accept is only meaningful while the task is still 'todo'; the
          // endpoint re-checks that and reports 'superseded' otherwise.
          finalStatus === 'todo' ? { actions: ASSIGN_ACTIONS } : {}
        )
      })
    }

    // Manager visibility for bugs and critical-priority work — the two
    // creation-time signals worth interrupting a manager for.
    if (type === 'bug' || priority === 'critical') {
      await notifySafely(async () => {
        const project = await pool.query('SELECT manager_id FROM projects WHERE id = $1', [projectId])
        const managerId = project.rows[0]?.manager_id
        if (!managerId || managerId === req.user.id) return
        const reason = type === 'bug' ? 'A new bug was reported' : 'A critical-priority task was created'
        await dispatchNotification(
          managerId,
          // No dedicated category exists for this (not one of the 14 in the
          // spec) — TASK_UPDATED is intentionally uncategorized, so it's
          // always delivered rather than silently riding on the unrelated
          // "task assigned" toggle.
          NOTIFICATION_TYPES.TASK_UPDATED,
          type === 'bug' ? 'New bug reported' : 'Critical task created',
          `${reason}: ${title}`,
          `/tasks/${result.rows[0].id}`,
          'high'
        )
      })
    }

    const task = await getTaskWithDetails(result.rows[0].id)
    return successResponse(res, task, 'Task created successfully.', 201)
  } catch (err) { return errorResponse(res, err.message, 500) }
}

// Notifications must never turn a successful action into a 500, so every
// dispatch block runs inside this guard instead of the handler's try/catch.
const notifySafely = async (fn) => {
  try {
    await fn()
  } catch (err) {
    console.error('[notifications] tasks.controller:', err.message)
  }
}

// Role-based routing for task-workflow events: when an Employee acts, every
// Admin/Manager needs to know (they have no other way to see it); when an
// Admin/Manager acts, only the specific affected Employee needs to know.
const notifyAdminsAndManagers = async (excludeUserId, type, title, message, linkTo, priority, options = {}) => {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role IN ('admin','manager') AND status = 'active'`
  )
  // `options` is spread last but excludeUserId is re-applied after it, so a
  // caller passing { actions } can never accidentally widen the recipient set.
  await dispatchToMany(rows.map((r) => r.id), type, title, message, linkTo, priority, {
    ...options,
    excludeUserId,
  })
}

// Inline action buttons offered on actionable notifications. Two is the
// hard ceiling: Notification.maxActions is 2 on Chrome/Android (and 0 on iOS
// Safari, where the body-tap deep link is the only affordance).
const REVIEW_ACTIONS = [
  { action: 'approve', title: 'Approve' },
  { action: 'reject', title: 'Reject' },
]
// Two is the ceiling (Notification.maxActions). The push surface gets Accept +
// a single Snooze; the full duration menu (1h / 3h / tomorrow) is in-app only,
// where there's room for it.
const ASSIGN_ACTIONS = [
  { action: 'accept', title: 'Accept' },
  { action: 'snooze_1h', title: 'Snooze 1h' },
]

// Best-effort project-completion milestone check: fires when the recomputed
// % complete exactly equals 25/50/75/100 right after this call. There's no
// persistent "last milestone notified" column on `projects`, so this relies
// on the engine's dedupe window (24h) rather than real crossing-detection —
// if the % later drops out of and back into the same milestone within a day
// it won't refire, and if a project revisits e.g. 50% weeks apart it will
// refire, which is the correct/desired behavior either way.
const MILESTONE_THRESHOLDS = [25, 50, 75, 100]

const checkProjectMilestone = async (projectId, excludeUserId) => {
  if (!projectId) return
  const counts = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
       FROM tasks WHERE project_id = $1`,
    [projectId]
  )
  const { total, completed } = counts.rows[0]
  if (!total) return

  const pct = Math.round((completed / total) * 100)
  if (!MILESTONE_THRESHOLDS.includes(pct)) return

  const project = await pool.query('SELECT name, manager_id FROM projects WHERE id = $1', [projectId])
  const p = project.rows[0]
  if (!p || !p.manager_id || p.manager_id === excludeUserId) return

  await dispatchNotification(
    p.manager_id,
    NOTIFICATION_TYPES.PROJECT_MILESTONE,
    `${p.name} reached ${pct}%`,
    `${p.name} is now ${pct}% complete.`,
    `/projects/${projectId}`,
    pct === 100 ? 'high' : 'normal',
    { dedupeWindowMinutes: 24 * 60 }
  )
}

exports.updateTask = async (req, res) => {
  try {
    const currentUser = req.user

    const {
      title,
      description,
      userStory,
      acceptanceCriteria,
      status,
      priority,
      type,
      assigneeId,
      dueDate,
      estimatedHours,
      actualHours,
      tags
    } = req.body

    // Employee can only update status — and only on a task assigned to them.
    // Mirrors the ownership rule in updateTaskStatus; without it this route is
    // an alternate way to restatus any task in the system.
    if (currentUser.role.toLowerCase() === 'employee') {
      const owner = await pool.query(
        'SELECT assignee_id FROM tasks WHERE id = $1',
        [req.params.id]
      )
      if (!owner.rows[0]) return errorResponse(res, 'Task not found.', 404)
      if (owner.rows[0].assignee_id !== currentUser.id) {
        return errorResponse(
          res,
          'You are not authorized to update this task.',
          403
        )
      }

      const result = await pool.query(
        `
        UPDATE tasks
        SET
          status = COALESCE($1,status),
          completed_at = CASE
            WHEN COALESCE($1::text,status::text)='completed'
            THEN COALESCE(completed_at,NOW())
            ELSE NULL
          END,
          updated_at = NOW()
        WHERE id = $2
        RETURNING id
        `,
        [
          status || null,
          req.params.id
        ]
      )

      if (!result.rows[0])
        return errorResponse(res, 'Task not found.', 404)

      const task = await getTaskWithDetails(req.params.id)

      // Employee changed their task's status — every Admin/Manager needs to know.
      await notifySafely(async () => {
        await notifyAdminsAndManagers(
          currentUser.id,
          NOTIFICATION_TYPES.TASK_STATUS_CHANGED,
          'Task Status Updated',
          `${currentUser.name} changed "${task.title}" to ${(status || task.status).replace('_', ' ')}`,
          `/tasks/${task.id}`,
          'low'
        )
        await checkProjectMilestone(task.project?.id, currentUser.id)
      })

      return successResponse(res, task, 'Task updated.')
    }

    // Sanitize nullable fields — convert empty string to null
    // PostgreSQL cannot parse "" as DATE, UUID, or NUMERIC
    const safeDueDate         = dueDate         && dueDate.trim()         !== '' ? dueDate         : null
    const safeAssigneeId      = assigneeId       && assigneeId.trim()      !== '' ? assigneeId       : null
    const safeEstimatedHours  = estimatedHours   !== undefined && estimatedHours !== '' ? estimatedHours : null
    const safeActualHours     = actualHours      !== undefined && actualHours    !== '' ? actualHours    : null
    const safeUserStory       = userStory        && userStory.trim()       !== '' ? userStory        : null
    const safeAcceptance      = acceptanceCriteria && acceptanceCriteria.trim() !== '' ? acceptanceCriteria : null

    // Snapshot pre-update state so reassignment/due-date/priority changes can
    // be told apart from a plain edit and routed to their specific
    // notification type, instead of one generic "Task Updated" for everything.
    const previous = await pool.query(
      'SELECT assignee_id, due_date, priority FROM tasks WHERE id = $1',
      [req.params.id]
    )
    const before = previous.rows[0]

    // Optimistic concurrency (AC-15) — see updateTaskStatus for the rationale.
    // Opt-in; omitted means unguarded, preserving every existing caller.
    const base = parseBaseUpdatedAt(req.body.baseUpdatedAt)
    if (!base.ok) return errorResponse(res, base.message, 400)

    const result = await pool.query(
      `UPDATE tasks SET
        title               = COALESCE($1,  title),
        description         = COALESCE($2,  description),
        user_story          = COALESCE($3,  user_story),
        acceptance_criteria = COALESCE($4,  acceptance_criteria),
        status              = COALESCE($5,  status),
        completed_at = CASE
          WHEN COALESCE($5::text, status::text) = 'completed'
          THEN COALESCE(completed_at, NOW())
          ELSE NULL
        END,
        priority            = COALESCE($6,  priority),
        type                = COALESCE($7,  type),
        assignee_id         = COALESCE($8,  assignee_id),
        due_date            = COALESCE($9,  due_date),
        estimated_hours     = COALESCE($10, estimated_hours),
        actual_hours        = COALESCE($11, actual_hours),
        tags                = COALESCE($12, tags),
        updated_at          = NOW()
      WHERE id = $13
        AND ${matchesClause(14)}
      RETURNING id`,
      [
        title              || null,
        description        || null,
        safeUserStory,
        safeAcceptance,
        status             || null,
        priority           || null,
        type               || null,
        safeAssigneeId,
        safeDueDate,
        safeEstimatedHours,
        safeActualHours,
        tags               || null,
        req.params.id,
        toTimestampParam(base.value)
      ]
    )

    if (!result.rows[0]) {
      // Guarded and matched nothing: distinguish a lost race from a bad id.
      if (base.value) {
        const verdict = await classifyFailedGuardedUpdate(pool, req.params.id)
        if (verdict.kind === 'conflict') {
          const serverTask = await getTaskWithDetails(req.params.id)
          return errorResponse(
            res,
            'This task was changed by someone else while you were offline.',
            409,
            buildConflictPayload({
              serverTask,
              // Only fields this request actually set — that list is what
              // decides whether a Merge can honestly be offered.
              attempted: {
                title: title || undefined,
                description: description || undefined,
                userStory: safeUserStory ?? undefined,
                acceptanceCriteria: safeAcceptance ?? undefined,
                status: status || undefined,
                priority: priority || undefined,
                type: type || undefined,
                assigneeId: safeAssigneeId ?? undefined,
                dueDate: safeDueDate ?? undefined,
                estimatedHours: safeEstimatedHours ?? undefined,
                actualHours: safeActualHours ?? undefined,
              },
              baseUpdatedAt: base.value,
            })
          )
        }
      }
      return errorResponse(res, 'Task not found.', 404)
    }

    const task = await getTaskWithDetails(req.params.id)

    // Notify the assignee — with the most specific type that applies.
    // Reassignment takes priority (the notification is about the NEW
    // assignee getting the task, not a status update on it); otherwise
    // due-date/priority changes get their own specific type; only a plain
    // field edit (title, description, ...) falls back to generic TASK_UPDATED.
    await notifySafely(async () => {
      if (!task.assignee || task.assignee.id === currentUser.id) return

      const reassigned = Boolean(safeAssigneeId) && before && before.assignee_id !== safeAssigneeId
      if (reassigned) {
        await dispatchNotification(
          task.assignee.id,
          NOTIFICATION_TYPES.TASK_REASSIGNED,
          'Task Reassigned',
          `You've been assigned: ${task.title}`,
          `/tasks/${task.id}`,
          'high'
        )
        return
      }

      const beforeDueDate = before && before.due_date
        ? new Date(before.due_date).toISOString().slice(0, 10)
        : null
      const dueDateChanged = Boolean(safeDueDate) && beforeDueDate !== safeDueDate
      const priorityChanged = Boolean(priority) && before && before.priority !== priority

      if (dueDateChanged) {
        await dispatchNotification(
          task.assignee.id,
          NOTIFICATION_TYPES.DUE_DATE_CHANGED,
          'Due Date Changed',
          `The due date for "${task.title}" changed to ${safeDueDate}.`,
          `/tasks/${task.id}`,
          'normal'
        )
      }

      if (priorityChanged) {
        await dispatchNotification(
          task.assignee.id,
          NOTIFICATION_TYPES.PRIORITY_CHANGED,
          'Priority Changed',
          `"${task.title}" priority changed to ${priority}.`,
          `/tasks/${task.id}`,
          priority === 'critical' ? 'high' : 'normal'
        )
      }

      if (!dueDateChanged && !priorityChanged) {
        await dispatchNotification(
          task.assignee.id,
          NOTIFICATION_TYPES.TASK_UPDATED,
          'Task Updated',
          `Task updated: ${task.title}`,
          `/tasks/${task.id}`,
          'normal'
        )
      }
    })

    // AC-17: a synced task whose fields changed must reach the calendar within
    // 5 minutes. Marking the link dirty clears its content hash so the next
    // sweep re-pushes it instead of taking the dedupe early-exit. Reuses
    // notifySafely for the same reason notifications do: this is a
    // best-effort side effect, never a reason to fail the request.
    await notifySafely(() => markSourceDirty('task', req.params.id))

    return successResponse(res, task, 'Task updated.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body
    const valid = ['todo', 'in_progress', 'in_review', 'completed']
    if (!valid.includes(status)) return errorResponse(res, 'Invalid status.')

    // Admin/Manager may move any task; an Employee may only move a task that is
    // assigned to them. Read the current assignee before writing — this route is
    // the board's drag-and-drop endpoint and was previously unauthenticated
    // beyond `protect`, so any signed-in user could restatus any task.
    const existing = await pool.query(
      'SELECT assignee_id FROM tasks WHERE id = $1',
      [req.params.id]
    )
    if (!existing.rows[0]) return errorResponse(res, 'Task not found.', 404)

    if (
      req.user.role.toLowerCase() === 'employee' &&
      existing.rows[0].assignee_id !== req.user.id
    ) {
      return errorResponse(
        res,
        'You are not authorized to update this task.',
        403
      )
    }

    // Compute completed_at in JS so $1 (status) is used in one context only.
    const completedAt = status === 'completed' ? new Date() : null

    // Optimistic concurrency (AC-15). Opt-in: when the client sends the
    // updated_at it last saw, the write is guarded so a replayed offline edit
    // can't silently clobber a change made meanwhile. Omitted => unguarded,
    // exactly as before.
    const base = parseBaseUpdatedAt(req.body.baseUpdatedAt)
    if (!base.ok) return errorResponse(res, base.message, 400)

    const result = await pool.query(
      `UPDATE tasks
       SET
         status = $1,
         completed_at = $2,
         updated_at = NOW()
       WHERE id = $3
         AND ${matchesClause(4)}
       RETURNING id`,
      [status, completedAt, req.params.id, toTimestampParam(base.value)]
    )

    if (!result.rows[0]) {
      // Zero rows is ambiguous when guarded — missing id, or lost race?
      if (base.value) {
        const verdict = await classifyFailedGuardedUpdate(pool, req.params.id)
        if (verdict.kind === 'conflict') {
          const serverTask = await getTaskWithDetails(req.params.id)
          return errorResponse(
            res,
            'This task was changed by someone else while you were offline.',
            409,
            buildConflictPayload({
              serverTask,
              attempted: { status },
              baseUpdatedAt: base.value,
            })
          )
        }
      }
      return errorResponse(res, 'Task not found.', 404)
    }
    const task = await getTaskWithDetails(req.params.id)

    // Employee changing status -> every Admin/Manager needs to know.
    // Admin/Manager changing status -> the specific affected Employee (the assignee) does,
    // using the more specific "review requested" type when they're moving it to in_review.
    await notifySafely(async () => {
      if (req.user.role.toLowerCase() === 'employee') {
        if (status === 'in_review') {
          // An employee submitting for review is an approval request. It goes
          // to the same admin/manager audience as any other employee status
          // change — the recipient set is unchanged — but as REVIEW_REQUESTED
          // rather than TASK_STATUS_CHANGED, so it carries Approve/Reject and
          // is governed by the `review_requests` preference. Before this, no
          // notification anywhere reached a reviewer with approve intent.
          await notifyAdminsAndManagers(
            req.user.id,
            NOTIFICATION_TYPES.REVIEW_REQUESTED,
            'Review Requested',
            `${req.user.name} submitted "${task.title}" for review`,
            `/tasks/${task.id}`,
            'high',
            { actions: REVIEW_ACTIONS }
          )
        } else {
          await notifyAdminsAndManagers(
            req.user.id,
            NOTIFICATION_TYPES.TASK_STATUS_CHANGED,
            'Task Status Updated',
            `${req.user.name} changed "${task.title}" to ${status.replace('_', ' ')}`,
            `/tasks/${task.id}`,
            'low'
          )
        }
      } else if (task.assignee && task.assignee.id !== req.user.id) {
        if (status === 'in_review') {
          await dispatchNotification(
            task.assignee.id,
            NOTIFICATION_TYPES.REVIEW_REQUESTED,
            'Review Requested',
            `${req.user.name} requested a review on: ${task.title}`,
            `/tasks/${task.id}`,
            'high'
          )
        } else {
          await dispatchNotification(
            task.assignee.id,
            NOTIFICATION_TYPES.TASK_STATUS_CHANGED,
            'Task Status Updated',
            `${task.title} is now ${status.replace('_', ' ')}`,
            `/tasks/${task.id}`,
            'low'
          )
        }
      }

      await checkProjectMilestone(task.project?.id, req.user.id)
    })

    // A completed task drops out of the synced set, so its calendar event is
    // reaped by the next sweep; any other transition just needs a re-push.
    // Both are expressed the same way — mark dirty and let the sweep decide —
    // so this hook never has to duplicate the sync engine's scoping rules.
    await notifySafely(() => markSourceDirty('task', req.params.id))

    return successResponse(res, task, 'Status updated.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.deleteTask = async (req, res) => {
  try {

    // Only Admin and Manager can delete tasks
    if (req.user.role.toLowerCase() === 'employee') {
      return errorResponse(
        res,
        'You are not authorized to delete tasks.',
        403
      )
    }

    // AC-18: remove the calendar event BEFORE the row goes away. The link
    // table has no FK to tasks (a link's source may be a task, milestone or
    // meeting), so nothing would cascade — deleting the task first would strand
    // both the link row and, worse, the event itself on the user's calendar as
    // a phantom deadline for a task that no longer exists.
    await notifySafely(() => purgeSource('task', req.params.id))

    const result = await pool.query(
      'DELETE FROM tasks WHERE id=$1 RETURNING id',
      [req.params.id]
    )

    if (!result.rows[0]) {
      return errorResponse(res, 'Task not found.', 404)
    }

    return successResponse(res, null, 'Task deleted.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.addComment = async (req, res) => {
  try {
    const { content } = req.body
    if (!content) return errorResponse(res, 'Comment content is required.')
    await pool.query('INSERT INTO comments (content,task_id,author_id) VALUES ($1,$2,$3)', [content, req.params.id, req.user.id])
    const task = await getTaskWithDetails(req.params.id)

    // @mentions (matched against email local-part, scoped to the task's
    // project members) always get the more specific mention notification.
    // Employee commenting -> every Admin/Manager needs to know.
    // Admin/Manager commenting -> the specific affected Employee (the assignee) does
    // (skipped if they were already mentioned, to avoid a duplicate ping).
    await notifySafely(async () => {
      const mentionTokens = [...content.matchAll(/@([a-zA-Z0-9._-]+)/g)].map((m) => m[1].toLowerCase())
      const mentionedIds = new Set()

      if (mentionTokens.length && task.project?.id) {
        const members = await pool.query(
          `SELECT u.id, u.email FROM project_members pm
             JOIN users u ON u.id = pm.user_id
            WHERE pm.project_id = $1 AND u.status = 'active'`,
          [task.project.id]
        )
        for (const m of members.rows) {
          const localPart = String(m.email).split('@')[0].toLowerCase()
          if (mentionTokens.includes(localPart) && m.id !== req.user.id) {
            mentionedIds.add(m.id)
          }
        }
      }

      for (const userId of mentionedIds) {
        await dispatchNotification(
          userId,
          NOTIFICATION_TYPES.TASK_MENTION,
          'You were mentioned',
          `${req.user.name} mentioned you on: ${task.title}`,
          `/tasks/${task.id}`,
          'high'
        )
      }

      if (req.user.role.toLowerCase() === 'employee') {
        await notifyAdminsAndManagers(
          req.user.id,
          NOTIFICATION_TYPES.TASK_COMMENT,
          'New Comment',
          `${req.user.name} commented on: ${task.title}`,
          `/tasks/${task.id}`,
          'normal'
        )
      } else if (task.assignee && task.assignee.id !== req.user.id && !mentionedIds.has(task.assignee.id)) {
        await dispatchNotification(
          task.assignee.id,
          NOTIFICATION_TYPES.TASK_COMMENT,
          'New Comment',
          `${req.user.name} commented on: ${task.title}`,
          `/tasks/${task.id}`,
          'normal'
        )
      }
    })

    return successResponse(res, task, 'Comment added.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.deleteComment = async (req, res) => {
  try {
    await pool.query('DELETE FROM comments WHERE id=$1 AND author_id=$2', [req.params.commentId, req.user.id])
    return successResponse(res, null, 'Comment deleted.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

// ─── Internal helpers shared with notification-actions.controller ─────────────
// Additive only: every call site above uses the local const bindings, so these
// exports change nothing here. The dependency runs one way (notification-actions
// -> tasks), so there is no require cycle.
exports.checkProjectMilestone = checkProjectMilestone
exports.getTaskWithDetails = getTaskWithDetails
exports.REVIEW_ACTIONS = REVIEW_ACTIONS
exports.ASSIGN_ACTIONS = ASSIGN_ACTIONS