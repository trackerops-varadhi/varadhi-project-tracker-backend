/**
 * Bugs Finder — controller.
 * ---------------------------------------------------------------------------
 * Thin by design: validate the request, delegate to services/bugs.service.js,
 * shape the response through utils/response.js. Business logic (SLA maths,
 * workflow rules, notification fan-out) lives in the service and the two
 * utils modules, per §21 of the spec.
 *
 * Every handler catches its own errors and returns through errorResponse
 * rather than throwing to error.middleware.js — the convention every other
 * controller in this codebase follows.
 */

const crypto = require('crypto')

const pool = require('../config/db')
const supabase = require('../config/supabase')
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response')
const { dispatchNotification, dispatchToMany, NOTIFICATION_TYPES } =
  require('../utils/notification-engine')
const service = require('../services/bugs.service')
const {
  SEVERITIES,
  PRIORITIES,
  ENVIRONMENTS,
  getSlaRules,
  slaDeadlines,
} = require('../utils/bug-sla')
const {
  BUG_STATUSES,
  STATUS_LABELS,
  EMPLOYEE_ALLOWED_STATUSES,
  BUG_ACTIONS,
  canTransition,
  logBugActivity,
} = require('../utils/bug-workflow')

const { notifySafely, isEmployee, isManagerOrAdmin } = service

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

const MAX_TITLE = 500

// Trim, then treat an all-whitespace string as absent. Used everywhere a
// nullable text/uuid field arrives from a form, because Postgres rejects '' for
// a uuid column — the same trap tasks.controller.js documents.
const clean = (value) => {
  if (value === undefined || value === null) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (value) => UUID_RE.test(String(value || ''))

/**
 * Validate the fields shared by create and update. Returns an array of
 * messages; empty means valid.
 */
function validateEnums({ severity, priority, environment, status }) {
  const errors = []
  if (severity && !SEVERITIES.includes(severity)) {
    errors.push(`Severity must be one of: ${SEVERITIES.join(', ')}.`)
  }
  if (priority && !PRIORITIES.includes(priority)) {
    errors.push(`Priority must be one of: ${PRIORITIES.join(', ')}.`)
  }
  if (environment && !ENVIRONMENTS.includes(environment)) {
    errors.push(`Environment must be one of: ${ENVIRONMENTS.join(', ')}.`)
  }
  if (status && !BUG_STATUSES.includes(status)) {
    errors.push(`Status must be one of: ${BUG_STATUSES.join(', ')}.`)
  }
  return errors
}

/** Confirm a referenced row exists, so an FK violation never surfaces as a 500. */
async function assertExists(table, id, label) {
  if (!id) return true
  if (!isUuid(id)) {
    const err = new Error(`${label} is not a valid id.`)
    err.status = 400
    throw err
  }
  const { rows } = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [id])
  if (!rows[0]) {
    const err = new Error(`${label} not found.`)
    err.status = 400
    throw err
  }
  return true
}

/**
 * Load a bug and apply read authorization in one step. Throws a status-tagged
 * error the caller's catch turns into the right response code.
 */
async function loadViewableBug(req) {
  if (!isUuid(req.params.id)) {
    const err = new Error('Bug not found.')
    err.status = 404
    throw err
  }
  const bug = await service.getBugById(req.params.id)
  if (!bug) {
    const err = new Error('Bug not found.')
    err.status = 404
    throw err
  }
  if (!service.canView(req.user, bug)) {
    const err = new Error('You do not have permission to view this bug.')
    err.status = 403
    throw err
  }
  return bug
}

/* -------------------------------------------------------------------------- */
/* List / read                                                                */
/* -------------------------------------------------------------------------- */

exports.getAllBugs = async (req, res) => {
  try {
    const { bugs, total, page, limit } = await service.listBugs(req.user, req.query)
    return paginatedResponse(res, bugs, total, page, limit)
  } catch (err) {
    console.error('getAllBugs error:', err)
    return errorResponse(res, 'Failed to load bugs.', err.status || 500)
  }
}

exports.getBugById = async (req, res) => {
  try {
    const bug = await loadViewableBug(req)
    return successResponse(res, bug)
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500)
  }
}

// Bugs for one project — powers the project detail page's Bugs tab (§15).
exports.getBugsByProject = async (req, res) => {
  try {
    const { bugs, total, page, limit } = await service.listBugs(req.user, {
      ...req.query,
      projectId: req.params.id,
    })
    return paginatedResponse(res, bugs, total, page, limit)
  } catch (err) {
    console.error('getBugsByProject error:', err)
    return errorResponse(res, 'Failed to load project bugs.', 500)
  }
}

exports.getReports = async (req, res) => {
  try {
    const data = await service.getReportMetrics({
      projectId: clean(req.query.projectId),
      dateFrom: clean(req.query.dateFrom),
      dateTo: clean(req.query.dateTo),
    })
    return successResponse(res, data)
  } catch (err) {
    console.error('getBugReports error:', err)
    return errorResponse(res, 'Failed to load bug reports.', 500)
  }
}

