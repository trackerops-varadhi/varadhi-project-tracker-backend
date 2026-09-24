// SQL for the work module (projects · project_members · tasks · comments).
// This module owns all four tables. No other module may require this file.
//
// WHAT CHANGED
// Joins to `projects` and `tasks` are KEPT — work owns both, so they are inside
// the boundary. Every `LEFT JOIN users` is gone; assignee, reporter, manager,
// member and comment-author names now come from identity.getUserCards().
//
// Still true and not this phase's problem: dashboard.controller.js and
// reports.controller.js query `tasks` and `projects` directly. That is table
// ownership, which Phase 2 (schemas) enforces — Phase 1 only draws the code
// boundary. Those two move into an `insights` module later.

const pool = require('../../platform/db').forSchema('work')
const { matchesClause, toTimestampParam } = require('./concurrency')

exports.connect = () => pool.connect()

/* ══════════════════════════════════════════════════════════════════════════ */
/* Projects                                                                   */
/* ══════════════════════════════════════════════════════════════════════════ */

const projectFilter = (spec, params) => {
  let where = 'WHERE 1=1'
  if (spec.status) { params.push(spec.status); where += ` AND status = $${params.length}` }
  if (spec.search) { params.push(`%${spec.search}%`); where += ` AND name ILIKE $${params.length}` }
  return where
}

exports.countProjects = async (spec) => {
  const params = []
  const where = projectFilter(spec, params)
  const { rows } = await pool.query(`SELECT COUNT(*) FROM projects ${where}`, params)
  return parseInt(rows[0].count)
}

exports.listProjectIds = async (spec, { limit, offset }) => {
  const params = []
  const where = projectFilter(spec, params)
  params.push(limit, offset)
  const { rows } = await pool.query(
    `SELECT id FROM projects ${where}
      ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return rows.map((r) => r.id)
}

exports.findProject = async (id) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id])
  return rows[0] || null
}

/**
 * Everyone actually participating in a project.
 *
 * Explicit project_members rows are not the whole picture — a task can be
 * assigned to someone never formally added to the project (nothing syncs task
 * assignment into project_members), so the Members tab was silently dropping
 * real participants. The UNION with task assignees reflects actual
 * participation rather than just explicit membership.
 *
 * Returns ids only; identity resolves them to people.
 */
exports.findProjectParticipantIds = async (projectId) => {
  const { rows } = await pool.query(
    `SELECT user_id FROM project_members WHERE project_id = $1
     UNION
     SELECT assignee_id FROM tasks WHERE project_id = $1 AND assignee_id IS NOT NULL`,
    [projectId]
  )
  return rows.map((r) => r.user_id).filter(Boolean)
}

exports.findProjectTaskCounts = async (projectId) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(CASE WHEN status = 'completed' THEN 1 END)::int AS completed
       FROM tasks WHERE project_id = $1`,
    [projectId]
  )
  return rows[0]
}

exports.findProjectNameAndManager = async (id) => {
  const { rows } = await pool.query('SELECT name, manager_id FROM projects WHERE id = $1', [id])
  return rows[0] || null
}

exports.findProjectManagerId = async (id) => {
  const { rows } = await pool.query('SELECT manager_id FROM projects WHERE id = $1', [id])
  return rows[0]?.manager_id
}

