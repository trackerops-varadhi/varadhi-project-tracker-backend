/**
 * Defects — controller.
 *
 * Thin by design: validate the request, delegate to service.js, shape the
 * response through shared/response.js. Business logic (SLA maths, workflow
 * rules, notification fan-out) lives in the service and the two sibling
 * modules sla.js / workflow.js.
 *
 * Every handler catches its own errors and returns through errorResponse
 * rather than throwing to error.middleware.js — the convention every other
 * controller in this codebase follows.
 */

const { successResponse, errorResponse, paginatedResponse } = require('../../shared/response')
const repo = require('./repo')
const service = require('./service')
const identity = require('../identity')
const work = require('../work')
const files = require('../files')
const notify = require('../notify')
const { SEVERITIES, PRIORITIES, ENVIRONMENTS, getSlaRules, slaDeadlines } = require('./sla')
const {
  BUG_STATUSES,
  STATUS_LABELS,
  EMPLOYEE_ALLOWED_STATUSES,
  BUG_ACTIONS,
  canTransition,
  logBugActivity,
} = require('./workflow')

const { notifySafely, isEmployee, isManagerOrAdmin } = service

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

const MAX_TITLE = 500
const MAX_COMMENT = 5000

// Bug attachments share the documents bucket under this prefix.
const ATTACHMENT_FOLDER = 'bugs'

// Trim, then treat an all-whitespace string as absent. Used everywhere a
// nullable text/uuid field arrives from a form, because Postgres rejects '' for
// a uuid column.
const clean = (value) => {
  if (value === undefined || value === null) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (value) => UUID_RE.test(String(value || ''))

const fail = (message, status) => {
  const err = new Error(message)
  err.status = status
  return err
}

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

/**
 * Confirm a referenced row exists, so an FK violation never surfaces as a 500.
 *
 * Where the legacy version ran `SELECT id FROM <table>` against any table, each
 * reference now goes through the owning module's interface — the existence of a
 * project is work's fact to state, not ours.
 */
const EXISTS_CHECK = {
  projects: (id) => work.projectExists(id),
  tasks: (id) => work.taskExists(id),
  users: async (id) => Boolean(await identity.getAccountState(id)),
  bugs: (id) => repo.bugExists(id),
}

async function assertExists(kind, id, label) {
  if (!id) return true
  if (!isUuid(id)) throw fail(`${label} is not a valid id.`, 400)
  if (!(await EXISTS_CHECK[kind](id))) throw fail(`${label} not found.`, 400)
  return true
}

/**
 * Load a bug and apply read authorization in one step. Throws a status-tagged
 * error the caller's catch turns into the right response code.
 */
async function loadViewableBug(req) {
  if (!isUuid(req.params.id)) throw fail('Bug not found.', 404)

  const bug = await service.getBugById(req.params.id)
  if (!bug) throw fail('Bug not found.', 404)
  if (!service.canView(req.user, bug)) {
    throw fail('You do not have permission to view this bug.', 403)
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
    return successResponse(res, await loadViewableBug(req))
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500)
  }
}

// Bugs for one project — powers the project detail page's Bugs tab.
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
    return successResponse(res, await service.getActivity(req.params.id, limit))
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

