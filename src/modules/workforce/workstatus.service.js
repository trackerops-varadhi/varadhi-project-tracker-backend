// End-of-day work status and the attendance register (Module 9, Phase 3).
// Knows nothing about req/res.

const repo = require('./workstatus.repo')
const leaveRepo = require('./leave.repo')
const identity = require('../identity')
const notify = require('../notify')
const {
  BUSINESS_TZ, todayIn, addDays, daysBetween, isYmd, isWeekend, previousWorkingDay,
} = require('./dates')

// Lazy, as in leave.service: people reads workforce at load time.
const people = () => require('../people')

const TEAM_ROLES = ['admin', 'manager', 'hr']
// A status can be back-filled for the last week, never written for the future.
const BACKFILL_DAYS = 7
const MAX_ATTENDANCE_DAYS = 31

class WorkStatusError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}
exports.WorkStatusError = WorkStatusError

const roleOf = (user) => String(user?.role || '').toLowerCase()

const textField = (value, label, { required = false, max = 4000 } = {}) => {
  const s = value === undefined || value === null ? '' : String(value).trim()
  if (!s) {
    if (required) throw new WorkStatusError(`${label} is required.`)
    return null
  }
  if (s.length > max) throw new WorkStatusError(`${label} must be ${max} characters or fewer.`)
  return s
}

const mapStatus = (row) => row && ({
  id: row.id,
  userId: row.user_id,
  date: row.date,
  summary: row.summary,
  blockers: row.blockers,
  tomorrowPlan: row.tomorrow_plan,
  submittedAt: row.submitted_at,
  updatedAt: row.updated_at,
})

/* ── own work status ──────────────────────────────────────────────────── */

exports.getMine = async (currentUser) => {
  const today = todayIn()
  const recent = (await repo.listOwnWorkStatus(currentUser.id)).map(mapStatus)
  return { date: today, today: recent.find((r) => r.date === today) ?? null, recent }
}

exports.submit = async (currentUser, body = {}) => {
  const today = todayIn()
  const date = body.date ? String(body.date) : today
  if (!isYmd(date)) throw new WorkStatusError('Date must be YYYY-MM-DD.')
  if (date > today) throw new WorkStatusError('You cannot submit a work status for a future date.')
  if (daysBetween(date, today) > BACKFILL_DAYS) {
    throw new WorkStatusError(`A work status can be filled in for the last ${BACKFILL_DAYS} days only.`)
  }
  const row = await repo.upsertWorkStatus({
    userId: currentUser.id,
    date,
    summary: textField(body.summary, 'Summary', { required: true }),
    blockers: textField(body.blockers, 'Blockers'),
    tomorrowPlan: textField(body.tomorrowPlan, 'Tomorrow\'s plan'),
  })
  return mapStatus(row)
}

/* ── team views (admin / manager / hr) ────────────────────────────────── */

const assertTeamRole = (currentUser) => {
  if (!TEAM_ROLES.includes(roleOf(currentUser))) {
    throw new WorkStatusError('Only admin, manager or HR can view team status.', 403)
  }
}

/** Everyone active, with their status for `date` or a gap where it is missing. */
exports.team = async (currentUser, { date } = {}) => {
  assertTeamRole(currentUser)
  const day = date ? String(date) : todayIn()
  if (!isYmd(day)) throw new WorkStatusError('Date must be YYYY-MM-DD.')

  const [users, statuses, attendance] = await Promise.all([
    identity.getActiveUsers(),
    repo.listWorkStatusOn(day),
    repo.attendanceRows(day, day),
  ])
  const byUser = new Map(statuses.map((s) => [s.user_id, s]))
  const loggedIn = new Set(attendance.map((a) => a.user_id))
  const items = users.map((u) => ({
    userId: u.id,
    userName: u.name,
    role: u.role,
    checkedIn: loggedIn.has(u.id),
    status: mapStatus(byUser.get(u.id)) ?? null,
  }))
  return {
    date: day,
    submitted: items.filter((i) => i.status).length,
    missing: items.filter((i) => !i.status && i.checkedIn).length,
    items,
  }
}

/**
 * The attendance register for [from, to] (max 31 days). Per person per day:
 * an explicit attendance status from a time log, else 'present' if anything
 * was logged, else 'on_leave' / 'half_day' from approved leave, else 'absent'
 * on a past or current weekday. Weekends are 'weekend'; future days null.
 */
