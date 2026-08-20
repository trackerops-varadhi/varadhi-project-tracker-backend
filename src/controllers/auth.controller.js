const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const pool = require('../config/db')
const { successResponse, errorResponse } = require('../utils/response')
 
const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' })

exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body
    if (!name || !email || !password) return errorResponse(res, 'Name, email and password are required.')
    if (password.length < 6) return errorResponse(res, 'Password must be at least 6 characters.')
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email])
    if (exists.rows[0]) return errorResponse(res, 'Email already registered.')
    const hashedPassword = await bcrypt.hash(password, 10)
    const result = await pool.query(
      'INSERT INTO users (name, email, password, role, status) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role, status, created_at',
      [name, email, hashedPassword, 'employee', 'active']
    )
    const user = result.rows[0]
    const token = signToken(user.id)
    return successResponse(res, { user, token }, 'Registered successfully', 201)
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return errorResponse(res, 'Email and password are required.')
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email])
    const user = result.rows[0]
    // console.log('LOGIN USER:', {
    // email: user?.email,
    // status: user?.status,
    // role: user?.role
    // })
    if (!user) return errorResponse(res, 'Invalid email or password.', 401)

    if (user.status === 'inactive') {
    return errorResponse(res, 'Account is deactivated. Contact admin.', 401)
    }
    if (!user.password) {
      return errorResponse(res, 'Please accept your invitation first.', 401)
    }
    const isMatch = await bcrypt.compare(password, user.password)
    // console.log('PASSWORD MATCH:', isMatch)

    if (!isMatch) {return errorResponse(res, 'Invalid email or password.', 401)}
    const token = signToken(user.id)
    const { password: _, ...safeUser } = user
    return successResponse(res, { user: safeUser, token }, 'Login successful')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.getMe = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, status, avatar, created_at FROM users WHERE id = $1',
      [req.user.id]
    )
    return successResponse(res, result.rows[0])
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return errorResponse(res, 'Email is required.')
    const result = await pool.query('SELECT id FROM users WHERE email = $1', [email])
    if (!result.rows[0]) return successResponse(res, null, 'If that email exists, a reset link has been sent.')
    const token = require('crypto').randomBytes(32).toString('hex')
    const expires = new Date(Date.now() + 3600000) // 1 hour
    await pool.query('UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE email = $3', [token, expires, email])
    // TODO: Send email with reset link
    return successResponse(res, null, 'Password reset link sent to your email.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body
    if (!token || !password) return errorResponse(res, 'Token and password are required.')
    if (password.length < 6) return errorResponse(res, 'Password must be at least 6 characters.')
    const result = await pool.query(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [token]
    )
    if (!result.rows[0]) return errorResponse(res, 'Invalid or expired reset token.', 400)
    const hashedPassword = await bcrypt.hash(password, 10)
    await pool.query(
      'UPDATE users SET password = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [hashedPassword, result.rows[0].id]
    )
    return successResponse(res, null, 'Password reset successfully.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) return errorResponse(res, 'Both passwords are required.')
    if (newPassword.length < 6) return errorResponse(res, 'New password must be at least 6 characters.')
    const result = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id])
    const isMatch = await bcrypt.compare(currentPassword, result.rows[0].password)
    if (!isMatch) return errorResponse(res, 'Current password is incorrect.', 401)
    const hashedPassword = await bcrypt.hash(newPassword, 10)
    await pool.query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashedPassword, req.user.id])
    return successResponse(res, null, 'Password changed successfully.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.verifyInvite = async (req, res) => {
  try {
    const { token } = req.params

    const result = await pool.query(
      'SELECT email, role FROM users WHERE invite_token = $1 AND status = $2',
      [token, 'invited']
    )

    if (!result.rows[0]) {
      return errorResponse(res, 'Invalid or expired invite link.', 400)
    }

    return successResponse(res, result.rows[0], 'Invite valid.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.acceptInvite = async (req, res) => {
  try {
    const { token, name, password } = req.body

    if (!token || !name || !password) {
      return errorResponse(res, 'Token, name and password are required.')
    }

    const found = await pool.query(
      'SELECT id FROM users WHERE invite_token = $1 AND status = $2',
      [token, 'invited']
    )

    if (!found.rows[0]) {
      return errorResponse(res, 'Invalid or expired invite link.', 400)
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    const result = await pool.query(
      `UPDATE users
       SET name=$1,
           password=$2,
           status='active',
           invite_token=NULL,
           updated_at=NOW()
       WHERE id=$3
       RETURNING id,name,email,role,status,avatar,created_at`,
      [name, hashedPassword, found.rows[0].id]
    )

    const user = result.rows[0]
    const jwtToken = signToken(user.id)

    return successResponse(
      res,
      { user, token: jwtToken },
      'Invitation accepted.'
    )
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}


// ============================================================================
// ADD these two handlers to backend/src/controllers/auth.controller.js
// (adapted from resetPassword — same validate-token → hash → update → clear shape)
// ============================================================================

// GET /api/auth/invite/:token
// Validates an invite token and returns the email + role so the accept page
// can render. Does not require auth (the invitee isn't logged in yet).
exports.verifyInvite = async (req, res) => {
  try {
    const { token } = req.params
    if (!token) return errorResponse(res, 'Invite token is required.', 400)

    const result = await pool.query(
      `SELECT email, role FROM users WHERE invite_token = $1 AND status = 'invited'`,
      [token]
    )
    if (!result.rows[0]) {
      return errorResponse(res, 'Invalid or expired invite link.', 400)
    }
    return successResponse(res, result.rows[0], 'Invite valid.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// POST /api/auth/accept-invite
// Input: { token, name, password }
// Validates the token, hashes the password, and in a single UPDATE sets
// name + password + status='active' + invite_token=NULL. Returns a JWT so the
// user is logged in immediately on success.
exports.acceptInvite = async (req, res) => {
  try {
    const { token, name, password } = req.body
    if (!token || !name || !password) {
      return errorResponse(res, 'Token, name and password are required.')
    }
    if (password.length < 6) {
      return errorResponse(res, 'Password must be at least 6 characters.')
    }

    // Token must match an invited user
    const found = await pool.query(
      `SELECT id FROM users WHERE invite_token = $1 AND status = 'invited'`,
      [token]
    )
    if (!found.rows[0]) {
      return errorResponse(res, 'Invalid or expired invite link.', 400)
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    // Single update closes acceptance: set name + password, activate, clear token
    const result = await pool.query(
      `UPDATE users
         SET name = $1,
             password = $2,
             status = 'active',
             invite_token = NULL,
             updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, email, role, status, avatar, created_at`,
      [name, hashedPassword, found.rows[0].id]
    )

    const user = result.rows[0]
    const token_jwt = signToken(user.id)
    return successResponse(res, { user, token: token_jwt }, 'Invitation accepted. Welcome!', 200)
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}


exports.logout = async (req, res) => {
  return successResponse(res, null, 'Logged out successfully.')
}
