/**
 * Notification action routes.
 *
 * Deliberately a SEPARATE router rather than extra routes on
 * notifications.routes.js. That file applies `router.use(requireAuth)` at the
 * top, and SF3 will add a credential (the signed action token) that does not go
 * through `protect` — mixing the two in one router would leave Module 7's
 * inbox one line-reordering away from being silently unauthenticated.
 */

const router = require('express').Router()
const { protect } = require('../middleware/auth.middleware')
const { createRateLimiter } = require('../middleware/rate-limit.middleware')
const ctrl = require('../controllers/notification-actions.controller')

// 30 actions per 5 minutes per user. Generous for a human tapping buttons;
// tight enough to blunt token brute-forcing once SF3 lands.
const actionLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: 'Too many notification actions. Please try again shortly.',
})

/**
 * Two credentials, one handler.
 *
 * A request carrying `token` in the body comes from the service worker, which
 * has no session bearer available — it skips `protect` and the controller
 * verifies the action token itself. Everything else must authenticate normally.
 *
 * `protect` is applied conditionally rather than removed: without a token the
 * behaviour is byte-identical to SF2a, so the in-app path keeps full session
 * auth and an unauthenticated request with no token still 401s at the
 * middleware, never reaching the controller.
 */
function authenticate(req, res, next) {
  if (req.body && typeof req.body.token === 'string' && req.body.token.length > 0) {
    return next()
  }
  return protect(req, res, next)
}

router.post('/', authenticate, actionLimiter, ctrl.performAction)

module.exports = router
