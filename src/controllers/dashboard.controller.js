const pool = require('../config/db')
const { successResponse, errorResponse } = require('../utils/response')

exports.getStats = async (req, res) => {
  try {
    const isEmployee = req.user.role.toLowerCase() === 'employee'

    let projectsQuery = `
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN status='active' THEN 1 END) AS active
      FROM projects
    `

    let tasksQuery = `
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN status='completed' THEN 1 END) AS completed,
        COUNT(CASE WHEN status='in_progress' THEN 1 END) AS in_progress
      FROM tasks
    `

    let overdueQuery = `
      SELECT COUNT(*) AS total
      FROM tasks
      WHERE due_date < NOW()
      AND status != 'completed'
    `

    let projectParams = []
    let taskParams = []
    let overdueParams = []

    // Employee dashboard → only assigned tasks
    if (isEmployee) {

      projectsQuery = `
        SELECT
          COUNT(DISTINCT p.id) AS total,
          COUNT(DISTINCT CASE WHEN p.status='active' THEN p.id END) AS active
        FROM projects p
        JOIN tasks t ON t.project_id = p.id
        WHERE t.assignee_id = $1
      `

      tasksQuery += `
        WHERE assignee_id = $1
      `

      overdueQuery += `
        AND assignee_id = $1
      `

      projectParams = [req.user.id]
      taskParams = [req.user.id]
      overdueParams = [req.user.id]
    }

    const [projects, tasks, members, overdue] = await Promise.all([
      pool.query(projectsQuery, projectParams),
      pool.query(tasksQuery, taskParams),
      pool.query(
        "SELECT COUNT(*) AS total FROM users WHERE status='active'"
      ),
      pool.query(overdueQuery, overdueParams)
    ])

    return successResponse(res, {
      totalProjects: Number(projects.rows[0].total),
      activeProjects: Number(projects.rows[0].active),
      totalTasks: Number(tasks.rows[0].total),
      completedTasks: Number(tasks.rows[0].completed),
      inProgressTasks: Number(tasks.rows[0].in_progress),
      overdueTasks: Number(overdue.rows[0].total),
      teamMembers: Number(members.rows[0].total),
    })

  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}




// Per-project health, derived from real task completion and end dates.
// Classification (no scheduling table exists, so this is computed):
//   delayed  - end_date has passed with open tasks remaining
//   at_risk  - due within 7 days and less than half the tasks are done
//   on_track - everything else
exports.getProjectHealth = async (req, res) => {
  try {
    const isEmployee = (req.user.role || 'employee').toLowerCase() === 'employee'
    const params = []
    // Employees only see projects they have tasks on, matching getStats.
    let scope = ''
    if (isEmployee) {
      params.push(req.user.id)
      scope = `WHERE p.id IN (SELECT project_id FROM tasks WHERE assignee_id = $1)`
    }

    const result = await pool.query(
      `
        SELECT
          p.id,
          p.name,
          p.status,
          p.end_date,
          COUNT(t.id)::int AS total_tasks,
          COUNT(CASE WHEN t.status = 'completed' THEN 1 END)::int AS completed_tasks
        FROM projects p
        LEFT JOIN tasks t ON t.project_id = p.id
        ${scope}
        GROUP BY p.id, p.name, p.status, p.end_date
        ORDER BY p.name
      `,
      params
    )

    const projects = result.rows.map((r) => {
      const total = r.total_tasks
      const done = r.completed_tasks
      const percent = total > 0 ? Math.round((done / total) * 100) : 0
      const open = total - done

      let health = 'on_track'
      if (r.end_date) {
        const end = new Date(r.end_date)
        const daysLeft = Math.ceil((end - new Date()) / 86400000)
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
    const overallPercent = totals.all > 0 ? Math.round((totals.done / totals.all) * 100) : 0

    return successResponse(res, { overallPercent, projects })
  } catch (err) {
    console.error('getProjectHealth error:', err)
    return errorResponse(res, 'Failed to load project health.', 500)
  }
}

// Gantt geometry computed from real project start/end dates. Bar offsets are
// returned as percentages of the overall window so the client does no date
// math. Projects missing either date are excluded — they cannot be placed.
exports.getGantt = async (req, res) => {
  try {
    const isEmployee = (req.user.role || 'employee').toLowerCase() === 'employee'
    const params = []
    let scope = 'WHERE p.start_date IS NOT NULL AND p.end_date IS NOT NULL'
    if (isEmployee) {
      params.push(req.user.id)
      scope += ` AND p.id IN (SELECT project_id FROM tasks WHERE assignee_id = $1)`
    }

    const result = await pool.query(
      `
        SELECT p.id, p.name, p.status, p.start_date, p.end_date,
               COUNT(t.id)::int AS total_tasks,
               COUNT(CASE WHEN t.status = 'completed' THEN 1 END)::int AS completed_tasks
        FROM projects p
        LEFT JOIN tasks t ON t.project_id = p.id
        ${scope}
        GROUP BY p.id, p.name, p.status, p.start_date, p.end_date
        ORDER BY p.start_date
      `,
      params
    )

    if (result.rows.length === 0) {
      return successResponse(res, { windowStart: null, windowEnd: null, projects: [] })
    }

    const starts = result.rows.map((r) => new Date(r.start_date).getTime())
    const ends = result.rows.map((r) => new Date(r.end_date).getTime())
    const windowStart = Math.min(...starts)
    const windowEnd = Math.max(...ends)
    const span = Math.max(1, windowEnd - windowStart)

    const projects = result.rows.map((r) => {
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
    })

    return successResponse(res, {
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      projects,
    })
  } catch (err) {
    console.error('getGantt error:', err)
    return errorResponse(res, 'Failed to load gantt data.', 500)
  }
}

exports.getActivity = async (req, res) => {
  try {

    const isEmployee = req.user.role.toLowerCase() === 'employee'

    let query = `
      SELECT
        t.id,
        t.title,
        t.status,
        t.updated_at AS created_at,
        u.id AS user_id,
        u.name AS user_name
      FROM tasks t
      JOIN users u
        ON t.reporter_id = u.id
    `

    const params = []

    // Employee -> only assigned tasks activity
    if (isEmployee) {
      query += `
        WHERE t.assignee_id = $1
      `
      params.push(req.user.id)
    }

    query += `
      ORDER BY t.updated_at DESC
      LIMIT 10
    `

    const result = await pool.query(query, params)

    const activity = result.rows.map(r => ({
      id: r.id,
      user: {
        id: r.user_id,
        name: r.user_name
      },
      message: `updated task "${r.title}" to ${r.status.replace('_', ' ')}`,
      createdAt: r.created_at
    }))

    return successResponse(res, activity)

  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}



exports.getProjectProgress = async (req, res) => {
  try {

    const isEmployee = req.user.role.toLowerCase() === 'employee'

    let query = `
      SELECT
        p.id,
        p.name,
        p.status,
        u.name AS manager_name,
        COUNT(t.id)::int AS "tasksCount",
        COUNT(
          CASE
            WHEN t.status='completed'
            THEN 1
          END
        )::int AS "completedTasksCount"
      FROM projects p
      LEFT JOIN tasks t
        ON t.project_id = p.id
      LEFT JOIN users u
        ON p.manager_id = u.id
    `

    const params = []

    if (isEmployee) {
      query += `
        WHERE p.id IN (
          SELECT DISTINCT project_id
          FROM tasks
          WHERE assignee_id = $1
        )
      `
      params.push(req.user.id)
    }

    query += `
      GROUP BY
        p.id,
        p.name,
        p.status,
        u.name
      ORDER BY
        p.created_at DESC
    `

    const result = await pool.query(query, params)

    return successResponse(res, result.rows)

  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}


exports.getBurndown = async (req, res) => {
  try {
    const { projectId } = req.params

    const project = await pool.query(
      'SELECT start_date, end_date FROM projects WHERE id = $1',
      [projectId]
    )
    if (!project.rows[0]) return errorResponse(res, 'Project not found.', 404)

    const { start_date, end_date } = project.rows[0]

    // Total tasks in the project (the starting height of the burndown)
    const totalRes = await pool.query(
      'SELECT COUNT(*)::int AS total FROM tasks WHERE project_id = $1',
      [projectId]
    )
    const total = totalRes.rows[0].total

    // Build the day series + cumulative completed-by-end-of-day in one query.
    // Falls back to a 14-day window from start_date if end_date is missing.
    const series = await pool.query(
      `
      WITH bounds AS (
        SELECT
          $2::date AS start_day,
          COALESCE($3::date, $2::date + INTERVAL '13 day') AS end_day
      ),
      days AS (
        SELECT generate_series(
          (SELECT start_day FROM bounds),
          (SELECT end_day   FROM bounds),
          INTERVAL '1 day'
        )::date AS day
      )
      SELECT
        d.day,
        (
          SELECT COUNT(*)::int
          FROM tasks t
          WHERE t.project_id = $1
            AND t.completed_at IS NOT NULL
            AND t.completed_at::date <= d.day
        ) AS completed_by_day
      FROM days d
      ORDER BY d.day
      `,
      [projectId, start_date, end_date]
    )

    const rows = series.rows
    const span = Math.max(rows.length - 1, 1) // avoid divide-by-zero
    const today = new Date()

    const data = rows.map((row, i) => {
      const ideal = Math.max(0, Math.round(total - (total / span) * i))
      const isFuture = new Date(row.day) > today
      return {
        day: `Day ${i + 1}`,
        ideal,
        // real remaining = total - completed by that day; null for future days
        actual: isFuture ? null : Math.max(0, total - row.completed_by_day),
      }
    })

    return successResponse(res, data)
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}