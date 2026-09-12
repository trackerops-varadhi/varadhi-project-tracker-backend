// PUBLIC INTERFACE — work (projects · project_members · tasks · comments)
//
// The only file outside this directory that anything else may require. Every
// function is async, so call sites survive this module moving behind a network
// boundary unchanged.
//
// work is the hub: four other modules read from it. That is why the accessors
// below are deliberately narrow — a card lookup, a routing fact, an existence
// check — rather than exposing rows. Nothing outside this module should know
// that a project has a `manager_id` column.

const repo = require('./repo')
const analytics = require('./analytics.repo')
const notifications = require('./notifications')
const events = require('./events')

exports.mount = [
  { path: '/api/projects', router: require('./projects.routes') },
  { path: '/api/tasks', router: require('./tasks.routes') },
]

/* ── Display lookups ────────────────────────────────────────────────────── */

/**
 * Resolve project ids to display cards.
 * Replaces the 18 lookup-only `LEFT JOIN projects` sites.
 *
 * @returns {Promise<Map<string, {id, name, status}>>}
 */
exports.getProjectCards = async (projectIds) => {
  const unique = [...new Set((projectIds || []).filter(Boolean))]
  if (unique.length === 0) return new Map()

  const rows = await repo.findProjectCards(unique)
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, status: r.status }]))
}

/**
 * Resolve task ids to display cards. Replaces the lookup-only
 * `LEFT JOIN tasks` that supplied a linked task's title and status.
 *
 * @returns {Promise<Map<string, {id, title, status}>>}
 */
exports.getTaskCards = async (taskIds) => {
  const unique = [...new Set((taskIds || []).filter(Boolean))]
  if (unique.length === 0) return new Map()

  const rows = await repo.findTaskCards(unique)
  return new Map(rows.map((r) => [r.id, { id: r.id, title: r.title, status: r.status }]))
}

/* ── Routing facts ──────────────────────────────────────────────────────── */

/**
 * Everyone on a project's member list.
 *
 * A *logic* read, not display: callers use it to decide who receives a
 * notification. Replaces other modules querying `project_members` directly.
 */
exports.getProjectMemberIds = async (projectId) => {
  if (!projectId) return []
  return repo.findProjectMemberIds(projectId)
}

/**
 * Who manages each project.
 *
 * The contract that replaces other modules reading `p.manager_id` — the SLA
 * sweep, the reminder sweep and the Teams fan-out all need it to decide who to
 * escalate to. Projects with no manager are present with a null value.
 *
 * @returns {Promise<Map<string, string|null>>} projectId -> managerId
 */
exports.getProjectManagerIds = async (projectIds) => {
  const unique = [...new Set((projectIds || []).filter(Boolean))]
  if (unique.length === 0) return new Map()

  const rows = await repo.findProjectManagers(unique)
  return new Map(rows.map((r) => [r.id, r.manager_id]))
}

/**
 * Ids of projects whose NAME matches a search term — the counterpart to
 * identity.searchUserIds(), letting another module offer "search by project"
 * without joining `projects`.
 */
exports.searchProjectIds = async (term) => {
  const trimmed = String(term || '').trim()
  if (!trimmed) return []
  return repo.searchProjectIds(`%${trimmed}%`)
}

// Existence checks, so a caller can reject a bad reference with a 400 instead
// of letting a foreign-key violation surface as an opaque 500.
exports.projectExists = async (id) => (id ? repo.projectExists(id) : false)
exports.taskExists = async (id) => (id ? repo.taskExists(id) : false)

/**
 * One task plus its project's manager, for a notification action.
 *
 * notify needs this to recompute permission from live rows when someone taps
 * Approve / Reject / Accept on a push notification — it must know the assignee
 * and the project manager, and it must not read `tasks` to find out.
 *
 * @returns {Promise<{id, title, status, assigneeId, projectId, projectManagerId}|null>}
 */
exports.getTaskActionContext = async (taskId) => {
  if (!taskId) return null
  const row = await repo.findTaskActionContext(taskId)
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assigneeId: row.assignee_id,
    projectId: row.project_id,
    projectManagerId: row.project_manager_id,
  }
}

