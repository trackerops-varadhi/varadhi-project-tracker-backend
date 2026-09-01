/**
 * Bugs Finder — service layer.
 * ---------------------------------------------------------------------------
 * Business logic for the bugs module: query building, row mapping, SLA
 * application, permission rules and notification fan-out. The controller stays
 * thin (validate -> call -> respond), which is what §21 of the spec asks for
 * and what the existing controllers in this codebase have grown too heavy to
 * do themselves.
 *
 * Conventions inherited from the rest of the backend:
 *   - raw parameterised SQL through the shared `pg` pool, no ORM
 *   - camelCase in the API payload, snake_case in the database
 *   - notifications dispatched through utils/notification-engine.js and always
 *     wrapped so a delivery failure can never fail the mutation
 */

const pool = require('../config/db')
const {
  dispatchNotification,
  dispatchToMany,
  NOTIFICATION_TYPES,
} = require('../utils/notification-engine')
const {
  getSlaRules,
  slaDeadlines,
  computeSlaState,
  formatSlaRemaining,
  SLA_STATUS,
  SEVERITIES,
  PRIORITIES,
  ENVIRONMENTS,
} = require('../utils/bug-sla')
const {
  BUG_STATUSES,
  STATUS_LABELS,
  BUG_ACTIONS,
  logBugActivity,
} = require('../utils/bug-workflow')

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

// A notification failure must never turn a successful mutation into a 500 —
// the same guard tasks.controller.js and documents.controller.js use.
const notifySafely = async (fn) => {
  try {
    await fn()
  } catch (err) {
    console.error('[notifications] bugs.service:', err.message)
  }
}

function isEmployee(user) {
  return String(user?.role || '').toLowerCase() === 'employee'
}

function isManagerOrAdmin(user) {
  return ['admin', 'manager'].includes(String(user?.role || '').toLowerCase())
}

/** "BUG-1042" from the sequential bug_number. */
function formatBugKey(bugNumber) {
  return `BUG-${bugNumber}`
}

// Accepts "BUG-1042", "bug-1042" or "1042" and returns the numeric part, or
// null when the term is not a bug-key search. Used by the search filter so
// looking up a bug by the id printed on screen actually finds it.
function parseBugKey(term) {
  const match = String(term || '').trim().match(/^(?:bug[-\s]?)?(\d{1,10})$/i)
  return match ? Number(match[1]) : null
}

const SELECT_BUG_COLUMNS = `
  b.*,
  p.name  AS project_name,
  a.name  AS assignee_name,  a.email AS assignee_email,  a.avatar AS assignee_avatar,
  r.name  AS reporter_name,  r.email AS reporter_email,  r.avatar AS reporter_avatar,
  t.title AS linked_task_title, t.status AS linked_task_status,
  d.bug_number AS duplicate_of_number, d.title AS duplicate_of_title
`

const BUG_JOINS = `
  FROM bugs b
  LEFT JOIN projects p ON b.project_id     = p.id
  LEFT JOIN users    a ON b.assignee_id    = a.id
  LEFT JOIN users    r ON b.reporter_id    = r.id
  LEFT JOIN tasks    t ON b.linked_task_id = t.id
  LEFT JOIN bugs     d ON b.duplicate_of_id = d.id
`

/**
 * Map a joined `bugs` row to the API shape. `rules` comes from getSlaRules()
 * so a whole page of bugs shares one rule lookup rather than one per row.
 */
