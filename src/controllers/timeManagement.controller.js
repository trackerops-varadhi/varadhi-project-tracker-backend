const pool = require('../config/db')
const { successResponse, errorResponse } = require('../utils/response')
const {
  dispatchNotification,
  NOTIFICATION_TYPES,
} = require('../utils/notification-engine')

// `hours` is NUMERIC(5,2) — anything at or above 1000 overflows the column and
// surfaces as a raw Postgres 500. A day cannot exceed 24h anyway, so cap there
// and reject the rest as a 400 rather than letting the driver fail.
const MAX_HOURS_PER_ENTRY = 24

// Returns a finite, in-range number of hours, or null if the input is unusable.
// Guards both paths into the column: an explicit `hours` value (which may be
// non-numeric) and a computed checkIn→checkOut span (which may be enormous).
const normalizeHours = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > MAX_HOURS_PER_ENTRY) return null
  // Match the column's scale so the value we return is the value stored.
  return Math.round(n * 100) / 100
}

// Postgres throws `invalid input syntax for type date` on a bad string, which
// would otherwise reach the client as a 500.
const isValidDate = (value) => !Number.isNaN(new Date(value).getTime())

const mapTimeLog = (row) => {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    projectId: row.project_id,
    projectName: row.project_name,
    date: row.date,
    hours: row.hours,
    checkIn: row.check_in,
    checkOut: row.check_out,
    note: row.note,
    createdAt: row.created_at,
  }
}

exports.getTimeLogs = async (req, res) => {
  try {
    const currentUser = req.user
    const { projectId } = req.query

    if (!currentUser || !currentUser.id) {
      return errorResponse(res, 'Authentication required.', 401)
    }

    let where = 'WHERE 1=1'
    const params = []

    // `role` is nullable in migrate.js (no NOT NULL), so a null would crash
    // .toLowerCase(). Default to the most restrictive scope on absence.
    const role = (currentUser.role || 'employee').toLowerCase()
    if (role === 'employee') {
      params.push(currentUser.id)
      where += ` AND tl.user_id = $${params.length}`
    }

    if (projectId) {
      params.push(projectId)
      where += ` AND tl.project_id = $${params.length}`
    }

    const result = await pool.query(
      `
        SELECT tl.*, u.name AS user_name, p.name AS project_name
        FROM time_logs tl
        LEFT JOIN users u ON tl.user_id = u.id
        LEFT JOIN projects p ON tl.project_id = p.id
        ${where}
        ORDER BY tl.date DESC, tl.created_at DESC
      `,
      params
    )

    const rows = result.rows.map(mapTimeLog).filter(Boolean)
    return successResponse(res, rows)
  } catch (err) {
    console.error('getTimeLogs error:', err)
    return errorResponse(res, 'Failed to load time logs.', 500)
  }
}

exports.createTimeLog = async (req, res) => {
  try {
    const { projectId, date, hours, note, checkIn, checkOut } = req.body

    if (!date) {
      return errorResponse(res, 'Date is required.')
    }
    if (!isValidDate(date)) {
      return errorResponse(res, 'Date is not a valid date.')
    }
    if (checkIn && !isValidDate(checkIn)) {
      return errorResponse(res, 'checkIn is not a valid timestamp.')
    }
    if (checkOut && !isValidDate(checkOut)) {
      return errorResponse(res, 'checkOut is not a valid timestamp.')
    }

    // Allow optional projectId; default to null
    const proj = projectId || null

    // If checkIn/checkOut provided compute hours, else use provided hours (or 0)
    let hrs = 0
    if (checkIn && checkOut) {
      // Both strings come from the same request, so they share a frame here
      // and a JS subtraction is safe (unlike checkOut, which compares a body
      // string against a naive timestamp read back from the column).
      if (new Date(checkOut) < new Date(checkIn)) {
        return errorResponse(res, 'checkOut cannot be earlier than checkIn.')
      }
      hrs = normalizeHours((new Date(checkOut) - new Date(checkIn)) / 3600000)
      if (hrs === null) {
        return errorResponse(
          res,
          `Computed duration exceeds the ${MAX_HOURS_PER_ENTRY}h maximum for a single entry.`
        )
      }
    } else if (hours !== undefined && hours !== null && hours !== '') {
      hrs = normalizeHours(hours)
      if (hrs === null) {
        return errorResponse(
          res,
          `Hours must be a number between 0 and ${MAX_HOURS_PER_ENTRY}.`
        )
      }
    }

    const result = await pool.query(
      `
        INSERT INTO time_logs (user_id, project_id, date, hours, note, check_in, check_out)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `,
      [req.user.id, proj, date, hrs, note || null, checkIn || null, checkOut || null]
    )

    const created = await pool.query(
      `
        SELECT tl.*, u.name AS user_name, p.name AS project_name
        FROM time_logs tl
        LEFT JOIN users u ON tl.user_id = u.id
        LEFT JOIN projects p ON tl.project_id = p.id
        WHERE tl.id = $1
      `,
      [result.rows[0].id]
    )

    if (!created.rows[0]) {
      return errorResponse(res, 'Failed to retrieve created time log.', 500)
    }

    // Confirm the entry through the notification engine (best-effort), so it
    // respects preferences, quiet hours and dedupe like every other module.
    try {
      const row = created.rows[0]
      await dispatchNotification(
        row.user_id,
        NOTIFICATION_TYPES.TIME_LOGGED,
        'Time Submitted',
        `Your time entry for ${row.date} (${row.hours}h) was recorded.`,
        '/time-management',
        'low'
      )
    } catch (e) {
      console.error('time log notify error:', e.message)
    }

    return successResponse(res, mapTimeLog(created.rows[0]), 'Time log created successfully.', 201)
  } catch (err) {
    console.error('createTimeLog error:', err)
    return errorResponse(res, 'Failed to create time log.', 500)
  }
}

