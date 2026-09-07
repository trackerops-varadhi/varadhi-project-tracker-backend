/*
 * Token material — issuance, verification and rotation.
 * ---------------------------------------------------------------------------
 * Pairs with session.service.js, which owns session identity. The split:
 *
 *   session.service.js  user_sessions — who/where/alive, revocation
 *   token.service.js    user_tokens   — refresh token hashes, rotation chain
 *
 * TWO DELIBERATE CHANGES FROM THE PREVIOUS VERSION OF THIS FILE
 *
 * 1. Session ids no longer churn. `createTokenPair` used to call
 *    crypto.randomUUID() on every rotation, so a session's identity changed
 *    every 15 minutes and the live database held 32 "sessions" for 2 users.
 *    The session id now comes from the caller and is carried unchanged through
 *    every rotation, which is what makes a revoked session stay revoked.
 *
 * 2. Access tokens are no longer persisted. They are stateless JWTs; their
 *    `sessionId` claim is checked against a live `user_sessions` row on every
 *    request (see auth.middleware.js). Revocation stays instant because the
 *    session row is the revocation list, and we stop writing ~2,880 rows per
 *    user per month that nothing ever read. `user_tokens` now holds refresh
 *    tokens only.
 *
 * Raw tokens are never stored — only SHA-256 hashes. A database disclosure
 * therefore leaks no usable credential. SHA-256 without a salt is correct here
 * (unlike for passwords): these are 200+ bit random JWTs, not guessable
 * secrets, so there is nothing for a rainbow table to precompute.
 */

const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const db = require('../config/db')
const {
  createSession,
  extendSession,
  revokeAllUserSessions,
  REVOKE_REASONS,
} = require('./session.service')

const ACCESS_TOKEN_EXPIRY = '15m'
const REFRESH_TOKEN_EXPIRY = '7d'
const REFRESH_TOKEN_MS = 7 * 24 * 60 * 60 * 1000

/*
 * Grace window for refresh-token reuse detection.
 *
 * Rotation revokes the old refresh token the instant a new one is issued, so
 * two tabs refreshing at the same moment produce a genuine race: tab A rotates,
 * and tab B — which read the cookie microseconds earlier — presents a token
 * that is now revoked. Treating that as an attack would sign honest users out
 * constantly, and on Render's free tier a cold start makes the overlap wider.
 *
 * So a token revoked within this window AND already replaced is treated as a
 * benign race and rotated again. Outside the window, or with no replacement
 * recorded, a revoked token means the credential leaked and the whole session
 * dies. 15s is long enough to cover a cold-start-delayed pair of requests and
 * short enough that a stolen token is near-useless.
 *
 * This is a backstop, not the primary defence — the frontend's single-flight
 * refresh queue is what should keep concurrent refreshes from happening at all.
 */
const REUSE_GRACE_MS = 15 * 1000

// Typed so the controller can map causes to responses without string-matching
// error messages. TOKEN_REUSE in particular must produce a hard logout rather
// than the ordinary "please log in again".
class TokenError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TokenError'
    this.code = code
  }
}

const hashToken = (rawToken) =>
  crypto.createHash('sha256').update(rawToken).digest('hex')

/*
 * Both tokens carry the same `sessionId`. That claim is the entire link between
 * a stateless access token and the revocable session row behind it — without it
 * the middleware would have nothing to check and revocation would be
 * impossible. `type` prevents a refresh token being presented as an access
 * token (and vice versa), which would otherwise turn a 7-day credential into a
 * bearer token for the API.
 *
 * `jti` is NOT decoration — it is required for correctness.
 *
 * JWT `iat`/`exp` are second-resolution. Without a unique claim, two tokens
 * minted for the same user + session within the same second are byte-identical,
 * so they hash identically, so the second INSERT violates
 * `user_tokens.token_hash UNIQUE` and the refresh fails. That is not
 * hypothetical: two tabs refreshing together, or any rapid re-login, lands in
 * the same second routinely — it failed on the second consecutive refresh in
 * testing before this claim existed.
 *
 * A random jti also means a token is unguessable independently of the clock,
 * and gives every token a stable identity for logging. The previous version of
 * this file solved the collision with a five-attempt regenerate-and-retry loop;
 * 128 bits of randomness is the simpler and stricter fix.
 */
const signToken = (userId, type, sessionId, expiresIn) =>
  jwt.sign(
    { id: userId, type, sessionId, jti: crypto.randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn }
  )

