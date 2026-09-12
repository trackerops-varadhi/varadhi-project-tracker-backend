// Report derivation. Owns no tables.
//
// Two of these — role-utilization and member-workload — were driven BY the
// users table (`FROM users u LEFT JOIN tasks t`). They are the queries the
// migration plan flagged as "users drives, tasks measures". insights now asks
// identity for the roster and work for each person's task load, then groups
// here, so neither module joins the other's table.

const work = require('../work')
const identity = require('../identity')

const EMPTY_LOAD = { total: 0, completed: 0, inProgress: 0, todoOrReview: 0, open: 0, overdue: 0 }

/**
 * GET /reports/role-utilization
 *
 * Task load and completion grouped by users.role. This schema has no team or
 * department concept — role is the only real grouping available — so the
 * "resource utilization" and "team productivity" cards are computed from it
 * rather than from invented team names.
 */
exports.roleUtilization = async () => {
  const users = await identity.getActiveUsers()
  const load = await work.analytics.getTaskLoadByAssignee(users.map((u) => u.id))

  // Group by role. The LEFT JOIN counted a user with no tasks as a member with
  // zero work, so an absent load entry defaults rather than being skipped.
  const byRole = new Map()
  for (const u of users) {
    const l = load.get(u.id) || EMPTY_LOAD
    const acc = byRole.get(u.role) || {
      role: u.role, memberCount: 0, totalTasks: 0, completedTasks: 0, openTasks: 0, overdueTasks: 0,
    }
    acc.memberCount += 1
    acc.totalTasks += l.total
    acc.completedTasks += l.completed
    acc.openTasks += l.open
    acc.overdueTasks += l.overdue
    byRole.set(u.role, acc)
  }

  const rows = [...byRole.values()]
    .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0)) // ORDER BY u.role
    .map((r) => ({
      ...r,
      // Completion rate = productivity signal.
      completionRate:
        r.totalTasks > 0 ? Math.round((r.completedTasks / r.totalTasks) * 100) : 0,
      // Open work per active member = utilization signal.
      openPerMember:
        r.memberCount > 0 ? Math.round((r.openTasks / r.memberCount) * 10) / 10 : 0,
    }))

  // Utilization is relative: the busiest role anchors the 100% bar, so the
  // chart stays meaningful regardless of absolute task volume.
  const peak = Math.max(1, ...rows.map((r) => r.openPerMember))
  return rows.map((r) => ({
    ...r,
    utilizationPercent: Math.round((r.openPerMember / peak) * 100),
  }))
}

/**
 * GET /reports/business-intelligence
 * Real period-over-period deltas, replacing hardcoded tiles.
 */
exports.businessIntelligence = async () => {
  const r = await work.analytics.getThroughputStats()

  // Percentage change guarding division by zero: with no prior activity a
  // positive current period reads as +100%, not Infinity.
  const delta = (current, previous) => {
    if (previous === 0) return current > 0 ? 100 : 0
    return Math.round(((current - previous) / previous) * 100)
  }

  const throughput = delta(r.completed_current, r.completed_previous)
  const intake = delta(r.created_current, r.created_previous)
  const overdueRate = r.total > 0 ? Math.round((r.overdue_now / r.total) * 100) : 0

  return {
    metrics: [
      {
        key: 'throughput',
        title: 'Throughput',
        value: `${throughput >= 0 ? '+' : ''}${throughput}%`,
        detail: `${r.completed_current} completed in 30d vs ${r.completed_previous} prior`,
        direction: throughput >= 0 ? 'up' : 'down',
        positive: throughput >= 0,
      },
      {
        key: 'intake',
        title: 'New Work',
        value: `${intake >= 0 ? '+' : ''}${intake}%`,
        detail: `${r.created_current} created in 30d vs ${r.created_previous} prior`,
        direction: intake >= 0 ? 'up' : 'down',
        // More incoming work is not inherently good or bad — neutral.
        positive: null,
      },
      {
        key: 'overdue',
        title: 'Overdue Rate',
        value: `${overdueRate}%`,
        detail: `${r.overdue_now} of ${r.total} tasks past due`,
        direction: overdueRate > 0 ? 'up' : 'flat',
        positive: overdueRate === 0,
      },
    ],
  }
}

