const router = require('express').Router()
const ctrl = require('../controllers/auth.controller')
const { protect } = require('../middleware/auth.middleware')
const { createRateLimiter } = require('../middleware/rate-limit.middleware')
const { extractIpAddress } = require('../utils/device-parser')

/*
 * Rate-limit key: the ORIGINAL client, read from the left of X-Forwarded-For.
 *
 * `req.ip` is wrong here now. Traffic reaches this service as
 * browser -> Vercel (same-origin proxy) -> Render -> Express, so req.ip
 * resolves to a Vercel edge address that is identical for every user on the
 * planet. Keying on it would put the entire company in one bucket, and the
 * first person to mistype a password would lock everyone out.
 *
 * The leftmost forwarded entry is client-controlled and therefore spoofable.
 * That is an accepted trade-off for a throttle: the alternative is a limiter
 * that reliably locks out real users, which is strictly worse. Nothing is
 * authorised on the basis of this value.
 */
const clientKey = (prefix) => (req) => `${prefix}:${extractIpAddress(req) || 'unknown'}`

/*
 * Brute-force protection on the credential endpoints.
 *
 * These were previously unthrottled, which meant an attacker could try
 * passwords against /auth/login as fast as the network allowed. bcrypt makes
 * each attempt cost ~100ms of CPU, which slows an attacker down but also means
 * a flood of attempts is simultaneously a denial-of-service against the API.
 *
 * KEYED BY IP, NOT BY EMAIL, and that is deliberate. Keying on the submitted
 * email would let anyone lock a colleague out of their own account by
 * deliberately failing logins against their address — turning a protection into
 * a griefing tool. IP keying throttles the attacker's machine instead.
 *
 * The limiter's own docs note it is per-process, so two Render instances would
 * each allow the full quota. That is an acceptable weakening here: this raises
 * the cost of online guessing, it is not the only thing standing between an
 * attacker and an account. It is also why the numbers are generous rather than
 * aggressive — a shared office NAT puts the whole team behind one IP, and
 * locking out the real users would be a worse outcome than a slow attacker.
 */
/*
 * Limits are env-tunable with secure defaults, for two reasons.
 *
 * Operationally: if the whole office shares one NAT address, 20 attempts per
 * 15 minutes may be too tight, and locking out the real team is a worse
 * outcome than a slow attacker. Raising it must not require a redeploy.
 *
 * For testing: the integration suites drive dozens of logins from 127.0.0.1
 * and would otherwise throttle themselves. Start the server with
 * LOGIN_RATE_LIMIT_MAX=1000 when running them back to back.
 *
 * The defaults are what ships. An unset environment is the secure one.
 */
const loginLimiter = createRateLimiter({
  windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 20,
  keyFn: clientKey('login'),
  message: 'Too many login attempts. Please wait a few minutes and try again.',
})

// Tighter, because these mint or consume single-use tokens and are never used
// repeatedly by a legitimate person. They are also the endpoints an attacker
// probes to enumerate accounts or brute-force a reset token.
const recoveryLimiter = createRateLimiter({
  windowMs: Number(process.env.RECOVERY_RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000,
  max: Number(process.env.RECOVERY_RATE_LIMIT_MAX) || 10,
  keyFn: clientKey('recovery'),
  message: 'Too many attempts. Please wait a while and try again.',
})

router.post('/register', recoveryLimiter, ctrl.register)
router.post('/login', loginLimiter, ctrl.login)

// Deliberately NOT behind `protect`.
//
// The most common moment to log out is after a period of inactivity, when the
// 15-minute access token has already expired. Requiring a live token here would
// make logout fail exactly when it is most needed, leaving a live session on the
// server while the user believes they signed out. The handler verifies the
// cookie's signature itself (ignoring only expiry) to find which session to
// revoke, so it still cannot be used to end anyone else's session.
router.post('/logout', ctrl.logout)

// Reads the refresh cookie, which is why it needs no access token either.
router.post('/refresh', ctrl.refreshToken)

router.post('/forgot-password', recoveryLimiter, ctrl.forgotPassword)
router.post('/reset-password', recoveryLimiter, ctrl.resetPassword)

// Invite tokens are 32 random bytes, so guessing is not the threat — but these
// are unauthenticated and hit the database, so they get the same ceiling.
router.get('/invite/:token', recoveryLimiter, ctrl.verifyInvite)
router.post('/accept-invite', recoveryLimiter, ctrl.acceptInvite)

router.get('/me', protect, ctrl.getMe)

// Revokes every OTHER session on success — see the handler. That happens
// server-side as a security property of changing a password; it is not a
// user-facing session management feature and has no UI of its own.
router.put('/change-password', protect, ctrl.changePassword)

module.exports = router
