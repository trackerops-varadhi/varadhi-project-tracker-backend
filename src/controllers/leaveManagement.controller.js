const pool = require('../config/db')
const { successResponse, errorResponse } = require('../utils/response')

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

    if (currentUser.role.toLowerCase() === 'employee') {
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
    return errorResponse(res, err.message, 500)
  }
}

exports.createLeaveRequest = async (req, res) => {
  try {
    const { startDate, endDate, type, reason } = req.body

    if (!startDate || !endDate || !reason) {
      return errorResponse(res, 'Start date, end date, and reason are required.')
    }

    const start = new Date(startDate)
    const end = new Date(endDate)
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
    return errorResponse(res, err.message, 500)
  }
}

// Notify managers when a new leave request is created (helper - non-blocking)
async function notifyManagersAboutLeave(leaveRow) {
  try {
    const managers = await pool.query("SELECT id, name FROM users WHERE role = 'manager'")
    const title = 'New Leave Request'
    const message = `${leaveRow.user_name} applied for ${leaveRow.type} from ${leaveRow.start_date} to ${leaveRow.end_date}`
    const link = '/leave-management'

    const inserts = managers.rows.map((mgr) => {
      return pool.query(
        `INSERT INTO notifications (type, title, message, user_id, link_to) VALUES ($1,$2,$3,$4,$5)`,
        ['leave_request', title, message, mgr.id, link]
      )
    })

    await Promise.all(inserts)
  } catch (e) {
    // swallow errors - notifications are best-effort
    console.error('notifyManagersAboutLeave error:', e.message)
  }
}

exports.updateLeaveRequestStatus = async (req, res) => {
  try {
    if (req.user.role.toLowerCase() === 'employee') {
      return errorResponse(res, 'You are not authorized to update leave status.', 403)
    }

    const { status } = req.body
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return errorResponse(res, 'Please provide a valid leave status.')
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

    // Notify the request owner about status change (best-effort)
    try {
      const refreshedRow = refreshed.rows[0]
      const title = 'Leave Request Update'
      const message = `Your leave request (${refreshedRow.start_date} → ${refreshedRow.end_date}) was ${refreshedRow.status}.`
      await pool.query(`INSERT INTO notifications (type, title, message, user_id, link_to) VALUES ($1,$2,$3,$4,$5)`, ['leave_status', title, message, refreshedRow.user_id, '/leave-management'])
    } catch (e) {
      console.error('notify requester error:', e.message)
    }

    return successResponse(res, mapLeaveRequest(refreshed.rows[0]), 'Leave request updated successfully.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}
