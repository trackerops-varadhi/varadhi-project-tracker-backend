/**
 * Minimal in-memory rate limiter
 * ---------------------------------------------------------------------------
 * Fixed-window counter. No new dependency (the project has no express-rate-limit
 * and adding one for a single endpoint isn't worth it).
 *
 * KNOWN LIMITATION — state is per-process, so this does NOT survive horizontal
 * scaling: two Render instances would each allow the full quota. That is
 * acceptable here because it guards the notification-action endpoint, whose
 * real safety property is DB-level idempotency (a replayed action returns the
 * stored result instead of re-applying), not the throttle. The throttle exists
 * to blunt brute-forcing of action tokens, not to enforce a business quota.
 *
 * This is NOT the "rate limiting prevents notification flooding" business rule
 * from the PRD — that is already satisfied by the engine's dedupe window.
 */

/**
 * @param {object}   opts
 * @param {number}   opts.windowMs
 * @param {number}   opts.max         requests per window per key
 * @param {function} [opts.keyFn]     req -> string
 * @param {string}   [opts.message]
 */
function createRateLimiter({ windowMs, max, keyFn, message } = {}) {
  const buckets = new Map() // key -> { count, resetAt }

  const resolveKey =
    keyFn ||
    ((req) =>
      (req.user && req.user.id) ||
      req.ip ||
      (req.connection && req.connection.remoteAddress) ||
      'unknown')

  // Opportunistic sweep so the Map can't grow without bound on a long-lived
  // process. Runs on request, not on a timer — nothing to unref at shutdown.
  let lastSweep = Date.now()
  const sweep = (now) => {
    if (now - lastSweep < windowMs) return
    lastSweep = now
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k)
  }

  return function rateLimit(req, res, next) {
    const now = Date.now()
    sweep(now)

    const key = resolveKey(req)
    const bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }

    bucket.count += 1
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
      res.setHeader('Retry-After', String(retryAfter))
      // Shape matches the action endpoint's error envelope so the service
      // worker can branch on data.code uniformly.
      return res.status(429).json({
        success: false,
        message: message || 'Too many requests. Please try again shortly.',
        data: { code: 'rate_limited', retryAfter },
      })
    }

    return next()
  }
}

module.exports = { createRateLimiter }
