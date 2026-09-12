// SQL for the defects module (bugs · bug_comments · bug_attachments ·
// bug_activity_logs · bug_sla_rules). This module owns all five tables.
//
// WHAT CHANGED FROM services/bugs.service.js
// The old BUG_JOINS reached into three other modules:
//     LEFT JOIN projects p   -> work.getProjectCards()      (display)
//     LEFT JOIN users    a   -> identity.getUserCards()     (display)
//     LEFT JOIN users    r   -> identity.getUserCards()     (display)
//     LEFT JOIN tasks    t   -> work.getTaskCards()         (display)
// The self-join to `bugs` for duplicate_of STAYS — defects owns that table, so
// it is inside the boundary.
//
// The search filter was the hard one: `p.name ILIKE` and `a.name ILIKE` sat
// inside the paginated COUNT predicate, so they could not be post-filtered in
// JS without breaking the total. Instead the service resolves matching project
// and user ids through their modules first and passes them in as arrays — the
// filter stays one SQL predicate, the count stays correct, and the join is gone.

const pool = require('../../platform/db').forSchema('defects')

const SELECT_BUG_COLUMNS = `
  b.*,
  d.bug_number AS duplicate_of_number, d.title AS duplicate_of_title
`

const BUG_JOINS = `
  FROM bugs b
  LEFT JOIN bugs d ON b.duplicate_of_id = d.id
`

// One definition of "still live", shared by the report metrics and the SLA
// filters so both always agree on what "open" or "breached" means.
const LIVE_STATUSES_SQL = `('open','assigned','in_progress','fixed','qa_verification','reopened')`