exports.getActivity = async (req, res) => {
  try {
    // Reuses the same authorization as the detail view — the timeline must not
    // be a side door onto a bug the user cannot open.
    await loadViewableBug(req)
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100))
    const { rows } = await pool.query(
      `SELECT l.id, l.action, l.field, l.old_value, l.new_value, l.detail, l.created_at,
              l.actor_id, u.name AS actor_name, u.avatar AS actor_avatar
         FROM bug_activity_logs l
         LEFT JOIN users u ON l.actor_id = u.id
        WHERE l.bug_id = $1
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $2`,
      [req.params.id, limit]
    )
    return successResponse(
      res,
      rows.map((l) => ({
        id: l.id,
        action: l.action,
        field: l.field,
        oldValue: l.old_value,
        newValue: l.new_value,
        detail: l.detail,
        createdAt: l.created_at,
        actor: l.actor_id ? { id: l.actor_id, name: l.actor_name, avatar: l.actor_avatar } : null,
      }))
    )
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500)
  }
}

/* -------------------------------------------------------------------------- */
/* Create / update / delete                                                   */
/* -------------------------------------------------------------------------- */

exports.createBug = async (req, res) => {
  try {
    const title = clean(req.body.title)
    const description = clean(req.body.description)
    const projectId = clean(req.body.projectId)
    const assigneeId = clean(req.body.assigneeId)
    const linkedTaskId = clean(req.body.linkedTaskId)
    const severity = clean(req.body.severity) || 'medium'
    const priority = clean(req.body.priority) || 'p2'
    const environment = clean(req.body.environment) || 'production'

    // Reporting is gated to admin/manager on the route (restrictTo), matching
    // how projects and tasks are created in this app — an employee has no
    // create-or-assign access anywhere in the tracker.
    if (!title) return errorResponse(res, 'Bug title is required.')
    if (title.length > MAX_TITLE) {
      return errorResponse(res, `Bug title must be ${MAX_TITLE} characters or fewer.`)
    }
    if (!description) return errorResponse(res, 'Description is required.')
    if (!projectId) return errorResponse(res, 'Project is required.')

    const enumErrors = validateEnums({ severity, priority, environment })
    if (enumErrors.length) return errorResponse(res, enumErrors.join(' '))

    // Defence in depth. The route already refuses employees, so this can only
    // fire if that guard is ever removed — assignment must never become
    // reachable by an employee through the create path.
    if (assigneeId && isEmployee(req.user)) {
      return errorResponse(res, 'You are not authorized to assign bugs.', 403)
    }

    await assertExists('projects', projectId, 'Project')
    await assertExists('users', assigneeId, 'Assignee')
    await assertExists('tasks', linkedTaskId, 'Linked task')

    const bug = await service.createBug(req.user, {
      title,
      description,
      stepsToReproduce: clean(req.body.stepsToReproduce),
      projectId,
      assigneeId,
      linkedTaskId,
      severity,
      priority,
      environment,
    })

    return successResponse(res, bug, 'Bug reported successfully.', 201)
  } catch (err) {
    console.error('createBug error:', err)
    return errorResponse(res, err.message || 'Failed to report the bug.', err.status || 500)
  }
}

// Fields an assigned developer (employee role) may change on their own bug.
// They document the fix; they do not re-triage severity/priority or move the
// bug between projects.
const EMPLOYEE_EDITABLE_FIELDS = new Set(['resolution', 'rootCause', 'stepsToReproduce'])

