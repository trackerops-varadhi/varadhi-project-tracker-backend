// SQL for time_logs. This module owns the table.
//
// As with leave.repo.js, the legacy `LEFT JOIN users` and `LEFT JOIN projects`
// are gone — both were lookup-only (u.name, p.name) and are now resolved via
// identity.getUserCards() and work.getProjectCards() in time.service.js. Every
// query here touches one table.

const pool = require('../../platform/db').forSchema('workforce')

exports.listTimeLogs = async ({ scopeUserId = null, projectId = null }) => {
  const params = []
  let where = 'WHERE 1=1'

  if (scopeUserId) {
    params.push(scopeUserId)
    where += ` AND user_id = $${params.length}`
  }
  if (projectId) {
    params.push(projectId)
    where += ` AND project_id = $${params.length}`
  }

  const { rows } = await pool.query(
    `SELECT * FROM time_logs ${where} ORDER BY date DESC, created_at DESC`,
    params
  )
  return rows
}

exports.insertTimeLog = async ({
  userId, projectId, date, hours, note, checkIn, checkOut, attendanceStatus = null,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO time_logs (user_id, project_id, date, hours, note, check_in, check_out, attendance_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, projectId, date, hours, note, checkIn, checkOut, attendanceStatus]
  )
  return rows[0]
}

// Used to refuse a second check-in while one is still open. Without this,
// repeated calls pile up open rows and only the newest is ever closed.
exports.findOpenCheckIn = async (userId, date) => {
  const { rows } = await pool.query(
    `SELECT id FROM time_logs
      WHERE user_id = $1 AND date = $2
        AND check_in IS NOT NULL AND check_out IS NULL
      LIMIT 1`,
    [userId, date]
  )
  return rows[0] || null
}

/**
 * Find the open check-in for a date and compute its duration IN POSTGRES.
 *
 * The arithmetic must not move to JS. `check_in`/`check_out` are `timestamp
 * WITHOUT time zone`, so Postgres stores the wall-clock value and strips the
 * offset. Reading the column back into JS yields a Date node interprets as
 * UTC, while the incoming `checkOut` string keeps its real offset —
 * subtracting the two in JS mixes frames and inflates every duration by the
 * server's UTC offset (a 09:00→17:00 shift billed as 13.5h in IST). Casting
 * the parameter the same way the column is declared keeps both operands in
 * one frame.
 *
 * Ordering by check_in DESC with the `check_out IS NULL` filter also ensures
 * this closes the OPEN check-in rather than merely the newest row for the
 * date — without that filter it picked up manual `POST /` entries created
 * after the check-in, overwriting their hours and leaving the real check-in
 * open forever.
 */
exports.findOpenCheckInForCheckout = async (userId, date, checkOut) => {
  const { rows } = await pool.query(
    `SELECT *,
            EXTRACT(EPOCH FROM ($3::timestamp - check_in)) / 3600.0 AS computed_hours
       FROM time_logs
      WHERE user_id = $1 AND date = $2
        AND check_in IS NOT NULL AND check_out IS NULL
      ORDER BY check_in DESC
      LIMIT 1`,
    [userId, date, checkOut]
  )
  return rows[0] || null
}

/**
 * Remove every time log booked against a deleted project.
 *
 * time_logs.project_id was ON DELETE CASCADE to projects until the Phase 2
 * schema split dropped the cross-schema key; this is that cascade, run from
 * the project.deleted subscriber. Logs with no project are never matched.
 *
 * @returns {Promise<number>} rows removed
 */
exports.deleteTimeLogsForProject = async (projectId) => {
  const { rowCount } = await pool.query('DELETE FROM time_logs WHERE project_id = $1', [projectId])
  return rowCount
}

exports.closeCheckOut = async (id, { checkOut, hours, note }) => {
  const { rows } = await pool.query(
    `UPDATE time_logs
        SET check_out = $1, hours = $2, note = COALESCE($3, note)
      WHERE id = $4
      RETURNING *`,
    [checkOut, hours, note, id]
  )
  return rows[0] || null
}

// Who logged time on each day of a range — the attendance signal people's HR
// dashboard counts as "present". Any row on the date counts, check-in or a
// manual entry, matching what the Time screen shows as a worked day.
exports.findPresenceByDate = async (from, to) => {
  const { rows } = await pool.query(
    `SELECT date, array_agg(DISTINCT user_id) AS user_ids
       FROM time_logs
      WHERE date BETWEEN $1 AND $2 AND user_id IS NOT NULL
      GROUP BY date`,
    [from, to]
  )
  return rows
}
