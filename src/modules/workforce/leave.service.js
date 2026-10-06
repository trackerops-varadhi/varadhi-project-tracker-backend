// Leave-request business logic: validation, day arithmetic, display enrichment
// and notification fan-out. Knows nothing about req/res.

const repo = require('./leave.repo')
const identity = require('../identity')
const notify = require('../notify')
const { BUSINESS_TZ, todayIn, daysBetween, isYmd } = require('./dates')

// Lazy: people's dashboard reads workforce, so a top-level require here
// would be a cycle. Used for the reporting manager on a late-notice request.
const people = () => require('../people')

// Guards `WHERE id = $1` against a non-UUID path param, which Postgres rejects
// with `invalid input syntax for type uuid` rather than returning no rows.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The leave types offered by the Apply Leave modal. Validated here rather than
// as a DB CHECK so an unknown value is a clean 400 instead of a constraint
// violation surfacing as a 500 — and because `type` is VARCHAR(30), an
// overlong string used to blow up with 'value too long for type character
// varying(30)' at INSERT time. Rejecting off-list values pre-INSERT closes
// both holes at once.
const LEAVE_TYPES = ['casual', 'sick', 'earned', 'annual', 'unpaid']
const DAY_TYPES = ['full_day', 'half_day']
// The statuses an approver may set. 'cancelled' is the owner's own action.
const STATUSES = ['pending', 'approved', 'rejected']
const PLANNING_TYPES = ['planned', 'unplanned']
// Planned leave with less notice than this is flagged to the reporting manager.
const LATE_NOTICE_DAYS = 7

// Allow-lists (Module 9). hr sees every request — HR observes and reports on
// leave — but approving one is a line-management decision, so it is not here.
const VIEW_ALL_ROLES = ['admin', 'manager', 'hr']
const APPROVER_ROLES = ['admin', 'manager']
const roleOf = (user) => String(user?.role || '').toLowerCase()
exports.VIEW_ALL_ROLES = VIEW_ALL_ROLES

// Thrown for anything the caller can fix. The controller maps `.status` onto
// the response; anything else becomes a 500.
class LeaveError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}
exports.LeaveError = LeaveError

// ── mapping ──────────────────────────────────────────────────────────────
// `card` is the identity lookup result and may be undefined — a leave request
// whose user was hard-deleted still renders, with a null name, rather than
// vanishing from the list the way an INNER JOIN would drop it.
const mapLeaveRequest = (row, cards) => {
  const card = cards.get(row.user_id)
  const approver = cards.get(row.approver_id)
  return {
    id: row.id,
    userId: row.user_id,
    userName: card?.name ?? null,
    startDate: row.start_date,
    endDate: row.end_date,
    days: row.days,
    type: row.type,
    dayType: row.day_type,
    reason: row.reason,
    status: row.status,
    planningType: row.planning_type,
    noticeDays: row.notice_days,
    isLateNotice: row.is_late_notice,
    approver: approver ? { id: approver.id, name: approver.name } : null,
    approvedAt: row.approved_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
  }
}

// One batched identity call for the whole page, not one per row.
const withUserCards = async (rows) => {
  const cards = await identity.getUserCards(rows.flatMap((r) => [r.user_id, r.approver_id]))
  return rows.map((r) => mapLeaveRequest(r, cards))
}

const withUserCard = async (row) => (await withUserCards([row]))[0]

// ── reads ────────────────────────────────────────────────────────────────
exports.listForUser = async (currentUser, { status } = {}) => {
  // Any role not on the allow-list — including a null role — sees only its own.
  const rows = await repo.listLeaveRequests({
    scopeUserId: VIEW_ALL_ROLES.includes(roleOf(currentUser)) ? null : currentUser.id,
    status: status || null,
  })
  return withUserCards(rows)
}

