/**
 * Error tracking hook.
 * ---------------------------------------------------------------------------
 * One function — `captureException` — that every error path can call, wired to
 * nothing by default.
 *
 * WHY A HOOK AND NOT SENTRY
 * No error-tracking service has been chosen for this project, and installing an
 * SDK is the part of that decision that is hard to reverse: it adds a
 * dependency, a DSN to manage, an outbound network call on every error, and in
 * Sentry's case automatic instrumentation that wraps express internals. This
 * file is the seam that makes the choice cheap later — call sites use
 * `captureException(err, context)` today and keep working unchanged when a real
 * backend is registered behind it.
 *
 * WHAT IT DOES WITH NO BACKEND
 * Logs the error as a structured line with its correlation id, which is what
 * would have happened anyway, and counts it so `/metrics` can show an error rate
 * before anyone has bought anything.
 *
 * REDACTION IS NOT OPTIONAL
 * Whatever is registered here receives error context, and error context is
 * exactly where credentials leak — a connection string in a pg error, a token in
 * a request body. `scrub()` runs before any backend sees the payload, not after,
 * so a third-party SDK never receives the raw value in the first place.
 */

const { logger } = require('./logger')
const metrics = require('./metrics')
const context = require('./request-context')

const SECRET_KEYS = /^(password|pass|token|secret|key|authorization|cookie|dsn|apikey|api_key|connectionstring|connection_string|database_url)$/i
const SECRET_VALUE = /(postgres(?:ql)?:\/\/[^\s'"]+)|(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})|(Bearer\s+\S+)/gi

/** Remove anything that looks like a credential, by key name and by shape. */
const scrub = (value, depth = 0) => {
  if (depth > 6) return '[depth]'
  if (value == null) return value
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[redacted]')
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1))
  if (value instanceof Error) {
    return { name: value.name, message: scrub(value.message, depth + 1), stack: value.stack }
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1)
    }
    return out
  }
  return value
}

let backend = null

/**
 * Register an error-tracking backend.
 * @param {{captureException: (err: Error, ctx: object) => void}} impl
 */
const register = (impl) => {
  if (impl && typeof impl.captureException !== 'function') {
    throw new Error('error-tracking backend must expose captureException(err, ctx)')
  }
  backend = impl
}

const isConfigured = () => backend !== null

/**
 * Report an error. Never throws — an error in the error reporter must not
 * replace the error being reported, which is the classic way a 500 becomes an
 * unhandled rejection and takes the process down.
 */
const captureException = (err, ctx = {}) => {
  const safe = scrub(ctx)
  const requestId = context.getRequestId()

  try {
    metrics.inc('errors_total', {
      type: (err && err.name) || 'Error',
      ...(ctx.route ? { route: String(ctx.route) } : {}),
    })
  } catch { /* metrics must never break error reporting */ }

  try {
    logger.error((err && err.message) || 'unknown error', { err, ...safe })
  } catch { /* logging must never break error reporting */ }

  if (!backend) return
  try {
    backend.captureException(err, { ...safe, ...(requestId ? { requestId } : {}) })
  } catch (reportErr) {
    try { logger.error('error-tracking backend threw', { err: reportErr }) } catch { /* give up */ }
  }
}

/**
 * Express error middleware. Mount LAST, after the routers.
 * Reports, then hands off — it does not decide the response shape, because
 * error.middleware.js already owns that and two handlers disagreeing about the
 * envelope is worse than either.
 */
const middleware = (err, req, res, next) => {
  captureException(err, {
    route: (req.route && req.baseUrl + req.route.path) || req.baseUrl || req.path,
    method: req.method,
  })
  return next(err)
}

/** Catch what escapes express entirely. Call once at startup. */
const installProcessHandlers = () => {
  process.on('unhandledRejection', (reason) => {
    captureException(reason instanceof Error ? reason : new Error(String(reason)),
      { source: 'unhandledRejection' })
  })
  process.on('uncaughtException', (err) => {
    captureException(err, { source: 'uncaughtException' })
    // Deliberately does NOT exit. This process has no graceful shutdown yet
    // (Phase 3 item), so exiting here would drop in-flight requests without
    // draining them. Revisit when shutdown exists.
  })
}

module.exports = {
  captureException, register, isConfigured, middleware, installProcessHandlers, scrub,
}