exports.updateBug = async (req, res) => {
  try {
    const bug = await loadViewableBug(req)

    if (!service.canEdit(req.user, bug)) {
      return errorResponse(res, 'You are not authorized to edit this bug.', 403)
    }

    // Which fields is this request actually trying to change?
    const candidates = {
      title: clean(req.body.title),
      description: clean(req.body.description),
      stepsToReproduce: clean(req.body.stepsToReproduce),
      severity: clean(req.body.severity),
      priority: clean(req.body.priority),
      environment: clean(req.body.environment),
      projectId: clean(req.body.projectId),
      resolution: clean(req.body.resolution),
      rootCause: clean(req.body.rootCause),
      linkedTaskId: req.body.linkedTaskId === null ? null : clean(req.body.linkedTaskId),
    }
    const provided = Object.keys(candidates).filter((k) => req.body[k] !== undefined)

    if (!provided.length) return errorResponse(res, 'No changes supplied.')

    // An employee editing a bug is limited to the fix-documentation fields,
    // even on a bug they reported — re-triaging severity is a manager call.
    if (isEmployee(req.user)) {
      const forbidden = provided.filter((f) => !EMPLOYEE_EDITABLE_FIELDS.has(f))
      if (forbidden.length) {
        return errorResponse(
          res,
          `You are not authorized to change: ${forbidden.join(', ')}.`,
          403
        )
      }
    }

    const enumErrors = validateEnums({
      severity: candidates.severity,
      priority: candidates.priority,
      environment: candidates.environment,
    })
    if (enumErrors.length) return errorResponse(res, enumErrors.join(' '))

    if (provided.includes('projectId')) await assertExists('projects', candidates.projectId, 'Project')
    if (provided.includes('linkedTaskId') && candidates.linkedTaskId) {
      await assertExists('tasks', candidates.linkedTaskId, 'Linked task')
    }
    if (provided.includes('title') && !candidates.title) {
      return errorResponse(res, 'Bug title cannot be empty.')
    }
    if (provided.includes('description') && !candidates.description) {
      return errorResponse(res, 'Description cannot be empty.')
    }

    // Column mapping for the fields that may be set.
    const COLUMN = {
      title: 'title',
      description: 'description',
      stepsToReproduce: 'steps_to_reproduce',
      severity: 'severity',
      priority: 'priority',
      environment: 'environment',
      projectId: 'project_id',
      resolution: 'resolution',
      rootCause: 'root_cause',
      linkedTaskId: 'linked_task_id',
    }

    const sets = []
    const params = []
    for (const field of provided) {
      params.push(candidates[field])
      sets.push(`${COLUMN[field]} = $${params.length}`)
    }

    // A severity change re-derives the SLA deadlines from the NEW rule, keeping
    // the original start time — re-triaging a bug up to Critical must tighten
    // its deadline, not hand it a fresh full window.
    const severityChanged = provided.includes('severity') && candidates.severity !== bug.severity
    if (severityChanged) {
      const { rule, responseDueAt, resolutionDueAt } = await slaDeadlines(
        candidates.severity,
        new Date(bug.sla.startedAt || bug.createdAt)
      )
      params.push(rule.id); sets.push(`sla_rule_id = $${params.length}`)
      params.push(responseDueAt); sets.push(`sla_response_due_at = $${params.length}`)
      params.push(resolutionDueAt); sets.push(`sla_resolution_due_at = $${params.length}`)
      // Re-evaluate the latch against the new deadline rather than leaving a
      // stale breach on a bug whose window just widened.
      sets.push(`sla_breached = (NOW() > $${params.length} AND resolved_at IS NULL)`)
    }

    sets.push('updated_at = NOW()')
    params.push(bug.id)

    await pool.query(`UPDATE bugs SET ${sets.join(', ')} WHERE id = $${params.length}`, params)

    // ─── Activity ───────────────────────────────────────────────────────────
    // Severity and priority get their own named actions (§25); everything else
    // is a generic field update carrying its before/after.
    for (const field of provided) {
      const before = field === 'projectId' ? bug.project?.id : field === 'linkedTaskId' ? bug.linkedTask?.id : bug[field]
      if (String(before ?? '') === String(candidates[field] ?? '')) continue

      const action =
        field === 'severity'
          ? BUG_ACTIONS.SEVERITY_CHANGED
          : field === 'priority'
          ? BUG_ACTIONS.PRIORITY_CHANGED
          : field === 'linkedTaskId'
          ? candidates[field]
            ? BUG_ACTIONS.TASK_LINKED
            : BUG_ACTIONS.TASK_UNLINKED
          : BUG_ACTIONS.UPDATED

      await logBugActivity({
        bugId: bug.id,
        actorId: req.user.id,
        action,
        field,
        oldValue: before,
        newValue: candidates[field],
      })
    }

    const updated = await service.getBugById(bug.id)

    // Notify the developer when the terms of their work change.
    await notifySafely(async () => {
      if (!updated.assignee?.id || updated.assignee.id === req.user.id) return
      const changedSeverity = severityChanged
      const changedPriority = provided.includes('priority') && candidates.priority !== bug.priority
      if (!changedSeverity && !changedPriority) return

      await dispatchNotification(
        updated.assignee.id,
        NOTIFICATION_TYPES.BUG_STATUS_CHANGED,
        changedSeverity ? 'Bug severity changed' : 'Bug priority changed',
        `${updated.key} is now ${changedSeverity ? updated.severity + ' severity' : updated.priority.toUpperCase()}`,
        `/bugs/${bug.id}`,
        updated.severity === 'critical' ? 'high' : 'normal'
      )
    })

    return successResponse(res, updated, 'Bug updated.')
  } catch (err) {
    console.error('updateBug error:', err)
    return errorResponse(res, err.message || 'Failed to update the bug.', err.status || 500)
  }
}

