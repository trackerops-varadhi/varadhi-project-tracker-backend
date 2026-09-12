// Aggregate reads over projects and tasks, for the insights module.
//
// WHY A SEPARATE FILE
// insights (dashboard + reports) owns no tables — every number it renders is a
// question about work's data. Those questions are answered here, in work, and
// exposed through work/index.js. Keeping them out of repo.js makes the reporting
// surface visible: this file is exactly what insights is allowed to ask.
//
// Each function corresponds 1:1 to a dashboard or report endpoint, and carries
// the same WHERE/GROUP BY/ORDER BY the endpoint's original query had. Ordering
// stays in SQL rather than moving to JS, because Postgres collation and
// localeCompare do not agree on name ordering.
//
// The `users` joins are gone. Where a query was driven BY users
// (role-utilization, member-workload) insights now asks identity for the people
// and work for their task load, then groups in JS.

const pool = require('../../platform/db').forSchema('work')

// Employees see only their own work, matching every list endpoint.
const scopeClause = (scopeUserId, params, column = 't.assignee_id') => {
  if (!scopeUserId) return ''
  params.push(scopeUserId)
  return ` AND ${column} = $${params.length}`
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* Dashboard                                                                  */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * Headline counters. Three queries, exactly as before — an employee's project
 * count is "projects I have a task on", which is a different query rather than
 * a filter on the same one.
 */
exports.dashboardCounters = async (scopeUserId) => {
  const projectsSql = scopeUserId
    ? `SELECT COUNT(DISTINCT p.id) AS total,
              COUNT(DISTINCT CASE WHEN p.status='active' THEN p.id END) AS active
         FROM projects p
         JOIN tasks t ON t.project_id = p.id
        WHERE t.assignee_id = $1`
    : `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN status='active' THEN 1 END) AS active
         FROM projects`

  const tasksSql = `
    SELECT COUNT(*) AS total,
           COUNT(CASE WHEN status='completed' THEN 1 END) AS completed,
           COUNT(CASE WHEN status='in_progress' THEN 1 END) AS in_progress
      FROM tasks${scopeUserId ? ' WHERE assignee_id = $1' : ''}`

  const overdueSql = `
    SELECT COUNT(*) AS total
      FROM tasks
     WHERE due_date < NOW() AND status != 'completed'${scopeUserId ? ' AND assignee_id = $1' : ''}`

  const params = scopeUserId ? [scopeUserId] : []
  const [projects, tasks, overdue] = await Promise.all([
    pool.query(projectsSql, params),
    pool.query(tasksSql, params),
    pool.query(overdueSql, params),
  ])

  return {
    projects: projects.rows[0],
    tasks: tasks.rows[0],
    overdue: overdue.rows[0],
  }
}

/** Per-project task rollup + end date, ordered by name. Drives project health. */
exports.projectHealthRollup = async (scopeUserId) => {
  const params = []
  const scope = scopeUserId
    ? (params.push(scopeUserId),
      `WHERE p.id IN (SELECT project_id FROM tasks WHERE assignee_id = $${params.length})`)
    : ''

  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.status, p.end_date,
            COUNT(t.id)::int AS total_tasks,
            COUNT(CASE WHEN t.status = 'completed' THEN 1 END)::int AS completed_tasks
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id
       ${scope}
      GROUP BY p.id, p.name, p.status, p.end_date
      ORDER BY p.name`,
    params
  )
  return rows
}

/** Same rollup plus start date, restricted to placeable projects, by start date. */
exports.ganttRollup = async (scopeUserId) => {
  const params = []
  let scope = 'WHERE p.start_date IS NOT NULL AND p.end_date IS NOT NULL'
  if (scopeUserId) {
    params.push(scopeUserId)
    scope += ` AND p.id IN (SELECT project_id FROM tasks WHERE assignee_id = $${params.length})`
  }

  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.status, p.start_date, p.end_date,
            COUNT(t.id)::int AS total_tasks,
            COUNT(CASE WHEN t.status = 'completed' THEN 1 END)::int AS completed_tasks
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id
       ${scope}
      GROUP BY p.id, p.name, p.status, p.start_date, p.end_date
      ORDER BY p.start_date`,
    params
  )
  return rows
}

/**
 * Recent task activity, newest first.
 *
 * `reporter_id IS NOT NULL` reproduces the legacy `JOIN users` exactly: an
 * INNER join dropped tasks with no reporter, and it did so BEFORE the LIMIT —
 * so filtering here rather than after the fetch keeps the page size right.
 */
