const pool = require('../config/db')
const { successResponse, errorResponse } = require('../utils/response')

/**
 * GET /reports/role-utilization
 * Task load and completion grouped by users.role. This schema has no team or
 * department concept — role is the only real grouping available — so the
 * "resource utilization" and "team productivity" cards are computed from it
 * rather than from invented team names.
 */
exports.getRoleUtilization = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.role,
        COUNT(DISTINCT u.id)::int AS member_count,
        COUNT(t.id)::int AS total_tasks,
        COUNT(CASE WHEN t.status = 'completed' THEN 1 END)::int AS completed_tasks,
        COUNT(CASE WHEN t.status <> 'completed' THEN 1 END)::int AS open_tasks,
        COUNT(CASE WHEN t.due_date < NOW() AND t.status <> 'completed' THEN 1 END)::int AS overdue_tasks
      FROM users u
      LEFT JOIN tasks t ON t.assignee_id = u.id
      WHERE u.status = 'active'
      GROUP BY u.role
      ORDER BY u.role
    `)

    const rows = result.rows.map((r) => ({
      role: r.role,
      memberCount: r.member_count,
      totalTasks: r.total_tasks,
      completedTasks: r.completed_tasks,
      openTasks: r.open_tasks,
      overdueTasks: r.overdue_tasks,
      // Completion rate = productivity signal.
      completionRate:
        r.total_tasks > 0 ? Math.round((r.completed_tasks / r.total_tasks) * 100) : 0,
      // Open work per active member = utilization signal.
      openPerMember:
        r.member_count > 0 ? Math.round((r.open_tasks / r.member_count) * 10) / 10 : 0,
    }))

    // Utilization is relative: the busiest role anchors the 100% bar, so the
    // chart stays meaningful regardless of absolute task volume.
    const peak = Math.max(1, ...rows.map((r) => r.openPerMember))
    return successResponse(
      res,
      rows.map((r) => ({
        ...r,
        utilizationPercent: Math.round((r.openPerMember / peak) * 100),
      }))
    )
  } catch (err) {
    console.error('getRoleUtilization error:', err)
    return errorResponse(res, 'Failed to load role utilization.', 500)
  }
}

/**
 * GET /reports/business-intelligence
 * Real period-over-period deltas from tasks.completed_at and created_at,
 * replacing the hardcoded "+18% / +12% / -5%" tiles.
 */
exports.getBusinessIntelligence = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(CASE WHEN completed_at >= NOW() - INTERVAL '30 days' THEN 1 END)::int AS completed_current,
        COUNT(CASE WHEN completed_at >= NOW() - INTERVAL '60 days'
                    AND completed_at <  NOW() - INTERVAL '30 days' THEN 1 END)::int AS completed_previous,
        COUNT(CASE WHEN created_at   >= NOW() - INTERVAL '30 days' THEN 1 END)::int AS created_current,
        COUNT(CASE WHEN created_at   >= NOW() - INTERVAL '60 days'
                    AND created_at   <  NOW() - INTERVAL '30 days' THEN 1 END)::int AS created_previous,
        COUNT(CASE WHEN due_date < NOW() AND status <> 'completed' THEN 1 END)::int AS overdue_now,
        COUNT(*)::int AS total
      FROM tasks
    `)
    const r = result.rows[0]

    // Percentage change guarding division by zero: with no prior activity a
    // positive current period reads as +100%, not Infinity.
    const delta = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0
      return Math.round(((current - previous) / previous) * 100)
    }

    const throughput = delta(r.completed_current, r.completed_previous)
    const intake = delta(r.created_current, r.created_previous)
    const overdueRate = r.total > 0 ? Math.round((r.overdue_now / r.total) * 100) : 0

    return successResponse(res, {
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
    })
  } catch (err) {
    console.error('getBusinessIntelligence error:', err)
    return errorResponse(res, 'Failed to load business intelligence.', 500)
  }
}

/**
 * GET /reports/risk-analysis
 * Risk indicators derived from real overdue counts and project end dates.
 */
