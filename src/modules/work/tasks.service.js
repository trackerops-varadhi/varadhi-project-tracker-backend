// Task business logic: shaping, scoping and notification fan-out.

const repo = require('./repo')
const identity = require('../identity')
const notify = require('../notify')
const {
  notifySafely,
  notifyAdminsAndManagers,
  checkProjectMilestone,
  REVIEW_ACTIONS,
  ASSIGN_ACTIONS,
} = require('./notifications')

// ALLOW-LIST, not deny-list (Module 9). This used to ask "is this an
// employee?", so any role that was not literally 'employee' — such as the new
// 'hr' — fell through to manager-level access. Now only admin and manager are
// elevated and every other role, present or future, is scoped to its own rows.
const isRestricted = (user) =>
  !['admin', 'manager'].includes(String(user?.role || '').toLowerCase())
exports.isRestricted = isRestricted

/**
 * One task with its comments, in the API shape. A thin wrapper over the batch
 * path below, so the shape is defined in exactly one place.
 *
 * The two `LEFT JOIN users` (assignee, reporter) and the comments'
 * `JOIN users` are gone; all three resolve through one batched
 * identity.getUserCards() call.
 *
 * NOTE on the comments join: it used to be an INNER JOIN, which would drop a
 * comment whose author no longer existed. That was unreachable in practice —
 * comments.author_id is ON DELETE CASCADE, so deleting a user deletes their
 * comments — but it becomes reachable once that FK is dropped in Phase 2. The
 * card lookup keeps the comment with a null author instead, which is the
 * behaviour you want then.
 */
async function getTaskWithDetails(taskId) {
  const [task] = await getTasksWithDetails([taskId])
  return task || null
}

/**
 * The same shape as getTaskWithDetails, for many tasks, in a fixed number of
 * queries: one for the task rows, one for every comment, one batched card
 * lookup. Three round trips whatever the page size.
 *
 * This is what the list endpoints call. They used to call getTaskWithDetails
 * once per row, so a 10-row page cost 30 queries and grew linearly — the N+1
 * the module restructure was meant to close. Concurrency alone did not fix it:
 * the query count was the problem, not the latency.
 *
 * Ordering follows `taskIds`, because that is where the sort lives (the ids come
 * from an ORDER BY in SQL). Ids with no row — deleted between the two queries —
 * are skipped rather than returned as null.
 */
async function getTasksWithDetails(taskIds) {
  const ids = (taskIds || []).filter(Boolean)
  if (ids.length === 0) return []

  const [rows, commentsByTask] = await Promise.all([
    repo.findTaskRows(ids),
    repo.findCommentsForTasks(ids),
  ])
  if (rows.length === 0) return []

  const users = await identity.getUserCards([
    ...rows.map((t) => t.assignee_id),
    ...rows.map((t) => t.reporter_id),
    ...[...commentsByTask.values()].flat().map((c) => c.author_id),
  ])

  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((t) => shapeTask(t, commentsByTask.get(t.id) || [], users))
}

/** Row + its comments + a card map -> the API shape. */
function shapeTask(t, comments, users) {
  const assignee = users.get(t.assignee_id)
  const reporter = users.get(t.reporter_id)

  return {
    id: t.id,
    title: t.title,
    description: t.description,
    userStory: t.user_story,
    acceptanceCriteria: t.acceptance_criteria,
    status: t.status,
    priority: t.priority,
    type: t.type,
    dueDate: t.due_date,
    estimatedHours: t.estimated_hours,
    actualHours: t.actual_hours,
    tags: t.tags || [],
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    completedAt: t.completed_at,
    // Legacy shape: always an object, even when the task has no project.
    project: { id: t.project_id, name: t.project_name },
    assignee: t.assignee_id
      ? {
          id: t.assignee_id,
          name: assignee?.name ?? null,
          email: assignee?.email ?? null,
          avatar: assignee?.avatar ?? null,
        }
      : null,
    reporter: t.reporter_id
      ? { id: t.reporter_id, name: reporter?.name ?? null }
      : null,
    comments: comments.map((c) => ({
      id: c.id,
      content: c.content,
      createdAt: c.created_at,
      author: {
        id: c.author_id,
        name: users.get(c.author_id)?.name ?? null,
        avatar: users.get(c.author_id)?.avatar ?? null,
      },
    })),
  }
}
exports.getTaskWithDetails = getTaskWithDetails
exports.getTasksWithDetails = getTasksWithDetails

/* ── reads ───────────────────────────────────────────────────────────────── */

exports.list = async (currentUser, query = {}) => {
  const { status, priority, type, assigneeId, projectId, search } = query
  const page = parseInt(query.page) || 1
  const limit = parseInt(query.limit) || 10

  const spec = {
    // Employees see only tasks assigned to them.
    scopeUserId: isRestricted(currentUser) ? currentUser.id : null,
    status, priority, type, assigneeId, projectId, search,
  }

  const total = await repo.countTasks(spec)
  const ids = await repo.listTaskIds(spec, { limit, offset: (page - 1) * limit })
  const tasks = await getTasksWithDetails(ids)

  return { tasks, total, page, limit }
}

exports.listByProject = async (projectId) => {
  const ids = await repo.findTaskIdsByProject(projectId)
  return getTasksWithDetails(ids)
}

