const pool = require('../config/db')
const { successResponse, errorResponse } = require('../utils/response')
const {
  dispatchNotification,
  notifyByRoles,
  NOTIFICATION_TYPES,
} = require('../utils/notification-engine')

// Guards `WHERE id = $1` against a non-UUID path param, which Postgres rejects
// with `invalid input syntax for type uuid` rather than returning no rows.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const mapLeaveRequest = (row) => ({
  id: row.id,
  userId: row.user_id,
  userName: row.user_name,
  startDate: row.start_date,
  endDate: row.end_date,
  days: row.days,
  type: row.type,
  reason: row.reason,
  status: row.status,
  createdAt: row.created_at,
})

exports.getLeaveRequests = async (req, res) => {
  try {
    const currentUser = req.user
    const { status } = req.query

    let where = 'WHERE 1=1'
    const params = []

    // `role` is nullable in migrate.js (no NOT NULL), so a null would crash
    // .toLowerCase(). Default to the most restrictive scope on absence.
    if ((currentUser.role || 'employee').toLowerCase() === 'employee') {
      params.push(currentUser.id)
      where += ` AND lr.user_id = $${params.length}`
    }

    if (status) {
      params.push(status)
      where += ` AND lr.status = $${params.length}`
    }

    const result = await pool.query(
      `
        SELECT lr.*, u.name AS user_name
        FROM leave_requests lr
        LEFT JOIN users u ON lr.user_id = u.id
        ${where}
        ORDER BY lr.start_date DESC
      `,
      params
    )

    return successResponse(res, result.rows.map(mapLeaveRequest))
  } catch (err) {
    console.error('getLeaveRequests error:', err)
    return errorResponse(res, 'Failed to load leave requests.', 500)
  }
}

exports.createLeaveRequest = async (req, res) => {
  try {
    const { startDate, endDate, type, reason } = req.body

    if (!startDate || !endDate || !reason || !String(reason).trim()) {
      return errorResponse(res, 'Start date, end date, and reason are required.')
    }

    const start = new Date(startDate)
    const end = new Date(endDate)

    // Unparseable dates previously produced days = NaN, which the driver
    // rejected against `days INTEGER NOT NULL` as an opaque 500.
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return errorResponse(res, 'Start date and end date must be valid dates.')
    }
    // A reversed range used to be silently clamped to 1 day by Math.max.
    if (end < start) {
      return errorResponse(res, 'End date cannot be earlier than start date.')
    }

    const days = Math.max(1, Math.round((end - start) / 86400000) + 1)

    const result = await pool.query(
      `
        INSERT INTO leave_requests (user_id, start_date, end_date, days, type, reason, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending')
        RETURNING id
      `,
      [req.user.id, startDate, endDate, days, type || 'annual', reason]
    )

    const created = await pool.query(
      `
        SELECT lr.*, u.name AS user_name
        FROM leave_requests lr
        LEFT JOIN users u ON lr.user_id = u.id
        WHERE lr.id = $1
      `,
      [result.rows[0].id]
    )

    // Fire-and-forget notify managers
    notifyManagersAboutLeave(created.rows[0]).catch(() => {})

    return successResponse(res, mapLeaveRequest(created.rows[0]), 'Leave request created successfully.', 201)
  } catch (err) {
    console.error('createLeaveRequest error:', err)
    return errorResponse(res, 'Failed to create leave request.', 500)
  }
}

// Notify managers when a new leave request is created (helper - non-blocking)
// Routed through the notification engine rather than a raw INSERT, so leave
// notifications get the same treatment as every other module: preference
// checks, quiet hours, dedupe, push delivery and Teams fan-out.
//
// notifyByRoles also fixes two bugs in the previous raw version: it includes
// admins (who were excluded entirely) and filters to status='active' (so
// deactivated accounts no longer accumulate notifications).
async function notifyManagersAboutLeave(leaveRow) {
  try {
    await notifyByRoles(
      ['admin', 'manager'],
      NOTIFICATION_TYPES.LEAVE_REQUESTED,
      'New Leave Request',
      `${leaveRow.user_name} applied for ${leaveRow.type} from ${leaveRow.start_date} to ${leaveRow.end_date}`,
      '/leave-management',
      'normal'
    )
  } catch (e) {
    // Best-effort: a notification failure must never fail the request itself.
    console.error('notifyManagersAboutLeave error:', e.message)
  }
}

exports.updateLeaveRequestStatus = async (req, res) => {
  try {
    if ((req.user.role || 'employee').toLowerCase() === 'employee') {
      return errorResponse(res, 'You are not authorized to update leave status.', 403)
    }

    const { status } = req.body
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return errorResponse(res, 'Please provide a valid leave status.')
    }

    // A non-UUID path param made Postgres throw `invalid input syntax for
    // type uuid`, which surfaced as a 500 instead of a 404.
    if (!UUID_RE.test(String(req.params.id || ''))) {
      return errorResponse(res, 'Leave request not found.', 404)
    }

    const result = await pool.query(
      `
        UPDATE leave_requests
        SET status = $1
        WHERE id = $2
        RETURNING id
      `,
      [status, req.params.id]
    )

    if (!result.rows[0]) {
      return errorResponse(res, 'Leave request not found.', 404)
    }

    const refreshed = await pool.query(
      `
        SELECT lr.*, u.name AS user_name
        FROM leave_requests lr
        LEFT JOIN users u ON lr.user_id = u.id
        WHERE lr.id = $1
      `,
      [req.params.id]
    )

    // Notify the request owner about the decision, through the engine.
    try {
      const refreshedRow = refreshed.rows[0]
      await dispatchNotification(
        refreshedRow.user_id,
        NOTIFICATION_TYPES.LEAVE_STATUS_CHANGED,
        'Leave Request Update',
        `Your leave request (${refreshedRow.start_date} → ${refreshedRow.end_date}) was ${refreshedRow.status}.`,
        '/leave-management',
        // An approval/rejection is a decision the requester is waiting on, so
        // it outranks routine notifications.
        'high'
      )
    } catch (e) {
      console.error('notify requester error:', e.message)
    }

    return successResponse(res, mapLeaveRequest(refreshed.rows[0]), 'Leave request updated successfully.')
  } catch (err) {
    console.error('updateLeaveRequestStatus error:', err)
    return errorResponse(res, 'Failed to update leave request.', 500)
  }
}
