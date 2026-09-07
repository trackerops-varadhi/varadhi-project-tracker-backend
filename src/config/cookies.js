/*
 * Auth cookie policy — one place, so the set and clear options can never drift.
 * ---------------------------------------------------------------------------
 * WHY SameSite IS 'none' AND NOT 'strict'
 *
 * The original requirement asked for SameSite=Strict in production. That is not
 * implementable on this deployment and shipping it would take the app down.
 * The frontend is on Vercel and the API is on Render — different registrable
 * domains, so every API call is a cross-site request. A Strict (or Lax) cookie
 * is simply not attached to those, which means no authenticated request would
 * ever carry a token and every user would be permanently logged out.
 *
 * 'none' + Secure is the only combination that works cross-site, and it is the
 * standard answer for a split frontend/API deployment.
 *
 * WHAT THIS COSTS, AND HOW IT IS PAID FOR
 *
 * SameSite=None means SameSite provides ZERO CSRF protection here. The original
 * plan's "CSRF protection via SameSite" does not hold on this architecture, so
 * the protection is provided explicitly instead, by two things:
 *
 *   1. csrf.middleware.js requires an X-Requested-With header on mutations.
 *      A cross-origin request carrying a custom header is forced into a CORS
 *      preflight, and the preflight is refused by the origin allow-list in
 *      server.js. A malicious page cannot add the header without passing that
 *      check first.
 *   2. express.urlencoded is no longer mounted on API routes. Form-encoded
 *      POSTs are "simple requests" that skip preflight entirely, so leaving
 *      that parser on was the actual hole — a hostile page could submit a form
 *      cross-site and the cookie would ride along.
 *
 * Neither of those is optional. Removing either re-opens CSRF.
 *
 * In development both origins are http://localhost, where Secure cookies are
 * not sent over plain HTTP and SameSite=None requires Secure. 'lax' is the
 * working local equivalent, which is why these are environment-dependent.
 */

const isProd = process.env.NODE_ENV === 'production'

const ACCESS_COOKIE = 'varadhi_access'
const REFRESH_COOKIE = 'varadhi_refresh'

/*
 * BOTH cookies are written at Path=/ — and the refresh cookie deliberately so.
 *
 * An earlier revision scoped the refresh cookie to '/api/auth', reasoning that a
 * 7-day credential need not ride along on every request for a task list. That is
 * true in isolation and wrong during this migration.
 *
 * Existing users already hold a `varadhi_refresh` cookie written at Path=/ by the
 * previous code. A cookie is identified by (name, domain, path), so writing a
 * second one at '/api/auth' does not replace it — the browser keeps BOTH, sends
 * both on every /api/auth request, and `cookie-parser` resolves the collision
 * non-obviously. The stale one then lingers for seven days. The same collision
 * appears in reverse on a rollback, when the old code starts writing at '/'
 * again.
 *
 * Matching the existing path means each new cookie cleanly OVERWRITES the one
 * already in the browser, so a logged-in user migrates with no duplicate and no
 * ambiguity. Path scoping can be reintroduced as its own change once no
 * pre-migration cookies remain in circulation.
 *
 * NOTE: clearCookie only matches a cookie when path and sameSite/secure match
 * what was set. That is why the clear options are derived from the same
 * constants below instead of being written out a second time — a mismatched
 * path is a cookie that silently survives logout.
 */
const REFRESH_COOKIE_PATH = '/'

// Any path a previous build may have written the refresh cookie to. Logout
// clears these as well, so a browser that saw an intermediate deployment cannot
// keep a stale refresh cookie alive at a path the current code never touches.
const LEGACY_REFRESH_COOKIE_PATHS = ['/api/auth']

const ACCESS_TOKEN_MS = 15 * 60 * 1000
const REFRESH_TOKEN_MS = 7 * 24 * 60 * 60 * 1000

const baseOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
}

/*
 * The access COOKIE deliberately outlives the access TOKEN inside it.
 *
 * This looks wrong and is load-bearing. Cookie Max-Age and JWT `exp` are
 * different mechanisms: Max-Age tells the BROWSER when to delete the cookie,
 * while `exp` is what the server actually enforces. When both were 15 minutes,
 * the browser deleted the cookie at the very moment the token expired, so the
 * next request arrived carrying no access cookie at all. The server answered
 * NO_TOKEN rather than TOKEN_EXPIRED — and the client only refreshes on
 * TOKEN_EXPIRED, so instead of a silent refresh every user was force-logged-out
 * every 15 minutes. Silent refresh could never have worked.
 *
 * Giving the cookie the refresh window's lifetime means an expired token is
 * still PRESENTED, the server can distinguish "expired, go refresh" from "no
 * credential at all", and the silent refresh path actually runs.
 *
 * This grants no extra access. The JWT is still signed with a 15-minute `exp`
 * and verifyAccessToken still rejects it the moment it lapses; the only change
 * is that the browser keeps handing over the expired token instead of throwing
 * it away, which is exactly what makes a graceful refresh possible.
 */
const COOKIE_OPTIONS = {
  ...baseOptions,
  maxAge: REFRESH_TOKEN_MS,
  path: '/',
}

const REFRESH_COOKIE_OPTIONS = {
  ...baseOptions,
  maxAge: REFRESH_TOKEN_MS,
  path: REFRESH_COOKIE_PATH,
}

// No maxAge — clearCookie sets an expiry in the past itself.
const clearAccessCookieOptions = { ...baseOptions, path: '/' }
const clearRefreshCookieOptions = { ...baseOptions, path: REFRESH_COOKIE_PATH }

/*
 * Set both cookies. Every issuance path (login, register, accept-invite,
 * refresh) goes through here so none of them can forget one or use a different
 * policy.
 */
const setAuthCookies = (res, accessToken, refreshToken) => {
  res.cookie(ACCESS_COOKIE, accessToken, COOKIE_OPTIONS)
  res.cookie(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTIONS)
}

const clearAuthCookies = (res) => {
  res.clearCookie(ACCESS_COOKIE, clearAccessCookieOptions)
  res.clearCookie(REFRESH_COOKIE, clearRefreshCookieOptions)

  // Sweep any path a previous build wrote to. Harmless when nothing is there —
  // it just emits an already-expired Set-Cookie the browser ignores — and it
  // guarantees logout cannot leave a live refresh token behind at a path the
  // current configuration no longer uses.
  for (const path of LEGACY_REFRESH_COOKIE_PATHS) {
    res.clearCookie(REFRESH_COOKIE, { ...baseOptions, path })
  }
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  LEGACY_REFRESH_COOKIE_PATHS,
  COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
  // Kept under its old name because auth.controller.js already imports it;
  // it is the access-cookie clear policy.
  clearCookieOptions: clearAccessCookieOptions,
  clearAccessCookieOptions,
  clearRefreshCookieOptions,
  setAuthCookies,
  clearAuthCookies,
}