exports.insertProject = async ({ name, description, managerId, startDate, endDate }) => {
  const { rows } = await pool.query(
    `INSERT INTO projects (name, description, manager_id, start_date, end_date)
          VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [name, description, managerId, startDate, endDate]
  )
  return rows[0].id
}

exports.addMember = async (projectId, userId) => {
  await pool.query(
    'INSERT INTO project_members VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [projectId, userId]
  )
}

exports.removeMember = async (projectId, userId) => {
  await pool.query(
    'DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',
    [projectId, userId]
  )
}

exports.updateProject = async (id, { name, description, status, startDate, endDate, managerId }) => {
  const { rows } = await pool.query(
    `UPDATE projects SET
        name        = COALESCE($1, name),
        description = COALESCE($2, description),
        status      = COALESCE($3, status),
        start_date  = COALESCE($4, start_date),
        end_date    = COALESCE($5, end_date),
        manager_id  = COALESCE($6, manager_id),
        updated_at  = NOW()
      WHERE id = $7 RETURNING id`,
    [name, description, status, startDate, endDate, managerId, id]
  )
  return rows[0] || null
}

exports.archiveProject = async (id) => {
  const { rows } = await pool.query(
    "UPDATE projects SET status='archived', updated_at=NOW() WHERE id=$1 RETURNING id",
    [id]
  )
  return rows[0] || null
}

/**
 * Delete a project and its tasks, and report which task ids went.
 *
 * The tasks would cascade on their own — work.tasks has an ON DELETE CASCADE to
 * work.projects — but a cascade is silent, and the project.deleted event must
 * name every task it took so other modules can drop what pointed at them. So
 * the tasks are deleted explicitly with RETURNING, then the project.
 * project_members and comments still cascade inside the schema.
 *
 * The project row is locked first. Inserting a task takes a KEY SHARE lock on
 * its project to check the foreign key, which FOR UPDATE blocks — so a task
 * created while this runs either commits before the lock (and is returned
 * here) or fails its FK check after the commit. Without the lock it could land
 * between the two DELETEs and be cascaded away without appearing in taskIds.
 *
 * @returns {Promise<{id: string, taskIds: string[]}|null>} null if not found
 */
exports.deleteProject = async (id) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const locked = await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [id])
    if (!locked.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }

    const tasks = await client.query('DELETE FROM tasks WHERE project_id=$1 RETURNING id', [id])
    await client.query('DELETE FROM projects WHERE id=$1', [id])

    await client.query('COMMIT')
    return { id, taskIds: tasks.rows.map((r) => r.id) }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* Tasks                                                                      */
/* ══════════════════════════════════════════════════════════════════════════ */

const taskFilter = (spec, params) => {
  let where = 'WHERE 1=1'
  if (spec.scopeUserId) { params.push(spec.scopeUserId); where += ` AND t.assignee_id = $${params.length}` }
  if (spec.status) { params.push(spec.status); where += ` AND t.status = $${params.length}` }
  if (spec.priority) { params.push(spec.priority); where += ` AND t.priority = $${params.length}` }
  if (spec.type) { params.push(spec.type); where += ` AND t.type = $${params.length}` }
  if (spec.assigneeId) { params.push(spec.assigneeId); where += ` AND t.assignee_id = $${params.length}` }
  if (spec.projectId) { params.push(spec.projectId); where += ` AND t.project_id = $${params.length}` }
  if (spec.search) { params.push(`%${spec.search}%`); where += ` AND t.title ILIKE $${params.length}` }
  return where
}

exports.countTasks = async (spec) => {
  const params = []
  const where = taskFilter(spec, params)
  const { rows } = await pool.query(`SELECT COUNT(*) FROM tasks t ${where}`, params)
  return parseInt(rows[0].count)
}

exports.listTaskIds = async (spec, { limit, offset }) => {
  const params = []
  const where = taskFilter(spec, params)
  params.push(limit, offset)
  const { rows } = await pool.query(
    `SELECT t.id FROM tasks t ${where}
      ORDER BY t.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return rows.map((r) => r.id)
}

exports.findTaskIdsByProject = async (projectId) => {
  const { rows } = await pool.query(
    'SELECT id FROM tasks WHERE project_id = $1 ORDER BY created_at DESC',
    [projectId]
  )
  return rows.map((r) => r.id)
}

// `projects` is joined (work owns it); the two `users` joins are gone.
exports.findTaskRow = async (taskId) => {
  const { rows } = await pool.query(
    `SELECT t.*, p.id AS project_id, p.name AS project_name
       FROM tasks t
       LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.id = $1`,
    [taskId]
  )
  return rows[0] || null
}

exports.findTaskComments = async (taskId) => {
  const { rows } = await pool.query(
    `SELECT id, content, created_at, author_id
       FROM comments WHERE task_id = $1 ORDER BY created_at ASC`,
    [taskId]
  )
  return rows
}

exports.findTaskOwner = async (id) => {
  const { rows } = await pool.query('SELECT assignee_id FROM tasks WHERE id = $1', [id])
  return rows[0] || null
}

exports.findTaskSnapshot = async (id) => {
  const { rows } = await pool.query(
    'SELECT assignee_id, due_date, priority FROM tasks WHERE id = $1',
    [id]
  )
  return rows[0] || null
}

const scopeFragment = (scopeUserId) =>
  scopeUserId ? { where: 'WHERE assignee_id = $1', params: [scopeUserId] } : { where: '', params: [] }

exports.taskStats = async (scopeUserId) => {
  const { where, params } = scopeFragment(scopeUserId)
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(CASE WHEN status = 'completed'   THEN 1 END)::int AS completed,
       COUNT(CASE WHEN status = 'in_progress' THEN 1 END)::int AS in_progress,
       COUNT(CASE WHEN status = 'in_review'   THEN 1 END)::int AS in_review,
       COUNT(CASE WHEN status = 'todo'        THEN 1 END)::int AS todo,
       COUNT(CASE WHEN due_date < NOW() AND status <> 'completed' THEN 1 END)::int AS overdue,
       COUNT(CASE WHEN completed_at > NOW() - INTERVAL '7 days'   THEN 1 END)::int AS completed_this_week
     FROM tasks ${where}`,
    params
  )
  return rows[0]
}

exports.priorityBreakdown = async (scopeUserId) => {
  const { where, params } = scopeFragment(scopeUserId)
  const { rows } = await pool.query(
    `SELECT priority, COUNT(*)::int AS count FROM tasks ${where} GROUP BY priority`,
    params
  )
  return rows
}

exports.upcomingTasks = async ({ days, limit, scopeUserId }) => {
  const params = [days, limit]
  let scope = ''
  if (scopeUserId) {
    params.push(scopeUserId)
    scope = ` AND t.assignee_id = $${params.length}`
  }
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.due_date, t.priority, t.status, t.assignee_id,
            p.name AS project_name
       FROM tasks t
       LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.due_date IS NOT NULL
        AND t.status <> 'completed'
        AND t.due_date < NOW() + ($1 || ' days')::interval
        ${scope}
      ORDER BY t.due_date ASC
      LIMIT $2`,
    params
  )
  return rows
}