const UPDATE_COLUMN = {
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

exports.updateBug = async (req, res) => {
  try {
    const bug = await loadViewableBug(req)

    if (!service.canEdit(req.user, bug)) {
      return errorResponse(res, 'You are not authorized to edit this bug.', 403)
    }

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
        return errorResponse(res, `You are not authorized to change: ${forbidden.join(', ')}.`, 403)
      }
    }

    const enumErrors = validateEnums({
      severity: candidates.severity,
      priority: candidates.priority,
      environment: candidates.environment,
    })
    if (enumErrors.length) return errorResponse(res, enumErrors.join(' '))

    if (provided.includes('projectId')) {
      await assertExists('projects', candidates.projectId, 'Project')
    }
    if (provided.includes('linkedTaskId') && candidates.linkedTaskId) {
      await assertExists('tasks', candidates.linkedTaskId, 'Linked task')
    }
    if (provided.includes('title') && !candidates.title) {
      return errorResponse(res, 'Bug title cannot be empty.')
    }
    if (provided.includes('description') && !candidates.description) {
      return errorResponse(res, 'Description cannot be empty.')
    }

    const sets = []
    const params = []
    for (const field of provided) {
      params.push(candidates[field])
      sets.push(`${UPDATE_COLUMN[field]} = $${params.length}`)
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
    await repo.updateBugColumns(bug.id, sets, params)

    // Severity and priority get their own named actions; everything else is a
    // generic field update carrying its before/after.
    for (const field of provided) {
      const before =
        field === 'projectId' ? bug.project?.id
          : field === 'linkedTaskId' ? bug.linkedTask?.id
          : bug[field]
      if (String(before ?? '') === String(candidates[field] ?? '')) continue

      const action =
        field === 'severity' ? BUG_ACTIONS.SEVERITY_CHANGED
          : field === 'priority' ? BUG_ACTIONS.PRIORITY_CHANGED
          : field === 'linkedTaskId'
          ? candidates[field] ? BUG_ACTIONS.TASK_LINKED : BUG_ACTIONS.TASK_UNLINKED
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

      await notify.dispatch({
        userId: updated.assignee.id,
        type: notify.TYPES.BUG_STATUS_CHANGED,
        title: changedSeverity ? 'Bug severity changed' : 'Bug priority changed',
        message: `${updated.key} is now ${changedSeverity ? updated.severity + ' severity' : updated.priority.toUpperCase()}`,
        linkTo: `/bugs/${bug.id}`,
        priority: updated.severity === 'critical' ? 'high' : 'normal',
      })
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

    const stub = await repo.findBugStub(req.params.id)
    if (!stub) return errorResponse(res, 'Bug not found.', 404)

    // Storage objects first: the attachment rows cascade away with the bug, so
    // reading their paths afterwards would be impossible and the files would be
    // orphaned in the bucket forever.
    await removeBugAttachmentObjects(req.params.id)

    await repo.deleteBug(req.params.id)

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

    // Same status is a no-op rather than an error, so a duplicate submit is
    // idempotent instead of a spurious 400.
    if (nextStatus === bug.status) {
      return successResponse(res, bug, 'Status unchanged.')
    }

    const transition = canTransition(bug.status, nextStatus)
    if (!transition.ok) return errorResponse(res, transition.message, 400)

    // An employee drives the development side of the flow on a bug assigned to
    // them; closing, rejecting and reopening are triage and verification
    // decisions reserved for admin/manager.
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
      if (!duplicateOfId) return errorResponse(res, 'Select the bug this duplicates.')
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
    // Assignment is a triage decision — admin/manager only.
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
      const account = await identity.getAccountState(isUuid(assigneeId) ? assigneeId : null)
      if (!account) return errorResponse(res, 'Developer not found.', 400)
      // Assigning work to a deactivated account silently strands the bug.
      if (account.status === 'inactive') {
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
/* Task integration                                                           */
/* -------------------------------------------------------------------------- */

// Bug priority (p0..p3) maps onto the tasks table's own scale — they are
// separate vocabularies and the task CHECK constraint only accepts its own.
const TASK_PRIORITY = { p0: 'critical', p1: 'high', p2: 'medium', p3: 'low' }

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
      return errorResponse(
        res,
        'A bug must belong to a project before a task can be created from it.'
      )
    }

    // The task row belongs to work, so work creates it. This is the only
    // cross-module write defects performs besides the document mirror.
    const taskId = await work.createTaskForBug({
      title: clean(req.body.title) || `${bug.key}: ${bug.title}`,
      description: clean(req.body.description) || `Fix for ${bug.key}.\n\n${bug.description}`,
      priority: TASK_PRIORITY[bug.priority] || 'medium',
      projectId: bug.project.id,
      assigneeId: clean(req.body.assigneeId) || bug.assignee?.id || null,
      reporterId: req.user.id,
      // Align the task's due date with the bug's resolution SLA so the two
      // deadlines cannot drift apart.
      dueDate: bug.sla.dueAt ? new Date(bug.sla.dueAt).toISOString().slice(0, 10) : null,
    })

    await repo.linkTask(bug.id, taskId)

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
      await notify.dispatch({
        userId: assigneeId,
        type: notify.TYPES.TASK_ASSIGNED,
        title: 'New Task Assigned',
        message: `Development task created from ${bug.key}: ${updated.linkedTask.title}`,
        linkTo: `/tasks/${taskId}`,
        priority: 'high',
      })
    })

    return successResponse(res, updated, 'Development task created and linked.', 201)
  } catch (err) {
    console.error('createTaskFromBug error:', err)
    return errorResponse(res, err.message || 'Failed to create the task.', err.status || 500)
  }
}