exports.recentTaskActivity = async (scopeUserId, limit = 10) => {
  const params = []
  let where = 'WHERE t.reporter_id IS NOT NULL'
  where += scopeClause(scopeUserId, params)
  params.push(limit)

  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.status, t.updated_at AS created_at, t.reporter_id
       FROM tasks t
       ${where}
      ORDER BY t.updated_at DESC
      LIMIT $${params.length}`,
    params
  )
  return rows
}

/** Per-project counts + manager id, newest project first. */
exports.projectProgressRollup = async (scopeUserId) => {
  const params = []
  const scope = scopeUserId
    ? (params.push(scopeUserId),
      `WHERE p.id IN (SELECT DISTINCT project_id FROM tasks WHERE assignee_id = $${params.length})`)
    : ''

  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.status, p.manager_id,
            COUNT(t.id)::int AS "tasksCount",
            COUNT(CASE WHEN t.status='completed' THEN 1 END)::int AS "completedTasksCount"
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id
       ${scope}
      GROUP BY p.id, p.name, p.status, p.manager_id
      ORDER BY p.created_at DESC`,
    params
  )
  return rows
}

/** Project window, total tasks, and cumulative completions per day. */
exports.burndown = async (projectId) => {
  const project = await pool.query(
    'SELECT start_date, end_date FROM projects WHERE id = $1',
    [projectId]
  )
  if (!project.rows[0]) return null

  const { start_date, end_date } = project.rows[0]

  const totalRes = await pool.query(
    'SELECT COUNT(*)::int AS total FROM tasks WHERE project_id = $1',
    [projectId]
  )

  // Day series + cumulative completed-by-end-of-day in one query. Falls back to
  // a 14-day window from start_date when end_date is missing.
  const series = await pool.query(
    `
    WITH bounds AS (
      SELECT $2::date AS start_day,
             COALESCE($3::date, $2::date + INTERVAL '13 day') AS end_day
    ),
    days AS (
      SELECT generate_series(
        (SELECT start_day FROM bounds),
        (SELECT end_day   FROM bounds),
        INTERVAL '1 day'
      )::date AS day
    )
    SELECT d.day,
           (SELECT COUNT(*)::int
              FROM tasks t
             WHERE t.project_id = $1
               AND t.completed_at IS NOT NULL
               AND t.completed_at::date <= d.day) AS completed_by_day
      FROM days d
     ORDER BY d.day`,
    [projectId, start_date, end_date]
  )

  return { total: totalRes.rows[0].total, series: series.rows }
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* Reports                                                                    */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * Task load per assignee, broken down by status.
 *
 * Replaces the `users LEFT JOIN tasks ... GROUP BY` in role-utilization and
 * member-workload. insights asks identity who the active people are, asks this
 * how much work each has, and groups in JS — so `users` is never joined.
 *
 * Assignees with no tasks are simply absent; callers default to zero, which is
 * what the LEFT JOIN produced.
 */
exports.taskLoadByAssignee = async (userIds) => {
  const { rows } = await pool.query(
    `SELECT assignee_id,
            COUNT(*)::int                                                     AS total,
            COUNT(CASE WHEN status = 'completed'   THEN 1 END)::int           AS completed,
            COUNT(CASE WHEN status = 'in_progress' THEN 1 END)::int           AS in_progress,
            COUNT(CASE WHEN status IN ('todo','in_review') THEN 1 END)::int   AS todo_or_review,
            COUNT(CASE WHEN status <> 'completed'  THEN 1 END)::int           AS open,
            COUNT(CASE WHEN due_date < NOW() AND status <> 'completed' THEN 1 END)::int AS overdue
       FROM tasks
      WHERE assignee_id = ANY($1::uuid[])
      GROUP BY assignee_id`,
    [userIds]
  )
  return rows
}

/** Period-over-period throughput, intake and overdue rate. */
exports.throughputStats = async () => {
  const { rows } = await pool.query(`
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
  return rows[0]
}

/** Task-side risk counters. */
exports.taskRiskCounts = async () => {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(CASE WHEN due_date < NOW() AND status <> 'completed' THEN 1 END)::int AS overdue,
           COUNT(CASE WHEN due_date >= NOW() AND due_date < NOW() + INTERVAL '7 days'
                       AND status <> 'completed' THEN 1 END)::int AS due_soon,
           COUNT(CASE WHEN assignee_id IS NULL AND status <> 'completed' THEN 1 END)::int AS unassigned
      FROM tasks
  `)
  return rows[0]
}

/** Project-side risk counters. */
exports.projectRiskCounts = async () => {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(CASE WHEN end_date < NOW() AND status = 'active' THEN 1 END)::int AS past_due
      FROM projects
  `)
  return rows[0]
}

/** One row per task status present. */
exports.taskCountsByStatus = async () => {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS count FROM tasks GROUP BY status`
  )
  return rows
}

/** Completed vs total per non-archived project, by name. */
exports.projectCompletionCounts = async () => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name,
            COUNT(t.id)::int AS total,
            COUNT(CASE WHEN t.status = 'completed' THEN 1 END)::int AS completed
       FROM projects p
       LEFT JOIN tasks t ON t.project_id = p.id
      WHERE p.status != 'archived'
      GROUP BY p.id, p.name
      ORDER BY p.name ASC`
  )
  return rows
}
