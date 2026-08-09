const pool = require('../config/db')
const bcrypt = require('bcryptjs')
const { successResponse, errorResponse } = require('../utils/response')
const { sendInviteEmail } = require('../utils/sendEmail')
const { notifyByRoles, NOTIFICATION_TYPES } = require('../utils/notification-engine')

// Notifications must never turn a successful action into a 500, so every
// dispatch block runs inside this guard instead of the handler's try/catch.
const notifySafely = async (fn) => {
  try {
    await fn()
  } catch (err) {
    console.error('[notifications] users.controller:', err.message)
  }
}

exports.getAllUsers = async (req, res) => {
  try {
    const { role, status, search } = req.query
    let query = `SELECT id, name, email, role, status, avatar, created_at,
      (SELECT COUNT(*) FROM tasks WHERE assignee_id = users.id)::int AS tasks_count
      FROM users WHERE 1=1`
    const params = []
    if (role) { params.push(role); query += ` AND role = $${params.length}` }
    if (status) { params.push(status); query += ` AND status = $${params.length}` }
    if (search) { params.push(`%${search}%`); query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})` }
    query += ' ORDER BY created_at DESC'
    const result = await pool.query(query, params)
    return successResponse(res, result.rows)
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.getUserById = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, status, avatar, created_at FROM users WHERE id = $1',
      [req.params.id]
    )
    if (!result.rows[0]) return errorResponse(res, 'User not found.', 404)
    return successResponse(res, result.rows[0])
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.updateProfile = async (req, res) => {
  try {
    const { name, email } = req.body
    if (!name || !email) return errorResponse(res, 'Name and email are required.')
    const emailCheck = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, req.user.id])
    if (emailCheck.rows[0]) return errorResponse(res, 'Email already in use.')
    const result = await pool.query(
      'UPDATE users SET name=$1, email=$2, updated_at=NOW() WHERE id=$3 RETURNING id, name, email, role, status, avatar',
      [name, email, req.user.id]
    )
    return successResponse(res, result.rows[0], 'Profile updated successfully.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.inviteUser = async (req, res) => {
  try {
    const { email, role } = req.body
    if (!email) return errorResponse(res, 'Email is required.')
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email])
    if (exists.rows[0]) return errorResponse(res, 'User already exists.')
    const token = require('crypto').randomBytes(32).toString('hex')
  const placeholderName = email.split('@')[0]

  await pool.query(
  'INSERT INTO users (name, email, role, status, invite_token) VALUES ($1, $2, $3, $4, $5)',
  [placeholderName, email, role || 'employee', 'invited', token]
)

      const appUrl = process.env.FRONTEND_URL || 'http://localhost:3000'
    const inviteLink = `${appUrl}/auth/accept-invite?token=${token}`
 
    await sendInviteEmail(email, inviteLink)

    await notifySafely(async () => {
      await notifyByRoles(
        ['admin'],
        NOTIFICATION_TYPES.USER_INVITED,
        'User invited',
        `${req.user.name} invited ${email} as ${role || 'employee'}.`,
        '/users',
        'low',
        { excludeUserId: req.user.id }
      )
    })

    return successResponse(
      res,
      { email, role },
      'Invite email sent successfully.',
      201
    )

  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.updateRole = async (req, res) => {
  try {
    const { role } = req.body
    const validRoles = ['admin', 'manager', 'employee']
    if (!validRoles.includes(role)) return errorResponse(res, 'Invalid role.')
    if (req.params.id === req.user.id) return errorResponse(res, 'Cannot change your own role.')
    const result = await pool.query(
      'UPDATE users SET role=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, email, role',
      [role, req.params.id]
    )
    if (!result.rows[0]) return errorResponse(res, 'User not found.', 404)

    await notifySafely(async () => {
      await notifyByRoles(
        ['admin'],
        NOTIFICATION_TYPES.USER_ROLE_CHANGED,
        'User role changed',
        `${req.user.name} changed ${result.rows[0].name}'s role to ${role}.`,
        '/users',
        'low',
        { excludeUserId: req.user.id }
      )
    })

    return successResponse(res, result.rows[0], 'Role updated successfully.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.deactivateUser = async (req, res) => {
  try {
    if (req.params.id === req.user.id) return errorResponse(res, 'Cannot deactivate yourself.')
    const current = await pool.query('SELECT name, status FROM users WHERE id = $1', [req.params.id])
    if (!current.rows[0]) return errorResponse(res, 'User not found.', 404)
    const newStatus = current.rows[0].status === 'active' ? 'inactive' : 'active'
    const result = await pool.query(
      'UPDATE users SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, status',
      [newStatus, req.params.id]
    )

    if (newStatus === 'inactive') {
      await notifySafely(async () => {
        await notifyByRoles(
          ['admin'],
          NOTIFICATION_TYPES.USER_REMOVED,
          'User deactivated',
          `${req.user.name} deactivated ${current.rows[0].name}.`,
          '/users',
          'low',
          { excludeUserId: req.user.id }
        )
      })
    }

    return successResponse(res, result.rows[0], `User ${newStatus === 'active' ? 'activated' : 'deactivated'} successfully.`)
  } catch (err) { return errorResponse(res, err.message, 500) }
}