/**
 * How much work each person has, and how much of it is done.
 *
 * The contract behind "N tasks" on the user list and the Top Performers card.
 * Both used to be `users` measuring `tasks` directly — the scalar subquery in
 * getAllUsers and the aggregate JOIN in getUserStats. Those are two of the four
 * queries the migration plan flagged as "users drives, tasks measures"; this is
 * how they stop crossing the boundary.
 *
 * Users with no tasks are absent from the map, not zero — callers default.
 *
 * @returns {Promise<Map<string, {total: number, completed: number}>>}
 */
exports.getTaskCountsByAssignee = async (userIds) => {
  const unique = [...new Set((userIds || []).filter(Boolean))]
  if (unique.length === 0) return new Map()

  const rows = await repo.findTaskCountsByAssignee(unique)
  return new Map(rows.map((r) => [r.assignee_id, { total: r.total, completed: r.completed }]))
}

/* ── Writes ─────────────────────────────────────────────────────────────── */

/**
 * Create a development task raised from a defect, and return its id.
 *
 * Deliberately narrow rather than a general `createTask`: the caller supplies
 * the content, work owns the fact that such a task starts at 'todo' with type
 * 'bug'. Does NOT notify — the caller owns that, because it is the one that
 * knows the notification should describe a bug rather than a bare task.
 */
exports.createTaskForBug = async ({
  title, description, priority, projectId, assigneeId = null, reporterId, dueDate = null,
}) => {
  const row = await repo.insertBugTask({
    title, description, priority, projectId, assigneeId, reporterId, dueDate,
  })
  return row.id
}

/* ── Behaviour other modules trigger ────────────────────────────────────── */

/* ── Domain events ──────────────────────────────────────────────────────── */

/**
 * What work announces, and how to listen.
 *
 * `events.on(events.EVENTS.TASK_CHANGED, handler)` — integrations subscribes
 * here so work no longer has to know the calendar exists. See events.js for
 * why task.deleted is awaited and emitted before the row goes.
 */
exports.events = {
  EVENTS: events.EVENTS,
  on: events.on,
}

/* ── Reads for integrations ─────────────────────────────────────────────── */

/** Tasks a user's calendar should mirror. `projectIds` narrows to a scope. */
exports.getSyncableTasksForUser = async (userId, projectIds = null) =>
  repo.findSyncableTasks(userId, projectIds)

/** Project end dates a user should see as calendar milestones. */
exports.getSyncableMilestonesForUser = async (userId) => repo.findSyncableMilestones(userId)

/**
 * Move a task's due date, and nothing else.
 *
 * The only write work accepts from integrations. Inbound calendar sync may
 * reschedule a deadline; it can never create, retitle or restatus a task, and
 * this narrow signature is what enforces that rather than a comment.
 */
exports.setTaskDueDate = async (taskId, dueDate) => repo.updateTaskDueDate(taskId, dueDate)

/**
 * Apply a guarded status transition to a task, and say whether it took.
 *
 * This is the authoritative half of a notification action. notify used to do
 * this UPDATE itself, inside its own transaction, back when `tasks` and
 * `notifications` shared the `public` schema. They no longer do, so the write
 * comes through here — and because there is no shared transaction left to lock
 * with, the compare-and-swap below IS the mutex that stops an action being
 * applied twice. A caller that loses the race gets `applied: false` together
 * with the status it lost to, which is enough to tell "someone already did
 * this" (currentStatus === toStatus) from "the task moved elsewhere".
 *
 * Emits TASK_CHANGED on success, exactly as the task routes do, so a calendar
 * event still gets marked dirty when a task is approved from a notification.
 *
 * @returns {Promise<{applied: boolean, status: string|null, currentStatus: string|null}>}
 */