exports.stats = async (currentUser) => {
  const r = await repo.taskStats(isRestricted(currentUser) ? currentUser.id : null)
  const pct = (n) => (r.total > 0 ? Math.round((n / r.total) * 100) : 0)

  return {
    total: r.total,
    completed: r.completed,
    inProgress: r.in_progress,
    inReview: r.in_review,
    todo: r.todo,
    overdue: r.overdue,
    completedThisWeek: r.completed_this_week,
    completedPercent: pct(r.completed),
    inProgressPercent: pct(r.in_progress),
    inReviewPercent: pct(r.in_review),
    todoPercent: pct(r.todo),
    overduePercent: pct(r.overdue),
  }
}

// Every level in the schema CHECK is returned even at zero, so the UI renders
// a stable set of rows instead of shifting layout.
exports.priorityBreakdown = async (currentUser) => {
  const rows = await repo.priorityBreakdown(isRestricted(currentUser) ? currentUser.id : null)
  const counts = Object.fromEntries(rows.map((r) => [r.priority, r.count]))
  const total = rows.reduce((sum, r) => sum + r.count, 0)

  return {
    total,
    priorities: ['critical', 'high', 'medium', 'low'].map((level) => ({
      priority: level,
      count: counts[level] || 0,
      percent: total > 0 ? Math.round(((counts[level] || 0) / total) * 100) : 0,
    })),
  }
}

// Overdue items are included first (negative daysLeft) because a deadline card
// that hides overdue work is actively misleading.
exports.upcoming = async (currentUser, { limit = 5, days = 30 } = {}) => {
  const rows = await repo.upcomingTasks({
    days: Math.min(Number(days) || 30, 365),
    limit: Math.min(Number(limit) || 5, 50),
    scopeUserId: isRestricted(currentUser) ? currentUser.id : null,
  })

  const users = await identity.getUserCards(rows.map((r) => r.assignee_id))

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  return rows.map((r) => {
    const dueMidnight = new Date(r.due_date)
    dueMidnight.setHours(0, 0, 0, 0)
    const daysLeft = Math.round((dueMidnight - startOfToday) / 86400000)
    return {
      id: r.id,
      title: r.title,
      dueDate: r.due_date,
      priority: r.priority,
      status: r.status,
      projectName: r.project_name,
      assigneeName: users.get(r.assignee_id)?.name ?? null,
      daysLeft,
      isOverdue: daysLeft < 0,
    }
  })
}

/* ── notification fan-outs ───────────────────────────────────────────────── */

exports.notifyTaskCreated = async (currentUser, { taskId, title, assigneeId, finalStatus, type, priority, projectId }) => {
  if (assigneeId && assigneeId !== currentUser.id) {
    await notifySafely(async () => {
      await notify.dispatch({
        userId: assigneeId,
        type: notify.TYPES.TASK_ASSIGNED,
        title: 'New Task Assigned',
        message: `You have been assigned: ${title}`,
        linkTo: `/tasks/${taskId}`,
        priority: 'high',
        // Accept is only meaningful while the task is still 'todo'; the
        // endpoint re-checks that and reports 'superseded' otherwise.
        ...(finalStatus === 'todo' ? { actions: ASSIGN_ACTIONS } : {}),
      })
    })
  }

  // Manager visibility for bugs and critical-priority work — the two
  // creation-time signals worth interrupting a manager for.
  if (type === 'bug' || priority === 'critical') {
    await notifySafely(async () => {
      const managerId = await repo.findProjectManagerId(projectId)
      if (!managerId || managerId === currentUser.id) return
      const reason = type === 'bug' ? 'A new bug was reported' : 'A critical-priority task was created'
      await notify.dispatch({
        userId: managerId,
        // No dedicated category exists for this — TASK_UPDATED is intentionally
        // uncategorized, so it is always delivered rather than silently riding
        // on the unrelated "task assigned" toggle.
        type: notify.TYPES.TASK_UPDATED,
        title: type === 'bug' ? 'New bug reported' : 'Critical task created',
        message: `${reason}: ${title}`,
        linkTo: `/tasks/${taskId}`,
        priority: 'high',
      })
    })
  }
}

/**
 * Resolve @mentions in a comment.
 *
 * Matched against the email local-part and scoped to the task's project
 * members. The old query joined `users` to `project_members` with a
 * `u.status = 'active'` filter; work now reads its own member ids and identity
 * supplies the email and status.
 */
exports.resolveMentions = async (content, projectId, actorId) => {
  const tokens = [...content.matchAll(/@([a-zA-Z0-9._-]+)/g)].map((m) => m[1].toLowerCase())
  const mentioned = new Set()
  if (!tokens.length || !projectId) return mentioned

  const memberIds = await repo.findProjectMemberIds(projectId)
  const cards = await identity.getUserCards(memberIds)

  for (const card of cards.values()) {
    if (card.status !== 'active') continue
    if (!card.email) continue
    const localPart = String(card.email).split('@')[0].toLowerCase()
    if (tokens.includes(localPart) && card.id !== actorId) mentioned.add(card.id)
  }
  return mentioned
}

exports.notifyAdminsAndManagers = notifyAdminsAndManagers
exports.checkProjectMilestone = checkProjectMilestone
exports.notifySafely = notifySafely
exports.REVIEW_ACTIONS = REVIEW_ACTIONS
exports.ASSIGN_ACTIONS = ASSIGN_ACTIONS