const SORTABLE_COLUMNS = {
  createdAt: 'b.created_at',
  updatedAt: 'b.updated_at',
  title: 'b.title',
  status: 'b.status',
  severity: `CASE b.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
  priority: 'b.priority',
  bugNumber: 'b.bug_number',
  slaDueAt: 'b.sla_resolution_due_at',
}

exports.SELECT_BUG_COLUMNS = SELECT_BUG_COLUMNS
exports.BUG_JOINS = BUG_JOINS
exports.LIVE_STATUSES_SQL = LIVE_STATUSES_SQL
exports.SORTABLE_COLUMNS = SORTABLE_COLUMNS

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build the shared WHERE clause for the list endpoint.
 *
 * `spec.search` arrives already decomposed by the service:
 *   { like, bugNumber, projectIds, assigneeIds }
 * so this function never needs to know that a project has a name.
 */
function buildWhere(spec, params) {
  let where = 'WHERE 1=1'

  // Row-level visibility: employees see only bugs they reported or are
  // assigned, matching how tasks scopes employees to their own rows.
  if (spec.scopeUserId) {
    params.push(spec.scopeUserId)
    const self = `$${params.length}`
    where += ` AND (b.assignee_id = ${self} OR b.reporter_id = ${self})`
  }

  if (spec.search) {
    const { like, bugNumber, projectIds, assigneeIds } = spec.search
    params.push(`%${like}%`)
    const likeParam = `$${params.length}`

    const clauses = [`b.title ILIKE ${likeParam}`, `b.description ILIKE ${likeParam}`]

    // Only add the id predicates when the other module actually matched
    // something — an empty ANY() would be dead weight in the plan.
    if (projectIds && projectIds.length) {
      params.push(projectIds)
      clauses.push(`b.project_id = ANY($${params.length}::uuid[])`)
    }
    if (assigneeIds && assigneeIds.length) {
      params.push(assigneeIds)
      clauses.push(`b.assignee_id = ANY($${params.length}::uuid[])`)
    }
    if (bugNumber !== null && bugNumber !== undefined) {
      params.push(bugNumber)
      clauses.push(`b.bug_number = $${params.length}`)
    }

    where += ` AND (${clauses.join(' OR ')})`
  }

  // Every scalar filter accepts a single value or a list, so the UI can offer
  // multi-select without a second endpoint.
  for (const [column, values] of Object.entries(spec.inFilters || {})) {
    if (!values || !values.length) continue
    params.push(values)
    where += ` AND ${column} = ANY($${params.length})`
  }

  if (spec.projectId) { params.push(spec.projectId); where += ` AND b.project_id = $${params.length}` }
  if (spec.assigneeId === 'unassigned') {
    where += ' AND b.assignee_id IS NULL'
  } else if (spec.assigneeId) {
    params.push(spec.assigneeId); where += ` AND b.assignee_id = $${params.length}`
  }
  if (spec.reporterId) { params.push(spec.reporterId); where += ` AND b.reporter_id = $${params.length}` }
  if (spec.linkedTaskId) { params.push(spec.linkedTaskId); where += ` AND b.linked_task_id = $${params.length}` }
  if (spec.dateFrom) { params.push(spec.dateFrom); where += ` AND b.created_at >= $${params.length}` }
  // Inclusive end-of-day: a dateTo of 2026-08-24 must include bugs filed that
  // afternoon, which a bare `<= '2026-08-24'` (midnight) would exclude.
  if (spec.dateTo) {
    params.push(spec.dateTo)
    where += ` AND b.created_at < ($${params.length}::date + INTERVAL '1 day')`
  }

  // SLA status is derived, not stored, so it is expressed in SQL rather than
  // filtered in JS — otherwise pagination would count the wrong rows.
  if (spec.slaStatus) {
    const live = `b.status NOT IN ('closed','duplicate','rejected','wont_fix','deferred')`
    const s = spec.slaStatus
    if (s === 'breached') {
      where += ` AND (b.sla_breached = TRUE OR (${live} AND b.sla_resolution_due_at < NOW()))`
    } else if (s === 'at_risk') {
      // Mirrors computeSlaState: at risk once the configured fraction of the
      // window has elapsed but the deadline has not yet passed.
      where += ` AND ${live} AND b.sla_breached = FALSE
                 AND b.sla_resolution_due_at >= NOW()
                 AND b.sla_resolution_due_at IS NOT NULL
                 AND NOW() >= b.sla_started_at + (
                       (b.sla_resolution_due_at - b.sla_started_at) *
                       COALESCE((SELECT at_risk_threshold FROM bug_sla_rules WHERE severity = b.severity), 0.75)
                     )`
    } else if (s === 'within') {
      where += ` AND ${live} AND b.sla_breached = FALSE AND b.sla_resolution_due_at >= NOW()`
    } else if (s === 'resolved_within') {
      where += ` AND b.resolved_at IS NOT NULL AND b.sla_breached = FALSE`
    } else if (s === 'resolved_after') {
      where += ` AND b.resolved_at IS NOT NULL AND b.sla_breached = TRUE`
    }
  }

  return where
}

exports.countBugs = async (spec) => {
  const params = []
  const where = buildWhere(spec, params)
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total ${BUG_JOINS} ${where}`,
    params
  )
  return rows[0].total
}