exports.applyTaskStatusTransition = async ({ taskId, fromStatus, toStatus }) => {
  if (!taskId || !fromStatus || !toStatus) {
    throw new Error('applyTaskStatusTransition requires taskId, fromStatus and toStatus')
  }

  const swapped = await repo.compareAndSwapTaskStatus(taskId, fromStatus, toStatus)

  if (!swapped) {
    // Report what it actually is, so the caller can distinguish an already-done
    // action from a genuine conflict without a second round trip.
    const ctx = await repo.findTaskActionContext(taskId)
    return { applied: false, status: null, currentStatus: ctx ? ctx.status : null }
  }

  await events.emit(events.EVENTS.TASK_CHANGED, { taskId })

  return { applied: true, status: swapped.status, currentStatus: swapped.status }
}

/** Upcoming unfinished tasks for a user, for the calendar preview. */
exports.getUpcomingTasksForUser = async (userId, days, limit) =>
  repo.findUpcomingTasksForUser(userId, days, limit)

/**
 * Enough of a task to render a Teams card.
 * @returns {Promise<{id, title, dueDate, status, priority, projectId, assigneeId}|null>}
 */
exports.getTaskSummary = async (taskId) => {
  if (!taskId) return null
  const r = await repo.findTaskSummary(taskId)
  if (!r) return null
  return {
    id: r.id,
    title: r.title,
    dueDate: r.due_date,
    status: r.status,
    priority: r.priority,
    projectId: r.project_id,
    assigneeId: r.assignee_id,
  }
}

/** Counts for a Teams summary digest. A null projectId aggregates everything. */
exports.getTaskDigestCounts = async (projectId = null) => repo.taskDigestCounts(projectId)

/* ── Analytics ──────────────────────────────────────────────────────────── */

/**
 * Aggregate reads for the insights module (dashboard + reports).
 *
 * Grouped under one namespace rather than flattened alongside the domain
 * accessors above, because they answer a different kind of question: these
 * return shaped aggregates for rendering, not domain objects other modules act
 * on. insights owns no tables, so this is the whole of what it may ask work.
 *
 * Every function returns raw aggregate rows; the arithmetic, thresholds and
 * presentation live in insights, which is where the reporting decisions belong.
 * See analytics.repo.js for the 1:1 mapping to each endpoint.
 */
exports.analytics = {
  // dashboard
  getDashboardCounters: async (scopeUserId = null) => analytics.dashboardCounters(scopeUserId),
  getProjectHealthRollup: async (scopeUserId = null) => analytics.projectHealthRollup(scopeUserId),
  getGanttRollup: async (scopeUserId = null) => analytics.ganttRollup(scopeUserId),
  getRecentTaskActivity: async (scopeUserId = null, limit = 10) =>
    analytics.recentTaskActivity(scopeUserId, limit),
  getProjectProgressRollup: async (scopeUserId = null) =>
    analytics.projectProgressRollup(scopeUserId),
  getBurndown: async (projectId) => analytics.burndown(projectId),

  // reports
  getTaskLoadByAssignee: async (userIds) => {
    const unique = [...new Set((userIds || []).filter(Boolean))]
    if (unique.length === 0) return new Map()
    const rows = await analytics.taskLoadByAssignee(unique)
    return new Map(rows.map((r) => [r.assignee_id, {
      total: r.total,
      completed: r.completed,
      inProgress: r.in_progress,
      todoOrReview: r.todo_or_review,
      open: r.open,
      overdue: r.overdue,
    }]))
  },
  getThroughputStats: async () => analytics.throughputStats(),
  getTaskRiskCounts: async () => analytics.taskRiskCounts(),
  getProjectRiskCounts: async () => analytics.projectRiskCounts(),
  getTaskCountsByStatus: async () => analytics.taskCountsByStatus(),
  getProjectCompletionCounts: async () => analytics.projectCompletionCounts(),
}

/**
 * Re-check a project's completion percentage and notify its manager if it just
 * landed exactly on 25/50/75/100.
 *
 * Consumed by notification-actions, which completes a task from a push
 * notification and must run the same milestone check the normal status path
 * does. It used to reach into tasks.controller.js for this.
 *
 * Best-effort by design — see notifications.js for why it relies on the
 * engine's dedupe window rather than true crossing-detection.
 */
exports.checkProjectMilestone = async (projectId, excludeUserId) =>
  notifications.checkProjectMilestone(projectId, excludeUserId)