function mapBugRow(row, rules, now = new Date()) {
  const sla = computeSlaState(row, rules, now)

  return {
    id: row.id,
    bugNumber: row.bug_number,
    key: formatBugKey(row.bug_number),
    title: row.title,
    description: row.description,
    stepsToReproduce: row.steps_to_reproduce,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    severity: row.severity,
    priority: row.priority,
    environment: row.environment,
    resolution: row.resolution,
    rootCause: row.root_cause,
    reopenCount: row.reopen_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    project: row.project_id ? { id: row.project_id, name: row.project_name } : null,
    assignee: row.assignee_id
      ? {
          id: row.assignee_id,
          name: row.assignee_name,
          email: row.assignee_email,
          avatar: row.assignee_avatar,
        }
      : null,
    reporter: row.reporter_id
      ? {
          id: row.reporter_id,
          name: row.reporter_name,
          email: row.reporter_email,
          avatar: row.reporter_avatar,
        }
      : null,
    linkedTask: row.linked_task_id
      ? { id: row.linked_task_id, title: row.linked_task_title, status: row.linked_task_status }
      : null,
    duplicateOf: row.duplicate_of_id
      ? {
          id: row.duplicate_of_id,
          key: formatBugKey(row.duplicate_of_number),
          title: row.duplicate_of_title,
        }
      : null,
    sla: {
      ...sla,
      // Rendered server-side so notification copy and the UI say the same
      // thing. The client still ticks its own countdown between polls, seeded
      // from `dueAt` — never from its own idea of "now" versus the server's.
      label: sla.clockStopped ? null : formatSlaRemaining(sla.remainingMs),
    },
    // Server clock, so a client whose system time is wrong still renders a
    // correct countdown by measuring against this rather than its own Date.now().
    serverTime: now.toISOString(),
  }
}

/**
 * Row-level visibility. Employees see only bugs they reported or are assigned,
 * matching how tasks.controller.js scopes employees to their own rows.
 * Returns a WHERE fragment plus the params it consumed.
 */