/* -------------------------------------------------------------------------- */
/* Comments                                                                   */
/* -------------------------------------------------------------------------- */

exports.getComments = async (req, res) => {
  try {
    await loadViewableBug(req)
    return successResponse(res, await service.getComments(req.params.id))
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500)
  }
}

exports.addComment = async (req, res) => {
  try {
    const bug = await loadViewableBug(req)
    const content = clean(req.body.content)

    if (!content) return errorResponse(res, 'Comment cannot be empty.')
    if (content.length > MAX_COMMENT) {
      return errorResponse(res, `Comment must be ${MAX_COMMENT} characters or fewer.`)
    }

    const row = await repo.insertComment(bug.id, req.user.id, content)

    await logBugActivity({
      bugId: bug.id,
      actorId: req.user.id,
      action: BUG_ACTIONS.COMMENT_ADDED,
      detail: { commentId: row.id },
    })

    await notifySafely(async () => {
      const recipients = new Set()
      if (bug.assignee?.id) recipients.add(bug.assignee.id)
      if (bug.reporter?.id) recipients.add(bug.reporter.id)
      await notify.dispatchToUsers({
        userIds: [...recipients],
        type: notify.TYPES.BUG_COMMENT,
        title: 'New comment on a bug',
        message: `${req.user.name} commented on ${bug.key}: ${bug.title}`,
        linkTo: `/bugs/${bug.id}`,
        excludeUserId: req.user.id,
      })
    })

    return successResponse(
      res,
      {
        id: row.id,
        content: row.content,
        edited: row.edited,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
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

    const existing = await repo.findComment(req.params.commentId, bug.id)
    if (!existing) return errorResponse(res, 'Comment not found.', 404)

    // Only the author edits their own words. An admin can delete a comment but
    // never rewrite it under someone else's name.
    if (existing.author_id !== req.user.id) {
      return errorResponse(res, 'You can only edit your own comments.', 403)
    }

    const row = await repo.updateComment(req.params.commentId, content)

    await logBugActivity({
      bugId: bug.id,
      actorId: req.user.id,
      action: BUG_ACTIONS.COMMENT_EDITED,
      detail: { commentId: req.params.commentId },
    })

    return successResponse(
      res,
      {
        id: row.id,
        content: row.content,
        edited: row.edited,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
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

    const existing = await repo.findComment(req.params.commentId, bug.id)
    if (!existing) return errorResponse(res, 'Comment not found.', 404)

    // The author, or a manager/admin moderating the thread.
    if (existing.author_id !== req.user.id && !isManagerOrAdmin(req.user)) {
      return errorResponse(res, 'You can only delete your own comments.', 403)
    }

    await repo.deleteComment(req.params.commentId)

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
/* Attachments — through the files module's storage pipeline                  */
/* -------------------------------------------------------------------------- */

// Used by deleteBug so a cascade does not orphan objects in the bucket.
async function removeBugAttachmentObjects(bugId) {
  try {
    for (const row of await repo.findAttachmentPaths(bugId)) {
      await files.removeStoredFile(row.storage_path || row.url)
    }
  } catch (err) {
    console.error('[defects] could not clean up attachments:', err.message)
  }
}

exports.uploadAttachment = async (req, res) => {
  let stored = null
  try {
    const bug = await loadViewableBug(req)

    if (!req.file) return errorResponse(res, 'No file uploaded.')
    const { originalname, size, buffer, mimetype } = req.file
    if (!buffer || !buffer.length) return errorResponse(res, 'Uploaded file is empty.')

    const ext = (await files.getFileExtension(originalname)) || 'file'

    try {
      stored = await files.storeFile({
        buffer,
        fileName: originalname,
        mimeType: mimetype,
        folder: ATTACHMENT_FOLDER,
      })
    } catch (uploadErr) {
      // A storage fault is upstream, not the client's fault — 502, as before.
      return errorResponse(res, uploadErr.message, 502)
    }

    // Mirror the file into `documents` so it also appears in the Documents
    // module rather than being invisible outside Bugs Finder. Non-fatal by
    // contract: files.createMirroredDocument returns null rather than throwing.
    const documentId = await files.createMirroredDocument({
      fileName: originalname,
      fileType: ext,
      fileSize: size,
      url: stored.url,
      description: `Attachment on ${bug.key}: ${bug.title}`,
      projectId: bug.project?.id || null,
      uploadedBy: req.user.id,
    })

    const row = await repo.insertAttachment({
      bugId: bug.id,
      documentId,
      fileName: originalname,
      fileType: ext,
      fileSize: size,
      url: stored.url,
      storagePath: stored.path,
      uploadedBy: req.user.id,
    })

    await logBugActivity({
      bugId: bug.id,
      actorId: req.user.id,
      action: BUG_ACTIONS.ATTACHMENT_ADDED,
      newValue: originalname,
      detail: { attachmentId: row.id },
    })

    return successResponse(
      res,
      {
        id: row.id,
        fileName: row.file_name,
        fileType: row.file_type,
        fileSize: parseInt(row.file_size, 10) || 0,
        url: row.url,
        createdAt: row.created_at,
        uploadedBy: { id: req.user.id, name: req.user.name },
      },
      'Attachment uploaded.',
      201
    )
  } catch (err) {
    // The DB write failed after the object landed — clean up rather than
    // leaving an unreferenced file in the bucket.
    if (stored) await files.removeStoredFile(stored.path)
    console.error('uploadBugAttachment error:', err)
    return errorResponse(res, err.message || 'Failed to upload the attachment.', err.status || 500)
  }
}

exports.deleteAttachment = async (req, res) => {
  try {
    const bug = await loadViewableBug(req)

    const attachment = await repo.findAttachment(req.params.attachmentId, bug.id)
    if (!attachment) return errorResponse(res, 'Attachment not found.', 404)

    // The uploader, or a manager/admin.
    if (attachment.uploaded_by !== req.user.id && !isManagerOrAdmin(req.user)) {
      return errorResponse(res, 'You can only delete attachments you uploaded.', 403)
    }

    await files.removeStoredFile(attachment.storage_path || attachment.url)
    await repo.deleteAttachment(attachment.id)
    // Drop the mirrored documents row too, so the Documents module does not
    // keep listing a file whose object has been removed.
    await files.removeDocument(attachment.document_id)

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
/* SLA rules administration                                                   */
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

    const r = await repo.upsertSlaRule({
      severity,
      responseMinutes: Math.round(responseMinutes),
      resolutionMinutes: Math.round(resolutionMinutes),
      atRiskThreshold,
      updatedBy: req.user.id,
    })

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
/* Options endpoint                                                           */
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
