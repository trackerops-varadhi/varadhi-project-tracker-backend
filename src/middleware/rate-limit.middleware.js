/**
 * Rate limiter
 * ---------------------------------------------------------------------------
 * Fixed-window counter over a pluggable store. Same response shape, same
 * headers and the same limits as before; what changed is where the counters
 * live — see rate-limit-store.js.
 *
 *   RATE_LIMIT_STORE=memory     per-process (default, single instance)
 *   RATE_LIMIT_STORE=postgres   shared across instances
 *   MULTI_INSTANCE=true         declaring this with the memory store is a
 *                               startup error, not a warning
 *
 * WHAT THIS GUARDS, AND WHAT IT DOES NOT
 * Login and password recovery, to blunt credential stuffing and action-token
 * brute forcing. It is NOT the PRD's "rate limiting prevents notification
 * flooding" rule — the engine's dedupe window already satisfies that — and it
 * is not the safety property behind notification actions, which is database
 * idempotency: a replayed action returns its stored result rather than applying
 * twice, with or without a throttle.
 *
 * FAIL OPEN ON A RUNTIME STORE ERROR, LOUDLY
 * If the store throws while serving a request, the request is ALLOWED and the
 * failure is logged and counted. That is the deliberate opposite of the leader
 * lock's fail-closed rule, and the asymmetry is the point: a leader that cannot
 * prove it is alone must not run, because duplicate sweeps are invisible to
 * monitoring and visible to users; a limiter that cannot reach its store must
 * not lock every user out of logging in over a transient database blip. The
 * configuration mistake that actually matters — memory store across several
 * instances — is caught at startup, where it cannot be missed, rather than
 * being papered over here.
 */

const { getStore } = require('./rate-limit-store')
const { logger } = require('../platform/logger')
const metrics = require('../platform/metrics')

/**
 * @param {object}   opts
 * @param {number}   opts.windowMs
 * @param {number}   opts.max         requests per window per key
 * @param {function} [opts.keyFn]     req -> string
 * @param {string}   [opts.message]
 * @param {string}   [opts.name]      label for metrics; defaults to the route
 */
function createRateLimiter({ windowMs, max, keyFn, message, name } = {}) {
  const resolveKey =
    keyFn ||
    ((req) =>
      (req.user && req.user.id) ||
      req.ip ||
      (req.connection && req.connection.remoteAddress) ||
      'unknown')

  return async function rateLimit(req, res, next) {
    const label = name || req.baseUrl || 'unnamed'
    // Namespaced so two limiters with different windows on the same IP cannot
    // share a bucket — they did not before, when each closed over its own Map.
    const key = `${label}:${windowMs}:${resolveKey(req)}`

    let bucket
    try {
      bucket = await getStore().hit(key, windowMs)
    } catch (err) {
      metrics.inc('rate_limit_store_errors_total', { limiter: label })
      logger.error('[rate-limit] store unavailable — allowing request', {
        err, limiter: label,
      })
      return next()
    }

    if (bucket.count <= max) {
      metrics.inc('rate_limit_allowed_total', { limiter: label })
      return next()
    }

    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000))
    metrics.inc('rate_limit_blocked_total', { limiter: label })
    res.setHeader('Retry-After', String(retryAfter))
    // Envelope matches the action endpoint's errors so the service worker can
    // branch on data.code uniformly.
    return res.status(429).json({
      success: false,
      message: message || 'Too many requests. Please try again shortly.',
      data: { code: 'rate_limited', retryAfter },
    })
  }
}

module.exports = { createRateLimiter }