exports.insertTask = async ({
  title, description, userStory, acceptanceCriteria, status, priority, type,
  projectId, assigneeId, reporterId, dueDate, estimatedHours, tags, completedAt,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO tasks (
       title, description, user_story, acceptance_criteria, status, priority, type,
       project_id, assignee_id, reporter_id, due_date, estimated_hours, tags, completed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      title, description, userStory, acceptanceCriteria, status, priority, type,
      projectId, assigneeId, reporterId, dueDate, estimatedHours, tags, completedAt,
    ]
  )
  return rows[0].id
}

// Always 'todo' status and 'bug' type — this exists for exactly one caller (a
// development task raised from a defect) rather than being a general factory.
exports.insertBugTask = async ({
  title, description, priority, projectId, assigneeId, reporterId, dueDate,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO tasks (title, description, status, priority, type,
                        project_id, assignee_id, reporter_id, due_date)
          VALUES ($1,$2,'todo',$3,'bug',$4,$5,$6,$7)
       RETURNING id`,
    [title, description, priority, projectId, assigneeId, reporterId, dueDate]
  )
  return rows[0]
}

/**
 * Compare-and-swap a task's status: move `id` from `fromStatus` to `toStatus`,
 * and do nothing at all if it is not currently in `fromStatus`.
 *
 * This is the concurrency primitive behind notification actions. It used to be
 * an inline UPDATE inside notify's transaction, which worked only while both
 * tables shared one schema. Now that `tasks` belongs to work, the guard has to
 * live here — and it carries the whole mutex, because there is no longer a
 * shared transaction to hold one.
 *
 * Two racing approvals both read status='todo' and both call this; Postgres
 * serialises the two UPDATEs on the row, so exactly one matches the WHERE and
 * the other returns zero rows. That is what makes a duplicate approval
 * impossible without a cross-schema lock.
 *
 * @returns {Promise<{id, status, previous}|null>} null when the CAS did not match
 */
exports.compareAndSwapTaskStatus = async (id, fromStatus, toStatus) => {
  // $4 carries "is this the completed state?" as its own boolean rather than
  // re-testing $3. Using $3 both as the value for `status` and inside a text
  // comparison makes Postgres deduce two different types for one parameter and
  // fail with `inconsistent types deduced for parameter $3`.
  const { rows } = await pool.query(
    `UPDATE tasks
        SET status = $3,
            completed_at = CASE
              WHEN $4 THEN COALESCE(completed_at, NOW())
              ELSE NULL
            END,
            updated_at = NOW()
      WHERE id = $1 AND status = $2
      RETURNING id, status`,
    [id, fromStatus, toStatus, toStatus === 'completed']
  )
  if (!rows[0]) return null
  return { id: rows[0].id, status: rows[0].status, previous: fromStatus }
}

// The employee path: status only, on a task already confirmed to be theirs.
exports.updateTaskStatusOnly = async (id, status) => {
  const { rows } = await pool.query(
    `UPDATE tasks
        SET status = COALESCE($1, status),
            completed_at = CASE
              WHEN COALESCE($1::text, status::text) = 'completed'
              THEN COALESCE(completed_at, NOW())
              ELSE NULL
            END,
            updated_at = NOW()
      WHERE id = $2
      RETURNING id`,
    [status, id]
  )
  return rows[0] || null
}

/**
 * The full field update, optionally guarded by optimistic concurrency.
 *
 * `baseUpdatedAt` is a Date or null. Null means unguarded, which is the
 * pre-existing behaviour for every caller that does not opt in.
 */
exports.updateTaskFields = async (id, fields, baseUpdatedAt) => {
  const {
    title, description, userStory, acceptanceCriteria, status, priority, type,
    assigneeId, dueDate, estimatedHours, actualHours, tags,
  } = fields

  const { rows } = await pool.query(
    `UPDATE tasks SET
       title               = COALESCE($1,  title),
       description         = COALESCE($2,  description),
       user_story          = COALESCE($3,  user_story),
       acceptance_criteria = COALESCE($4,  acceptance_criteria),
       status              = COALESCE($5,  status),
       completed_at = CASE
         WHEN COALESCE($5::text, status::text) = 'completed'
         THEN COALESCE(completed_at, NOW())
         ELSE NULL
       END,
       priority            = COALESCE($6,  priority),
       type                = COALESCE($7,  type),
       assignee_id         = COALESCE($8,  assignee_id),
       due_date            = COALESCE($9,  due_date),
       estimated_hours     = COALESCE($10, estimated_hours),
       actual_hours        = COALESCE($11, actual_hours),
       tags                = COALESCE($12, tags),
       updated_at          = NOW()
     WHERE id = $13
       AND ${matchesClause(14)}
     RETURNING id`,
    [
      title, description, userStory, acceptanceCriteria, status, priority, type,
      assigneeId, dueDate, estimatedHours, actualHours, tags,
      id, toTimestampParam(baseUpdatedAt),
    ]
  )
  return rows[0] || null
}

exports.updateTaskStatusGuarded = async (id, status, completedAt, baseUpdatedAt) => {
  const { rows } = await pool.query(
    `UPDATE tasks
        SET status = $1, completed_at = $2, updated_at = NOW()
      WHERE id = $3
        AND ${matchesClause(4)}
      RETURNING id`,
    [status, completedAt, id, toTimestampParam(baseUpdatedAt)]
  )
  return rows[0] || null
}

exports.deleteTask = async (id) => {
  const { rows } = await pool.query('DELETE FROM tasks WHERE id=$1 RETURNING id', [id])
  return rows[0] || null
}

/**
 * Distinguish a lost concurrency race from a missing row.
 *
 * A guarded UPDATE matching zero rows is ambiguous — the id may not exist, or
 * may exist with a different updated_at. Re-read to tell them apart so the
 * client gets 404 vs 409 correctly.
 */
exports.classifyFailedUpdate = async (taskId) => {
  const { rows } = await pool.query('SELECT updated_at FROM tasks WHERE id = $1', [taskId])
  if (!rows[0]) return { kind: 'missing' }
  return { kind: 'conflict', currentUpdatedAt: rows[0].updated_at }
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* Comments                                                                   */
/* ══════════════════════════════════════════════════════════════════════════ */

exports.insertComment = async (content, taskId, authorId) => {
  await pool.query(
    'INSERT INTO comments (content, task_id, author_id) VALUES ($1,$2,$3)',
    [content, taskId, authorId]
  )
}

// Scoped to the author: a user may only delete their own comment. Unchanged.
exports.deleteComment = async (commentId, authorId) => {
  await pool.query('DELETE FROM comments WHERE id=$1 AND author_id=$2', [commentId, authorId])
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* Cross-module read helpers (consumed via index.js)                          */
/* ══════════════════════════════════════════════════════════════════════════ */

exports.findProjectCards = async (ids) => {
  const { rows } = await pool.query(
    `SELECT id, name, status FROM projects WHERE id = ANY($1::uuid[])`,
    [ids]
  )
  return rows
}

exports.findProjectMemberIds = async (projectId) => {
  const { rows } = await pool.query(
    `SELECT user_id FROM project_members WHERE project_id = $1`,
    [projectId]
  )
  return rows.map((r) => r.user_id)
}

exports.searchProjectIds = async (likeTerm) => {
  const { rows } = await pool.query(`SELECT id FROM projects WHERE name ILIKE $1`, [likeTerm])
  return rows.map((r) => r.id)
}

exports.findProjectManagers = async (ids) => {
  const { rows } = await pool.query(
    `SELECT id, manager_id FROM projects WHERE id = ANY($1::uuid[])`,
    [ids]
  )
  return rows
}

exports.findTaskCards = async (ids) => {
  const { rows } = await pool.query(
    `SELECT id, title, status FROM tasks WHERE id = ANY($1::uuid[])`,
    [ids]
  )
  return rows
}

// Total and completed task counts per assignee. Replaces the two places
// users.controller.js measured `tasks` itself — a scalar subquery on the user
// list, and an aggregate JOIN behind "top performers".
/* ── Reads for the integrations module ──────────────────────────────────── */
//
// Calendar sync mirrors tasks and project milestones onto a user's calendar,
// and Teams renders task context into Adaptive Cards. Both used to query
// `tasks` and `projects` directly; these are the same queries, now owned here.

/** Tasks a user's calendar should mirror. `projectIds` narrows to a scope. */
exports.findSyncableTasks = async (userId, projectIds = null) => {
  const params = [userId]
  let scope = ''
  if (Array.isArray(projectIds) && projectIds.length > 0) {
    params.push(projectIds)
    scope = ` AND t.project_id = ANY($${params.length}::uuid[])`
  }

  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.description, t.due_date, t.priority, t.status,
            p.name AS project_name
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.assignee_id = $1
        AND t.due_date IS NOT NULL
        AND t.status NOT IN ('completed')${scope}`,
    params
  )
  return rows
}

