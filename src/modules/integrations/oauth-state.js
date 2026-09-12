/**
 * OAuth state tokens for the calendar connect flow (Module 4).
 * ---------------------------------------------------------------------------
 * The OAuth callback arrives as a plain browser GET from Google/Microsoft. It
 * carries no Authorization header, so `protect` cannot run on it and the
 * server has no other way to know which user is completing the flow.
 *
 * The `state` parameter solves both problems at once, and it must be signed:
 * an unsigned state is the classic OAuth CSRF hole, where an attacker gets a
 * victim's browser to complete a flow that attaches the ATTACKER's calendar to
 * the victim's account (or vice versa). Signing binds the callback to the
 * exact user who started it.
 *
 * The design mirrors utils/notification-actions.js deliberately:
 *   - a derived signing secret, never the raw JWT_SECRET, so a state token can
 *     never be replayed as a session token;
 *   - `sub` rather than `id`, so even with identical secrets the payload could
 *     not satisfy auth.middleware.js, which reads `decoded.id`;
 *   - a `typ` discriminator that makes cross-use structurally impossible.
 *
 * TTL is short. Unlike an action token — which may sit on a lock screen over a
 * weekend — an OAuth round trip completes in under a minute, so ten minutes is
 * generous and keeps the replay window small.
 */

const jwt = require('jsonwebtoken')

const TOKEN_TYPE = 'cal_oauth'
const TOKEN_VERSION = 1
const TTL_SECONDS = 10 * 60

function secret() {
  if (process.env.CALENDAR_OAUTH_SECRET) return process.env.CALENDAR_OAUTH_SECRET
  if (!process.env.JWT_SECRET) return null
  // Distinct suffix from '::notif-action' so the two token families can never
  // validate against each other's secret.
  return `${process.env.JWT_SECRET}::cal-oauth`
}

/**
 * @param {{userId: string, provider: 'google'|'outlook'}} claims
 * @returns {string|null}
 */
function buildStateToken({ userId, provider }) {
  const key = secret()
  if (!key || !userId || !provider) return null

  try {
    return jwt.sign(
      { typ: TOKEN_TYPE, v: TOKEN_VERSION, sub: userId, prov: provider },
      key,
      { expiresIn: TTL_SECONDS }
    )
  } catch (err) {
    console.error('[oauth-state] failed to mint state token:', err.message)
    return null
  }
}

/**
 * @returns {{ok: true, claims} | {ok: false, code: 'state_expired'|'state_invalid'}}
 */
function verifyStateToken(token) {
  const key = secret()
  if (!key || !token) return { ok: false, code: 'state_invalid' }

  let decoded
  try {
    decoded = jwt.verify(token, key)
  } catch (err) {
    return {
      ok: false,
      code: err.name === 'TokenExpiredError' ? 'state_expired' : 'state_invalid',
    }
  }

  if (decoded.typ !== TOKEN_TYPE) return { ok: false, code: 'state_invalid' }
  if (decoded.v !== TOKEN_VERSION) return { ok: false, code: 'state_invalid' }
  if (!decoded.sub || !decoded.prov) return { ok: false, code: 'state_invalid' }

  return { ok: true, claims: decoded }
}

module.exports = { buildStateToken, verifyStateToken, TOKEN_TYPE, TTL_SECONDS }
