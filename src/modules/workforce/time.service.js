// Time-log business logic: validation, hour normalisation, display enrichment
// and notification. Knows nothing about req/res.

const repo = require('./time.repo')
const identity = require('../identity')
const work = require('../work')
const notify = require('../notify')

// `hours` is NUMERIC(5,2) — anything at or above 1000 overflows the column and
// surfaces as a raw Postgres 500. A day cannot exceed 24h anyway, so cap there
// and reject the rest as a 400 rather than letting the driver fail.
const MAX_HOURS_PER_ENTRY = 24

class TimeError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}
exports.TimeError = TimeError

// Returns a finite, in-range number of hours, or null if the input is unusable.
// Guards both paths into the column: an explicit `hours` value (which may be
// non-numeric) and a computed checkIn→checkOut span (which may be enormous).
const normalizeHours = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > MAX_HOURS_PER_ENTRY) return null
  // Match the column's scale so the value we return is the value stored.
  return Math.round(n * 100) / 100
}

// Module 9: how the person worked that day. 'on_leave'/'absent' are derived by
// the attendance register, never self-reported on a time log.
const ATTENDANCE_STATUSES = ['present', 'wfh', 'half_day']
const attendanceStatusOf = (value) => {
  if (value === undefined || value === null || value === '') return null
  if (!ATTENDANCE_STATUSES.includes(String(value))) {
    throw new TimeError(`Attendance status must be one of: ${ATTENDANCE_STATUSES.join(', ')}.`)
  }
  return String(value)
}

// Postgres throws `invalid input syntax for type date` on a bad string, which
// would otherwise reach the client as a 500.
const isValidDate = (value) => !Number.isNaN(new Date(value).getTime())

// ── mapping ──────────────────────────────────────────────────────────────
const mapTimeLog = (row, userCard, projectCard) => {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    userName: userCard?.name ?? null,
    projectId: row.project_id,
    projectName: projectCard?.name ?? null,
    date: row.date,
    hours: row.hours,
    checkIn: row.check_in,
    checkOut: row.check_out,
    attendanceStatus: row.attendance_status ?? null,
    note: row.note,
    createdAt: row.created_at,
  }
}

// Two batched cross-module lookups for the whole page, resolved in parallel —
// replacing what used to be two SQL joins. This is the shape every list
// endpoint takes once its display joins are removed.
const withCards = async (rows) => {
  if (rows.length === 0) return []
  const [users, projects] = await Promise.all([
    identity.getUserCards(rows.map((r) => r.user_id)),
    work.getProjectCards(rows.map((r) => r.project_id)),
  ])
  return rows.map((r) => mapTimeLog(r, users.get(r.user_id), projects.get(r.project_id)))
}

const withCard = async (row) => (await withCards([row]))[0]

// Best-effort confirmation, shared by createTimeLog and checkOut. Awaited by
// both callers, matching the legacy controllers.
const notifyLogged = async (row) => {
  try {
    await notify.dispatch({
      userId: row.user_id,
      type: notify.TYPES.TIME_LOGGED,
      title: 'Time Submitted',
      message: `Your time entry for ${row.date} (${row.hours}h) was recorded.`,
      linkTo: '/time-management',
      priority: 'low',
    })
  } catch (e) {
    console.error('time log notify error:', e.message)
  }
}

// ── reads ────────────────────────────────────────────────────────────────
exports.listForUser = async (currentUser, { projectId } = {}) => {
  if (!currentUser || !currentUser.id) {
    throw new TimeError('Authentication required.', 401)
  }
  // Allow-list (Module 9): admin, manager and hr see everyone's time; any other
  // role — including a null one — sees only its own.
  const role = String(currentUser.role || '').toLowerCase()
  const rows = await repo.listTimeLogs({
    scopeUserId: ['admin', 'manager', 'hr'].includes(role) ? null : currentUser.id,
    projectId: projectId || null,
  })
  return withCards(rows)
}