/*
 * Issue an access/refresh pair against an EXISTING session and persist only the
 * refresh hash. Runs inside the caller's transaction so a token row can never
 * outlive a rolled-back session (or vice versa).
 */
const issueTokensForSession = async (client, userId, sessionId) => {
  const accessToken = signToken(userId, 'access', sessionId, ACCESS_TOKEN_EXPIRY)
  const refreshToken = signToken(
    userId,
    'refresh',
    sessionId,
    REFRESH_TOKEN_EXPIRY
  )

  const result = await client.query(
    `INSERT INTO user_tokens
       (user_id, token_type, token_hash, session_id, refresh_family_id, expires_at)
     VALUES ($1, 'refresh', $2, $3, $3, $4)
     RETURNING id`,
    [
      userId,
      hashToken(refreshToken),
      sessionId,
      new Date(Date.now() + REFRESH_TOKEN_MS),
    ]
  )

  return { accessToken, refreshToken, refreshTokenId: result.rows[0].id }
}

/*
 * Begin a session: one row in user_sessions, one refresh token beneath it.
 * This is what login / register / accept-invite call.
 *
 * The whole thing is one transaction — a session with no token is unusable, and
 * a token with no session fails every subsequent request, so neither may exist
 * alone.
 */
const startSession = async (userId, req) => {
  const client = await db.connect()

  try {
    await client.query('BEGIN')

    const session = await createSession(client, userId, req)
    const { accessToken, refreshToken } = await issueTokensForSession(
      client,
      userId,
      session.id
    )

    await client.query('COMMIT')

    return { accessToken, refreshToken, sessionId: session.id }
  } catch (err) {
    await client.query('ROLLBACK')
    throw new Error(`Failed to start session: ${err.message}`)
  } finally {
    client.release()
  }
}

/*
 * Verify an access token WITHOUT touching the database.
 *
 * Returns the claims only. Whether the session behind them is still alive is
 * the middleware's job (one indexed lookup that also fetches the user), which
 * is why this stays synchronous and cheap.
 *
 * jwt.verify throws on a bad signature or an expired token; both are normalised
 * to a TokenError so callers have one thing to catch.
 */
const verifyAccessToken = (rawToken) => {
  let decoded

  try {
    decoded = jwt.verify(rawToken, process.env.JWT_SECRET)
  } catch (err) {
    const code =
      err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'
    throw new TokenError(code, 'Access token is not valid.')
  }

  if (decoded.type !== 'access') {
    throw new TokenError('TOKEN_INVALID', 'Token is not an access token.')
  }

  if (!decoded.sessionId) {
    // Pre-migration tokens have no sessionId claim. They cannot be checked
    // against a session row, so they are refused rather than trusted — this is
    // the cutover boundary, and it is why everyone re-logs in once.
    throw new TokenError('TOKEN_INVALID', 'Token predates session tracking.')
  }

  return { userId: decoded.id, sessionId: decoded.sessionId }
}

/*
 * Rotate a refresh token, keeping the session id fixed.
 *
 * Cases, in the order they are checked:
 *
 *   bad signature / expired      → TOKEN_INVALID, no session harmed
 *   hash absent from the table   → TOKEN_INVALID (pruned, forged-but-signed, or
 *                                  from a session whose rows were deleted)
 *   revoked, replaced, in grace  → benign two-tab race; rotate again
 *   revoked, outside grace       → TOKEN_REUSE; the credential leaked, so every
 *                                  session for that user dies
 *   session no longer live       → TOKEN_INVALID (revoked or expired elsewhere)
 *   otherwise                    → normal rotation
 *
 * The reuse case revokes ALL of the user's sessions, not just this one. A
 * replayed refresh token means the cookie escaped the browser; which session
 * the attacker will use it against is unknowable, so the only safe response is
 * to invalidate everything and make the human log in again.
 */