exports.deleteBug = async (req, res) => {
  try {
    // Deletion is destructive and unrecoverable — admin only. A manager who
    // wants a bug off the board marks it rejected or won't-fix, which keeps the
    // record and its audit trail.
    if (String(req.user.role).toLowerCase() !== 'admin') {
      return errorResponse(res, 'Only an administrator can delete a bug.', 403)
    }

    const { rows } = await pool.query('SELECT id, bug_number FROM bugs WHERE id = $1', [
      req.params.id,
    ])
    if (!rows[0]) return errorResponse(res, 'Bug not found.', 404)

    // Storage objects first: the attachment rows cascade away with the bug, so
    // reading their paths afterwards would be impossible and the files would be
    // orphaned in the bucket forever.
    await removeBugAttachmentObjects(req.params.id)

    // bug_comments, bug_attachments and bug_activity_logs all cascade.
    await pool.query('DELETE FROM bugs WHERE id = $1', [req.params.id])

    return successResponse(res, { id: req.params.id }, 'Bug deleted.')
  } catch (err) {
    console.error('deleteBug error:', err)
    return errorResponse(res, 'Failed to delete the bug.', 500)
  }
}

/* -------------------------------------------------------------------------- */
/* Workflow                                                                   */
/* -------------------------------------------------------------------------- */

exports.updateStatus = async (req, res) => {
  try {
    const bug = await loadViewableBug(req)
    const nextStatus = clean(req.body.status)

    if (!nextStatus) return errorResponse(res, 'Status is required.')
    if (!BUG_STATUSES.includes(nextStatus)) {
      return errorResponse(res, `Invalid status "${nextStatus}".`)
    }

    // Same status is a no-op rather than an error, so a duplicate submit (§27)
    // is idempotent instead of a spurious 400.
    if (nextStatus === bug.status) {
      return successResponse(res, bug, 'Status unchanged.')
    }

    const transition = canTransition(bug.status, nextStatus)
    if (!transition.ok) return errorResponse(res, transition.message, 400)

    // Role rules (§18). An employee drives the development side of the flow on
    // a bug assigned to them; closing, rejecting and reopening are triage and
    // verification decisions reserved for admin/manager.
    if (isEmployee(req.user)) {
      if (bug.assignee?.id !== req.user.id) {
        return errorResponse(res, 'You can only update bugs assigned to you.', 403)
      }
      if (!EMPLOYEE_ALLOWED_STATUSES.has(nextStatus)) {
        return errorResponse(
          res,
          `You are not authorized to set a bug to "${STATUS_LABELS[nextStatus]}".`,
          403
        )
      }
    }

    // A duplicate must say what it duplicates, otherwise the status carries no
    // information and the link column stays empty.
    const duplicateOfId = clean(req.body.duplicateOfId)
    if (nextStatus === 'duplicate') {
      if (!duplicateOfId) {
        return errorResponse(res, 'Select the bug this duplicates.')
      }
      if (duplicateOfId === bug.id) {
        return errorResponse(res, 'A bug cannot be a duplicate of itself.')
      }
      await assertExists('bugs', duplicateOfId, 'Duplicate target')
    }

    const updated = await service.applyStatusChange(req.user, bug, nextStatus, {
      resolution: clean(req.body.resolution),
      rootCause: clean(req.body.rootCause),
      duplicateOfId: nextStatus === 'duplicate' ? duplicateOfId : undefined,
    })

    return successResponse(res, updated, `Bug moved to ${STATUS_LABELS[nextStatus]}.`)
  } catch (err) {
    console.error('updateBugStatus error:', err)
    return errorResponse(res, err.message || 'Failed to update the status.', err.status || 500)
  }
}

exports.assignBug = async (req, res) => {
  try {
    // Assignment is a triage decision — admin/manager only, matching §18.
    if (isEmployee(req.user)) {
      return errorResponse(res, 'You are not authorized to assign bugs.', 403)
    }

    const bug = await loadViewableBug(req)
    // An explicit null unassigns; an absent key is a malformed request.
    const assigneeId = req.body.assigneeId === null ? null : clean(req.body.assigneeId)

    if (req.body.assigneeId === undefined) {
      return errorResponse(res, 'assigneeId is required (send null to unassign).')
    }

    if (assigneeId) {
      const { rows } = await pool.query(
        `SELECT id, status FROM users WHERE id = $1`,
        [isUuid(assigneeId) ? assigneeId : null]
      )
      if (!rows[0]) return errorResponse(res, 'Developer not found.', 400)
      // Assigning work to a deactivated account silently strands the bug.
      if (rows[0].status === 'inactive') {
        return errorResponse(res, 'That user is deactivated and cannot be assigned bugs.', 400)
      }
    }

    if ((bug.assignee?.id || null) === assigneeId) {
      return successResponse(res, bug, 'Assignee unchanged.')
    }

    const updated = await service.assignBug(req.user, bug, assigneeId)
    return successResponse(res, updated, assigneeId ? 'Bug assigned.' : 'Bug unassigned.')
  } catch (err) {
    console.error('assignBug error:', err)
    return errorResponse(res, err.message || 'Failed to assign the bug.', err.status || 500)
  }
}