// POST /check-in
exports.checkIn = async (req, res) => {
  try {
    const { projectId, date, checkIn, note } = req.body
    if (!date || !checkIn) return errorResponse(res, 'Date and checkIn timestamp are required.')
    if (!isValidDate(date)) return errorResponse(res, 'Date is not a valid date.')
    if (!isValidDate(checkIn)) return errorResponse(res, 'checkIn is not a valid timestamp.')

    // Refuse a second check-in while one is still open. Without this, repeated
    // calls pile up open rows and only the newest is ever closed by checkOut.
    const open = await pool.query(
      `SELECT id FROM time_logs
        WHERE user_id = $1 AND date = $2 AND check_in IS NOT NULL AND check_out IS NULL
        LIMIT 1`,
      [req.user.id, date]
    )
    if (open.rows[0]) {
      return errorResponse(
        res,
        'You already have an open check-in for this date. Check out before checking in again.',
        409
      )
    }

    const proj = projectId || null
    const result = await pool.query(
      `INSERT INTO time_logs (user_id, project_id, date, hours, note, check_in) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.user.id, proj, date, 0, note || null, checkIn]
    )
    const created = await pool.query(
      `SELECT tl.*, u.name AS user_name, p.name AS project_name FROM time_logs tl LEFT JOIN users u ON tl.user_id = u.id LEFT JOIN projects p ON tl.project_id = p.id WHERE tl.id = $1`,
      [result.rows[0].id]
    )
    return successResponse(res, mapTimeLog(created.rows[0]), 'Checked in.', 201)
  } catch (e) {
    console.error('checkIn error:', e)
    return errorResponse(res, 'Failed to check in.', 500)
  }
}

// POST /check-out
exports.checkOut = async (req, res) => {
  try {
    const { date, checkOut, note } = req.body
    if (!date || !checkOut) return errorResponse(res, 'Date and checkOut timestamp are required.')
    if (!isValidDate(date)) return errorResponse(res, 'Date is not a valid date.')
    if (!isValidDate(checkOut)) return errorResponse(res, 'checkOut is not a valid timestamp.')

    // Close the OPEN check-in, not merely the newest row for the date.
    // Without `check_in IS NOT NULL AND check_out IS NULL` this picked up
    // manual `POST /` entries created after the check-in, overwriting their
    // hours and leaving the real check-in open forever.
    // `check_in`/`check_out` are `timestamp WITHOUT time zone`, so Postgres
    // stores the wall-clock value and strips the offset. Reading the column
    // back into JS yields a Date that node interprets as UTC, while the
    // incoming `checkOut` string keeps its real offset — subtracting the two
    // in JS mixed frames and inflated every duration by the server's UTC
    // offset (a 09:00→17:00 shift billed as 13.5h in IST).
    //
    // Casting the parameter the same way the column is declared and doing the
    // arithmetic in SQL keeps both operands in one frame.
    const found = await pool.query(
      `SELECT *,
              EXTRACT(EPOCH FROM ($3::timestamp - check_in)) / 3600.0 AS computed_hours
         FROM time_logs
        WHERE user_id = $1 AND date = $2
          AND check_in IS NOT NULL AND check_out IS NULL
        ORDER BY check_in DESC
        LIMIT 1`,
      [req.user.id, date, checkOut]
    )

    if (!found.rows[0]) {
      return errorResponse(res, 'No open check-in found for this date.', 404)
    }

    // Computed by Postgres above, so both operands share the column's frame.
    const computed = Number(found.rows[0].computed_hours)
    if (computed < 0) {
      return errorResponse(res, 'checkOut cannot be earlier than checkIn.')
    }

    const hours = normalizeHours(computed)
    if (hours === null) {
      return errorResponse(
        res,
        `Computed duration exceeds the ${MAX_HOURS_PER_ENTRY}h maximum for a single entry.`
      )
    }

    const updated = await pool.query(
      `UPDATE time_logs SET check_out=$1, hours=$2, note=COALESCE($3, note) WHERE id=$4 RETURNING id`,
      [checkOut, hours, note || null, found.rows[0].id]
    )

    const refreshed = await pool.query(
      `SELECT tl.*, u.name AS user_name, p.name AS project_name FROM time_logs tl LEFT JOIN users u ON tl.user_id = u.id LEFT JOIN projects p ON tl.project_id = p.id WHERE tl.id = $1`,
      [updated.rows[0].id]
    )

    // Confirm the checkout through the engine (best-effort).
    try {
      const row = refreshed.rows[0]
      await dispatchNotification(
        row.user_id,
        NOTIFICATION_TYPES.TIME_LOGGED,
        'Time Submitted',
        `Your time entry for ${row.date} (${row.hours}h) was recorded.`,
        '/time-management',
        'low'
      )
    } catch (e) { console.error('notify error:', e.message) }

    return successResponse(res, mapTimeLog(refreshed.rows[0]), 'Checked out.')
  } catch (e) {
    console.error('checkOut error:', e)
    return errorResponse(res, 'Failed to check out.', 500)
  }
}