exports.getRiskAnalysis = async (req, res) => {
  try {
    const [tasks, projects] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(CASE WHEN due_date < NOW() AND status <> 'completed' THEN 1 END)::int AS overdue,
          COUNT(CASE WHEN due_date >= NOW() AND due_date < NOW() + INTERVAL '7 days'
                      AND status <> 'completed' THEN 1 END)::int AS due_soon,
          COUNT(CASE WHEN assignee_id IS NULL AND status <> 'completed' THEN 1 END)::int AS unassigned
        FROM tasks
      `),
      pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(CASE WHEN end_date < NOW() AND status = 'active' THEN 1 END)::int AS past_due
        FROM projects
      `),
    ])
    const t = tasks.rows[0]
    const p = projects.rows[0]

    // Thresholds are proportional so the levels stay meaningful as the
    // dataset grows.
    const level = (count, total, warn = 0.1, high = 0.25) => {
      if (total === 0 || count === 0) return 'Low'
      const ratio = count / total
      if (ratio >= high) return 'High'
      if (ratio >= warn) return 'Medium'
      return 'Low'
    }

    return successResponse(res, {
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
    })
  } catch (err) {
    console.error('getRiskAnalysis error:', err)
    return errorResponse(res, 'Failed to load risk analysis.', 500)
  }
}

/**
 * GET /reports/task-status
 * Returns one row per status with its count, in the shape the pie chart needs:
 *   [{ name: 'Completed', value: 38, color: '#22c55e' }, ...]
 * Statuses with zero tasks are still returned (value: 0) so the legend is stable.
 */
exports.getTaskStatus = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM tasks
       GROUP BY status`
    )

    // Map DB status -> display label + chart color. Source of truth lives here
    // so the frontend chart stays a dumb renderer.
    const STATUS_META = {
      completed:   { name: 'Completed',   color: '#22c55e' },
      in_progress: { name: 'In Progress', color: '#f59e0b' },
      in_review:   { name: 'In Review',   color: '#3b82f6' },
      todo:        { name: 'To Do',       color: '#94a3b8' },
    }

    const counts = Object.fromEntries(
      result.rows.map((r) => [r.status, r.count])
    )

    const data = Object.entries(STATUS_META).map(([status, meta]) => ({
      name: meta.name,
      value: counts[status] || 0,
      color: meta.color,
    }))

    return successResponse(res, data)
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

/**
 * GET /reports/member-workload
 * Per-member task breakdown, in the bar-chart shape:
 *   [{ name: 'Jagdish D', completed: 12, inProgress: 4, todo: 1 }, ...]
 *
 * NOTE: grouped by tasks.assignee_id (who does the work). If your column is
 * named differently, change `t.assignee_id` in the JOIN below.
 * Members with no assigned tasks are still included (all zeros).
 */
exports.getMemberWorkload = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id,
         u.name,
         COUNT(CASE WHEN t.status = 'completed'   THEN 1 END)::int AS completed,
         COUNT(CASE WHEN t.status = 'in_progress' THEN 1 END)::int AS in_progress,
         COUNT(CASE WHEN t.status IN ('todo', 'in_review') THEN 1 END)::int AS todo
       FROM users u
       LEFT JOIN tasks t ON t.assignee_id = u.id
       WHERE u.status = 'active'
       GROUP BY u.id, u.name
       ORDER BY u.name ASC`
    )

    const data = result.rows.map((r) => ({
      name: r.name,
      completed: r.completed,
      inProgress: r.in_progress, // camelCase to match the chart's dataKey
      todo: r.todo,
    }))

    return successResponse(res, data)
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

/**
 * GET /reports/project-completion
 * Per-project completed vs total task counts:
 *   [{ name: 'Tracker Frontend', completed: 12, total: 20 }, ...]
 * The frontend keeps using calcProgress(completed, total), so we return raw
 * counts rather than a precomputed percentage.
 * Archived projects are excluded; projects with no tasks are still returned.
 */
exports.getProjectCompletion = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         p.id,
         p.name,
         COUNT(t.id)::int AS total,
         COUNT(CASE WHEN t.status = 'completed' THEN 1 END)::int AS completed
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id
       WHERE p.status != 'archived'
       GROUP BY p.id, p.name
       ORDER BY p.name ASC`
    )

    const data = result.rows.map((r) => ({
      name: r.name,
      completed: r.completed,
      total: r.total,
    }))

    return successResponse(res, data)
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}