// ── writes ───────────────────────────────────────────────────────────────
exports.create = async (currentUser, body) => {
  // Only these five are read from the body. The owner is always req.user.id —
  // a userId or employee name in the payload is ignored outright, never
  // trusted as the requester's identity.
  const { startDate, endDate, type, reason, dayType, planningType } = body

  if (!startDate || !endDate || !reason || !String(reason).trim()) {
    throw new LeaveError('Start date, end date, and reason are required.')
  }

  // `type` is optional and falls back to 'annual' (unchanged behaviour), but
  // an explicitly supplied value must be on the list.
  const leaveType = type === undefined || type === null || type === '' ? 'annual' : String(type)
  if (!LEAVE_TYPES.includes(leaveType)) {
    throw new LeaveError(`Leave type must be one of: ${LEAVE_TYPES.join(', ')}.`)
  }

  // Same treatment for dayType: absent means Full Day, present must be valid.
  const leaveDayType =
    dayType === undefined || dayType === null || dayType === '' ? 'full_day' : String(dayType)
  if (!DAY_TYPES.includes(leaveDayType)) {
    throw new LeaveError(`Day type must be one of: ${DAY_TYPES.join(', ')}.`)
  }

  const start = new Date(startDate)
  const end = new Date(endDate)

  // Unparseable dates previously produced days = NaN, which the driver
  // rejected against `days NOT NULL` as an opaque 500.
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new LeaveError('Start date and end date must be valid dates.')
  }
  // A reversed range used to be silently clamped to 1 day by Math.max.
  if (end < start) {
    throw new LeaveError('End date cannot be earlier than start date.')
  }
  // A half day only makes sense on a single date — half of a multi-day range
  // is ambiguous (which day is the half?), so reject it rather than guess.
  if (leaveDayType === 'half_day' && end.getTime() !== start.getTime()) {
    throw new LeaveError('A half-day leave must start and end on the same date.')
  }

  // Full day: inclusive count across the range. Half day: always 0.5, since
  // the range is guaranteed to be a single date by the check above.
  const days =
    leaveDayType === 'half_day'
      ? 0.5
      : Math.max(1, Math.round((end - start) / 86400000) + 1)

  // Planned vs unplanned (Module 9). The requester chooses, except that leave
  // starting today or earlier cannot have been planned. Absent means: planned
  // when it starts in the future, unplanned otherwise.
  const today = todayIn()
  const noticeDays = isYmd(String(startDate)) ? daysBetween(today, String(startDate)) : null
  let planning = planningType === undefined || planningType === null || planningType === ''
    ? (noticeDays > 0 ? 'planned' : 'unplanned')
    : String(planningType)
  if (!PLANNING_TYPES.includes(planning)) {
    throw new LeaveError(`Planning type must be one of: ${PLANNING_TYPES.join(', ')}.`)
  }
  if (noticeDays !== null && noticeDays <= 0) planning = 'unplanned'
  const isLateNotice = planning === 'planned' && noticeDays !== null && noticeDays < LATE_NOTICE_DAYS

  const row = await repo.insertLeaveRequest({
    userId: currentUser.id,
    startDate, endDate, days,
    type: leaveType,
    reason,
    dayType: leaveDayType,
    planningType: planning,
    noticeDays,
    isLateNotice,
  })

  const dto = await withUserCard(row)

  // Fire-and-forget. Routed through the notify interface rather than a raw
  // INSERT so leave gets the same treatment as every other module: preference
  // checks, quiet hours, dedupe, push delivery and Teams fan-out.
  notify.dispatchToRoles({
    roles: ['admin', 'manager'],
    type: notify.TYPES.LEAVE_REQUESTED,
    title: 'New Leave Request',
    message: `${dto.userName ?? 'A team member'} applied for ${row.type} from ${row.start_date} to ${row.end_date}`,
    linkTo: '/leave-management',
  }).catch((e) => console.error('notifyManagersAboutLeave error:', e.message))

  // Planned leave with under a week's notice goes to the requester's
  // reporting manager (people), when they have one. Fire-and-forget too.
  if (isLateNotice) {
    notifyLateNotice(dto).catch((e) => console.error('notifyLateNotice error:', e.message))
  }

  return dto
}

