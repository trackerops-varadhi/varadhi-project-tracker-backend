// Dashboard derivation. Owns no tables — every number comes from work's
// analytics interface and identity's roster, and the arithmetic, thresholds and
// shaping happen here.

const work = require('../work')
const identity = require('../identity')

const isEmployee = (user) => String(user?.role || 'employee').toLowerCase() === 'employee'
const scopeOf = (user) => (isEmployee(user) ? user.id : null)

/** Headline counters. */
exports.stats = async (currentUser) => {
  const [counters, teamMembers] = await Promise.all([
    work.analytics.getDashboardCounters(scopeOf(currentUser)),
    identity.getActiveUserCount(),
  ])

  return {
    totalProjects: Number(counters.projects.total),
    activeProjects: Number(counters.projects.active),
    totalTasks: Number(counters.tasks.total),
    completedTasks: Number(counters.tasks.completed),
    inProgressTasks: Number(counters.tasks.in_progress),
    overdueTasks: Number(counters.overdue.total),
    teamMembers,
  }
}

/**
 * Per-project health, derived from real task completion and end dates.
 *
 * No scheduling table exists, so the classification is computed:
 *   delayed  - end_date has passed with open tasks remaining
 *   at_risk  - due within 7 days and less than half the tasks are done
 *   on_track - everything else
 */
exports.projectHealth = async (currentUser) => {
  const rows = await work.analytics.getProjectHealthRollup(scopeOf(currentUser))

  const projects = rows.map((r) => {
    const total = r.total_tasks
    const done = r.completed_tasks
    const percent = total > 0 ? Math.round((done / total) * 100) : 0
    const open = total - done

    let health = 'on_track'
    if (r.end_date) {
      const daysLeft = Math.ceil((new Date(r.end_date) - new Date()) / 86400000)
      if (daysLeft < 0 && open > 0) health = 'delayed'
      else if (daysLeft <= 7 && percent < 50) health = 'at_risk'
    }
    if (r.status === 'completed') health = 'on_track'

    return {
      id: r.id,
      name: r.name,
      status: r.status,
      endDate: r.end_date,
      totalTasks: total,
      completedTasks: done,
      percent,
      health,
    }
  })

  // Overall percentage across every task in scope — drives the gauge.
  const totals = projects.reduce(
    (acc, p) => ({ done: acc.done + p.completedTasks, all: acc.all + p.totalTasks }),
    { done: 0, all: 0 }
  )

  return {
    overallPercent: totals.all > 0 ? Math.round((totals.done / totals.all) * 100) : 0,
    projects,
  }
}

/**
 * Gantt geometry. Bar offsets are returned as percentages of the overall window
 * so the client does no date maths. Projects missing either date are excluded
 * by the query — they cannot be placed.
 */
exports.gantt = async (currentUser) => {
  const rows = await work.analytics.getGanttRollup(scopeOf(currentUser))

  if (rows.length === 0) {
    return { windowStart: null, windowEnd: null, projects: [] }
  }

  const starts = rows.map((r) => new Date(r.start_date).getTime())
  const ends = rows.map((r) => new Date(r.end_date).getTime())
  const windowStart = Math.min(...starts)
  const windowEnd = Math.max(...ends)
  const span = Math.max(1, windowEnd - windowStart)

  return {
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    projects: rows.map((r) => {
      const s = new Date(r.start_date).getTime()
      const e = new Date(r.end_date).getTime()
      const total = r.total_tasks
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        startDate: r.start_date,
        endDate: r.end_date,
        // Percentages of the shared window, ready for CSS left/width.
        offsetPercent: Math.round(((s - windowStart) / span) * 10000) / 100,
        widthPercent: Math.max(1, Math.round(((e - s) / span) * 10000) / 100),
        percent: total > 0 ? Math.round((r.completed_tasks / total) * 100) : 0,
      }
    }),
  }
}

/**
 * Recent activity feed.
 *
 * The reporter's name used to come from an INNER `JOIN users`. work now filters
 * to tasks that have a reporter (which is what the inner join did, and it did
 * it before the LIMIT), and identity supplies the names.
 */
exports.activity = async (currentUser) => {
  const rows = await work.analytics.getRecentTaskActivity(scopeOf(currentUser), 10)
  const users = await identity.getUserCards(rows.map((r) => r.reporter_id))

  return rows.map((r) => ({
    id: r.id,
    user: {
      id: r.reporter_id,
      name: users.get(r.reporter_id)?.name ?? null,
    },
    message: `updated task "${r.title}" to ${r.status.replace('_', ' ')}`,
    createdAt: r.created_at,
  }))
}

/**
 * Per-project progress.
 *
 * Legacy shape: the raw query rows, so `manager_name` stays snake_case while
 * `tasksCount` / `completedTasksCount` were already quoted camelCase aliases.
 * Preserved exactly — the Projects card reads these keys.
 */
exports.projectProgress = async (currentUser) => {
  const rows = await work.analytics.getProjectProgressRollup(scopeOf(currentUser))
  const managers = await identity.getUserCards(rows.map((r) => r.manager_id))

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    manager_name: managers.get(r.manager_id)?.name ?? null,
    tasksCount: r.tasksCount,
    completedTasksCount: r.completedTasksCount,
  }))
}

/** Burndown series. Returns null when the project does not exist. */
exports.burndown = async (projectId) => {
  const data = await work.analytics.getBurndown(projectId)
  if (!data) return null

  const { total, series } = data
  const span = Math.max(series.length - 1, 1) // avoid divide-by-zero
  const today = new Date()

  return series.map((row, i) => {
    const ideal = Math.max(0, Math.round(total - (total / span) * i))
    const isFuture = new Date(row.day) > today
    return {
      day: `Day ${i + 1}`,
      ideal,
      // Real remaining = total - completed by that day; null for future days.
      actual: isFuture ? null : Math.max(0, total - row.completed_by_day),
    }
  })
}