/** Project end dates a user should see as milestones: theirs to manage or join. */
exports.findSyncableMilestones = async (userId) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT p.id, p.name, p.end_date
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id
      WHERE p.end_date IS NOT NULL
        AND p.status = 'active'
        AND (p.manager_id = $1 OR pm.user_id = $1)`,
    [userId]
  )
  return rows
}

/**
 * Due-date-only write, for a calendar-side reschedule pulled back in.
 *
 * Deliberately narrow: inbound calendar sync may move a deadline and nothing
 * else. It can never create, retitle or restatus a task, and this signature is
 * what enforces that.
 */
exports.updateTaskDueDate = async (taskId, dueDate) => {
  await pool.query(
    `UPDATE tasks SET due_date = $2, updated_at = NOW() WHERE id = $1`,
    [taskId, dueDate]
  )
}

/** The calendar preview on the dashboard — upcoming, unfinished, windowed. */
exports.findUpcomingTasksForUser = async (userId, days, limit) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.description, t.due_date, t.priority, t.status,
            p.name AS project_name
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.assignee_id = $1
        AND t.due_date IS NOT NULL
        AND t.status NOT IN ('completed')
        AND t.due_date >= CURRENT_DATE
        AND t.due_date <= CURRENT_DATE + ($2 || ' days')::interval
      ORDER BY t.due_date ASC
      LIMIT $3`,
    [userId, String(days), limit]
  )
  return rows
}

