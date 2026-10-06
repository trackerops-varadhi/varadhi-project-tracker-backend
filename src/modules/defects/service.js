/**
 * Defects — service layer.
 *
 * Business logic: query orchestration, row mapping, SLA application, permission
 * rules and notification fan-out. The controller stays thin (validate -> call
 * -> respond).
 *
 * Cross-module data is resolved through the other modules' public interfaces
 * and merged here, never joined in SQL. See repo.js for what that replaced.
 */

const repo = require('./repo')
const identity = require('../identity')
const work = require('../work')
const notify = require('../notify')
const {
  getSlaRules,
  slaDeadlines,
  computeSlaState,
  formatSlaRemaining,
  SLA_STATUS,
  SEVERITIES,
  PRIORITIES,
  ENVIRONMENTS,
} = require('./sla')
const { BUG_STATUSES, STATUS_LABELS, BUG_ACTIONS, logBugActivity } = require('./workflow')

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

// A notification failure must never turn a successful mutation into a 500.
const notifySafely = async (fn) => {
  try {
    await fn()
  } catch (err) {
    console.error('[notifications] defects.service:', err.message)
  }
}

// ALLOW-LIST, not deny-list (Module 9). This used to ask "is this an
// employee?", so any role that was not literally 'employee' — such as the new
// 'hr' — fell through to manager-level access. Now only admin and manager are
// elevated and every other role, present or future, is scoped to its own rows.
const isRestricted = (user) =>
  !['admin', 'manager'].includes(String(user?.role || '').toLowerCase())
const isManagerOrAdmin = (user) =>
  ['admin', 'manager'].includes(String(user?.role || '').toLowerCase())

/** "BUG-1042" from the sequential bug_number. */
const formatBugKey = (bugNumber) => `BUG-${bugNumber}`

// Accepts "BUG-1042", "bug-1042" or "1042" and returns the numeric part, or
// null when the term is not a bug-key search.
const parseBugKey = (term) => {
  const match = String(term || '').trim().match(/^(?:bug[-\s]?)?(\d{1,10})$/i)
  return match ? Number(match[1]) : null
}

/**
 * Resolve every cross-module display reference for a page of bug rows, in three
 * parallel batched calls. This is what the four LEFT JOINs became.
 */
const loadCards = async (rows) => {
  const [projects, users, tasks] = await Promise.all([
    work.getProjectCards(rows.map((r) => r.project_id)),
    identity.getUserCards([
      ...rows.map((r) => r.assignee_id),
      ...rows.map((r) => r.reporter_id),
    ]),
    work.getTaskCards(rows.map((r) => r.linked_task_id)),
  ])
  return { projects, users, tasks }
}

/**
 * Map a bug row to the API shape. `rules` comes from getSlaRules() so a whole
 * page shares one rule lookup rather than one per row.
 */