exports.listBugs = async (spec, { limit, offset, sortBy, sortDir }) => {
  const params = []
  const where = buildWhere(spec, params)

  const orderColumn = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.createdAt
  const direction = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'

  params.push(limit, offset)
  const { rows } = await pool.query(
    `SELECT ${SELECT_BUG_COLUMNS} ${BUG_JOINS} ${where}
      ORDER BY ${orderColumn} ${direction}, b.bug_number DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return rows
}

/* -------------------------------------------------------------------------- */
/* Single bug + relations                                                     */
/* -------------------------------------------------------------------------- */

exports.findBugRow = async (bugId) => {
  const { rows } = await pool.query(
    `SELECT ${SELECT_BUG_COLUMNS} ${BUG_JOINS} WHERE b.id = $1`,
    [bugId]
  )
  return rows[0] || null
}

exports.bugExists = async (id) => {
  const { rows } = await pool.query('SELECT id FROM bugs WHERE id = $1', [id])
  return Boolean(rows[0])
}

exports.findBugStub = async (id) => {
  const { rows } = await pool.query('SELECT id, bug_number FROM bugs WHERE id = $1', [id])
  return rows[0] || null
}

// The three relation reads dropped their `LEFT JOIN users` — author, uploader
// and actor names now come from identity.getUserCards() in the service.
exports.findComments = async (bugId) => {
  const { rows } = await pool.query(
    `SELECT id, content, edited, created_at, updated_at, author_id
       FROM bug_comments
      WHERE bug_id = $1
      ORDER BY created_at ASC`,
    [bugId]
  )
  return rows
}

exports.findAttachments = async (bugId) => {
  const { rows } = await pool.query(
    `SELECT id, file_name, file_type, file_size, url, created_at, uploaded_by
       FROM bug_attachments
      WHERE bug_id = $1
      ORDER BY created_at DESC`,
    [bugId]
  )
  return rows
}

exports.findActivity = async (bugId, limit = 200) => {
  const { rows } = await pool.query(
    `SELECT id, action, field, old_value, new_value, detail, created_at, actor_id
       FROM bug_activity_logs
      WHERE bug_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [bugId, limit]
  )
  return rows
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

// Exposed so the service can run create inside one transaction — a bug row must
// never exist without its activity entry.
exports.connect = () => pool.connect()

exports.insertBug = async (client, {
  title, description, stepsToReproduce, status, severity, priority, environment,
  projectId, assigneeId, reporterId, linkedTaskId,
  slaRuleId, slaStartedAt, slaResponseDueAt, slaResolutionDueAt,
}) => {
  const { rows } = await client.query(
    `INSERT INTO bugs (
       title, description, steps_to_reproduce, status, severity, priority, environment,
       project_id, assignee_id, reporter_id, linked_task_id,
       sla_rule_id, sla_started_at, sla_response_due_at, sla_resolution_due_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, bug_number`,
    [
      title, description, stepsToReproduce, status, severity, priority, environment,
      projectId, assigneeId, reporterId, linkedTaskId,
      slaRuleId, slaStartedAt, slaResponseDueAt, slaResolutionDueAt,
    ]
  )
  return rows[0]
}

// `sets` and `params` are built by the caller because which columns move
// depends on the transition; the id is appended here so the caller cannot get
// the placeholder number wrong.
exports.updateBugColumns = async (bugId, sets, params) => {
  params.push(bugId)
  await pool.query(`UPDATE bugs SET ${sets.join(', ')} WHERE id = $${params.length}`, params)
}

exports.updateAssignee = async (bugId, assigneeId, nextStatus) => {
  await pool.query(
    `UPDATE bugs
        SET assignee_id = $1,
            status = $2,
            first_response_at = COALESCE(first_response_at, CASE WHEN $1::uuid IS NOT NULL THEN NOW() END),
            updated_at = NOW()
      WHERE id = $3`,
    [assigneeId || null, nextStatus, bugId]
  )
}

exports.linkTask = async (bugId, taskId) => {
  await pool.query('UPDATE bugs SET linked_task_id = $1, updated_at = NOW() WHERE id = $2', [
    taskId, bugId,
  ])
}

exports.deleteBug = async (id) => {
  // bug_comments, bug_attachments and bug_activity_logs all cascade.
  await pool.query('DELETE FROM bugs WHERE id = $1', [id])
}

/* ── Comments ───────────────────────────────────────────────────────────── */

exports.insertComment = async (bugId, authorId, content) => {
  const { rows } = await pool.query(
    `INSERT INTO bug_comments (bug_id, author_id, content)
          VALUES ($1, $2, $3)
       RETURNING id, content, created_at, updated_at, edited`,
    [bugId, authorId, content]
  )
  return rows[0]
}

exports.findComment = async (commentId, bugId) => {
  const { rows } = await pool.query(
    'SELECT id, author_id FROM bug_comments WHERE id = $1 AND bug_id = $2',
    [commentId, bugId]
  )
  return rows[0] || null
}

exports.updateComment = async (commentId, content) => {
  const { rows } = await pool.query(
    `UPDATE bug_comments
        SET content = $1, edited = TRUE, updated_at = NOW()
      WHERE id = $2
      RETURNING id, content, edited, created_at, updated_at`,
    [content, commentId]
  )
  return rows[0]
}

exports.deleteComment = async (commentId) => {
  await pool.query('DELETE FROM bug_comments WHERE id = $1', [commentId])
}

/* ── Attachments ────────────────────────────────────────────────────────── */

exports.insertAttachment = async ({
  bugId, documentId, fileName, fileType, fileSize, url, storagePath, uploadedBy,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO bug_attachments
       (bug_id, document_id, file_name, file_type, file_size, url, storage_path, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, file_name, file_type, file_size, url, created_at`,
    [bugId, documentId, fileName, fileType, fileSize, url, storagePath, uploadedBy]
  )
  return rows[0]
}

exports.findAttachment = async (attachmentId, bugId) => {
  const { rows } = await pool.query(
    `SELECT id, file_name, url, storage_path, uploaded_by, document_id
       FROM bug_attachments WHERE id = $1 AND bug_id = $2`,
    [attachmentId, bugId]
  )
  return rows[0] || null
}

exports.findAttachmentPaths = async (bugId) => {
  const { rows } = await pool.query(
    'SELECT storage_path, url FROM bug_attachments WHERE bug_id = $1',
    [bugId]
  )
  return rows
}

exports.deleteAttachment = async (id) => {
  await pool.query('DELETE FROM bug_attachments WHERE id = $1', [id])
}

/* ── SLA rules ──────────────────────────────────────────────────────────── */

exports.upsertSlaRule = async ({
  severity, responseMinutes, resolutionMinutes, atRiskThreshold, updatedBy,
}) => {
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
    [severity, responseMinutes, resolutionMinutes, atRiskThreshold, updatedBy]
  )
  return rows[0]
}

/* -------------------------------------------------------------------------- */
/* Report aggregates                                                          */
/* -------------------------------------------------------------------------- */

const buildReportWhere = (spec, params) => {
  let where = 'WHERE 1=1'
  if (spec.projectId) { params.push(spec.projectId); where += ` AND b.project_id = $${params.length}` }
  if (spec.dateFrom) { params.push(spec.dateFrom); where += ` AND b.created_at >= $${params.length}` }
  if (spec.dateTo) {
    params.push(spec.dateTo)
    where += ` AND b.created_at < ($${params.length}::date + INTERVAL '1 day')`
  }
  return where
}

exports.reportMetrics = async (spec) => {
  const params = []
  const where = buildReportWhere(spec, params)

  const breachedSql = `
    b.sla_breached = TRUE
    OR (b.status IN ${LIVE_STATUSES_SQL} AND b.sla_resolution_due_at < NOW())`

  // byProject and byDeveloper now GROUP BY the foreign key rather than the
  // joined name; the service resolves ids to names afterwards. See the note in
  // service.js — this is the one place the migration changes an edge case.
  const [totals, bySeverity, byProject, byDeveloper, trend] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int                                                        AS total,
         COUNT(*) FILTER (WHERE b.status IN ${LIVE_STATUSES_SQL})::int        AS open,
         COUNT(*) FILTER (WHERE b.status = 'closed')::int                     AS closed,
         COUNT(*) FILTER (WHERE b.severity = 'critical')::int                 AS critical,
         COUNT(*) FILTER (WHERE b.resolved_at IS NOT NULL)::int               AS resolved,
         COUNT(*) FILTER (WHERE ${breachedSql})::int                          AS breached,
         COUNT(*) FILTER (WHERE b.reopen_count > 0)::int                      AS reopened,
         AVG(EXTRACT(EPOCH FROM (b.resolved_at - b.created_at)))              AS avg_resolution_seconds,
         AVG(EXTRACT(EPOCH FROM (b.first_response_at - b.created_at)))        AS avg_response_seconds
       FROM bugs b ${where}`,
      params
    ),
    pool.query(
      `SELECT b.severity, COUNT(*)::int AS count FROM bugs b ${where} GROUP BY b.severity`,
      params
    ),
    pool.query(
      `SELECT b.project_id, COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE b.status = 'closed')::int AS closed
         FROM bugs b ${where}
        GROUP BY b.project_id ORDER BY count DESC LIMIT 12`,
      params
    ),
    pool.query(
      `SELECT b.assignee_id, COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE b.status = 'closed')::int AS closed,
              COUNT(*) FILTER (WHERE ${breachedSql})::int      AS breached
         FROM bugs b ${where} AND b.assignee_id IS NOT NULL
        GROUP BY b.assignee_id ORDER BY count DESC LIMIT 12`,
      params
    ),
    pool.query(
      `SELECT to_char(date_trunc('week', b.created_at), 'YYYY-MM-DD') AS week,
              COUNT(*)::int AS reported,
              COUNT(*) FILTER (WHERE b.resolved_at IS NOT NULL)::int AS resolved
         FROM bugs b ${where}
        GROUP BY 1 ORDER BY 1 ASC LIMIT 26`,
      params
    ),
  ])

  return {
    totals: totals.rows[0],
    bySeverity: bySeverity.rows,
    byProject: byProject.rows,
    byDeveloper: byDeveloper.rows,
    trend: trend.rows,
  }
}

