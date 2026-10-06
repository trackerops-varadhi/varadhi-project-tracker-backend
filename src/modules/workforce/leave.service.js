// Leave-request business logic: validation, day arithmetic, display enrichment
// and notification fan-out. Knows nothing about req/res.

const repo = require('./leave.repo')
const identity = require('../identity')
const notify = require('../notify')

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
const STATUSES = ['pending', 'approved', 'rejected']

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
const mapLeaveRequest = (row, card) => ({
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
  createdAt: row.created_at,
})

// One batched identity call for the whole page, not one per row.
const withUserCards = async (rows) => {
  const cards = await identity.getUserCards(rows.map((r) => r.user_id))
  return rows.map((r) => mapLeaveRequest(r, cards.get(r.user_id)))
}

const withUserCard = async (row) => {
  const cards = await identity.getUserCards([row.user_id])
  return mapLeaveRequest(row, cards.get(row.user_id))
}

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
  const { startDate, endDate, type, reason, dayType } = body

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

  const row = await repo.insertLeaveRequest({
    userId: currentUser.id,
    startDate, endDate, days,
    type: leaveType,
    reason,
    dayType: leaveDayType,
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

  return dto
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

  const row = await repo.updateLeaveStatus(id, status)
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
