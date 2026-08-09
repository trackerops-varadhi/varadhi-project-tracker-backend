const pool = require('../config/db')
const { successResponse, errorResponse } = require('../utils/response')

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

    if (currentUser.role.toLowerCase() === 'employee') {
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

    // Allow optional projectId; default to null
    const proj = projectId || null

    // If checkIn/checkOut provided compute hours, else use provided hours (or 0)
    let hrs = 0
    if (checkIn && checkOut) {
      hrs = Math.max(0, (new Date(checkOut) - new Date(checkIn)) / 3600000)
    } else if (hours) {
      hrs = Number(hours)
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

    // Add a notification for the user about the submitted time (best-effort)
    try {
      const row = created.rows[0]
      const title = 'Time Submitted'
      const message = `Your time entry for ${row.date} (${row.hours}h) was recorded.`
      await pool.query(`INSERT INTO notifications (type, title, message, user_id, link_to) VALUES ($1,$2,$3,$4,$5)`, ['time_log', title, message, row.user_id, '/time-management'])
    } catch (e) {
      console.error('time log notify error:', e.message)
    }

    return successResponse(res, mapTimeLog(created.rows[0]), 'Time log created successfully.', 201)
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// POST /check-in
exports.checkIn = async (req, res) => {
  try {
    const { projectId, date, checkIn, note } = req.body
    if (!date || !checkIn) return errorResponse(res, 'Date and checkIn timestamp are required.')
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
    return errorResponse(res, e.message, 500)
  }
}

// POST /check-out
exports.checkOut = async (req, res) => {
  try {
    const { date, checkOut, note } = req.body
    if (!date || !checkOut) return errorResponse(res, 'Date and checkOut timestamp are required.')

    // Find the latest time_log for this user on the given date
    const found = await pool.query(
      `SELECT * FROM time_logs WHERE user_id=$1 AND date=$2 ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, date]
    )

    if (!found.rows[0]) {
      return errorResponse(res, 'No check-in found for this date.', 404)
    }

    const checkIn = found.rows[0].check_in
    const hours = checkIn ? Math.max(0, (new Date(checkOut) - new Date(checkIn)) / 3600000) : 0

    const updated = await pool.query(
      `UPDATE time_logs SET check_out=$1, hours=$2, note=COALESCE($3, note) WHERE id=$4 RETURNING id`,
      [checkOut, hours, note || null, found.rows[0].id]
    )

    const refreshed = await pool.query(
      `SELECT tl.*, u.name AS user_name, p.name AS project_name FROM time_logs tl LEFT JOIN users u ON tl.user_id = u.id LEFT JOIN projects p ON tl.project_id = p.id WHERE tl.id = $1`,
      [updated.rows[0].id]
    )

    // notify user
    try {
      const row = refreshed.rows[0]
      const title = 'Time Submitted'
      const message = `Your time entry for ${row.date} (${row.hours}h) was recorded.`
      await pool.query(`INSERT INTO notifications (type, title, message, user_id, link_to) VALUES ($1,$2,$3,$4,$5)`, ['time_log', title, message, row.user_id, '/time-management'])
    } catch (e) { console.error('notify error:', e.message) }

    return successResponse(res, mapTimeLog(refreshed.rows[0]), 'Checked out.')
  } catch (e) {
    return errorResponse(res, e.message, 500)
  }
}