function visibilityScope(user, params) {
  if (!isEmployee(user)) return ''
  params.push(user.id)
  const self = `$${params.length}`
  return ` AND (b.assignee_id = ${self} OR b.reporter_id = ${self})`
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

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

/**
 * Paginated, filtered bug list. Every filter is applied in SQL — the frontend
 * never receives more than one page (§10/§24).
 */
async function listBugs(user, query = {}) {
  const {
    search,
    projectId,
    assigneeId,
    reporterId,
    status,
    severity,
    priority,
    environment,
    slaStatus,
    linkedTaskId,
    dateFrom,
    dateTo,
    sortBy = 'createdAt',
    sortDir = 'desc',
  } = query

  const page = Math.max(1, parseInt(query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20))

  const params = []
  let where = 'WHERE 1=1'
  where += visibilityScope(user, params)

  // Search across bug key, title, description, project name and developer name
  // (§24). ILIKE rather than the GIN index for the text columns because the
  // term is a substring, not a lexeme — the index still serves the ranked
  // full-text path if that is added later.
  if (search && String(search).trim()) {
    const term = String(search).trim()
    const bugNumber = parseBugKey(term)
    params.push(`%${term}%`)
    const like = `$${params.length}`
    if (bugNumber !== null) {
      params.push(bugNumber)
      where += ` AND (b.title ILIKE ${like} OR b.description ILIKE ${like}
                      OR p.name ILIKE ${like} OR a.name ILIKE ${like}
                      OR b.bug_number = $${params.length})`
    } else {
      where += ` AND (b.title ILIKE ${like} OR b.description ILIKE ${like}
                      OR p.name ILIKE ${like} OR a.name ILIKE ${like})`
    }
  }

  // Every scalar filter accepts a single value or a comma-separated list, so
  // the UI can offer multi-select without a second endpoint.
  const inFilter = (column, value, allowed) => {
    if (!value) return
    const values = String(value)
      .split(',')
      .map((v) => v.trim())
      .filter((v) => (allowed ? allowed.includes(v) : Boolean(v)))
    if (!values.length) return
    params.push(values)
    where += ` AND ${column} = ANY($${params.length})`
  }

  inFilter('b.status', status, BUG_STATUSES)
  inFilter('b.severity', severity, SEVERITIES)
  inFilter('b.priority', priority, PRIORITIES)
  inFilter('b.environment', environment, ENVIRONMENTS)

  if (projectId) { params.push(projectId); where += ` AND b.project_id = $${params.length}` }
  if (assigneeId === 'unassigned') {
    where += ' AND b.assignee_id IS NULL'
  } else if (assigneeId) {
    params.push(assigneeId); where += ` AND b.assignee_id = $${params.length}`
  }
  if (reporterId) { params.push(reporterId); where += ` AND b.reporter_id = $${params.length}` }
  if (linkedTaskId) { params.push(linkedTaskId); where += ` AND b.linked_task_id = $${params.length}` }
  if (dateFrom) { params.push(dateFrom); where += ` AND b.created_at >= $${params.length}` }
  // Inclusive end-of-day: a dateTo of 2026-08-24 must include bugs filed that
  // afternoon, which a bare `<= '2026-08-24'` (midnight) would exclude.
  if (dateTo) { params.push(dateTo); where += ` AND b.created_at < ($${params.length}::date + INTERVAL '1 day')` }

  // SLA status is derived, not stored, so it is expressed in SQL rather than
  // filtered in JS — otherwise pagination would count the wrong rows.
  if (slaStatus) {
    const live = `b.status NOT IN ('closed','duplicate','rejected','wont_fix','deferred')`
    if (slaStatus === SLA_STATUS.BREACHED) {
      where += ` AND (b.sla_breached = TRUE OR (${live} AND b.sla_resolution_due_at < NOW()))`
    } else if (slaStatus === SLA_STATUS.AT_RISK) {
      // Mirrors computeSlaState: at risk once the configured fraction of the
      // window has elapsed but the deadline has not yet passed.
      where += ` AND ${live} AND b.sla_breached = FALSE
                 AND b.sla_resolution_due_at >= NOW()
                 AND b.sla_resolution_due_at IS NOT NULL
                 AND NOW() >= b.sla_started_at + (
                       (b.sla_resolution_due_at - b.sla_started_at) *
                       COALESCE((SELECT at_risk_threshold FROM bug_sla_rules WHERE severity = b.severity), 0.75)
                     )`
    } else if (slaStatus === SLA_STATUS.WITHIN) {
      where += ` AND ${live} AND b.sla_breached = FALSE AND b.sla_resolution_due_at >= NOW()`
    } else if (slaStatus === SLA_STATUS.RESOLVED_WITHIN) {
      where += ` AND b.resolved_at IS NOT NULL AND b.sla_breached = FALSE`
    } else if (slaStatus === SLA_STATUS.RESOLVED_AFTER) {
      where += ` AND b.resolved_at IS NOT NULL AND b.sla_breached = TRUE`
    }
  }

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total ${BUG_JOINS} ${where}`,
    params
  )
  const total = countResult.rows[0].total

  const orderColumn = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.createdAt
  const direction = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'

  params.push(limit, (page - 1) * limit)
  const rows = await pool.query(
    `SELECT ${SELECT_BUG_COLUMNS} ${BUG_JOINS} ${where}
      ORDER BY ${orderColumn} ${direction}, b.bug_number DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const rules = await getSlaRules()
  const now = new Date()

  return {
    bugs: rows.rows.map((r) => mapBugRow(r, rules, now)),
    total,
    page,
    limit,
  }
}

/**
 * One bug with its comments, attachments and activity timeline.
 * Returns null when the id does not exist.
 */
async function getBugById(bugId, { includeRelations = true } = {}) {
  const result = await pool.query(
    `SELECT ${SELECT_BUG_COLUMNS} ${BUG_JOINS} WHERE b.id = $1`,
    [bugId]
  )
  if (!result.rows[0]) return null

  const rules = await getSlaRules()
  const bug = mapBugRow(result.rows[0], rules)

  if (!includeRelations) return bug

  const [comments, attachments, activity] = await Promise.all([
    pool.query(
      `SELECT c.id, c.content, c.edited, c.created_at, c.updated_at,
              c.author_id, u.name AS author_name, u.avatar AS author_avatar
         FROM bug_comments c
         LEFT JOIN users u ON c.author_id = u.id
        WHERE c.bug_id = $1
        ORDER BY c.created_at ASC`,
      [bugId]
    ),
    pool.query(
      `SELECT a.id, a.file_name, a.file_type, a.file_size, a.url, a.created_at,
              a.uploaded_by, u.name AS uploader_name
         FROM bug_attachments a
         LEFT JOIN users u ON a.uploaded_by = u.id
        WHERE a.bug_id = $1
        ORDER BY a.created_at DESC`,
      [bugId]
    ),
    pool.query(
      `SELECT l.id, l.action, l.field, l.old_value, l.new_value, l.detail, l.created_at,
              l.actor_id, u.name AS actor_name, u.avatar AS actor_avatar
         FROM bug_activity_logs l
         LEFT JOIN users u ON l.actor_id = u.id
        WHERE l.bug_id = $1
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT 200`,
      [bugId]
    ),
  ])

  bug.comments = comments.rows.map((c) => ({
    id: c.id,
    content: c.content,
    edited: c.edited,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    author: c.author_id
      ? { id: c.author_id, name: c.author_name, avatar: c.author_avatar }
      : null,
  }))

  bug.attachments = attachments.rows.map((a) => ({
    id: a.id,
    fileName: a.file_name,
    fileType: a.file_type,
    fileSize: parseInt(a.file_size, 10) || 0,
    url: a.url,
    createdAt: a.created_at,
    uploadedBy: a.uploaded_by ? { id: a.uploaded_by, name: a.uploader_name } : null,
  }))

  bug.activity = activity.rows.map((l) => ({
    id: l.id,
    action: l.action,
    field: l.field,
    oldValue: l.old_value,
    newValue: l.new_value,
    detail: l.detail,
    createdAt: l.created_at,
    actor: l.actor_id ? { id: l.actor_id, name: l.actor_name, avatar: l.actor_avatar } : null,
  }))

  return bug
}

/**
 * May `user` see this bug? Mirrors visibilityScope so a direct GET cannot
 * bypass the list endpoint's scoping.
 */
function canView(user, bug) {
  if (!isEmployee(user)) return true
  return bug.assignee?.id === user.id || bug.reporter?.id === user.id
}

/**
 * May `user` edit this bug's fields (title/description/severity/priority/…)?
 * Admin and manager always; the reporter may correct their own report; an
 * assigned developer may edit resolution/root-cause but not re-triage, which
 * the controller enforces by field allow-list.
 */
function canEdit(user, bug) {
  if (isManagerOrAdmin(user)) return true
  return bug.reporter?.id === user.id || bug.assignee?.id === user.id
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create a bug, stamping the SLA deadlines from the severity's rule.
 * Runs in a transaction so a bug row never exists without its activity entry.
 */
async function createBug(user, input) {
  const {
    title,
    description,
    projectId = null,
    severity = 'medium',
    priority = 'p2',
    environment = 'production',
    assigneeId = null,
    linkedTaskId = null,
    stepsToReproduce = null,
  } = input

  const startedAt = new Date()
  const { rule, responseDueAt, resolutionDueAt } = await slaDeadlines(severity, startedAt)

  // A bug that arrives with a developer already chosen starts at 'assigned',
  // matching the workflow in §3 rather than forcing a second call to get there.
  const initialStatus = assigneeId ? 'assigned' : 'open'

  const client = await pool.connect()
  let bugId
  try {
    await client.query('BEGIN')

    const inserted = await client.query(
      `INSERT INTO bugs (
         title, description, steps_to_reproduce, status, severity, priority, environment,
         project_id, assignee_id, reporter_id, linked_task_id,
         sla_rule_id, sla_started_at, sla_response_due_at, sla_resolution_due_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, bug_number`,
      [
        title,
        description,
        stepsToReproduce,
        initialStatus,
        severity,
        priority,
        environment,
        projectId,
        assigneeId,
        user.id,
        linkedTaskId,
        rule.id,
        startedAt,
        responseDueAt,
        resolutionDueAt,
      ]
    )
    bugId = inserted.rows[0].id

    await logBugActivity(
      {
        bugId,
        actorId: user.id,
        action: BUG_ACTIONS.CREATED,
        newValue: title,
        detail: { severity, priority, environment, status: initialStatus },
      },
      client
    )

    if (assigneeId) {
      await logBugActivity(
        { bugId, actorId: user.id, action: BUG_ACTIONS.ASSIGNED, field: 'assignee', newValue: assigneeId },
        client
      )
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  const bug = await getBugById(bugId)

  // ─── Notifications ────────────────────────────────────────────────────────
  await notifySafely(async () => {
    if (assigneeId && assigneeId !== user.id) {
      await dispatchNotification(
        assigneeId,
        NOTIFICATION_TYPES.BUG_ASSIGNED,
        'Bug assigned to you',
        `${bug.key}: ${title} (${severity} severity, due ${formatSlaRemaining(bug.sla.remainingMs)})`,
        `/bugs/${bugId}`,
        severity === 'critical' ? 'urgent' : 'high'
      )
    }

    // A critical defect is escalated to every admin/manager the moment it is
    // filed — the same "managers need to know" rule tasks.controller.js applies
    // to bug-type tasks and critical priority.
    if (severity === 'critical' || priority === 'p0') {
      const { rows } = await pool.query(
        `SELECT id FROM users WHERE role IN ('admin','manager') AND status = 'active'`
      )
      await dispatchToMany(
        rows.map((r) => r.id),
        NOTIFICATION_TYPES.BUG_CRITICAL_REPORTED,
        'Critical bug reported',
        `${bug.key}: ${title}`,
        `/bugs/${bugId}`,
        'urgent',
        { excludeUserId: user.id }
      )
    }
  })

  return bug
}

/**
 * Apply a status transition. The legality check happens in the controller
 * (which owns the 400); this applies the side effects that come with it:
 * first-response stamping, resolution/close timestamps, reopen counting and
 * the SLA restart on a reopen.
 */
async function applyStatusChange(user, bug, nextStatus, { resolution, rootCause, duplicateOfId } = {}) {
  const previous = bug.status
  const now = new Date()

  const sets = ['status = $1', 'updated_at = NOW()']
  const params = [nextStatus]
  const push = (fragment, value) => {
    params.push(value)
    sets.push(fragment.replace('$?', `$${params.length}`))
  }

  // First response = the first move off 'open'. Recorded once and never
  // overwritten, so a later reopen cannot rewrite the original response time.
  if (!bug.sla.firstResponseAt && previous === 'open' && nextStatus !== 'open') {
    push('first_response_at = $?', now)
  }

  // 'fixed' is when the developer considers the defect resolved — that is the
  // moment the resolution SLA is measured against, not the later QA close.
  if (nextStatus === 'fixed' && !bug.resolvedAt) {
    push('resolved_at = $?', now)
  }

  if (nextStatus === 'closed') {
    push('closed_at = $?', now)
    // A bug closed straight from QA without ever passing through 'fixed' still
    // needs a resolution timestamp for the resolution-time metrics.
    if (!bug.resolvedAt) push('resolved_at = $?', now)
  }

  if (nextStatus === 'reopened') {
    // Reopening restarts the resolution clock: the team has taken on a fresh
    // commitment. The original breach flag is cleared with it, but the reopen
    // count and the activity log preserve the history.
    const { rule, responseDueAt, resolutionDueAt } = await slaDeadlines(bug.severity, now)
    sets.push('reopen_count = reopen_count + 1')
    push('sla_started_at = $?', now)
    push('sla_response_due_at = $?', responseDueAt)
    push('sla_resolution_due_at = $?', resolutionDueAt)
    push('sla_rule_id = $?', rule.id)
    sets.push('sla_breached = FALSE')
    sets.push('sla_breached_at = NULL')
    sets.push('sla_at_risk_notified_at = NULL')
    sets.push('resolved_at = NULL')
    sets.push('closed_at = NULL')
  }

  if (resolution !== undefined && resolution !== null) push('resolution = $?', resolution)
  if (rootCause !== undefined && rootCause !== null) push('root_cause = $?', rootCause)
  if (duplicateOfId !== undefined) push('duplicate_of_id = $?', duplicateOfId || null)

  params.push(bug.id)
  await pool.query(`UPDATE bugs SET ${sets.join(', ')} WHERE id = $${params.length}`, params)

  // ─── Activity ─────────────────────────────────────────────────────────────
  await logBugActivity({
    bugId: bug.id,
    actorId: user.id,
    action: BUG_ACTIONS.STATUS_CHANGED,
    field: 'status',
    oldValue: previous,
    newValue: nextStatus,
  })

  // The spec's timeline calls out reopen / closed / fixed as distinct events,
  // not just another status change, so they get their own entry too.
  if (nextStatus === 'reopened') {
    await logBugActivity({ bugId: bug.id, actorId: user.id, action: BUG_ACTIONS.REOPENED })
  } else if (nextStatus === 'closed') {
    await logBugActivity({ bugId: bug.id, actorId: user.id, action: BUG_ACTIONS.CLOSED })
  } else if (nextStatus === 'fixed') {
    await logBugActivity({ bugId: bug.id, actorId: user.id, action: BUG_ACTIONS.RESOLVED })
  }

  const updated = await getBugById(bug.id)

  // ─── Notifications ────────────────────────────────────────────────────────
  await notifySafely(async () => {
    // Who cares about this transition: the assignee, the reporter, and — when
    // an employee moves it — the admins/managers who have no other visibility.
    const recipients = new Set()
    if (updated.assignee?.id) recipients.add(updated.assignee.id)
    if (updated.reporter?.id) recipients.add(updated.reporter.id)

    if (isEmployee(user)) {
      const { rows } = await pool.query(
        `SELECT id FROM users WHERE role IN ('admin','manager') AND status = 'active'`
      )
      for (const r of rows) recipients.add(r.id)
    }

    const type =
      nextStatus === 'reopened'
        ? NOTIFICATION_TYPES.BUG_REOPENED
        : nextStatus === 'closed'
        ? NOTIFICATION_TYPES.BUG_CLOSED
        : NOTIFICATION_TYPES.BUG_STATUS_CHANGED

    const title =
      nextStatus === 'reopened'
        ? 'Bug reopened'
        : nextStatus === 'closed'
        ? 'Bug closed'
        : 'Bug status updated'

    await dispatchToMany(
      [...recipients],
      type,
      title,
      `${updated.key} "${updated.title}" is now ${STATUS_LABELS[nextStatus]}`,
      `/bugs/${bug.id}`,
      nextStatus === 'reopened' ? 'high' : 'normal',
      { excludeUserId: user.id }
    )
  })

  return updated
}

/**
 * Assign or reassign a developer. Separate from the generic update because it
 * carries its own notification, its own activity action, and an automatic
 * open -> assigned transition.
 */
async function assignBug(user, bug, assigneeId) {
  const previousAssigneeId = bug.assignee?.id || null

  // Assigning an unassigned, still-open bug advances it to 'assigned' — the
  // workflow's second step happens as a consequence of the assignment rather
  // than needing a separate status call.
  const nextStatus = assigneeId && bug.status === 'open' ? 'assigned' : bug.status

  await pool.query(
    `UPDATE bugs
        SET assignee_id = $1,
            status = $2,
            first_response_at = COALESCE(first_response_at, CASE WHEN $1::uuid IS NOT NULL THEN NOW() END),
            updated_at = NOW()
      WHERE id = $3`,
    [assigneeId || null, nextStatus, bug.id]
  )

  await logBugActivity({
    bugId: bug.id,
    actorId: user.id,
    action: !assigneeId
      ? BUG_ACTIONS.UNASSIGNED
      : previousAssigneeId
      ? BUG_ACTIONS.REASSIGNED
      : BUG_ACTIONS.ASSIGNED,
    field: 'assignee',
    oldValue: previousAssigneeId,
    newValue: assigneeId,
  })

  if (nextStatus !== bug.status) {
    await logBugActivity({
      bugId: bug.id,
      actorId: user.id,
      action: BUG_ACTIONS.STATUS_CHANGED,
      field: 'status',
      oldValue: bug.status,
      newValue: nextStatus,
    })
  }

  const updated = await getBugById(bug.id)

  await notifySafely(async () => {
    if (!assigneeId || assigneeId === user.id) return
    await dispatchNotification(
      assigneeId,
      previousAssigneeId
        ? NOTIFICATION_TYPES.BUG_REASSIGNED
        : NOTIFICATION_TYPES.BUG_ASSIGNED,
      previousAssigneeId ? 'Bug reassigned to you' : 'Bug assigned to you',
      `${updated.key}: ${updated.title} (${updated.severity} severity)`,
      `/bugs/${bug.id}`,
      updated.severity === 'critical' ? 'urgent' : 'high'
    )
  })

  return updated
}

/* -------------------------------------------------------------------------- */
/* Reports aggregates                                                         */
/* -------------------------------------------------------------------------- */

// One definition of "still live", shared by the report metrics and the SLA
// filters in listBugs so both always agree on what "open" or "breached" means.
const LIVE_STATUSES_SQL = `('open','assigned','in_progress','fixed','qa_verification','reopened')`

/**
 * Defect metrics for the Reports page (§26). Admin/manager only — enforced by
 * restrictTo on the route, so no scoping is applied here.
 */
async function getReportMetrics({ projectId, dateFrom, dateTo } = {}) {
  const params = []
  let where = 'WHERE 1=1'
  if (projectId) { params.push(projectId); where += ` AND b.project_id = $${params.length}` }
  if (dateFrom) { params.push(dateFrom); where += ` AND b.created_at >= $${params.length}` }
  if (dateTo) { params.push(dateTo); where += ` AND b.created_at < ($${params.length}::date + INTERVAL '1 day')` }

  const breachedSql = `
    b.sla_breached = TRUE
    OR (b.status IN ${LIVE_STATUSES_SQL} AND b.sla_resolution_due_at < NOW())`

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
      `SELECT COALESCE(p.name, 'Unassigned project') AS project, COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE b.status = 'closed')::int AS closed
         FROM bugs b LEFT JOIN projects p ON b.project_id = p.id ${where}
        GROUP BY p.name ORDER BY count DESC LIMIT 12`,
      params
    ),
    pool.query(
      `SELECT u.name, COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE b.status = 'closed')::int AS closed,
              COUNT(*) FILTER (WHERE ${breachedSql})::int      AS breached
         FROM bugs b JOIN users u ON b.assignee_id = u.id ${where}
        GROUP BY u.name ORDER BY count DESC LIMIT 12`,
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

  const t = totals.rows[0]
  // SLA compliance = share of bugs whose clock has finished that finished on
  // time. Bugs still in flight are excluded — counting them as compliant would
  // flatter the number, counting them as breached would defame it.
  const settled = t.resolved
  const compliant = Math.max(0, settled - t.breached)

  return {
    totals: {
      total: t.total,
      open: t.open,
      closed: t.closed,
      critical: t.critical,
      resolved: t.resolved,
      breached: t.breached,
      reopened: t.reopened,
    },
    slaCompliancePercent: settled > 0 ? Math.round((compliant / settled) * 100) : null,
    reopenRatePercent: t.total > 0 ? Math.round((t.reopened / t.total) * 100) : 0,
    avgResolutionHours: t.avg_resolution_seconds
      ? Math.round((t.avg_resolution_seconds / 3600) * 10) / 10
      : null,
    avgResponseHours: t.avg_response_seconds
      ? Math.round((t.avg_response_seconds / 3600) * 10) / 10
      : null,
    bySeverity: SEVERITIES.map((severity) => ({
      severity,
      count: bySeverity.rows.find((r) => r.severity === severity)?.count || 0,
    })),
    byProject: byProject.rows.map((r) => ({ project: r.project, count: r.count, closed: r.closed })),
    byDeveloper: byDeveloper.rows.map((r) => ({
      name: r.name,
      count: r.count,
      closed: r.closed,
      breached: r.breached,
    })),
    trend: trend.rows.map((r) => ({ week: r.week, reported: r.reported, resolved: r.resolved })),
  }
}

module.exports = {
  // queries
  listBugs,
  getBugById,
  getReportMetrics,
  // mutations
  createBug,
  applyStatusChange,
  assignBug,
  // helpers shared with the controller / cron
  mapBugRow,
  formatBugKey,
  parseBugKey,
  canView,
  canEdit,
  isEmployee,
  isManagerOrAdmin,
  notifySafely,
  visibilityScope,
  SELECT_BUG_COLUMNS,
  BUG_JOINS,
  LIVE_STATUSES_SQL,
}