/* -------------------------------------------------------------------------- */
/* Task integration (§16)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create a development task FROM a bug and link the two. Not a duplicate of
 * the bug: the task is the unit of scheduled work, the bug stays the defect
 * record, and the link is what keeps them associated.
 */
exports.createTaskFromBug = async (req, res) => {
  try {
    if (isEmployee(req.user)) {
      return errorResponse(res, 'You are not authorized to create tasks.', 403)
    }

    const bug = await loadViewableBug(req)

    if (bug.linkedTask) {
      return errorResponse(res, 'This bug is already linked to a task.', 409)
    }
    if (!bug.project?.id) {
      return errorResponse(res, 'A bug must belong to a project before a task can be created from it.')
    }

    // Bug priority (p0..p3) maps onto the tasks table's own scale — they are
    // separate vocabularies and the task CHECK constraint only accepts its own.
    const TASK_PRIORITY = { p0: 'critical', p1: 'high', p2: 'medium', p3: 'low' }

    const inserted = await pool.query(
      `INSERT INTO tasks (title, description, status, priority, type,
                          project_id, assignee_id, reporter_id, due_date)
            VALUES ($1,$2,'todo',$3,'bug',$4,$5,$6,$7)
         RETURNING id`,
      [
        clean(req.body.title) || `${bug.key}: ${bug.title}`,
        clean(req.body.description) ||
          `Fix for ${bug.key}.\n\n${bug.description}`,
        TASK_PRIORITY[bug.priority] || 'medium',
        bug.project.id,
        clean(req.body.assigneeId) || bug.assignee?.id || null,
        req.user.id,
        // Align the task's due date with the bug's resolution SLA so the two
        // deadlines cannot drift apart.
        bug.sla.dueAt ? new Date(bug.sla.dueAt).toISOString().slice(0, 10) : null,
      ]
    )

    const taskId = inserted.rows[0].id
    await pool.query('UPDATE bugs SET linked_task_id = $1, updated_at = NOW() WHERE id = $2', [
      taskId,
      bug.id,
    ])

    await logBugActivity({
      bugId: bug.id,
      actorId: req.user.id,
      action: BUG_ACTIONS.TASK_CREATED,
      field: 'linkedTask',
      newValue: taskId,
    })

    const updated = await service.getBugById(bug.id)

    await notifySafely(async () => {
      const assigneeId = updated.linkedTask ? clean(req.body.assigneeId) || bug.assignee?.id : null
      if (!assigneeId || assigneeId === req.user.id) return
      await dispatchNotification(
        assigneeId,
        NOTIFICATION_TYPES.TASK_ASSIGNED,
        'New Task Assigned',
        `Development task created from ${bug.key}: ${updated.linkedTask.title}`,
        `/tasks/${taskId}`,
        'high'
      )
    })

    return successResponse(res, updated, 'Development task created and linked.', 201)
  } catch (err) {
    console.error('createTaskFromBug error:', err)
    return errorResponse(res, err.message || 'Failed to create the task.', err.status || 500)
  }
}

/* -------------------------------------------------------------------------- */
/* Comments (§13)                                                             */
/* -------------------------------------------------------------------------- */

exports.getComments = async (req, res) => {
  try {
    await loadViewableBug(req)
    const { rows } = await pool.query(
      `SELECT c.id, c.content, c.edited, c.created_at, c.updated_at,
              c.author_id, u.name AS author_name, u.avatar AS author_avatar
         FROM bug_comments c
         LEFT JOIN users u ON c.author_id = u.id
        WHERE c.bug_id = $1
        ORDER BY c.created_at ASC`,
      [req.params.id]
    )
    return successResponse(
      res,
      rows.map((c) => ({
        id: c.id,
        content: c.content,
        edited: c.edited,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        author: c.author_id
          ? { id: c.author_id, name: c.author_name, avatar: c.author_avatar }
          : null,
      }))
    )
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500)
  }
}

const MAX_COMMENT = 5000