/** Enough of a task to render a Teams card. */
exports.findTaskSummary = async (taskId) => {
  const { rows } = await pool.query(
    `SELECT id, title, due_date, status, priority, project_id, assignee_id
       FROM tasks WHERE id = $1`,
    [taskId]
  )
  return rows[0] || null
}

/**
 * Counts for the Teams summary digest. A null projectId aggregates across
 * every project, which is what a global webhook wants.
 */
exports.taskDigestCounts = async (projectId) => {
  const params = []
  let where = `WHERE 1=1`
  if (projectId) {
    params.push(projectId)
    where += ` AND t.project_id = $1`
  }

  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE t.status = 'completed'
                        AND t.updated_at > NOW() - interval '24 hours')::int AS completed,
       COUNT(*) FILTER (WHERE t.status = 'in_progress')::int                 AS in_progress,
       COUNT(*) FILTER (WHERE t.due_date < CURRENT_DATE
                        AND t.status <> 'completed')::int                    AS overdue,
       COUNT(*) FILTER (WHERE t.due_date = CURRENT_DATE
                        AND t.status <> 'completed')::int                    AS due_today
     FROM tasks t ${where}`,
    params
  )
  return rows[0] || {}
}

// One task plus its project's manager — the read behind a push-notification
// action (Approve / Reject / Accept), which needs the assignee and the manager
// to recompute permission from live rows.
exports.findTaskActionContext = async (taskId) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.status, t.assignee_id, t.project_id,
            p.manager_id AS project_manager_id
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.id = $1`,
    [taskId]
  )
  return rows[0] || null
}

