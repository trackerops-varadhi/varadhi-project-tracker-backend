/**
 * Notification action tokens
 * ---------------------------------------------------------------------------
 * A service worker cannot read the session token: it lives in localStorage
 * (unreachable from a SW) and the auth cookie is on the frontend origin while
 * the API is cross-origin. So an actionable push carries its own short-lived,
 * narrowly-scoped credential minted at dispatch time.
 *
 * THE TOKEN IDENTIFIES; IT DOES NOT AUTHORIZE.
 * It answers only "which notification is acting, on behalf of whom". Every
 * permission decision is recomputed from live database rows at action time by
 * notification-actions.controller.js. A cryptographically perfect token still
 * yields 403 if the user was demoted, deactivated, the task was reassigned, or
 * the task already moved on. The `acts` claim only NARROWS what may be
 * attempted — membership grants nothing.
 *
 * SIGNING SECRET — derived, never the raw JWT_SECRET.
 * auth.middleware.js does `jwt.verify(token, JWT_SECRET)` then trusts
 * `decoded.id`. If action tokens shared that secret, one would be a single `id`
 * claim away from being a full session token. Deriving makes the confusion
 * impossible in BOTH directions: a session token can't be replayed as an action
 * token either, because it lacks `typ: 'notif_action'`. The derivation also
 * means no new environment variable is required on Render.
 */

const jwt = require('jsonwebtoken')

const TOKEN_TYPE = 'notif_action'
const TOKEN_VERSION = 1

// 72h: long enough that a notification sitting on a lock screen over a weekend
// still works. Expiry is not a security boundary here — permissions are
// rechecked from the DB on every call — it just bounds replay of a leaked push
// payload and keeps the token from outliving the work it refers to.
const DEFAULT_TTL_HOURS = 72

function ttlSeconds() {
  const hours = Number(process.env.NOTIFICATION_ACTION_TTL_HOURS) || DEFAULT_TTL_HOURS
  return Math.round(hours * 60 * 60)
}

function secret() {
  if (process.env.NOTIFICATION_ACTION_SECRET) return process.env.NOTIFICATION_ACTION_SECRET
  if (!process.env.JWT_SECRET) return null
  return `${process.env.JWT_SECRET}::notif-action`
}

/**
 * Which inline actions a notification type offers. Mirrors the constants in
 * tasks.controller.js (REVIEW_ACTIONS / ASSIGN_ACTIONS) but keyed by type, so
 * the engine can derive the `acts` claim without importing a controller.
 *
 * Notification.maxActions is 2 on Chrome/Android and 0 on iOS Safari, so never
 * list more than two per type.
 */
const ACTIONS_FOR_TYPE = {
  review_requested: ['approve', 'reject'],
  task_assigned: ['accept', 'snooze_1h'],
}

/**
 * @param {object} claims
 * @param {string} claims.notificationId
 * @param {string} claims.userId        recipient
 * @param {string} [claims.taskId]
 * @param {string[]} [claims.actions]   allow-list; narrowing only
 * @returns {string|null} signed JWT, or null if signing isn't possible
 */
function buildActionToken({ notificationId, userId, taskId, actions }) {
  const key = secret()
  if (!key || !notificationId || !userId) return null

  try {
    return jwt.sign(
      {
        typ: TOKEN_TYPE,
        v: TOKEN_VERSION,
        nid: notificationId,
        // Deliberately `sub`, never `id`: auth.middleware.js reads `decoded.id`,
        // so this payload can never satisfy `protect` even if the secrets were
        // somehow identical.
        sub: userId,
        res: 'task',
        rid: taskId || null,
        acts: Array.isArray(actions) ? actions : [],
      },
      key,
      { expiresIn: ttlSeconds() }
    )
  } catch (err) {
    console.error('[notification-actions] failed to mint action token:', err.message)
    return null
  }
}

/**
 * @returns {{ ok: true, claims: object } | { ok: false, code: 'action_token_expired'|'action_token_invalid' }}
 */
function verifyActionToken(token) {
  const key = secret()
  if (!key || !token) return { ok: false, code: 'action_token_invalid' }

  let decoded
  try {
    decoded = jwt.verify(token, key)
  } catch (err) {
    return {
      ok: false,
      code: err.name === 'TokenExpiredError' ? 'action_token_expired' : 'action_token_invalid',
    }
  }

  // Reject anything that isn't unmistakably one of ours.
  if (decoded.typ !== TOKEN_TYPE) return { ok: false, code: 'action_token_invalid' }
  if (decoded.v !== TOKEN_VERSION) return { ok: false, code: 'action_token_invalid' }
  if (!decoded.nid || !decoded.sub) return { ok: false, code: 'action_token_invalid' }

  return { ok: true, claims: decoded }
}

/** True if the token's allow-list permits attempting `action` at all. */
function tokenAllowsAction(claims, action) {
  if (!claims || !Array.isArray(claims.acts) || claims.acts.length === 0) return false
  return claims.acts.includes(action)
}

module.exports = {
  buildActionToken,
  verifyActionToken,
  tokenAllowsAction,
  ACTIONS_FOR_TYPE,
  TOKEN_TYPE,
  TOKEN_VERSION,
}