exports.addComment = async (req, res) => {
  try {
    const bug = await loadViewableBug(req)
    const content = clean(req.body.content)

    if (!content) return errorResponse(res, 'Comment cannot be empty.')
    if (content.length > MAX_COMMENT) {
      return errorResponse(res, `Comment must be ${MAX_COMMENT} characters or fewer.`)
    }

    const { rows } = await pool.query(
      `INSERT INTO bug_comments (bug_id, author_id, content)
            VALUES ($1, $2, $3)
         RETURNING id, content, created_at, updated_at, edited`,
      [bug.id, req.user.id, content]
    )

    await logBugActivity({
      bugId: bug.id,
      actorId: req.user.id,
      action: BUG_ACTIONS.COMMENT_ADDED,
      detail: { commentId: rows[0].id },
    })

    await notifySafely(async () => {
      const recipients = new Set()
      if (bug.assignee?.id) recipients.add(bug.assignee.id)
      if (bug.reporter?.id) recipients.add(bug.reporter.id)
      await dispatchToMany(
        [...recipients],
        NOTIFICATION_TYPES.BUG_COMMENT,
        'New comment on a bug',
        `${req.user.name} commented on ${bug.key}: ${bug.title}`,
        `/bugs/${bug.id}`,
        'normal',
        { excludeUserId: req.user.id }
      )
    })

    return successResponse(
      res,
      {
        id: rows[0].id,
        content: rows[0].content,
        edited: rows[0].edited,
        createdAt: rows[0].created_at,
        updatedAt: rows[0].updated_at,
        author: { id: req.user.id, name: req.user.name },
      },
      'Comment added.',
      201
    )
  } catch (err) {
    console.error('addBugComment error:', err)
    return errorResponse(res, err.message || 'Failed to add the comment.', err.status || 500)
  }
}

exports.updateComment = async (req, res) => {
  try {
    const bug = await loadViewableBug(req)
    const content = clean(req.body.content)
    if (!content) return errorResponse(res, 'Comment cannot be empty.')
    if (content.length > MAX_COMMENT) {
      return errorResponse(res, `Comment must be ${MAX_COMMENT} characters or fewer.`)
    }

    const existing = await pool.query(
      'SELECT id, author_id FROM bug_comments WHERE id = $1 AND bug_id = $2',
      [req.params.commentId, bug.id]
    )
    if (!existing.rows[0]) return errorResponse(res, 'Comment not found.', 404)

    // Only the author edits their own words. An admin can delete a comment but
    // never rewrite it under someone else's name.
    if (existing.rows[0].author_id !== req.user.id) {
      return errorResponse(res, 'You can only edit your own comments.', 403)
    }

    const { rows } = await pool.query(
      `UPDATE bug_comments
          SET content = $1, edited = TRUE, updated_at = NOW()
        WHERE id = $2
        RETURNING id, content, edited, created_at, updated_at`,
      [content, req.params.commentId]
    )

    await logBugActivity({
      bugId: bug.id,
      actorId: req.user.id,
      action: BUG_ACTIONS.COMMENT_EDITED,
      detail: { commentId: req.params.commentId },
    })

    return successResponse(
      res,
      {
        id: rows[0].id,
        content: rows[0].content,
        edited: rows[0].edited,
        createdAt: rows[0].created_at,
        updatedAt: rows[0].updated_at,
        author: { id: req.user.id, name: req.user.name },
      },
      'Comment updated.'
    )
  } catch (err) {
    console.error('updateBugComment error:', err)
    return errorResponse(res, err.message || 'Failed to update the comment.', err.status || 500)
  }
}

exports.deleteComment = async (req, res) => {
  try {
    const bug = await loadViewableBug(req)

    const existing = await pool.query(
      'SELECT id, author_id FROM bug_comments WHERE id = $1 AND bug_id = $2',
      [req.params.commentId, bug.id]
    )
    if (!existing.rows[0]) return errorResponse(res, 'Comment not found.', 404)

    // The author, or a manager/admin moderating the thread.
    if (existing.rows[0].author_id !== req.user.id && !isManagerOrAdmin(req.user)) {
      return errorResponse(res, 'You can only delete your own comments.', 403)
    }

    await pool.query('DELETE FROM bug_comments WHERE id = $1', [req.params.commentId])

    await logBugActivity({
      bugId: bug.id,
      actorId: req.user.id,
      action: BUG_ACTIONS.COMMENT_DELETED,
      detail: { commentId: req.params.commentId },
    })

    return successResponse(res, { id: req.params.commentId }, 'Comment deleted.')
  } catch (err) {
    console.error('deleteBugComment error:', err)
    return errorResponse(res, err.message || 'Failed to delete the comment.', err.status || 500)
  }
}

/* -------------------------------------------------------------------------- */
/* Attachments (§14) — reuses the documents storage pipeline                   */
/* -------------------------------------------------------------------------- */

// Same bucket and prefix conventions as documents.controller.js, so bug
// attachments live alongside every other uploaded file rather than in a second,
// parallel storage architecture.
const STORAGE_BUCKET = 'documents'
const STORAGE_FOLDER = 'bugs'
const PUBLIC_URL_MARKER = `/storage/v1/object/public/${STORAGE_BUCKET}/`
const DEFAULT_MIME_TYPE = 'application/octet-stream'

function getExtension(fileName) {
  const parts = String(fileName || '').split('.')
  return parts.length > 1 ? String(parts.pop()).toLowerCase() : ''
}

