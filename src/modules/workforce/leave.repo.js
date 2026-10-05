// SQL for leave_requests. This module owns the table; nothing outside
// modules/workforce/ may query it.
//
// Note what is NOT here: the `LEFT JOIN users u ON lr.user_id = u.id` that the
// legacy controller used for `u.name`. That join was lookup-only — it existed
// purely to turn a UUID into a display name — so it moved out to
// identity.getUserCards() in leave.service.js. Every query below touches
// exactly one table, which is what lets this module own its own schema in
// Phase 2 without dropping a single foreign key it depends on.

const pool = require('../../platform/db').forSchema('workforce')

exports.listLeaveRequests = async ({ scopeUserId = null, status = null }) => {
  const params = []
  let where = 'WHERE 1=1'

  if (scopeUserId) {
    params.push(scopeUserId)
    where += ` AND user_id = $${params.length}`
  }
  if (status) {
    params.push(status)
    where += ` AND status = $${params.length}`
  }

  const { rows } = await pool.query(
    `SELECT * FROM leave_requests ${where} ORDER BY start_date DESC`,
    params
  )
  return rows
}

exports.findLeaveRequestById = async (id) => {
  const { rows } = await pool.query(`SELECT * FROM leave_requests WHERE id = $1`, [id])
  return rows[0] || null
}

exports.insertLeaveRequest = async ({
  userId, startDate, endDate, days, type, reason, dayType,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO leave_requests
       (user_id, start_date, end_date, days, type, reason, status, day_type)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     RETURNING *`,
    [userId, startDate, endDate, days, type, reason, dayType]
  )
  return rows[0]
}

// Returns the updated row, or null when no row matched — so the caller can
// tell "not found" from "updated" without a second SELECT.
exports.updateLeaveStatus = async (id, status) => {
  const { rows } = await pool.query(
    `UPDATE leave_requests SET status = $1 WHERE id = $2 RETURNING *`,
    [status, id]
  )
  return rows[0] || null
}

// Leave requests that touch a date range, any status. The caller decides what
// counts (approved = on leave, pending = awaiting a decision).
//
// `applied_on` is the calendar day the request was made in the business time
// zone. created_at is a zone-less timestamp written by NOW() on a UTC session,
// so it is read as UTC first and then converted.
exports.findLeaveOverlapping = async (from, to, timeZone) => {
  const { rows } = await pool.query(
    `SELECT id, user_id, start_date, end_date, status, day_type,
            ((created_at AT TIME ZONE 'UTC') AT TIME ZONE $3)::date::text AS applied_on
       FROM leave_requests
      WHERE start_date <= $2 AND end_date >= $1`,
    [from, to, timeZone]
  )
  return rows
}