function mapBugRow(row, cards, rules, now = new Date()) {
  const sla = computeSlaState(row, rules, now)
  const assignee = cards.users.get(row.assignee_id)
  const reporter = cards.users.get(row.reporter_id)
  const task = cards.tasks.get(row.linked_task_id)

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
    project: row.project_id
      ? { id: row.project_id, name: cards.projects.get(row.project_id)?.name ?? null }
      : null,
    assignee: row.assignee_id
      ? {
          id: row.assignee_id,
          name: assignee?.name ?? null,
          email: assignee?.email ?? null,
          avatar: assignee?.avatar ?? null,
        }
      : null,
    reporter: row.reporter_id
      ? {
          id: row.reporter_id,
          name: reporter?.name ?? null,
          email: reporter?.email ?? null,
          avatar: reporter?.avatar ?? null,
        }
      : null,
    linkedTask: row.linked_task_id
      ? {
          id: row.linked_task_id,
          title: task?.title ?? null,
          status: task?.status ?? null,
        }
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

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Paginated, filtered bug list. Every filter is applied in SQL — the frontend
 * never receives more than one page.
 */
async function listBugs(user, query = {}) {
  const {
    search, projectId, assigneeId, reporterId, status, severity, priority,
    environment, slaStatus, linkedTaskId, dateFrom, dateTo,
    sortBy = 'createdAt', sortDir = 'desc',
  } = query

  const page = Math.max(1, parseInt(query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20))

  // Split a comma-separated multi-select into a validated array.
  const listOf = (value, allowed) => {
    if (!value) return []
    return String(value)
      .split(',')
      .map((v) => v.trim())
      .filter((v) => (allowed ? allowed.includes(v) : Boolean(v)))
  }

  // The search term may name a project or a developer. Those used to be
  // `p.name ILIKE` / `a.name ILIKE` inside the join; now each module resolves
  // its own matches to ids first and the filter stays one SQL predicate, so the
  // pagination count remains correct.
  let searchSpec = null
  if (search && String(search).trim()) {
    const term = String(search).trim()
    const [projectIds, assigneeIds] = await Promise.all([
      work.searchProjectIds(term),
      identity.searchUserIds(term),
    ])
    searchSpec = { like: term, bugNumber: parseBugKey(term), projectIds, assigneeIds }
  }

  const spec = {
    scopeUserId: isRestricted(user) ? user.id : null,
    search: searchSpec,
    inFilters: {
      'b.status': listOf(status, BUG_STATUSES),
      'b.severity': listOf(severity, SEVERITIES),
      'b.priority': listOf(priority, PRIORITIES),
      'b.environment': listOf(environment, ENVIRONMENTS),
    },
    projectId, assigneeId, reporterId, linkedTaskId, dateFrom, dateTo, slaStatus,
  }

  const total = await repo.countBugs(spec)
  const rows = await repo.listBugs(spec, {
    limit, offset: (page - 1) * limit, sortBy, sortDir,
  })

  const [cards, rules] = await Promise.all([loadCards(rows), getSlaRules()])
  const now = new Date()

  return { bugs: rows.map((r) => mapBugRow(r, cards, rules, now)), total, page, limit }
}

/** Shape a comment/attachment/activity row with its actor card. */
const mapComment = (c, users) => ({
  id: c.id,
  content: c.content,
  edited: c.edited,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
  author: c.author_id
    ? {
        id: c.author_id,
        name: users.get(c.author_id)?.name ?? null,
        avatar: users.get(c.author_id)?.avatar ?? null,
      }
    : null,
})

const mapActivity = (l, users) => ({
  id: l.id,
  action: l.action,
  field: l.field,
  oldValue: l.old_value,
  newValue: l.new_value,
  detail: l.detail,
  createdAt: l.created_at,
  actor: l.actor_id
    ? {
        id: l.actor_id,
        name: users.get(l.actor_id)?.name ?? null,
        avatar: users.get(l.actor_id)?.avatar ?? null,
      }
    : null,
})

/**
 * One bug with its comments, attachments and activity timeline.
 * Returns null when the id does not exist.
 */
async function getBugById(bugId, { includeRelations = true } = {}) {
  const row = await repo.findBugRow(bugId)
  if (!row) return null

  const [cards, rules] = await Promise.all([loadCards([row]), getSlaRules()])
  const bug = mapBugRow(row, cards, rules)

  if (!includeRelations) return bug

  const [comments, attachments, activity] = await Promise.all([
    repo.findComments(bugId),
    repo.findAttachments(bugId),
    repo.findActivity(bugId),
  ])

  // One identity call covering every author, uploader and actor on the page —
  // replacing three separate `LEFT JOIN users`.
  const users = await identity.getUserCards([
    ...comments.map((c) => c.author_id),
    ...attachments.map((a) => a.uploaded_by),
    ...activity.map((l) => l.actor_id),
  ])

  bug.comments = comments.map((c) => mapComment(c, users))
  bug.attachments = attachments.map((a) => ({
    id: a.id,
    fileName: a.file_name,
    fileType: a.file_type,
    fileSize: parseInt(a.file_size, 10) || 0,
    url: a.url,
    createdAt: a.created_at,
    uploadedBy: a.uploaded_by
      ? { id: a.uploaded_by, name: users.get(a.uploaded_by)?.name ?? null }
      : null,
  }))
  bug.activity = activity.map((l) => mapActivity(l, users))

  return bug
}

/** Activity timeline on its own, for the dedicated endpoint. */
async function getActivity(bugId, limit = 100) {
  const rows = await repo.findActivity(bugId, limit)
  const users = await identity.getUserCards(rows.map((l) => l.actor_id))
  return rows.map((l) => mapActivity(l, users))
}

/** Comments on their own, for the dedicated endpoint. */
async function getComments(bugId) {
  const rows = await repo.findComments(bugId)
  const users = await identity.getUserCards(rows.map((c) => c.author_id))
  return rows.map((c) => mapComment(c, users))
}

/**
 * May `user` see this bug? Mirrors the visibility scope so a direct GET cannot
 * bypass the list endpoint's scoping.
 */
function canView(user, bug) {
  if (!isRestricted(user)) return true
  return bug.assignee?.id === user.id || bug.reporter?.id === user.id
}

/**
 * May `user` edit this bug's fields? Admin and manager always; the reporter may
 * correct their own report; an assigned developer may edit resolution/root
 * cause but not re-triage, which the controller enforces by field allow-list.
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
    title, description, projectId = null, severity = 'medium', priority = 'p2',
    environment = 'production', assigneeId = null, linkedTaskId = null,
    stepsToReproduce = null,
  } = input

  const startedAt = new Date()
  const { rule, responseDueAt, resolutionDueAt } = await slaDeadlines(severity, startedAt)

  // A bug that arrives with a developer already chosen starts at 'assigned',
  // rather than forcing a second call to get there.
  const initialStatus = assigneeId ? 'assigned' : 'open'

  const client = await repo.connect()
  let bugId
  try {
    await client.query('BEGIN')

    const inserted = await repo.insertBug(client, {
      title, description, stepsToReproduce, status: initialStatus,
      severity, priority, environment,
      projectId, assigneeId, reporterId: user.id, linkedTaskId,
      slaRuleId: rule.id,
      slaStartedAt: startedAt,
      slaResponseDueAt: responseDueAt,
      slaResolutionDueAt: resolutionDueAt,
    })
    bugId = inserted.id

    await logBugActivity(
      {
        bugId, actorId: user.id, action: BUG_ACTIONS.CREATED, newValue: title,
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

  await notifySafely(async () => {
    if (assigneeId && assigneeId !== user.id) {
      await notify.dispatch({
        userId: assigneeId,
        type: notify.TYPES.BUG_ASSIGNED,
        title: 'Bug assigned to you',
        message: `${bug.key}: ${title} (${severity} severity, due ${formatSlaRemaining(bug.sla.remainingMs)})`,
        linkTo: `/bugs/${bugId}`,
        priority: severity === 'critical' ? 'urgent' : 'high',
      })
    }

    // A critical defect is escalated to every admin/manager the moment it is
    // filed — the same "managers need to know" rule tasks applies to bug-type
    // tasks and critical priority.
    if (severity === 'critical' || priority === 'p0') {
      const leadIds = await identity.getActiveUserIdsByRoles(['admin', 'manager'])
      await notify.dispatchToUsers({
        userIds: leadIds,
        type: notify.TYPES.BUG_CRITICAL_REPORTED,
        title: 'Critical bug reported',
        message: `${bug.key}: ${title}`,
        linkTo: `/bugs/${bugId}`,
        priority: 'urgent',
        excludeUserId: user.id,
      })
    }
  })

  return bug
}

/**
 * Apply a status transition. The legality check happens in the controller
 * (which owns the 400); this applies the side effects: first-response stamping,
 * resolution/close timestamps, reopen counting and the SLA restart on a reopen.
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

  await repo.updateBugColumns(bug.id, sets, params)

  await logBugActivity({
    bugId: bug.id, actorId: user.id, action: BUG_ACTIONS.STATUS_CHANGED,
    field: 'status', oldValue: previous, newValue: nextStatus,
  })

  // Reopen / closed / fixed are distinct timeline events, not just another
  // status change, so they get their own entry too.
  if (nextStatus === 'reopened') {
    await logBugActivity({ bugId: bug.id, actorId: user.id, action: BUG_ACTIONS.REOPENED })
  } else if (nextStatus === 'closed') {
    await logBugActivity({ bugId: bug.id, actorId: user.id, action: BUG_ACTIONS.CLOSED })
  } else if (nextStatus === 'fixed') {
    await logBugActivity({ bugId: bug.id, actorId: user.id, action: BUG_ACTIONS.RESOLVED })
  }

  const updated = await getBugById(bug.id)

  await notifySafely(async () => {
    // Who cares about this transition: the assignee, the reporter, and — when
    // an employee moves it — the admins/managers who have no other visibility.
    const recipients = new Set()
    if (updated.assignee?.id) recipients.add(updated.assignee.id)
    if (updated.reporter?.id) recipients.add(updated.reporter.id)

    if (isRestricted(user)) {
      for (const id of await identity.getActiveUserIdsByRoles(['admin', 'manager'])) {
        recipients.add(id)
      }
    }

    const type =
      nextStatus === 'reopened' ? notify.TYPES.BUG_REOPENED
        : nextStatus === 'closed' ? notify.TYPES.BUG_CLOSED
        : notify.TYPES.BUG_STATUS_CHANGED

    const title =
      nextStatus === 'reopened' ? 'Bug reopened'
        : nextStatus === 'closed' ? 'Bug closed'
        : 'Bug status updated'

    await notify.dispatchToUsers({
      userIds: [...recipients],
      type,
      title,
      message: `${updated.key} "${updated.title}" is now ${STATUS_LABELS[nextStatus]}`,
      linkTo: `/bugs/${bug.id}`,
      priority: nextStatus === 'reopened' ? 'high' : 'normal',
      excludeUserId: user.id,
    })
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
  // workflow's second step happens as a consequence of the assignment.
  const nextStatus = assigneeId && bug.status === 'open' ? 'assigned' : bug.status

  await repo.updateAssignee(bug.id, assigneeId, nextStatus)

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
      bugId: bug.id, actorId: user.id, action: BUG_ACTIONS.STATUS_CHANGED,
      field: 'status', oldValue: bug.status, newValue: nextStatus,
    })
  }

  const updated = await getBugById(bug.id)

  await notifySafely(async () => {
    if (!assigneeId || assigneeId === user.id) return
    await notify.dispatch({
      userId: assigneeId,
      type: previousAssigneeId ? notify.TYPES.BUG_REASSIGNED : notify.TYPES.BUG_ASSIGNED,
      title: previousAssigneeId ? 'Bug reassigned to you' : 'Bug assigned to you',
      message: `${updated.key}: ${updated.title} (${updated.severity} severity)`,
      linkTo: `/bugs/${bug.id}`,
      priority: updated.severity === 'critical' ? 'urgent' : 'high',
    })
  })

  return updated
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Defect metrics for the Reports page. Admin/manager only — enforced by
 * restrictTo on the route, so no scoping is applied here.
 */
async function getReportMetrics({ projectId, dateFrom, dateTo } = {}) {
  const raw = await repo.reportMetrics({ projectId, dateFrom, dateTo })
  const t = raw.totals

  // Resolve the two grouped dimensions to display names. The SQL groups by
  // foreign key now; the legacy version grouped by the joined name.
  const [projectCards, userCards] = await Promise.all([
    work.getProjectCards(raw.byProject.map((r) => r.project_id)),
    identity.getUserCards(raw.byDeveloper.map((r) => r.assignee_id)),
  ])

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
      count: raw.bySeverity.find((r) => r.severity === severity)?.count || 0,
    })),
    byProject: raw.byProject.map((r) => ({
      project: projectCards.get(r.project_id)?.name || 'Unassigned project',
      count: r.count,
      closed: r.closed,
    })),
    byDeveloper: raw.byDeveloper.map((r) => ({
      name: userCards.get(r.assignee_id)?.name ?? null,
      count: r.count,
      closed: r.closed,
      breached: r.breached,
    })),
    trend: raw.trend.map((r) => ({ week: r.week, reported: r.reported, resolved: r.resolved })),
  }
}

module.exports = {
  listBugs,
  getBugById,
  getActivity,
  getComments,
  getReportMetrics,
  createBug,
  applyStatusChange,
  assignBug,
  mapBugRow,
  formatBugKey,
  parseBugKey,
  canView,
  canEdit,
  isRestricted,
  isManagerOrAdmin,
  notifySafely,
  SLA_STATUS,
}