exports.attendance = async (currentUser, { from, to } = {}) => {
  assertTeamRole(currentUser)
  const today = todayIn()
  const start = from ? String(from) : today
  const end = to ? String(to) : start
  if (!isYmd(start) || !isYmd(end)) throw new WorkStatusError('from and to must be YYYY-MM-DD dates.')
  if (end < start) throw new WorkStatusError('"to" cannot be before "from".')
  if (daysBetween(start, end) >= MAX_ATTENDANCE_DAYS) {
    throw new WorkStatusError(`The register covers at most ${MAX_ATTENDANCE_DAYS} days per request.`)
  }

  const [users, logs, leave] = await Promise.all([
    identity.getActiveUsers(),
    repo.attendanceRows(start, end),
    leaveRepo.findLeaveOverlapping(start, end, BUSINESS_TZ),
  ])
  const logKey = (u, d) => `${u}|${d}`
  const logByKey = new Map(logs.map((l) => [logKey(l.user_id, l.date), l]))
  const approved = leave.filter((l) => l.status === 'approved')

  const dates = []
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d)

  const summary = Object.fromEntries(dates.map((d) => [d, {
    present: 0, wfh: 0, half_day: 0, on_leave: 0, absent: 0,
  }]))

  const items = users.map((u) => {
    const days = dates.map((d) => {
      const log = logByKey.get(logKey(u.id, d))
      const onLeave = approved.find((l) => l.user_id === u.id && l.start_date <= d && l.end_date >= d)
      let status
      if (log) status = log.attendance_status || 'present'
      else if (onLeave) status = onLeave.day_type === 'half_day' ? 'half_day' : 'on_leave'
      else if (isWeekend(d)) status = 'weekend'
      else if (d > today) status = null
      else status = 'absent'
      if (status && summary[d][status] !== undefined) summary[d][status] += 1
      return {
        date: d,
        status,
        hours: log?.hours ?? null,
        firstCheckIn: log?.first_check_in ?? null,
        lastCheckOut: log?.last_check_out ?? null,
      }
    })
    return { userId: u.id, userName: u.name, role: u.role, days }
  })

  return { from: start, to: end, dates, summary, items }
}

/* ── background sweeps (called from jobs.js) ──────────────────────────── */

/** Evening nudge: logged time today but no work status yet. */
exports.sweepNudge = async () => {
  const today = todayIn()
  if (isWeekend(today)) return { nudged: 0 }
  const missing = await repo.findMissingWorkStatus(today)
  if (missing.length) {
    await notify.dispatchToUsers({
      userIds: missing,
      type: notify.TYPES.WORK_STATUS_MISSING,
      title: 'Daily work status',
      message: 'You logged time today but have not submitted your end-of-day work status.',
      linkTo: '/time-management?tab=work-status',
      priority: 'normal',
      dedupeWindowMinutes: 60 * 12,
    })
  }
  return { nudged: missing.length }
}

/** Next morning: still missing for the previous working day → their manager. */
exports.sweepEscalate = async () => {
  const day = previousWorkingDay(todayIn())
  const missing = await repo.findMissingWorkStatus(day)
  if (!missing.length) return { escalated: 0 }

  const cards = await identity.getUserCards(missing)
  const byManager = new Map()
  for (const userId of missing) {
    const managerId = await people().getReportingManagerId(userId)
    if (!managerId || managerId === userId) continue
    if (!byManager.has(managerId)) byManager.set(managerId, [])
    byManager.get(managerId).push(cards.get(userId)?.name ?? 'A team member')
  }
  for (const [managerId, names] of byManager) {
    await notify.dispatch({
      userId: managerId,
      type: notify.TYPES.WORK_STATUS_MISSING,
      title: 'Work status not submitted',
      message: `${names.join(', ')} did not submit a work status for ${day}.`,
      linkTo: '/time-management?tab=team-status',
      priority: 'normal',
      dedupeWindowMinutes: 60 * 12,
    })
  }
  return { escalated: [...byManager.values()].reduce((n, l) => n + l.length, 0) }
}

/** First of the month: remind everyone to file planned leave in advance. */
exports.sweepLeaveNoticeReminder = async () => {
  await notify.dispatchToRoles({
    roles: ['admin', 'manager', 'employee', 'hr'],
    type: notify.TYPES.SYSTEM,
    title: 'Plan your leave',
    message: 'A new month has started — please apply for any planned leave at least 7 days in advance.',
    linkTo: '/leave-management',
    priority: 'low',
    dedupeWindowMinutes: 60 * 24,
  })
  return { sent: true }
}