/**
 * GET /reports/risk-analysis
 *
 * Already the template the rest of the module now follows: two independent
 * queries combined in JS rather than one cross-table join.
 */
exports.riskAnalysis = async () => {
  const [t, p] = await Promise.all([
    work.analytics.getTaskRiskCounts(),
    work.analytics.getProjectRiskCounts(),
  ])

  // Thresholds are proportional so the levels stay meaningful as the dataset
  // grows.
  const level = (count, total, warn = 0.1, high = 0.25) => {
    if (total === 0 || count === 0) return 'Low'
    const ratio = count / total
    if (ratio >= high) return 'High'
    if (ratio >= warn) return 'Medium'
    return 'Low'
  }

  return {
    risks: [
      {
        key: 'overdue',
        title: 'Overdue Tasks',
        level: level(t.overdue, t.total),
        detail: `${t.overdue} of ${t.total} tasks past their due date`,
        count: t.overdue,
      },
      {
        key: 'due_soon',
        title: 'Deadline Pressure',
        level: level(t.due_soon, t.total),
        detail: `${t.due_soon} tasks due within 7 days`,
        count: t.due_soon,
      },
      {
        key: 'unassigned',
        title: 'Unassigned Work',
        level: level(t.unassigned, t.total),
        detail: `${t.unassigned} open tasks have no assignee`,
        count: t.unassigned,
      },
      {
        key: 'project_schedule',
        title: 'Project Schedule',
        level: level(p.past_due, p.total),
        detail: `${p.past_due} of ${p.total} active projects past their end date`,
        count: p.past_due,
      },
    ],
  }
}

/**
 * GET /reports/task-status
 *
 * Statuses with zero tasks are still returned so the pie chart's legend is
 * stable. The label/colour mapping lives here so the chart stays a dumb
 * renderer.
 */
const STATUS_META = {
  completed: { name: 'Completed', color: '#22c55e' },
  in_progress: { name: 'In Progress', color: '#f59e0b' },
  in_review: { name: 'In Review', color: '#3b82f6' },
  todo: { name: 'To Do', color: '#94a3b8' },
}

exports.taskStatus = async () => {
  const rows = await work.analytics.getTaskCountsByStatus()
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.count]))

  return Object.entries(STATUS_META).map(([status, meta]) => ({
    name: meta.name,
    value: counts[status] || 0,
    color: meta.color,
  }))
}

/**
 * GET /reports/member-workload
 *
 * Per-member breakdown for the bar chart. Members with no assigned tasks are
 * still included (all zeros), which is what the LEFT JOIN produced.
 */
exports.memberWorkload = async () => {
  const users = await identity.getActiveUsers()
  const load = await work.analytics.getTaskLoadByAssignee(users.map((u) => u.id))

  // Already ordered by name — identity.getActiveUsers sorts in SQL, preserving
  // the collation the legacy `ORDER BY u.name ASC` used.
  return users.map((u) => {
    const l = load.get(u.id) || EMPTY_LOAD
    return {
      name: u.name,
      completed: l.completed,
      inProgress: l.inProgress, // camelCase to match the chart's dataKey
      todo: l.todoOrReview,
    }
  })
}

/**
 * GET /reports/project-completion
 *
 * Raw counts rather than a precomputed percentage — the frontend keeps using
 * calcProgress(completed, total). Archived projects are excluded; projects with
 * no tasks are still returned.
 */
exports.projectCompletion = async () => {
  const rows = await work.analytics.getProjectCompletionCounts()
  return rows.map((r) => ({ name: r.name, completed: r.completed, total: r.total }))
}
