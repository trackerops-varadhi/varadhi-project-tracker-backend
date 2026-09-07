/*
 * Authentication + role gate.
 * ---------------------------------------------------------------------------
 * Two things changed here, both load-bearing.
 *
 * 1. THE BEARER FALLBACK IS GONE.
 *    The previous version accepted `Authorization: Bearer <jwt>` and verified
 *    only the signature — no database check at all. That made remote session
 *    revocation a no-op: a revoked session's access token kept working for its
 *    full 15 minutes simply by being sent in a header instead of a cookie. You
 *    cannot build "revoke this device" on top of a path that never asks whether
 *    the session is alive. Auth is now cookie-only.
 *
 *    Consequence, accepted at planning time: every existing token is refused
 *    once, and everyone signs in again. That is the cutover.
 *
 * 2. ONE QUERY, NOT TWO.
 *    Access tokens are no longer stored, so there is no token row to look up.
 *    The signature is verified in-process, then a single indexed join resolves
 *    the session and the user together. Net effect versus the old code: one
 *    fewer round trip per request, and revocation actually works.
 *
 * The two failure codes matter to the client and are not interchangeable:
 *
 *   TOKEN_EXPIRED   the signature is fine, the clock ran out. A silent refresh
 *                   will fix it — the browser should try one.
 *   SESSION_REVOKED the session is dead (logged out elsewhere, revoked by an
 *                   admin, password changed, expired). Refreshing CANNOT fix
 *                   this, so the client must log out immediately instead of
 *                   burning a round trip discovering that.
 */

const pool = require('../config/db')
const { verifyAccessToken, TokenError } = require('../services/token.service')
const { getActiveSessionWithUser } = require('../services/session.service')

const unauthorized = (res, message, code) =>
  res.status(401).json({ success: false, message, code })

exports.protect = async (req, res, next) => {
  const rawToken = req.cookies?.varadhi_access

  if (!rawToken) {
    return unauthorized(res, 'Not authenticated. Please login.', 'NO_TOKEN')
  }

  let claims

  try {
    claims = verifyAccessToken(rawToken)
  } catch (err) {
    if (err instanceof TokenError) {
      // TOKEN_EXPIRED tells the client to refresh; TOKEN_INVALID (bad
      // signature, wrong token type, pre-cutover token with no sessionId
      // claim) tells it not to bother.
      return unauthorized(
        res,
        err.code === 'TOKEN_EXPIRED'
          ? 'Access token expired.'
          : 'Invalid authentication token.',
        err.code
      )
    }
    return unauthorized(res, 'Invalid authentication token.', 'TOKEN_INVALID')
  }

  try {
    const row = await getActiveSessionWithUser(claims.sessionId)

    // Covers revoked, expired, and deleted-user in one branch — every one of
    // them means "this session is over", and telling the client which is not
    // useful to it and leaks state to anyone holding a stale token.
    if (!row) {
      return unauthorized(
        res,
        'Session is no longer active. Please login again.',
        'SESSION_REVOKED'
      )
    }

    // The token says who it belongs to and the session row says who owns it.
    // They must agree. They only ever disagree if JWT_SECRET leaked and someone
    // forged a token pointing at another user's session, so this is cheap
    // insurance against the worst case rather than an expected branch.
    if (row.session_user_id !== claims.userId) {
      return unauthorized(
        res,
        'Session is no longer active. Please login again.',
        'SESSION_REVOKED'
      )
    }

    if (row.status === 'inactive') {
      return unauthorized(res, 'Account is deactivated.', 'ACCOUNT_INACTIVE')
    }

    // Same shape the rest of the codebase expects on req.user (id, name, email,
    // role, status) — every controller reads those fields, so this stays
    // exactly as it was.
    req.user = {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      status: row.status,
    }

    // Needed by logout (to revoke this session) and by change-password (to
    // spare it while revoking every other one).
    req.sessionId = row.session_id

    // NOTE: no last_active_at write here. It existed to feed the Active
    // Sessions list's "last active" column; with that UI removed nothing reads
    // it per-request, so `protect` is now genuinely read-only — one indexed
    // SELECT and nothing else. The column is still maintained on refresh (see
    // extendSession), so the session row keeps a meaningful audit trail without
    // a write on every authenticated request.

    return next()
  } catch (err) {
    // A database failure is not an authentication failure. Returning 401 here
    // would sign every user out during a brief Supabase blip — and with the
    // frontend wired to redirect on 401, a ten-second outage would become a
    // fleet-wide logout. 500 is the honest answer.
    console.error('[auth] session lookup failed:', err.message)
    return res.status(500).json({
      success: false,
      message: 'Authentication check failed. Please try again.',
    })
  }
}

exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to perform this action.',
      })
    }
    next()
  }
}