const rotateRefreshToken = async (rawRefreshToken, req) => {
  let decoded

  try {
    decoded = jwt.verify(rawRefreshToken, process.env.JWT_SECRET)
  } catch {
    throw new TokenError('TOKEN_INVALID', 'Refresh token is not valid.')
  }

  if (decoded.type !== 'refresh' || !decoded.sessionId) {
    throw new TokenError('TOKEN_INVALID', 'Token is not a refresh token.')
  }

  const tokenHash = hashToken(rawRefreshToken)
  const client = await db.connect()

  try {
    await client.query('BEGIN')

    // FOR UPDATE serialises concurrent refreshes of the SAME token row. Without
    // it two simultaneous requests could both read the row as live and both
    // rotate it, issuing two divergent token chains for one session.
    const existing = await client.query(
      `SELECT id, user_id, session_id, revoked_at, expires_at, replaced_by_token_id
       FROM user_tokens
       WHERE token_hash = $1
         AND token_type = 'refresh'
       FOR UPDATE`,
      [tokenHash]
    )

    const row = existing.rows[0]

    if (!row) {
      await client.query('ROLLBACK')
      throw new TokenError('TOKEN_INVALID', 'Refresh token is not recognised.')
    }

    if (row.revoked_at) {
      const revokedMsAgo = Date.now() - new Date(row.revoked_at).getTime()
      const benignRace =
        row.replaced_by_token_id !== null && revokedMsAgo <= REUSE_GRACE_MS

      if (!benignRace) {
        // Commit the rollback of THIS transaction first, then revoke through the
        // service on its own connection — nesting a second transaction inside
        // this one on a different client would deadlock on the row we hold.
        await client.query('ROLLBACK')

        await revokeAllUserSessions(
          row.user_id,
          REVOKE_REASONS.TOKEN_REUSE,
          null,
          null
        )

        throw new TokenError(
          'TOKEN_REUSE',
          'Refresh token was already used. All sessions have been revoked.'
        )
      }

      /*
       * Benign race: a sibling tab rotated this exact token moments ago.
       *
       * DO NOT mint a second token here. An earlier version of this code fell
       * through to normal rotation, which forked the chain — the sibling's new
       * token AND this one both ended up live for the same session. That is a
       * real weakness, not just untidiness: a refresh token stolen and replayed
       * inside the grace window would hand the attacker a parallel chain they
       * could rotate for a full 7 days, and because each token was then only
       * ever used once, reuse detection would never fire again.
       *
       * Nothing needs to be issued. Refresh cookies are shared across a
       * browser's tabs, so the sibling's rotation already replaced the cookie
       * this request was sent with — the caller simply has stale in-flight
       * state. Reporting "already refreshed" lets it retry against the fresh
       * cookie it is by now holding, with no new credential in existence.
       */
      await client.query('ROLLBACK')

      return {
        raced: true,
        sessionId: row.session_id,
        userId: row.user_id,
      }
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK')
      throw new TokenError('TOKEN_INVALID', 'Refresh token has expired.')
    }

    // The session may have been revoked from another device between this token
    // being issued and now — that is exactly what remote revocation is for, so
    // it must be checked here and not merely on the access path.
    const sessionCheck = await client.query(
      `SELECT id FROM user_sessions
       WHERE id = $1
         AND revoked_at IS NULL
         AND expires_at > NOW()
       LIMIT 1`,
      [row.session_id]
    )

    if (!sessionCheck.rows[0]) {
      await client.query('ROLLBACK')
      throw new TokenError('TOKEN_INVALID', 'Session is no longer active.')
    }

    // Same session_id — this is the fix. Rotation replaces token material
    // underneath an identity that does not move.
    const issued = await issueTokensForSession(
      client,
      row.user_id,
      row.session_id
    )

    // Guarded on `revoked_at IS NULL` for the normal path; the benign-race path
    // has already been revoked, so rowCount 0 there is expected and fine.
    await client.query(
      `UPDATE user_tokens
       SET revoked_at = COALESCE(revoked_at, NOW()),
           replaced_by_token_id = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [issued.refreshTokenId, row.id]
    )

    // Sliding window: active use keeps the session alive.
    await extendSession(client, row.session_id)

    await client.query('COMMIT')

    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      sessionId: row.session_id,
      userId: row.user_id,
    }
  } catch (err) {
    // The specific paths above already rolled back; this catches anything else.
    // ROLLBACK on an already-finished transaction is a no-op warning, not an
    // error, so it is safe to attempt unconditionally.
    if (!(err instanceof TokenError)) {
      await client.query('ROLLBACK').catch(() => {})
      throw new Error(`Failed to rotate refresh token: ${err.message}`)
    }
    throw err
  } finally {
    client.release()
  }
}

module.exports = {
  TokenError,
  REUSE_GRACE_MS,
  hashToken,
  startSession,
  issueTokensForSession,
  verifyAccessToken,
  rotateRefreshToken,
}