// ── writes ───────────────────────────────────────────────────────────────
exports.create = async (currentUser, body) => {
  const { projectId, date, hours, note, checkIn, checkOut } = body
  const attendanceStatus = attendanceStatusOf(body.attendanceStatus)

  if (!date) throw new TimeError('Date is required.')
  if (!isValidDate(date)) throw new TimeError('Date is not a valid date.')
  if (checkIn && !isValidDate(checkIn)) throw new TimeError('checkIn is not a valid timestamp.')
  if (checkOut && !isValidDate(checkOut)) throw new TimeError('checkOut is not a valid timestamp.')

  // If checkIn/checkOut are both supplied, compute hours from them; otherwise
  // take the explicit `hours` value, defaulting to 0.
  let hrs = 0
  if (checkIn && checkOut) {
    // Both strings come from the same request, so they share a frame here and
    // a JS subtraction is safe — unlike the checkOut endpoint, which compares
    // a body string against a naive timestamp read back from the column and
    // must therefore do its arithmetic in SQL.
    if (new Date(checkOut) < new Date(checkIn)) {
      throw new TimeError('checkOut cannot be earlier than checkIn.')
    }
    hrs = normalizeHours((new Date(checkOut) - new Date(checkIn)) / 3600000)
    if (hrs === null) {
      throw new TimeError(
        `Computed duration exceeds the ${MAX_HOURS_PER_ENTRY}h maximum for a single entry.`
      )
    }
  } else if (hours !== undefined && hours !== null && hours !== '') {
    hrs = normalizeHours(hours)
    if (hrs === null) {
      throw new TimeError(`Hours must be a number between 0 and ${MAX_HOURS_PER_ENTRY}.`)
    }
  }

  const row = await repo.insertTimeLog({
    userId: currentUser.id,
    projectId: projectId || null,
    date,
    hours: hrs,
    note: note || null,
    checkIn: checkIn || null,
    checkOut: checkOut || null,
    attendanceStatus,
  })

  await notifyLogged(row)
  return withCard(row)
}

exports.checkIn = async (currentUser, body) => {
  const { projectId, date, checkIn, note } = body
  const attendanceStatus = attendanceStatusOf(body.attendanceStatus) || 'present'
  if (!date || !checkIn) throw new TimeError('Date and checkIn timestamp are required.')
  if (!isValidDate(date)) throw new TimeError('Date is not a valid date.')
  if (!isValidDate(checkIn)) throw new TimeError('checkIn is not a valid timestamp.')

  const open = await repo.findOpenCheckIn(currentUser.id, date)
  if (open) {
    throw new TimeError(
      'You already have an open check-in for this date. Check out before checking in again.',
      409
    )
  }

  const row = await repo.insertTimeLog({
    userId: currentUser.id,
    projectId: projectId || null,
    date,
    hours: 0,
    note: note || null,
    checkIn,
    checkOut: null,
    attendanceStatus,
  })
  return withCard(row)
}

exports.checkOut = async (currentUser, body) => {
  const { date, checkOut, note } = body
  if (!date || !checkOut) throw new TimeError('Date and checkOut timestamp are required.')
  if (!isValidDate(date)) throw new TimeError('Date is not a valid date.')
  if (!isValidDate(checkOut)) throw new TimeError('checkOut is not a valid timestamp.')

  const found = await repo.findOpenCheckInForCheckout(currentUser.id, date, checkOut)
  if (!found) throw new TimeError('No open check-in found for this date.', 404)

  // Computed by Postgres, so both operands shared the column's frame.
  const computed = Number(found.computed_hours)
  if (computed < 0) throw new TimeError('checkOut cannot be earlier than checkIn.')

  const hours = normalizeHours(computed)
  if (hours === null) {
    throw new TimeError(
      `Computed duration exceeds the ${MAX_HOURS_PER_ENTRY}h maximum for a single entry.`
    )
  }

  const row = await repo.closeCheckOut(found.id, { checkOut, hours, note: note || null })

  await notifyLogged(row)
  return withCard(row)
}
