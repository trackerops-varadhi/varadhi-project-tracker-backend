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
  planningType = 'planned', noticeDays = null, isLateNotice = false,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO leave_requests
       (user_id, start_date, end_date, days, type, reason, status, day_type,
        planning_type, notice_days, is_late_notice)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10)
     RETURNING *`,
    [userId, startDate, endDate, days, type, reason, dayType, planningType, noticeDays, isLateNotice]
  )
  return rows[0]
}

// Returns the updated row, or null when no row matched — so the caller can
// tell "not found" from "updated" without a second SELECT.
//
// Records who decided and, on approval, when. Only a PENDING request can be
// decided — a cancelled one is not resurrected by a late approval.
exports.updateLeaveStatus = async (id, status, approverId = null) => {
  const { rows } = await pool.query(
    `UPDATE leave_requests
        SET status = $1,
            approver_id = $3,
            approved_at = CASE WHEN $1 = 'approved' THEN NOW() ELSE NULL END
      WHERE id = $2 AND status <> 'cancelled'
      RETURNING *`,
    [status, id, approverId]
  )
  return rows[0] || null
}

// Owner withdraws their own request — only while it is still pending.
exports.cancelLeaveRequest = async (id, userId) => {
  const { rows } = await pool.query(
    `UPDATE leave_requests SET status = 'cancelled', cancelled_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'pending'
      RETURNING *`,
    [id, userId]
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
    `SELECT id, user_id, start_date, end_date, status, day_type, type, planning_type,
            ((created_at AT TIME ZONE 'UTC') AT TIME ZONE $3)::date::text AS applied_on
       FROM leave_requests
      WHERE start_date <= $2 AND end_date >= $1`,
    [from, to, timeZone]
  )
  return rows
}

/* ── balances ─────────────────────────────────────────────────────────── */

exports.findEntitlements = async ({ year, userId = null }) => {
  const params = [year]
  let where = 'WHERE year = $1'
  if (userId) { params.push(userId); where += ` AND user_id = $2` }
  const { rows } = await pool.query(`SELECT * FROM leave_balances ${where}`, params)
  return rows
}

// Approved days per user and type for leave starting in `year`.
exports.sumApprovedDays = async ({ year, userId = null }) => {
  const params = [year]
  let where = `WHERE status = 'approved' AND EXTRACT(YEAR FROM start_date) = $1`
  if (userId) { params.push(userId); where += ` AND user_id = $2` }
  const { rows } = await pool.query(
    `SELECT user_id, type AS leave_type, SUM(days)::float AS used
       FROM leave_requests ${where}
      GROUP BY user_id, type`,
    params
  )
  return rows
}

exports.upsertEntitlement = async ({ userId, year, leaveType, entitled, carriedForward, updatedBy }) => {
  const { rows } = await pool.query(
    `INSERT INTO leave_balances (user_id, year, leave_type, entitled, carried_forward, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, year, leave_type)
     DO UPDATE SET entitled = EXCLUDED.entitled,
                   carried_forward = EXCLUDED.carried_forward,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = NOW()
     RETURNING *`,
    [userId, year, leaveType, entitled, carriedForward, updatedBy]
  )
  return rows[0]
}
