// PUBLIC INTERFACE — identity (users · user_sessions · user_tokens)
//
// The only file outside this directory that anything else may require.
//
// This module is different from the others in one way worth stating: every
// authenticated request in the system depends on it. `protect` calls
// verifyAccessToken + getActiveSessionWithUser on every single call, which is
// the deliberate price of instant revocation — the session row IS the
// revocation list, so it has to be read, not trusted from a token claim.

const repo = require('./repo')
const tokenService = require('./token.service')
const sessionService = require('./session.service')
const cookies = require('./cookies')
const cleanupCron = require('./session-cleanup-cron')

exports.mount = [
  { path: '/api/auth', router: require('./auth.routes') },
  { path: '/api/users', router: require('./users.routes') },
]

/* ── Background jobs ────────────────────────────────────────────────────── */
//
// Daily prune of dead session and token rows past their audit retention.
// Deletes only revoked/expired rows, so it can never sign anyone out.
exports.jobs = [
  {
    name: 'session-cleanup',
    start: cleanupCron.startSessionCleanupCron,
    stop: cleanupCron.stopSessionCleanupCron,
  },
]

/* ══════════════════════════════════════════════════════════════════════════ */
/* Display + directory lookups                                                */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * Resolve user ids to display cards.
 *
 * This replaces the ~24 `LEFT JOIN users u ON ... = u.id` sites that existed
 * only to turn a UUID into a name or avatar. Those joins were the single
 * biggest obstacle to owning `users` in its own schema, and none of them needed
 * a join — they needed a batched lookup, which is what this is.
 *
 * Returns a Map so callers merge by id without an O(n²) find(), and so a
 * missing user is a clean `undefined` rather than a silently dropped row.
 *
 * `role` and `status` are included because two callers need them for logic, not
 * display: the project Members tab renders a role, and the @mention resolver
 * must skip deactivated accounts.
 *
 * @returns {Promise<Map<string, {id, name, email, avatar, role, status}>>}
 */
exports.getUserCards = async (userIds) => {
  const unique = [...new Set((userIds || []).filter(Boolean))]
  if (unique.length === 0) return new Map()

  const rows = await repo.findUserCards(unique)
  return new Map(rows.map((r) => [r.id, {
    id: r.id, name: r.name, email: r.email, avatar: r.avatar,
    role: r.role, status: r.status,
  }]))
}

/**
 * Ids of users whose NAME matches a search term.
 *
 * Lets another module offer "search by developer name" without joining
 * `users`. The caller passes the ids into its own `WHERE ... = ANY($n)` —
 * same result set, no cross-module join, and the pagination count stays
 * correct because the filter is still one SQL predicate rather than
 * post-filtering in JS.
 */
exports.searchUserIds = async (term) => {
  const trimmed = String(term || '').trim()
  if (!trimmed) return []
  return repo.searchUserIds(`%${trimmed}%`)
}

/**
 * Ids of every ACTIVE user holding one of these roles.
 *
 * Distinct from notify.dispatchToRoles: that sends directly, whereas callers
 * here need the ids to merge into a wider recipient set before one dispatch.
 * Deactivated accounts are excluded — they used to accumulate notifications.
 */
exports.getActiveUserIdsByRoles = async (roles) => {
  if (!roles || roles.length === 0) return []
  return repo.findActiveIdsByRoles(roles)
}

/**
 * Every active user, as cards.
 *
 * Consumed by insights, which groups people by role and pairs them with their
 * task load. Those reports used to be `users LEFT JOIN tasks ... GROUP BY
 * u.role`, driven BY this table — so unlike the other lookups, the caller needs
 * the whole active roster rather than a set of ids it already holds.
 *
 * @returns {Promise<Array<{id, name, email, role, avatar}>>}
 */
exports.getActiveUsers = async () => repo.findActiveUsers()

/** How many people are active. Drives the dashboard's Team Members counter. */
exports.getActiveUserCount = async () => repo.countActiveUsers()

/**
 * Existence + account status for one user, for validation before assigning
 * work. Returns null when the id does not exist.
 */
exports.getAccountState = async (userId) => {
  if (!userId) return null
  return repo.findAccountState(userId)
}

/**
 * Invite a new account — the same path as POST /api/users/invite (invite
 * email, admin notification). Consumed by people when a selected candidate is
 * converted into an employee. Throws InviteError (`.status` set) for anything
 * the caller can fix, e.g. an email that already has an account.
 *
 * @returns {Promise<{ id: string, email: string, role: string }>}
 */
exports.inviteUser = (actor, { email, role, name }) =>
  require('./users.service').invite(actor, { email, role, name })
exports.InviteError = require('./users.service').UserError

/* ══════════════════════════════════════════════════════════════════════════ */
/* Auth primitives                                                            */
/* ══════════════════════════════════════════════════════════════════════════ */
//
// These are consumed by middleware/auth.middleware.js, which is platform-level
// (every router uses it) rather than part of this module. The middleware is the
// express adapter; the decisions below are identity's.
//
// EXCEPTION TO THE ALL-ASYNC RULE: verifyAccessToken is synchronous and
// TokenError is a class. Both are deliberate — verification is an in-process
// signature check with no I/O, and the error type is part of the contract
// (`err.code` distinguishes TOKEN_EXPIRED, which the client should refresh
// from, versus TOKEN_INVALID, which it must not). Wrapping either in a promise
// would misrepresent them.

exports.verifyAccessToken = tokenService.verifyAccessToken
exports.TokenError = tokenService.TokenError

/**
 * Resolve a session id to its live session + user in one indexed join.
 *
 * Returns null when the session is revoked, expired, or its user is gone —
 * every one of which means "this session is over".
 */
exports.getActiveSessionWithUser = async (sessionId) =>
  sessionService.getActiveSessionWithUser(sessionId)

/* ── Session administration ─────────────────────────────────────────────── */

exports.revokeSession = async (sessionId, reason, revokedBy) =>
  sessionService.revokeSession(sessionId, reason, revokedBy)

exports.revokeAllUserSessions = async (userId, reason, revokedBy, exceptSessionId) =>
  sessionService.revokeAllUserSessions(userId, reason, revokedBy, exceptSessionId)

exports.REVOKE_REASONS = sessionService.REVOKE_REASONS

/* ── Cookie policy ──────────────────────────────────────────────────────── */
//
// Consumed by routes/diagnostics.routes.js, which reports what flags the
// browser actually received. The policy itself must have exactly one
// definition — a diagnostic that describes different flags from the ones being
// set is worse than no diagnostic.

exports.COOKIE_OPTIONS = cookies.COOKIE_OPTIONS
exports.ACCESS_COOKIE = cookies.ACCESS_COOKIE
exports.REFRESH_COOKIE = cookies.REFRESH_COOKIE