function sanitizeFileName(fileName) {
  const base = String(fileName || '').split(/[\\/]/).pop()
  const ext = getExtension(base)
  const stem = ext ? base.slice(0, -(ext.length + 1)) : base
  const safeStem =
    stem
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .slice(0, 100)
      .toLowerCase() || 'file'
  const safeExt = ext.replace(/[^a-z0-9]/g, '').slice(0, 10)
  return safeExt ? `${safeStem}.${safeExt}` : safeStem
}

function storagePathFromUrl(url) {
  if (typeof url !== 'string') return null
  const index = url.indexOf(PUBLIC_URL_MARKER)
  if (index === -1) return null
  const raw = url.slice(index + PUBLIC_URL_MARKER.length).split('?')[0]
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// Best-effort removal; never throws — a stale object must not block a DB write.
async function removeFromStorage(path) {
  if (!path) return false
  try {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([path])
    if (error) {
      console.error(`[bugs] storage remove failed for "${path}":`, error.message)
      return false
    }
    return true
  } catch (err) {
    console.error(`[bugs] storage remove threw for "${path}":`, err.message)
    return false
  }
}

// Used by deleteBug so a cascade does not orphan objects in the bucket.
async function removeBugAttachmentObjects(bugId) {
  try {
    const { rows } = await pool.query(
      'SELECT storage_path, url FROM bug_attachments WHERE bug_id = $1',
      [bugId]
    )
    for (const row of rows) {
      await removeFromStorage(row.storage_path || storagePathFromUrl(row.url))
    }
  } catch (err) {
    console.error('[bugs] could not clean up attachments:', err.message)
  }
}

exports.uploadAttachment = async (req, res) => {
  let uploadedPath = null
  try {
    const bug = await loadViewableBug(req)

    if (!req.file) return errorResponse(res, 'No file uploaded.')
    const { originalname, size, buffer, mimetype } = req.file
    if (!buffer || !buffer.length) return errorResponse(res, 'Uploaded file is empty.')

    const ext = getExtension(originalname) || 'file'
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
    const path = `${STORAGE_FOLDER}/${unique}-${sanitizeFileName(originalname)}`

    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, buffer, {
        contentType: mimetype || DEFAULT_MIME_TYPE,
        cacheControl: '3600',
        upsert: false,
      })
    if (uploadError) {
      return errorResponse(res, `Failed to upload the file: ${uploadError.message}`, 502)
    }
    uploadedPath = path

    const { data: publicData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path)
    const url = publicData?.publicUrl
    if (!url) {
      await removeFromStorage(path)
      return errorResponse(res, 'File uploaded but no public URL was returned by storage.', 502)
    }

    // Mirror the file into `documents` so it also appears in the existing
    // Documents module rather than being invisible outside Bugs Finder. A
    // failure here is non-fatal: the attachment itself is what matters.
    let documentId = null
    try {
      const doc = await pool.query(
        `INSERT INTO documents
           (name, original_name, file_type, file_size, url, description, project_id, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id`,
        [
          originalname,
          originalname,
          ext,
          size,
          url,
          `Attachment on ${bug.key}: ${bug.title}`,
          bug.project?.id || null,
          req.user.id,
        ]
      )
      documentId = doc.rows[0].id
    } catch (err) {
      console.error('[bugs] could not mirror attachment into documents:', err.message)
    }

    const { rows } = await pool.query(
      `INSERT INTO bug_attachments
         (bug_id, document_id, file_name, file_type, file_size, url, storage_path, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, file_name, file_type, file_size, url, created_at`,
      [bug.id, documentId, originalname, ext, size, url, path, req.user.id]
    )

    await logBugActivity({
      bugId: bug.id,
      actorId: req.user.id,
      action: BUG_ACTIONS.ATTACHMENT_ADDED,
      newValue: originalname,
      detail: { attachmentId: rows[0].id },
    })

    return successResponse(
      res,
      {
        id: rows[0].id,
        fileName: rows[0].file_name,
        fileType: rows[0].file_type,
        fileSize: parseInt(rows[0].file_size, 10) || 0,
        url: rows[0].url,
        createdAt: rows[0].created_at,
        uploadedBy: { id: req.user.id, name: req.user.name },
      },
      'Attachment uploaded.',
      201
    )
  } catch (err) {
    // The DB write failed after the object landed — clean up rather than
    // leaving an unreferenced file in the bucket.
    if (uploadedPath) await removeFromStorage(uploadedPath)
    console.error('uploadBugAttachment error:', err)
    return errorResponse(res, err.message || 'Failed to upload the attachment.', err.status || 500)
  }
}