exports.findTaskCountsByAssignee = async (userIds) => {
  const { rows } = await pool.query(
    `SELECT assignee_id,
            COUNT(*)::int                                       AS total,
            COUNT(*) FILTER (WHERE status = 'completed')::int    AS completed
       FROM tasks
      WHERE assignee_id = ANY($1::uuid[])
      GROUP BY assignee_id`,
    [userIds]
  )
  return rows
}

exports.projectExists = async (id) => {
  const { rows } = await pool.query('SELECT id FROM projects WHERE id = $1', [id])
  return Boolean(rows[0])
}

exports.taskExists = async (id) => {
  const { rows } = await pool.query('SELECT id FROM tasks WHERE id = $1', [id])
  return Boolean(rows[0])
}

/* ── Reminder sweeps ──────────────────────────────────────────────────────
 *
 * These back notify's reminder cron. The sweeps used to live in
 * utils/reminder-cron.js and query `tasks JOIN projects` — and, for two of
 * them, `notification_preferences` and `users` as well — on one pool. After the
 * Phase 2 split only the first half of that is work's to answer, so the joins
 * that crossed a boundary moved out to the caller and what remains is here.
 *
 * `completed` and `done` are both terminal. The original swept both because
 * the status vocabulary drifted historically; dropping either would start
 * re-reminding people about finished work.
 *
 * Every date comparison happens in Postgres under an explicit timezone. "Due
 * tomorrow" is a calendar question, and answering it in JS against a server
 * running UTC shifts the boundary by the offset — the same bug the DATE type
 * parser in platform/db.js exists to avoid.
 */

