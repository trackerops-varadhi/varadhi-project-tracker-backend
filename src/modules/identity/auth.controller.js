/*
 * Authentication endpoints.
 * ---------------------------------------------------------------------------
 * Every credential-issuing path (login, register, accept-invite, refresh) goes
 * through startSession/rotateRefreshToken and sets httpOnly cookies. Three
 * things are deliberately true here:
 *
 * 1. NO TOKEN IN ANY RESPONSE BODY. A token readable by JavaScript is a token
 *    readable by any XSS. The middleware does not accept Bearer at all, so
 *    returning one would be handing out a credential that does not work and
 *    should not exist.
 *
 * 2. accept-invite issues a REAL session, not a bare JWT with no session row —
 *    which the middleware would reject outright.
 *
 * 3. verifyInvite / acceptInvite are defined ONCE. This file used to define
 *    each twice, with the second silently winning.
 */

const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')

const repo = require('./repo')
const { startSession, rotateRefreshToken, TokenError } = require('./token.service')
const { revokeSession, revokeAllUserSessions, REVOKE_REASONS } = require('./session.service')
const { ACCESS_COOKIE, REFRESH_COOKIE, setAuthCookies, clearAuthCookies } = require('./cookies')
const { successResponse, errorResponse } = require('../../shared/response')
const { sendResetEmail } = require('../../utils/sendEmail')

exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body
    if (!name || !email || !password) {
      return errorResponse(res, 'Name, email and password are required.')
    }
    if (password.length < 6) {
      return errorResponse(res, 'Password must be at least 6 characters.')
    }

    if (await repo.findByEmail(email)) {
      return errorResponse(res, 'Email already registered.')
    }

    const user = await repo.insertUser({
      name, email, passwordHash: await bcrypt.hash(password, 10),
    })

    const { accessToken, refreshToken } = await startSession(user.id, req)
    setAuthCookies(res, accessToken, refreshToken)

    return successResponse(res, { user }, 'Registered successfully', 201)
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return errorResponse(res, 'Email and password are required.')
    }

    const user = await repo.findUserForLogin(email)

    // Same message and same shape for "no such user" and "wrong password", so
    // the endpoint cannot be used to enumerate who has an account.
    if (!user) return errorResponse(res, 'Invalid email or password.', 401)

    if (user.status === 'inactive') {
      return errorResponse(res, 'Account is deactivated. Contact admin.', 401)
    }
    if (!user.password) {
      return errorResponse(res, 'Please accept your invitation first.', 401)
    }

    const isMatch = await bcrypt.compare(password, user.password)
    if (!isMatch) return errorResponse(res, 'Invalid email or password.', 401)

    const { accessToken, refreshToken } = await startSession(user.id, req)
    setAuthCookies(res, accessToken, refreshToken)

    const { password: _password, ...safeUser } = user
    return successResponse(res, { user: safeUser }, 'Login successful')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.getMe = async (req, res) => {
  try {
    return successResponse(res, await repo.findSafeUserById(req.user.id))
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

/*
 * Silent refresh. The only endpoint that reads the refresh cookie.
 *
 * Returns the user alongside the new session id so the frontend can reconcile
 * role changes without a second request.
 */
exports.refreshToken = async (req, res) => {
  const rawRefreshToken = req.cookies?.[REFRESH_COOKIE]

  if (!rawRefreshToken) {
    return res.status(401).json({
      success: false,
      message: 'No refresh token.',
      code: 'NO_REFRESH_TOKEN',
    })
  }

  try {
    const rotation = await rotateRefreshToken(rawRefreshToken, req)
    const user = await repo.findSafeUserById(rotation.userId)

    /*
     * A sibling tab already rotated this token seconds ago. Deliberately send
     * NO Set-Cookie: the browser is already holding the sibling's fresh
     * cookies, and overwriting them here would either fork the token chain or
     * clobber a newer credential with an older one.
     *
     * Still a 200 — the session is alive and the caller's retry will succeed.
     * A 401 would send a perfectly valid session to the login page.
     */
    if (rotation.raced) {
      return successResponse(
        res, { user, sessionId: rotation.sessionId }, 'Session already refreshed'
      )
    }

    setAuthCookies(res, rotation.accessToken, rotation.refreshToken)

    return successResponse(res, { user, sessionId: rotation.sessionId }, 'Session refreshed')
  } catch (err) {
    // Any failure to refresh ends the session on this device, so the cookies go
    // regardless of cause — leaving a dead refresh cookie in place would make
    // the client retry forever.
    clearAuthCookies(res)

    if (err instanceof TokenError && err.code === 'TOKEN_REUSE') {
      // Distinct code: the frontend must NOT quietly retry. Every session for
      // this user has just been revoked because the token was replayed, and the
      // human needs to know their account may be compromised.
      return res.status(401).json({
        success: false,
        message:
          'Session security check failed. All sessions have been signed out. Please log in again.',
        code: 'TOKEN_REUSE',
      })
    }

    return res.status(401).json({
      success: false,
      message: 'Session expired. Please login again.',
      code: 'REFRESH_FAILED',
    })
  }
}

/*
 * Resolve the session id for logout WITHOUT requiring a live access token.
 *
 * Logout is mounted without `protect` on purpose. The overwhelmingly common
 * moment to log out is after a period of inactivity, when the 15-minute access
 * token has already expired — if logout required a valid one, it would fail
 * exactly when it is most needed, leaving a live session on the server while
 * the user believes they signed out.
 *
 * Signatures are still verified; only expiry is ignored. An unsigned or forged
 * token yields no session id and revokes nothing, so this cannot be used to
 * terminate someone else's session.
 */
const resolveSessionIdForLogout = (req) => {
  const candidates = [req.cookies?.[ACCESS_COOKIE], req.cookies?.[REFRESH_COOKIE]]

  for (const raw of candidates) {
    if (!raw) continue
    try {
      const decoded = jwt.verify(raw, process.env.JWT_SECRET, { ignoreExpiration: true })
      if (decoded?.sessionId) return decoded.sessionId
    } catch {
      /* try the next cookie */
    }
  }

  return null
}

/*
 * Log out THIS session only.
 *
 * Always returns 200 and always clears cookies. A logout that reports failure
 * leaves the user staring at a screen they believe is still authenticated; the
 * safe direction to fail is "signed out".
 */
exports.logout = async (req, res) => {
  const sessionId = req.sessionId || resolveSessionIdForLogout(req)

  try {
    if (sessionId) await revokeSession(sessionId, REVOKE_REASONS.LOGOUT)
  } catch (err) {
    // Cookies are still cleared below, so the browser is signed out either way.
    console.error('[auth] logout revoke failed:', err.message)
  }

  clearAuthCookies(res)
  return successResponse(res, null, 'Logged out successfully.')
}

const GENERIC_REPLY = 'If that email exists, a reset link has been sent.'

exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return errorResponse(res, 'Email is required.')

    // Same response whether or not the address exists — otherwise this endpoint
    // is an account-enumeration oracle. That includes the message text itself,
    // so both branches below return GENERIC_REPLY verbatim.
    if (!(await repo.findByEmail(email))) {
      return successResponse(res, null, GENERIC_REPLY)
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expires = new Date(Date.now() + 3600000) // 1 hour
    await repo.setResetToken(email, token, expires)

    const appUrl = process.env.FRONTEND_URL || 'http://localhost:3000'

    // A dead SMTP box must not surface as a 500. The token is already stored,
    // so the failure is "we could not deliver", not "the reset did not happen" —
    // and reporting it differently would re-open the enumeration hole above.
    try {
      await sendResetEmail(email, `${appUrl}/auth/reset-password?token=${token}`)
    } catch (mailErr) {
      console.error('[auth] reset email failed:', mailErr.message)
    }

    return successResponse(res, null, GENERIC_REPLY)
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

/*
 * Reset via emailed token. Revokes EVERY session, with no exception.
 *
 * Unlike change-password there is no trusted current session to spare: a reset
 * is the recovery path, and the most likely reason someone is using it is that
 * they believe their account is compromised. Leaving any existing session alive
 * would leave the attacker signed in.
 */
exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body
    if (!token || !password) {
      return errorResponse(res, 'Token and password are required.')
    }
    if (password.length < 6) {
      return errorResponse(res, 'Password must be at least 6 characters.')
    }

    const found = await repo.findByLiveResetToken(token)
    if (!found) return errorResponse(res, 'Invalid or expired reset token.', 400)

    await repo.setPasswordAndClearReset(found.id, await bcrypt.hash(password, 10))
    await revokeAllUserSessions(found.id, REVOKE_REASONS.PASSWORD_RESET, null, null)

    clearAuthCookies(res)
    return successResponse(
      res, null, 'Password reset successfully. Please log in with your new password.'
    )
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

/*
 * Change password while signed in. Revokes every OTHER session.
 *
 * The current session is spared deliberately: signing someone out of the tab
 * they just used to change their password is hostile, and it teaches people
 * that changing a password is annoying enough to avoid. Every other device is
 * signed out, which is the security property that actually matters.
 */
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) {
      return errorResponse(res, 'Both passwords are required.')
    }
    if (newPassword.length < 6) {
      return errorResponse(res, 'New password must be at least 6 characters.')
    }

    const row = await repo.findPasswordHash(req.user.id)
    const isMatch = await bcrypt.compare(currentPassword, row.password)
    if (!isMatch) return errorResponse(res, 'Current password is incorrect.', 401)

    await repo.setPassword(req.user.id, await bcrypt.hash(newPassword, 10))

    const revoked = await revokeAllUserSessions(
      req.user.id,
      REVOKE_REASONS.PASSWORD_CHANGE,
      req.user.id,
      req.sessionId // spare the session doing the changing
    )

    return successResponse(
      res,
      { revokedCount: revoked.length },
      revoked.length > 0
        ? `Password changed. ${revoked.length} other session(s) signed out.`
        : 'Password changed successfully.'
    )
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// GET /api/auth/invite/:token — validates an invite token and returns the email
// and role so the accept page can render. Unauthenticated by nature.
exports.verifyInvite = async (req, res) => {
  try {
    const { token } = req.params
    if (!token) return errorResponse(res, 'Invite token is required.', 400)

    const invite = await repo.findInviteByToken(token)
    if (!invite) return errorResponse(res, 'Invalid or expired invite link.', 400)

    return successResponse(res, invite, 'Invite valid.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// POST /api/auth/accept-invite — { token, name, password }
// Activates the account and starts a real session, so an invited user lands
// signed in rather than holding a token the middleware refuses.
exports.acceptInvite = async (req, res) => {
  try {
    const { token, name, password } = req.body
    if (!token || !name || !password) {
      return errorResponse(res, 'Token, name and password are required.')
    }
    if (password.length < 6) {
      return errorResponse(res, 'Password must be at least 6 characters.')
    }

    const found = await repo.findInvitedIdByToken(token)
    if (!found) return errorResponse(res, 'Invalid or expired invite link.', 400)

    const user = await repo.acceptInvite(found.id, name, await bcrypt.hash(password, 10))

    const { accessToken, refreshToken } = await startSession(user.id, req)
    setAuthCookies(res, accessToken, refreshToken)

    return successResponse(res, { user }, 'Invitation accepted. Welcome!', 200)
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}
