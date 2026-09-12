/**
 * Authenticated requests for the integration suites.
 * ---------------------------------------------------------------------------
 * These suites used to sign their own JWT and send `Authorization: Bearer`.
 * That path was removed in b0bd3ee. `protect` now:
 *
 *   - reads the access token from the `varadhi_access` COOKIE, never a header
 *   - requires a `sessionId` claim in the token
 *   - resolves a live `user_sessions` row on every request
 *
 * all so that revoking a session actually revokes it, instead of the token
 * continuing to work for its full 15 minutes by being sent in a header. A
 * self-signed `{ id }` token satisfies none of that, so every suite still doing
 * it had been failing with 401 (no session) or 403 (CSRF) since that commit —
 * unrelated to, and predating, the Phase 2 schema split.
 *
 * So: mint a real session the way a login does, send the token in the cookie
 * the middleware reads, and add the `X-Requested-With` header the CSRF guard
 * requires on state-changing requests.
 *
 * WHY THE DEEP IMPORT IS OK HERE
 * token.service is internal to identity, and production code may only enter
 * through modules/identity/index.js. scripts/ lives outside src/, which is the
 * only tree check-boundaries.js scans, so this is not a boundary violation —
 * and a test harness minting a session is legitimately privileged. Widening
 * identity's public interface purely for test convenience would be the worse
 * trade: that surface is the contract a future extracted service has to honour
 * over HTTP.
 */

const { startSession } = require('../src/modules/identity/token.service')

const sessions = new Map()

/**
 * A real access-token cookie for `userId`, creating the session on first use
 * and reusing it afterwards so a suite does not open one session per request.
 *
 * @param {string} userId
 * @param {string} [label] shows up in the session's device column
 * @returns {Promise<string>} value for the `Cookie` request header
 */
const accessCookie = async (userId, label = 'ZZ test harness') => {
  if (!sessions.has(userId)) {
    const { accessToken } = await startSession(userId, {
      headers: { 'user-agent': label },
    })
    sessions.set(userId, accessToken)
  }
  return `varadhi_access=${sessions.get(userId)}`
}

/**
 * Headers for an authenticated request as `userId`.
 * Includes Content-Type and the CSRF header; merge in anything extra.
 */
const authHeaders = async (userId, extra = {}) => ({
  'Content-Type': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
  Cookie: await accessCookie(userId),
  ...extra,
})

/** Forget cached sessions (for a suite that revokes them mid-run). */
const reset = () => sessions.clear()

module.exports = { accessCookie, authHeaders, reset }