const TERMINAL_STATUSES = ['completed', 'done']

/**
 * Tasks whose due date falls exactly `offsetDays` calendar days from today in
 * `timezone`. 0 is today, 1 is tomorrow, 5 is five days out.
 *
 * Used for the due-today and due-tomorrow sweeps, and — with the offset driven
 * by each user's configured lead time — for the custom lead-time sweep, which
 * is why the offset is a parameter rather than three near-identical queries.
 */
exports.findTasksDueInDays = async (offsetDays, timezone) => {
  const { rows } = await pool.query(
    `SELECT t.id,
            t.title,
            t.due_date,
            t.assignee_id,
            p.name       AS project_name,
            p.manager_id AS manager_id
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.assignee_id IS NOT NULL
        AND t.due_date IS NOT NULL
        AND t.status <> ALL($3)
        AND (t.due_date AT TIME ZONE $1)::date
            = ((NOW() AT TIME ZONE $1)::date + ($2 || ' days')::interval)::date`,
    [timezone, String(offsetDays), TERMINAL_STATUSES]
  )
  return rows
}

/** Tasks past their due date and not terminal. */
exports.findOverdueTasks = async () => {
  const { rows } = await pool.query(
    `SELECT t.id,
            t.title,
            t.due_date,
            t.assignee_id,
            p.name       AS project_name,
            p.manager_id AS manager_id
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.assignee_id IS NOT NULL
        AND t.due_date IS NOT NULL
        AND t.due_date < NOW()
        AND t.status <> ALL($1)`,
    [TERMINAL_STATUSES]
  )
  return rows
}

/**
 * Tasks more than `hours` past due, on a project that has a manager.
 *
 * The original also joined `users` for the assignee's display name. That join
 * crossed into identity, so it is gone — the caller resolves names through
 * identity.getUserCards(), the same batched lookup every other display
 * reference in the codebase now uses.
 */
exports.findTasksOverdueByHours = async (hours, { requireManager = false } = {}) => {
  // requireManager distinguishes the two escalations. The 48h sweep notifies
  // the project manager, so a project without one has nobody to escalate to and
  // an INNER JOIN is correct. The 72h sweep notifies every admin instead, so a
  // managerless project must still be reported — hence the LEFT JOIN. Collapsing
  // these into one query would silently drop managerless projects from the final
  // escalation, which is the one that exists precisely because nothing else
  // worked.
  const { rows } = await pool.query(
    `SELECT t.id,
            t.title,
            t.due_date,
            t.assignee_id,
            p.name       AS project_name,
            p.manager_id AS manager_id
       FROM tasks t
       ${requireManager ? 'JOIN' : 'LEFT JOIN'} projects p ON p.id = t.project_id
      WHERE t.due_date IS NOT NULL
        AND t.due_date < NOW() - ($1 || ' hours')::interval
        AND t.status <> ALL($2)
        ${requireManager ? 'AND p.manager_id IS NOT NULL' : ''}`,
    [String(hours), TERMINAL_STATUSES]
  )
  return rows
}
