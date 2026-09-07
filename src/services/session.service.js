/*
 * Session lifecycle — the single authority on what a "session" is.
 * ---------------------------------------------------------------------------
 * A session is one browser, for one user, surviving every token rotation
 * underneath it. That last part is the fix for the defect this module exists
 * to correct: `token.service.js` used to mint a fresh session_id on every
 * refresh, so a "session" lived 15 minutes and the live database accumulated 32
 * of them for 2 users. Identity now lives in the `user_sessions` row and tokens
 * rotate beneath a stable id, which is what makes remote revocation mean
 * anything at all.
 *
 * DIVISION OF LABOUR with token.service.js:
 *   session.service.js  owns user_sessions — identity, liveness, revocation.
 *   token.service.js    owns user_tokens   — refresh token material, rotation.
 * Revoking a session revokes its tokens (below); rotating a token never
 * touches session identity. Keep that direction one-way.
 *
 * ACCESS TOKENS ARE NOT PERSISTED (an accepted design decision). They are
 * verified by JWT signature, and their `sessionId` claim is checked against a
 * live session row on every request. That keeps revocation instant — a revoked
 * session rejects its still-unexpired access tokens on the very next request —
 * while removing ~2,880 pointless INSERTs per user per month. The session row
 * is the revocation list.
 */

const db = require('../config/db')
const { parseUserAgent, extractIpAddress } = require('../utils/device-parser')

// Sliding window: a session dies after 7 days of NO USE, not 7 days after
// login. Every refresh pushes expires_at out again (see extendSession), which
// is what "browser close + reopen → still signed in" requires. Someone using
// the tracker daily is never logged out by expiry; someone who stops using it
// is signed out a week later.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

// last_active_at is maintained on refresh only (see extendSession). The
// per-request throttled write that used to keep it current was removed with the
// Active Sessions UI — nothing reads it at that resolution any more.

// Every value the CHECK constraint on user_sessions.revoked_reason accepts.
// Exported so callers use these constants instead of free-form strings — a
// typo'd reason is a 23514 constraint violation at runtime, i.e. a failed
// logout, which is exactly the kind of thing that should not be a string
// literal scattered across controllers.
const REVOKE_REASONS = {
  LOGOUT: 'logout',
  PASSWORD_CHANGE: 'password_change',
  PASSWORD_RESET: 'password_reset',
  TOKEN_REUSE: 'token_reuse',
  ACCOUNT_DEACTIVATED: 'account_deactivated',
  INACTIVITY: 'inactivity',
  EXPIRED: 'expired',
}

// NOTE: the database CHECK constraint on user_sessions.revoked_reason still
// accepts 'logout_all', 'user_revoked' and 'admin_revoked' — reasons written by
// the removed Active Sessions endpoints. They are intentionally left in the
// constraint rather than migrated away: historical rows already carry those
// values, and narrowing the constraint would be a destructive schema change for
// no benefit.

/*
 * Create the session row. Called inside the caller's transaction (login,
 * register, accept-invite) so a session is never left orphaned by a later
 * failure in the same request.
 *
 * Returns the row whose `id` becomes the `sessionId` claim in both JWTs.
 */
const createSession = async (client, userId, req) => {
  const userAgent = req?.headers?.['user-agent'] || null
  const { browser, os, deviceLabel } = parseUserAgent(userAgent)
  const ipAddress = extractIpAddress(req || {})
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  const result = await client.query(
    `INSERT INTO user_sessions
       (user_id, browser, os, device_label, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, user_id, expires_at, created_at`,
    [userId, browser, os, deviceLabel, ipAddress, userAgent, expiresAt]
  )

  return result.rows[0]
}

/*
 * The authentication hot path, called by `protect` on every request.
 *
 * One query does the whole job: resolves the session, proves it is live, and
 * returns the user. Before this design the middleware did a token lookup AND a
 * user lookup; joining them means dropping access-token persistence costs
 * nothing in round trips and actually saves one.
 *
 * Returns null for "not authenticated" in every failure mode — revoked,
 * expired, or session/user deleted — so the caller cannot accidentally treat a
 * revoked session as a merely-expired one.
 */
const getActiveSessionWithUser = async (sessionId) => {
  const result = await db.query(
    `SELECT
       s.id            AS session_id,
       s.user_id       AS session_user_id,
       s.expires_at    AS session_expires_at,
       u.id, u.name, u.email, u.role, u.status
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > NOW()
     LIMIT 1`,
    [sessionId]
  )

  return result.rows[0] || null
}

