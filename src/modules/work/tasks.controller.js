// HTTP layer for tasks.

const { successResponse, errorResponse, paginatedResponse } = require('../../shared/response')
const repo = require('./repo')
const service = require('./tasks.service')
const notify = require('../notify')
const events = require('./events')
const { parseBaseUpdatedAt, buildConflictPayload } = require('./concurrency')

// work no longer imports integrations. It announces what happened; whoever
// mirrors tasks onto a calendar subscribes. See events.js.
const { TASK_CHANGED, TASK_DELETED } = events.EVENTS

const {
  isRestricted, getTaskWithDetails, notifySafely,
  notifyAdminsAndManagers, checkProjectMilestone, REVIEW_ACTIONS,
} = service

/* ── reads ───────────────────────────────────────────────────────────────── */

exports.getAllTasks = async (req, res) => {
  try {
    const { tasks, total, page, limit } = await service.list(req.user, req.query)
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
    return successResponse(res, await service.listByProject(req.params.id))
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.getTaskStats = async (req, res) => {
  try {
    return successResponse(res, await service.stats(req.user))
  } catch (err) {
    console.error('getTaskStats error:', err)
    return errorResponse(res, 'Failed to load task stats.', 500)
  }
}

exports.getPriorityBreakdown = async (req, res) => {
  try {
    return successResponse(res, await service.priorityBreakdown(req.user))
  } catch (err) {
    console.error('getPriorityBreakdown error:', err)
    return errorResponse(res, 'Failed to load priority breakdown.', 500)
  }
}

exports.getUpcomingTasks = async (req, res) => {
  try {
    return successResponse(res, await service.upcoming(req.user, req.query))
  } catch (err) {
    console.error('getUpcomingTasks error:', err)
    return errorResponse(res, 'Failed to load upcoming tasks.', 500)
  }
}

/* ── create ──────────────────────────────────────────────────────────────── */

exports.createTask = async (req, res) => {
  try {
    // Only Admin and Manager can create tasks.
    if (isRestricted(req.user)) {
      return errorResponse(res, 'You are not authorized to create tasks.', 403)
    }

    const {
      title, description, userStory, acceptanceCriteria, status, priority, type,
      projectId, assigneeId, dueDate, estimatedHours, tags,
    } = req.body

    if (!title) return errorResponse(res, 'Task title is required.')
    if (!projectId) return errorResponse(res, 'Project is required.')

    const finalStatus = status || 'todo'
    // Computed in JS and bound as its own parameter so the status placeholder
    // is used in a single context, avoiding the "inconsistent types deduced for
    // parameter" enum inference error.
    const completedAt = finalStatus === 'completed' ? new Date() : null

    const taskId = await repo.insertTask({
      title,
      description,
      userStory: userStory || null,
      acceptanceCriteria: acceptanceCriteria || null,
      status: finalStatus,
      priority: priority || 'medium',
      type: type || 'feature',
      projectId,
      assigneeId: assigneeId || null,
      reporterId: req.user.id,
      dueDate: dueDate || null,
      estimatedHours: estimatedHours || null,
      tags: tags || [],
      completedAt,
    })

    await service.notifyTaskCreated(req.user, {
      taskId, title, assigneeId, finalStatus, type, priority, projectId,
    })

    return successResponse(res, await getTaskWithDetails(taskId), 'Task created successfully.', 201)
  } catch (err) { return errorResponse(res, err.message, 500) }
}

/* ── update ──────────────────────────────────────────────────────────────── */

exports.updateTask = async (req, res) => {
  try {
    const currentUser = req.user
    const {
      title, description, userStory, acceptanceCriteria, status, priority, type,
      assigneeId, dueDate, estimatedHours, actualHours, tags,
    } = req.body

    // Employee can only update status — and only on a task assigned to them.
    // Mirrors the ownership rule in updateTaskStatus; without it this route is
    // an alternate way to restatus any task in the system.
    if (isRestricted(currentUser)) {
      const owner = await repo.findTaskOwner(req.params.id)
      if (!owner) return errorResponse(res, 'Task not found.', 404)
      if (owner.assignee_id !== currentUser.id) {
        return errorResponse(res, 'You are not authorized to update this task.', 403)
      }

      const updated = await repo.updateTaskStatusOnly(req.params.id, status || null)
      if (!updated) return errorResponse(res, 'Task not found.', 404)

      const task = await getTaskWithDetails(req.params.id)

      // Employee changed their task's status — every Admin/Manager needs to know.
      await notifySafely(async () => {
        await notifyAdminsAndManagers(
          currentUser.id,
          notify.TYPES.TASK_STATUS_CHANGED,
          'Task Status Updated',
          `${currentUser.name} changed "${task.title}" to ${(status || task.status).replace('_', ' ')}`,
          `/tasks/${task.id}`,
          'low'
        )
        await checkProjectMilestone(task.project?.id, currentUser.id)
      })

      return successResponse(res, task, 'Task updated.')
    }

    // Sanitize nullable fields — Postgres cannot parse "" as DATE, UUID or NUMERIC.
    const safeDueDate = dueDate && dueDate.trim() !== '' ? dueDate : null
    const safeAssigneeId = assigneeId && assigneeId.trim() !== '' ? assigneeId : null
    const safeEstimatedHours = estimatedHours !== undefined && estimatedHours !== '' ? estimatedHours : null
    const safeActualHours = actualHours !== undefined && actualHours !== '' ? actualHours : null
    const safeUserStory = userStory && userStory.trim() !== '' ? userStory : null
    const safeAcceptance = acceptanceCriteria && acceptanceCriteria.trim() !== '' ? acceptanceCriteria : null

    // Snapshot pre-update state so reassignment/due-date/priority changes can be
    // told apart from a plain edit and routed to their specific notification
    // type, instead of one generic "Task Updated" for everything.
    const before = await repo.findTaskSnapshot(req.params.id)

    // Optimistic concurrency. Opt-in; omitted means unguarded, preserving every
    // existing caller.
    const base = parseBaseUpdatedAt(req.body.baseUpdatedAt)
    if (!base.ok) return errorResponse(res, base.message, 400)

    const updated = await repo.updateTaskFields(
      req.params.id,
      {
        title: title || null,
        description: description || null,
        userStory: safeUserStory,
        acceptanceCriteria: safeAcceptance,
        status: status || null,
        priority: priority || null,
        type: type || null,
        assigneeId: safeAssigneeId,
        dueDate: safeDueDate,
        estimatedHours: safeEstimatedHours,
        actualHours: safeActualHours,
        tags: tags || null,
      },
      base.value
    )

    if (!updated) {
      // Guarded and matched nothing: distinguish a lost race from a bad id.
      if (base.value) {
        const verdict = await repo.classifyFailedUpdate(req.params.id)
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

    // Notify the assignee with the most specific type that applies.
    // Reassignment takes priority (the notification is about the NEW assignee
    // getting the task, not a status update on it); otherwise due-date/priority
    // changes get their own type; only a plain field edit falls back to generic.
    await notifySafely(async () => {
      if (!task.assignee || task.assignee.id === currentUser.id) return

      const reassigned = Boolean(safeAssigneeId) && before && before.assignee_id !== safeAssigneeId
      if (reassigned) {
        await notify.dispatch({
          userId: task.assignee.id,
          type: notify.TYPES.TASK_REASSIGNED,
          title: 'Task Reassigned',
          message: `You've been assigned: ${task.title}`,
          linkTo: `/tasks/${task.id}`,
          priority: 'high',
        })
        return
      }

      const beforeDueDate = before && before.due_date
        ? new Date(before.due_date).toISOString().slice(0, 10)
        : null
      const dueDateChanged = Boolean(safeDueDate) && beforeDueDate !== safeDueDate
      const priorityChanged = Boolean(priority) && before && before.priority !== priority

      if (dueDateChanged) {
        await notify.dispatch({
          userId: task.assignee.id,
          type: notify.TYPES.DUE_DATE_CHANGED,
          title: 'Due Date Changed',
          message: `The due date for "${task.title}" changed to ${safeDueDate}.`,
          linkTo: `/tasks/${task.id}`,
        })
      }

      if (priorityChanged) {
        await notify.dispatch({
          userId: task.assignee.id,
          type: notify.TYPES.PRIORITY_CHANGED,
          title: 'Priority Changed',
          message: `"${task.title}" priority changed to ${priority}.`,
          linkTo: `/tasks/${task.id}`,
          priority: priority === 'critical' ? 'high' : 'normal',
        })
      }

      if (!dueDateChanged && !priorityChanged) {
        await notify.dispatch({
          userId: task.assignee.id,
          type: notify.TYPES.TASK_UPDATED,
          title: 'Task Updated',
          message: `Task updated: ${task.title}`,
          linkTo: `/tasks/${task.id}`,
        })
      }
    })

    // A synced task whose fields changed must reach the calendar within five
    // minutes. work does not know that — it says the task changed, and the
    // subscriber decides what that means. Awaited and self-guarding, so a
    // failing subscriber can never fail the request.
    await events.emit(TASK_CHANGED, { taskId: req.params.id, status: task?.status, actorId: req.user.id })

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

    // Admin/Manager may move any task; an Employee may only move a task
    // assigned to them. This is the board's drag-and-drop endpoint, so without
    // the check any signed-in user could restatus any task.
    const existing = await repo.findTaskOwner(req.params.id)
    if (!existing) return errorResponse(res, 'Task not found.', 404)

    if (isRestricted(req.user) && existing.assignee_id !== req.user.id) {
      return errorResponse(res, 'You are not authorized to update this task.', 403)
    }

    const completedAt = status === 'completed' ? new Date() : null

    const base = parseBaseUpdatedAt(req.body.baseUpdatedAt)
    if (!base.ok) return errorResponse(res, base.message, 400)

    const updated = await repo.updateTaskStatusGuarded(
      req.params.id, status, completedAt, base.value
    )

    if (!updated) {
      // Zero rows is ambiguous when guarded — missing id, or lost race?
      if (base.value) {
        const verdict = await repo.classifyFailedUpdate(req.params.id)
        if (verdict.kind === 'conflict') {
          const serverTask = await getTaskWithDetails(req.params.id)
          return errorResponse(
            res,
            'This task was changed by someone else while you were offline.',
            409,
            buildConflictPayload({ serverTask, attempted: { status }, baseUpdatedAt: base.value })
          )
        }
      }
      return errorResponse(res, 'Task not found.', 404)
    }

    const task = await getTaskWithDetails(req.params.id)

    // Employee changing status -> every Admin/Manager needs to know.
    // Admin/Manager changing status -> the affected Employee does, using the
    // more specific "review requested" type when moving it to in_review.
    await notifySafely(async () => {
      if (isRestricted(req.user)) {
        if (status === 'in_review') {
          // An employee submitting for review is an approval request. Same
          // recipient set as any other employee status change, but as
          // REVIEW_REQUESTED so it carries Approve/Reject and is governed by
          // the `review_requests` preference.
          await notifyAdminsAndManagers(
            req.user.id,
            notify.TYPES.REVIEW_REQUESTED,
            'Review Requested',
            `${req.user.name} submitted "${task.title}" for review`,
            `/tasks/${task.id}`,
            'high',
            { actions: REVIEW_ACTIONS }
          )
        } else {
          await notifyAdminsAndManagers(
            req.user.id,
            notify.TYPES.TASK_STATUS_CHANGED,
            'Task Status Updated',
            `${req.user.name} changed "${task.title}" to ${status.replace('_', ' ')}`,
            `/tasks/${task.id}`,
            'low'
          )
        }
      } else if (task.assignee && task.assignee.id !== req.user.id) {
        if (status === 'in_review') {
          await notify.dispatch({
            userId: task.assignee.id,
            type: notify.TYPES.REVIEW_REQUESTED,
            title: 'Review Requested',
            message: `${req.user.name} requested a review on: ${task.title}`,
            linkTo: `/tasks/${task.id}`,
            priority: 'high',
          })
        } else {
          await notify.dispatch({
            userId: task.assignee.id,
            type: notify.TYPES.TASK_STATUS_CHANGED,
            title: 'Task Status Updated',
            message: `${task.title} is now ${status.replace('_', ' ')}`,
            linkTo: `/tasks/${task.id}`,
            priority: 'low',
          })
        }
      }

      await checkProjectMilestone(task.project?.id, req.user.id)
    })

    // A completed task drops out of the synced set and its calendar event is
    // reaped; any other transition just needs a re-push. Both are the same
    // announcement — the task changed — so this never duplicates the sync
    // engine's scoping rules.
    await events.emit(TASK_CHANGED, { taskId: req.params.id, status, actorId: req.user.id })

    return successResponse(res, task, 'Status updated.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.deleteTask = async (req, res) => {
  try {
    // Only Admin and Manager can delete tasks.
    if (isRestricted(req.user)) {
      return errorResponse(res, 'You are not authorized to delete tasks.', 403)
    }

    // Announced BEFORE the row goes away, and awaited. calendar_event_links has
    // no FK to tasks (a link's source may be a task, milestone or meeting), so
    // nothing cascades — deleting first would strand the link row and leave the
    // event on the user's calendar as a phantom deadline. See events.js for why
    // that ordering is the one thing the inversion must not change.
    await events.emit(TASK_DELETED, { taskId: req.params.id })

    const deleted = await repo.deleteTask(req.params.id)
    if (!deleted) return errorResponse(res, 'Task not found.', 404)

    return successResponse(res, null, 'Task deleted.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

/* ── comments ────────────────────────────────────────────────────────────── */

exports.addComment = async (req, res) => {
  try {
    const { content } = req.body
    if (!content) return errorResponse(res, 'Comment content is required.')

    await repo.insertComment(content, req.params.id, req.user.id)
    const task = await getTaskWithDetails(req.params.id)

    // @mentions always get the more specific mention notification.
    // Employee commenting -> every Admin/Manager needs to know.
    // Admin/Manager commenting -> the affected Employee does, skipped if they
    // were already mentioned so they do not get a duplicate ping.
    await notifySafely(async () => {
      const mentionedIds = await service.resolveMentions(content, task.project?.id, req.user.id)

      for (const userId of mentionedIds) {
        await notify.dispatch({
          userId,
          type: notify.TYPES.TASK_MENTION,
          title: 'You were mentioned',
          message: `${req.user.name} mentioned you on: ${task.title}`,
          linkTo: `/tasks/${task.id}`,
          priority: 'high',
        })
      }

      if (isRestricted(req.user)) {
        await notifyAdminsAndManagers(
          req.user.id,
          notify.TYPES.TASK_COMMENT,
          'New Comment',
          `${req.user.name} commented on: ${task.title}`,
          `/tasks/${task.id}`,
          'normal'
        )
      } else if (
        task.assignee &&
        task.assignee.id !== req.user.id &&
        !mentionedIds.has(task.assignee.id)
      ) {
        await notify.dispatch({
          userId: task.assignee.id,
          type: notify.TYPES.TASK_COMMENT,
          title: 'New Comment',
          message: `${req.user.name} commented on: ${task.title}`,
          linkTo: `/tasks/${task.id}`,
        })
      }
    })

    return successResponse(res, task, 'Comment added.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.deleteComment = async (req, res) => {
  try {
    await repo.deleteComment(req.params.commentId, req.user.id)
    return successResponse(res, null, 'Comment deleted.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}