exports.deleteAttachment = async (req, res) => {
  try {
    const bug = await loadViewableBug(req)

    const { rows } = await pool.query(
      'SELECT id, file_name, url, storage_path, uploaded_by, document_id FROM bug_attachments WHERE id = $1 AND bug_id = $2',
      [req.params.attachmentId, bug.id]
    )
    const attachment = rows[0]
    if (!attachment) return errorResponse(res, 'Attachment not found.', 404)

    // The uploader, or a manager/admin.
    if (attachment.uploaded_by !== req.user.id && !isManagerOrAdmin(req.user)) {
      return errorResponse(res, 'You can only delete attachments you uploaded.', 403)
    }

    await removeFromStorage(attachment.storage_path || storagePathFromUrl(attachment.url))
    await pool.query('DELETE FROM bug_attachments WHERE id = $1', [attachment.id])
    // Drop the mirrored documents row too, so the Documents module does not
    // keep listing a file whose object has been removed.
    if (attachment.document_id) {
      await pool
        .query('DELETE FROM documents WHERE id = $1', [attachment.document_id])
        .catch((err) => console.error('[bugs] could not remove mirrored document:', err.message))
    }

    await logBugActivity({
      bugId: bug.id,
      actorId: req.user.id,
      action: BUG_ACTIONS.ATTACHMENT_DELETED,
      oldValue: attachment.file_name,
    })

    return successResponse(res, { id: attachment.id }, 'Attachment deleted.')
  } catch (err) {
    console.error('deleteBugAttachment error:', err)
    return errorResponse(res, err.message || 'Failed to delete the attachment.', err.status || 500)
  }
}

/* -------------------------------------------------------------------------- */
/* SLA rules administration (§6)                                              */
/* -------------------------------------------------------------------------- */

exports.getSlaRules = async (req, res) => {
  try {
    const rules = await getSlaRules()
    return successResponse(res, SEVERITIES.map((severity) => rules[severity]))
  } catch (err) {
    console.error('getBugSlaRules error:', err)
    return errorResponse(res, 'Failed to load SLA rules.', 500)
  }
}

exports.updateSlaRule = async (req, res) => {
  try {
    const severity = clean(req.params.severity)
    if (!SEVERITIES.includes(severity)) {
      return errorResponse(res, `Severity must be one of: ${SEVERITIES.join(', ')}.`)
    }

    const responseMinutes = Number(req.body.responseMinutes)
    const resolutionMinutes = Number(req.body.resolutionMinutes)
    const atRiskThreshold =
      req.body.atRiskThreshold === undefined ? null : Number(req.body.atRiskThreshold)

    if (!Number.isFinite(responseMinutes) || responseMinutes <= 0) {
      return errorResponse(res, 'Response time must be a positive number of minutes.')
    }
    if (!Number.isFinite(resolutionMinutes) || resolutionMinutes <= 0) {
      return errorResponse(res, 'Resolution time must be a positive number of minutes.')
    }
    // A resolution target inside the response target is incoherent — it would
    // mark bugs breached before anyone was even due to look at them.
    if (resolutionMinutes < responseMinutes) {
      return errorResponse(res, 'Resolution time cannot be shorter than response time.')
    }
    if (atRiskThreshold !== null && (!(atRiskThreshold > 0) || !(atRiskThreshold < 1))) {
      return errorResponse(res, 'At-risk threshold must be between 0 and 1 (exclusive).')
    }

    const { rows } = await pool.query(
      `INSERT INTO bug_sla_rules (severity, response_minutes, resolution_minutes, at_risk_threshold, updated_by)
            VALUES ($1,$2,$3,COALESCE($4, 0.75),$5)
       ON CONFLICT (severity) DO UPDATE
          SET response_minutes   = EXCLUDED.response_minutes,
              resolution_minutes = EXCLUDED.resolution_minutes,
              at_risk_threshold  = COALESCE($4, bug_sla_rules.at_risk_threshold),
              updated_by         = EXCLUDED.updated_by,
              updated_at         = NOW()
       RETURNING id, severity, response_minutes, resolution_minutes, at_risk_threshold`,
      [severity, Math.round(responseMinutes), Math.round(resolutionMinutes), atRiskThreshold, req.user.id]
    )

    const r = rows[0]
    return successResponse(
      res,
      {
        id: r.id,
        severity: r.severity,
        responseMinutes: r.response_minutes,
        resolutionMinutes: r.resolution_minutes,
        atRiskThreshold: Number(r.at_risk_threshold),
      },
      'SLA rule updated. New deadlines apply to bugs reported from now on.'
    )
  } catch (err) {
    console.error('updateBugSlaRule error:', err)
    return errorResponse(res, 'Failed to update the SLA rule.', 500)
  }
}

/* -------------------------------------------------------------------------- */
/* Options endpoint — enum vocabularies for the UI                             */
/* -------------------------------------------------------------------------- */

// One round trip for every dropdown the module needs, so the frontend never
// hardcodes a vocabulary that could drift from the database CHECK constraints.
exports.getOptions = async (req, res) => {
  try {
    return successResponse(res, {
      statuses: BUG_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
      severities: SEVERITIES,
      priorities: PRIORITIES,
      environments: ENVIRONMENTS,
    })
  } catch (err) {
    return errorResponse(res, 'Failed to load options.', 500)
  }
}