const notifyLateNotice = async (dto) => {
  const managerId = await people().getReportingManagerId(dto.userId)
  if (!managerId || managerId === dto.userId) return
  await notify.dispatch({
    userId: managerId,
    type: notify.TYPES.LEAVE_LATE_NOTICE,
    title: 'Leave with short notice',
    message: `${dto.userName ?? 'A team member'} applied for planned leave from ${dto.startDate} with only ${dto.noticeDays} day(s) notice.`,
    linkTo: '/leave-management',
    priority: 'normal',
  })
}

exports.updateStatus = async (currentUser, id, status) => {
  if (!APPROVER_ROLES.includes(roleOf(currentUser))) {
    throw new LeaveError('You are not authorized to update leave status.', 403)
  }
  if (!STATUSES.includes(status)) {
    throw new LeaveError('Please provide a valid leave status.')
  }
  // A non-UUID path param made Postgres throw `invalid input syntax for type
  // uuid`, which surfaced as a 500 instead of a 404.
  if (!UUID_RE.test(String(id || ''))) {
    throw new LeaveError('Leave request not found.', 404)
  }

  const existing = await repo.findLeaveRequestById(id)
  if (!existing) throw new LeaveError('Leave request not found.', 404)
  if (existing.status === 'cancelled') {
    throw new LeaveError('This leave request was cancelled by the requester.', 409)
  }

  const row = await repo.updateLeaveStatus(id, status, currentUser.id)
  if (!row) throw new LeaveError('Leave request not found.', 404)

  const dto = await withUserCard(row)

  // Notify the request owner about the decision. An approval or rejection is
  // something the requester is actively waiting on, so it outranks routine
  // notifications.
  //
  // Awaited (unlike the create path, which is fire-and-forget) to preserve the
  // legacy controller's ordering exactly: the response is not sent until the
  // dispatch has been attempted. Wrapped so a notification failure still
  // cannot fail the status change itself.
  try {
    await notify.dispatch({
      userId: row.user_id,
      type: notify.TYPES.LEAVE_STATUS_CHANGED,
      title: 'Leave Request Update',
      message: `Your leave request (${row.start_date} → ${row.end_date}) was ${row.status}.`,
      linkTo: '/leave-management',
      priority: 'high',
    })
  } catch (e) {
    console.error('notify requester error:', e.message)
  }

  return dto
}

/** The owner withdraws their own request while it is still pending. */
exports.cancel = async (currentUser, id) => {
  if (!UUID_RE.test(String(id || ''))) throw new LeaveError('Leave request not found.', 404)
  const existing = await repo.findLeaveRequestById(id)
  if (!existing) throw new LeaveError('Leave request not found.', 404)
  if (existing.user_id !== currentUser.id) {
    throw new LeaveError('You can only cancel your own leave requests.', 403)
  }
  if (existing.status !== 'pending') {
    throw new LeaveError(`Only a pending request can be cancelled (this one is ${existing.status}).`, 409)
  }
  const row = await repo.cancelLeaveRequest(id, currentUser.id)
  if (!row) throw new LeaveError('Only a pending request can be cancelled.', 409)
  return withUserCard(row)
}

/* ── absence calendar (all roles) ─────────────────────────────────────── */

const MAX_CALENDAR_DAYS = 92

/**
 * Who is away, for workload balancing — visible to every role (the sheet's
 * "absentee visibility"). Deliberately carries no reason text: that stays in
 * the role-scoped list.
 */
exports.calendar = async ({ from, to } = {}) => {
  const start = from || todayIn()
  const end = to || start
  if (!isYmd(String(start)) || !isYmd(String(end))) throw new LeaveError('from and to must be YYYY-MM-DD dates.')
  if (end < start) throw new LeaveError('"to" cannot be before "from".')
  if (daysBetween(start, end) > MAX_CALENDAR_DAYS) {
    throw new LeaveError(`The calendar covers at most ${MAX_CALENDAR_DAYS} days per request.`)
  }

  const rows = (await repo.findLeaveOverlapping(start, end, BUSINESS_TZ))
    .filter((r) => r.status === 'approved' || r.status === 'pending')
  const cards = await identity.getUserCards(rows.map((r) => r.user_id))
  return {
    from: start,
    to: end,
    items: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: cards.get(r.user_id)?.name ?? null,
      startDate: r.start_date,
      endDate: r.end_date,
      dayType: r.day_type,
      type: r.type,
      planningType: r.planning_type,
      status: r.status,
    })),
  }
}