/* -------------------------------------------------------------------------- */
/* SLA sweep                                                                  */
/* -------------------------------------------------------------------------- */

// Statuses whose resolution clock is still running. Narrower than
// LIVE_STATUSES_SQL: a bug that is 'fixed' or in QA has stopped its clock.
const SWEEP_LIVE_STATUSES = `('open','assigned','in_progress','reopened')`
exports.SWEEP_LIVE_STATUSES = SWEEP_LIVE_STATUSES

exports.findAtRiskBugs = async (limit = 200) => {
  // The threshold comes from bug_sla_rules per severity, so an admin changing
  // it takes effect on the next tick without a code change.
  const { rows } = await pool.query(
    `SELECT b.id, b.bug_number, b.title, b.severity, b.assignee_id, b.project_id,
            b.sla_resolution_due_at
       FROM bugs b
      WHERE b.status IN ${SWEEP_LIVE_STATUSES}
        AND b.sla_breached = FALSE
        AND b.sla_at_risk_notified_at IS NULL
        AND b.sla_resolution_due_at IS NOT NULL
        AND b.sla_resolution_due_at > NOW()
        AND NOW() >= b.sla_started_at + (
              (b.sla_resolution_due_at - b.sla_started_at) *
              COALESCE((SELECT at_risk_threshold FROM bug_sla_rules WHERE severity = b.severity), 0.75))
      LIMIT $1`,
    [limit]
  )
  return rows
}

exports.latchAtRisk = async (bugId) => {
  await pool.query('UPDATE bugs SET sla_at_risk_notified_at = NOW() WHERE id = $1', [bugId])
}

/**
 * Latch and select in one statement: a bug can only be picked up by the
 * RETURNING clause on the tick that first flips its flag, so two overlapping
 * runs can never both notify for the same breach.
 *
 * The legacy version did this as `UPDATE bugs b FROM projects p ... p.id IS NOT
 * DISTINCT FROM b.project_id`, which silently excluded bugs with no project and
 * needed a second "orphans" sweep to compensate. Dropping the join makes one
 * statement cover both, and project_id comes back for the service to resolve a
 * manager from.
 */
exports.latchBreachedBugs = async () => {
  const { rows } = await pool.query(
    `UPDATE bugs
        SET sla_breached = TRUE,
            sla_breached_at = NOW(),
            updated_at = NOW()
      WHERE status IN ${SWEEP_LIVE_STATUSES}
        AND sla_breached = FALSE
        AND sla_resolution_due_at IS NOT NULL
        AND sla_resolution_due_at < NOW()
      RETURNING id, bug_number, title, severity, assignee_id, reporter_id,
                project_id, sla_resolution_due_at`
  )
  return rows
}
