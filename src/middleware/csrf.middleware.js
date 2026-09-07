/*
 * CSRF protection via a required custom header.
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * Auth cookies must be SameSite=None here — the frontend (Vercel) and the API
 * (Render) are different registrable domains, and any stricter value means the
 * cookie is never sent at all (see config/cookies.js). SameSite=None means the
 * browser attaches auth cookies to cross-site requests, so SameSite contributes
 * nothing to CSRF defence on this deployment. Something has to.
 *
 * HOW IT WORKS
 *
 * Mutating requests must carry `X-Requested-With`. The value is irrelevant —
 * its mere presence is the defence, because of how CORS classifies requests:
 *
 *   - A cross-origin request with a custom header is NOT a "simple request".
 *     The browser must first send a preflight OPTIONS, and it will only send
 *     the real request if the preflight succeeds.
 *   - server.js answers preflights only for the origins in its allow-list.
 *   - An attacker's page is not on that list, so its preflight fails and the
 *     real request is never sent.
 *   - JavaScript cannot opt out of preflight, and HTML forms cannot set custom
 *     headers at all.
 *
 * So a hostile page can neither add the header nor avoid needing it.
 *
 * THIS ONLY WORKS ALONGSIDE TWO OTHER THINGS. Both are load-bearing:
 *
 *   1. `express.urlencoded` must NOT be mounted on API routes. Form-encoded
 *      POSTs are simple requests — no preflight, no custom header possible —
 *      so a parser that accepts them re-opens exactly the hole this closes.
 *      A form POST would still arrive here without the header and be rejected,
 *      but defence in depth matters on the one control standing between a
 *      cookie and a cross-site write.
 *   2. The CORS origin allow-list must stay a real list. `origin: true` or a
 *      reflected origin would make every preflight succeed and render this
 *      middleware decorative.
 *
 * Safe methods are exempt because they must not mutate anything. If a GET in
 * this codebase ever changes state, that GET is the bug — not this exemption.
 */

// Case-insensitive by virtue of Node lower-casing all incoming header names.
const CSRF_HEADER = 'x-requested-with'

// RFC 7231 safe methods, plus OPTIONS which is the preflight itself.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/*
 * Paths that authenticate with something OTHER than an ambient cookie, and so
 * are not CSRF-eligible in the first place.
 *
 * /api/notification-actions accepts a signed action token in the request body,
 * minted at dispatch and delivered inside the push payload. That path exists
 * precisely because a service worker cannot rely on the session, and
 * notification-actions.routes.js documents that it deliberately keeps its
 * credential in the BODY rather than a header — adding a required header here
 * would break every notification action button.
 *
 * The exemption is safe for the reason CSRF exists at all: forging a request is
 * only useful when the browser supplies the credential automatically. A body
 * token is not ambient — an attacker who already has it does not need CSRF.
 *
 * Matched by prefix so sub-paths are covered; anchored with a leading slash so
 * a route like /api/notification-actions-admin would NOT accidentally match.
 */
const EXEMPT_PREFIXES = ['/api/notification-actions']

const isExempt = (path) =>
  EXEMPT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  )

const requireCsrfHeader = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next()

  // req.path is the mount-relative path; originalUrl carries the full path and
  // the querystring. The prefixes above are absolute, so match on originalUrl
  // with the query stripped.
  const path = (req.originalUrl || req.url || '').split('?')[0]
  if (isExempt(path)) return next()

  const header = req.headers[CSRF_HEADER]

  if (!header || String(header).trim() === '') {
    return res.status(403).json({
      success: false,
      message:
        'Request blocked: missing X-Requested-With header. This request did not originate from the application.',
      code: 'CSRF_HEADER_MISSING',
    })
  }

  return next()
}

module.exports = { requireCsrfHeader, CSRF_HEADER, EXEMPT_PREFIXES }