/* ── balances ─────────────────────────────────────────────────────────── */

const yearOf = (value) => {
  const y = value === undefined || value === null || value === '' ? Number(todayIn().slice(0, 4)) : Number(value)
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new LeaveError('Year must be between 2000 and 2100.')
  return y
}

const buildBalances = (userId, year, entitlements, usage) => {
  const byType = new Map()
  const row = (t) => {
    if (!byType.has(t)) byType.set(t, { leaveType: t, entitled: 0, carriedForward: 0, used: 0 })
    return byType.get(t)
  }
  for (const e of entitlements) {
    const r = row(e.leave_type)
    r.entitled = Number(e.entitled)
    r.carriedForward = Number(e.carried_forward)
  }
  for (const u of usage) row(u.leave_type).used = Number(u.used)
  const types = [...byType.values()]
    .map((t) => ({ ...t, remaining: Math.round((t.entitled + t.carriedForward - t.used) * 10) / 10 }))
    .sort((a, b) => LEAVE_TYPES.indexOf(a.leaveType) - LEAVE_TYPES.indexOf(b.leaveType))
  return { userId, year, types }
}

/**
 * GET /balances: your own by default; `userId=` for someone else, or
 * `scope=team` for everyone — both admin/manager/hr only.
 */
exports.balances = async (currentUser, { year, userId, scope } = {}) => {
  const y = yearOf(year)
  const elevated = VIEW_ALL_ROLES.includes(roleOf(currentUser))

  if (scope === 'team') {
    if (!elevated) throw new LeaveError('You can only view your own leave balance.', 403)
    const [users, entitlements, usage] = await Promise.all([
      identity.getActiveUsers(),
      repo.findEntitlements({ year: y }),
      repo.sumApprovedDays({ year: y }),
    ])
    return {
      year: y,
      items: users.map((u) => ({
        ...buildBalances(u.id, y,
          entitlements.filter((e) => e.user_id === u.id),
          usage.filter((x) => x.user_id === u.id)),
        userName: u.name,
      })),
    }
  }

  const target = userId || currentUser.id
  if (target !== currentUser.id && !elevated) {
    throw new LeaveError('You can only view your own leave balance.', 403)
  }
  if (!UUID_RE.test(String(target))) throw new LeaveError('User not found.', 404)
  const [entitlements, usage] = await Promise.all([
    repo.findEntitlements({ year: y, userId: target }),
    repo.sumApprovedDays({ year: y, userId: target }),
  ])
  return buildBalances(target, y, entitlements, usage)
}

/** PUT /balances — admin/hr set a person's entitlement for a year and type. */
exports.setEntitlement = async (currentUser, body = {}) => {
  if (!['admin', 'hr'].includes(roleOf(currentUser))) {
    throw new LeaveError('Only admin or HR can set leave entitlements.', 403)
  }
  const { userId, leaveType } = body
  if (!UUID_RE.test(String(userId || ''))) throw new LeaveError('Please select a user.')
  if (!LEAVE_TYPES.includes(String(leaveType))) {
    throw new LeaveError(`Leave type must be one of: ${LEAVE_TYPES.join(', ')}.`)
  }
  const num = (v, label) => {
    const n = v === undefined || v === null || v === '' ? 0 : Number(v)
    if (!Number.isFinite(n) || n < 0 || n > 365 || Math.round(n * 2) !== n * 2) {
      throw new LeaveError(`${label} must be between 0 and 365, in half days.`)
    }
    return n
  }
  const entitled = num(body.entitled, 'Entitled days')
  const carriedForward = num(body.carriedForward, 'Carried-forward days')
  const account = await identity.getAccountState(userId)
  if (!account) throw new LeaveError('User not found.', 404)

  const year = yearOf(body.year)
  await repo.upsertEntitlement({
    userId, year, leaveType: String(leaveType), entitled, carriedForward, updatedBy: currentUser.id,
  })
  return exports.balances(currentUser, { year, userId })
}

exports.LEAVE_TYPES = LEAVE_TYPES
