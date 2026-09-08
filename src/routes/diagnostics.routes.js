/*
 * Cookie / session diagnostics.
 * ---------------------------------------------------------------------------
 *   GET /api/diag/cookies      what the server actually received
 *   GET /api/diag/set-test     sets a probe cookie with the real auth flags
 *   GET /api/diag/read-test    reports whether the probe cookie came back
 *
 * WHY THIS EXISTS
 * A third-party-cookie failure is invisible from the server: login returns 200,
 * the Set-Cookie header goes out correctly, and the BROWSER silently discards
 * it. Server logs look perfect while every user is locked out. The only way to
 * tell is to ask the browser what it actually kept — which is what set-test and
 * read-test do, in two clicks, from the affected phone.
 *
 * SAFETY
 * - NEVER returns cookie VALUES. Only presence, length and a short hash-free
 *   prefix marker. A token echoed here would be a token in a browser history,
 *   a screenshot, or a support chat.
 * - Unauthenticated by necessity: the whole point is to diagnose the case where
 *   authentication is impossible.
 * - Gated behind ENABLE_DIAGNOSTICS. Unset (the default) and every route here
 *   404s exactly as if the file did not exist.
 *
 * REMOVE THE ENV VAR once production login is confirmed working. These routes
 * disclose nothing sensitive, but a permanently mounted debug surface is
 * something an attacker enumerates for free.
 */

const router = require('express').Router()
const { COOKIE_OPTIONS } = require('../config/cookies')

const ENABLED = process.env.ENABLE_DIAGNOSTICS === 'true'

// Behaves as though the router were never mounted when disabled.
router.use((req, res, next) => {
  if (!ENABLED) return res.status(404).json({ success: false, message: 'Not found' })
  next()
})

const PROBE_COOKIE = 'varadhi_probe'

// Presence and shape only — never the value.
const describeCookies = (req) => {
  const jar = req.cookies || {}
  return Object.fromEntries(
    Object.keys(jar).map((name) => [
      name,
      { present: true, length: String(jar[name] ?? '').length },
    ])
  )
}

/*
 * The main one. Open this on the failing phone AFTER logging in: if
 * `varadhi_access` is missing here but login returned 200, the browser
 * discarded the cookie and you are looking at third-party cookie blocking.
 */
router.get('/cookies', (req, res) => {
  const jar = req.cookies || {}

  res.json({
    success: true,
    now: new Date().toISOString(),
    environment: process.env.NODE_ENV,

    // Did the browser send our auth cookies at all?
    authCookies: {
      varadhi_access: Boolean(jar.varadhi_access),
      varadhi_refresh: Boolean(jar.varadhi_refresh),
      varadhi_token_hint: Boolean(jar.varadhi_token),
    },
    allCookies: describeCookies(req),
    cookieHeaderPresent: Boolean(req.headers.cookie),

    // Same-origin proxy or direct cross-site call? `origin` is absent on a
    // server-to-server proxied request, which is itself the signal that the
    // Vercel rewrite is in play.
    request: {
      origin: req.headers.origin || null,
      referer: req.headers.referer || null,
      host: req.headers.host || null,
      forwardedFor: req.headers['x-forwarded-for'] || null,
      forwardedHost: req.headers['x-forwarded-host'] || null,
      userAgent: req.headers['user-agent'] || null,
      secure: req.secure,
      protocol: req.protocol,
    },

    // What this server WOULD set, so you can compare against what arrived.
    cookiePolicy: {
      httpOnly: COOKIE_OPTIONS.httpOnly,
      secure: COOKIE_OPTIONS.secure,
      sameSite: COOKIE_OPTIONS.sameSite,
      path: COOKIE_OPTIONS.path,
    },

    hint:
      'Open /api/diag/set-test, then /api/diag/read-test. If read-test says ' +
      'received:false, this browser is refusing to store the cookie — which ' +
      'on a cross-site deployment means third-party cookie blocking.',
  })
})

/*
 * Sets a throwaway cookie using the EXACT flags the auth cookies use, so a
 * failure here reproduces the auth failure without needing credentials.
 */
router.get('/set-test', (req, res) => {
  res.cookie(PROBE_COOKIE, `ok-${Date.now()}`, {
    ...COOKIE_OPTIONS,
    httpOnly: false, // readable by the page so a browser console can confirm too
    maxAge: 5 * 60 * 1000,
  })

  res.json({
    success: true,
    message: 'Probe cookie set. Now open /api/diag/read-test in this same browser.',
    flagsUsed: {
      secure: COOKIE_OPTIONS.secure,
      sameSite: COOKIE_OPTIONS.sameSite,
      path: COOKIE_OPTIONS.path,
    },
  })
})

router.get('/read-test', (req, res) => {
  const received = Boolean(req.cookies?.[PROBE_COOKIE])

  res.json({
    success: true,
    received,
    verdict: received
      ? 'PASS — this browser stores and returns the cookie. Cookie transport is fine.'
      : 'FAIL — the browser did not return the cookie it was just given. On a ' +
        'cross-site setup this is third-party cookie blocking (Safari ITP, ' +
        'Chrome privacy settings, or corporate policy). Route the API through ' +
        'the frontend origin so the cookie becomes first-party.',
    origin: req.headers.origin || null,
    host: req.headers.host || null,
  })
})

module.exports = router
