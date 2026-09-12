/*
 * User-Agent → { browser, os, deviceLabel }.
 * ---------------------------------------------------------------------------
 * Feeds the presentation columns on `user_sessions`, which exist so the Active
 * Sessions list can say "Chrome on Windows" instead of showing a 200-character
 * UA string. Parsed once at session creation and stored, never re-derived on
 * read — a stored label cannot drift when this file changes.
 *
 * Hand-rolled rather than ua-parser-js on purpose: this needs to name a browser
 * and an OS for a ~20-person internal team, not to identify every device ever
 * shipped. That is a dozen ordered regexes, and it avoids adding a dependency
 * (plus its update treadmill) to a security-sensitive path.
 *
 * ORDER IS THE WHOLE GAME. Browser UA strings are deliberately full of lies for
 * compatibility reasons — every Chromium browser claims to be Chrome *and*
 * Safari, and Chrome claims to be Mozilla and Gecko-like. So the checks run
 * most-specific first and stop at the first hit:
 *
 *   Edge     UA contains "Edg/"     AND "Chrome/" AND "Safari/"
 *   Opera    UA contains "OPR/"     AND "Chrome/" AND "Safari/"
 *   Chrome   UA contains "Chrome/"  AND "Safari/"
 *   Safari   UA contains "Safari/"  only
 *
 * Reversing any pair of those makes every Edge user show up as Chrome, and
 * every Chrome user show up as Safari. Add new browsers ABOVE the generic
 * entry they impersonate, never below.
 *
 * Everything here is best-effort and must never throw: a UA string is
 * attacker-controlled input, and failing to label a device is not a reason to
 * fail a login. Unrecognised input yields 'Unknown', which the UI renders as-is.
 */

const UNKNOWN = 'Unknown'

// Ordered most-specific first — see the header. First match wins.
const BROWSERS = [
  { name: 'Edge',              test: /\bEdg(?:e|A|iOS)?\// },
  { name: 'Opera',             test: /\bOPR\/|\bOpera\// },
  { name: 'Samsung Internet',  test: /\bSamsungBrowser\// },
  { name: 'Brave',             test: /\bBrave\// },
  { name: 'Vivaldi',           test: /\bVivaldi\// },
  { name: 'Firefox',           test: /\bFirefox\/|\bFxiOS\// },
  // Chrome on iOS is CriOS — it is Chrome to the user, so it is named Chrome.
  { name: 'Chrome',            test: /\bChrome\/|\bCriOS\// },
  // Reached only when nothing Chromium matched above, which is what makes this
  // actually mean Safari rather than "any browser that mentions Safari".
  { name: 'Safari',            test: /\bSafari\// },
  // Non-browser clients. Useful to surface: a session labelled "curl" in
  // someone's Active Sessions list is a genuine signal worth seeing.
  { name: 'curl',              test: /\bcurl\// },
  { name: 'Postman',           test: /\bPostmanRuntime\// },
]

// iOS before macOS: an iPhone UA contains "like Mac OS X" and would otherwise
// be labelled macOS. Android before Linux for the same reason.
const OPERATING_SYSTEMS = [
  { name: 'iOS',       test: /\b(iPhone|iPad|iPod)\b/ },
  { name: 'Android',   test: /\bAndroid\b/ },
  { name: 'Windows',   test: /\bWindows NT\b/ },
  { name: 'macOS',     test: /\bMac OS X\b|\bMacintosh\b/ },
  { name: 'ChromeOS',  test: /\bCrOS\b/ },
  { name: 'Linux',     test: /\bLinux\b|\bX11\b/ },
]

const matchFirst = (candidates, userAgent) => {
  for (const candidate of candidates) {
    if (candidate.test.test(userAgent)) return candidate.name
  }
  return UNKNOWN
}

/*
 * Mobile/tablet detection drives only the label wording ("Chrome on Android
 * (Mobile)"), not any security decision. iPadOS 13+ ships a desktop UA that is
 * indistinguishable from macOS Safari, so an iPad may read as desktop — an
 * accepted inaccuracy, not a bug worth a fingerprinting workaround.
 */
const detectFormFactor = (userAgent) => {
  if (/\biPad\b/.test(userAgent) || /\bTablet\b/.test(userAgent)) return 'Tablet'
  if (/\bMobi\b|\bMobile\b|\biPhone\b|\biPod\b/.test(userAgent)) return 'Mobile'
  return 'Desktop'
}

/*
 * Returns the three stored columns. Always returns strings — never null, never
 * throws — so a caller can insert the result directly.
 *
 * deviceLabel is the single human-readable string the Settings UI shows:
 *   "Chrome on Windows"            (desktop — the common case, kept clean)
 *   "Safari on iOS (Mobile)"       (form factor appended only when notable)
 *   "Unknown browser on Unknown"   (unparseable or absent UA)
 *
 * Values are clamped to the column widths declared in migrate-sessions.js
 * (browser/os VARCHAR(100), device_label VARCHAR(200)). A UA long enough to
 * overflow those is malformed anyway, but truncating here means a hostile
 * header can never turn a login into a 22001 string-too-long error.
 */
const parseUserAgent = (rawUserAgent) => {
  const userAgent = typeof rawUserAgent === 'string' ? rawUserAgent.trim() : ''

  if (!userAgent) {
    return { browser: UNKNOWN, os: UNKNOWN, deviceLabel: 'Unknown device' }
  }

  const browser = matchFirst(BROWSERS, userAgent)
  const os = matchFirst(OPERATING_SYSTEMS, userAgent)
  const formFactor = detectFormFactor(userAgent)

  const browserPart = browser === UNKNOWN ? 'Unknown browser' : browser
  const suffix = formFactor === 'Desktop' ? '' : ` (${formFactor})`
  const deviceLabel = `${browserPart} on ${os}${suffix}`

  return {
    browser: browser.slice(0, 100),
    os: os.slice(0, 100),
    deviceLabel: deviceLabel.slice(0, 200),
  }
}

/*
 * Express puts the peer address in req.ip, but behind Render's proxy that is
 * the proxy's address unless `trust proxy` is enabled — which server.js does
 * not currently set. This reads the forwarded chain directly so the stored IP
 * is the client's rather than a load balancer's.
 *
 * The LEFTMOST entry of X-Forwarded-For is the client. It is also fully
 * client-spoofable, so this value is display-only: it is shown in the Active
 * Sessions list to help someone recognise their own session, and it is never
 * used to authenticate, authorise, or bind a session. Treating a spoofable
 * header as a security control is the classic mistake here — this deliberately
 * does not.
 *
 * The ::ffff: prefix on IPv4-mapped IPv6 addresses is stripped so the list
 * shows 203.0.113.7 rather than ::ffff:203.0.113.7.
 */
const extractIpAddress = (req) => {
  const forwarded = req.headers?.['x-forwarded-for']
  const candidate = Array.isArray(forwarded) ? forwarded[0] : forwarded

  const raw = candidate
    ? String(candidate).split(',')[0].trim()
    : req.ip || req.socket?.remoteAddress || ''

  const normalised = raw.replace(/^::ffff:/i, '')
  return normalised ? normalised.slice(0, 100) : null
}

module.exports = { parseUserAgent, extractIpAddress }