/*
 * Push a live session's expiry back out to a full TTL from now. Called on every
 * successful refresh, which is what makes the 7-day window sliding rather than
 * absolute.
 *
 * Guarded on `revoked_at IS NULL` so this can never resurrect a session that
 * was revoked between the refresh token being read and this update running.
 */
const extendSession = async (client, sessionId) => {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  const result = await client.query(
    `UPDATE user_sessions
     SET expires_at = $1,
         last_active_at = NOW()
     WHERE id = $2
       AND revoked_at IS NULL
     RETURNING id`,
    [expiresAt, sessionId]
  )

  return result.rowCount === 1
}

/*
 * Revoke one session and every refresh token issued under it.
 *
 * Both statements run in one transaction: a session marked dead while its
 * refresh tokens stay live would let the holder mint a fresh session, which is
 * precisely the hole remote revocation is meant to close.
 *
 * Idempotent — `revoked_at IS NULL` means re-revoking is a no-op returning
 * false, so a double-clicked Revoke button cannot rewrite the reason or the
 * timestamp of the original revocation.
 */
const revokeSession = async (sessionId, reason, revokedBy = null) => {
  const client = await db.connect()

  try {
    await client.query('BEGIN')

    const result = await client.query(
      `UPDATE user_sessions
       SET revoked_at = NOW(),
           revoked_reason = $2,
           revoked_by = $3
       WHERE id = $1
         AND revoked_at IS NULL
       RETURNING id, user_id`,
      [sessionId, reason, revokedBy]
    )

    if (result.rowCount === 0) {
      await client.query('COMMIT')
      return null
    }

    await client.query(
      `UPDATE user_tokens
       SET revoked_at = NOW(),
           updated_at = NOW()
       WHERE session_id = $1
         AND revoked_at IS NULL`,
      [sessionId]
    )

    await client.query('COMMIT')
    return result.rows[0]
  } catch (err) {
    await client.query('ROLLBACK')
    throw new Error(`Failed to revoke session: ${err.message}`)
  } finally {
    client.release()
  }
}

/*
 * Revoke every live session for a user, optionally sparing one.
 *
 * `exceptSessionId` is what makes "password changed → sign out my other
 * devices" work without signing the user out of the browser they just typed
 * their new password into. Pass null to revoke everything, which is what
 * account deactivation and an admin revoke want.
 *
 * Returns the ids revoked so the caller can report a count.
 */
const revokeAllUserSessions = async (
  userId,
  reason,
  revokedBy = null,
  exceptSessionId = null
) => {
  const client = await db.connect()

  try {
    await client.query('BEGIN')

    // $4 IS NULL makes the "spare nothing" case a single query rather than two
    // near-identical statements that could drift apart.
    const result = await client.query(
      `UPDATE user_sessions
       SET revoked_at = NOW(),
           revoked_reason = $2,
           revoked_by = $3
       WHERE user_id = $1
         AND revoked_at IS NULL
         AND ($4::uuid IS NULL OR id <> $4::uuid)
       RETURNING id`,
      [userId, reason, revokedBy, exceptSessionId]
    )

    const revokedIds = result.rows.map((row) => row.id)

    if (revokedIds.length > 0) {
      await client.query(
        `UPDATE user_tokens
         SET revoked_at = NOW(),
             updated_at = NOW()
         WHERE session_id = ANY($1::uuid[])
           AND revoked_at IS NULL`,
        [revokedIds]
      )
    }

    await client.query('COMMIT')
    return revokedIds
  } catch (err) {
    await client.query('ROLLBACK')
    throw new Error(`Failed to revoke user sessions: ${err.message}`)
  } finally {
    client.release()
  }
}

/*
 * Everything exported below is load-bearing for authentication itself, not for
 * any user-facing session screen:
 *
 *   createSession             login / register / accept-invite
 *   getActiveSessionWithUser  every authenticated request — this IS revocation
 *   extendSession             sliding 7-day window on refresh
 *   revokeSession             logout
 *   revokeAllUserSessions     password change, password reset, and refresh
 *                             token replay detection
 *
 * The list/lookup helpers that backed the Active Sessions UI (listUserSessions,
 * findSessionById) and the per-request last_active_at write (touchSession) were
 * removed with it. Nothing in the authentication path used them.
 */
module.exports = {
  SESSION_TTL_MS,
  REVOKE_REASONS,
  createSession,
  getActiveSessionWithUser,
  extendSession,
  revokeSession,
  revokeAllUserSessions,
}
