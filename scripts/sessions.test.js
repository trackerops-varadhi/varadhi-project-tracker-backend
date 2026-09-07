/*
 * Session management integration tests.
 * ---------------------------------------------------------------------------
 *   npm run test:sessions      (backend must be running on :5000)
 *
 * Hits the live API the way a browser does — real cookies, real rotation, real
 * revocation.
 *
 * NOTE ON SCOPE: the user-facing Active Sessions API was removed as
 * over-engineered for this project. Session records remain, because they ARE
 * the revocation mechanism — `protect` resolves an access token's sessionId
 * against a live session row on every request. So the tests below verify
 * session behaviour through the endpoints that still exist (login, refresh,
 * logout, change-password) plus direct database assertions, rather than through
 * a REST surface.
 *
 * RUN THIS WITH NODE_ENV=development (or any non-production value). In
 * production the auth cookies are Secure, so they are not sent over the plain
 * HTTP this test uses and every assertion fails for the wrong reason.
 *
 * Running back-to-back with the other suites will trip the login rate limiter;
 * start the server with LOGIN_RATE_LIMIT_MAX=1000 when doing that.
 *
 * Takes ~20 seconds: one test deliberately waits out the 15-second refresh
 * reuse grace window, which cannot be shortened without changing the constant
 * it is verifying.
 *
 * Fixtures are `zz-`prefixed and deleted at the end. No existing user,
 * credential or business row is read or written.
 */

require('dotenv').config()
const axios = require('axios')
const pool = require('../src/config/db')

const BASE = 'http://localhost:5000/api'
const EMAIL = `zz-session-test-${Date.now()}@varadhi.test`
const PASS = 'password123'
const NEWPASS = 'password456'

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; console.log(`  FAIL  ${name}${extra ? `  <- ${extra}` : ''}`) }
}

// Minimal path-aware cookie jar.
function makeJar() {
  const store = new Map()
  return {
    set(setCookies) {
      for (const raw of setCookies || []) {
        const [pair, ...attrs] = raw.split(';')
        const eq = pair.indexOf('=')
        const name = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        const pathAttr = attrs.find((a) => a.trim().toLowerCase().startsWith('path='))
        const path = pathAttr ? pathAttr.split('=')[1].trim() : '/'
        const expires = attrs.find((a) => a.trim().toLowerCase().startsWith('expires='))
        const key = `${name}|${path}`
        if (value === '' || (expires && new Date(expires.split('=')[1]) < new Date())) {
          store.delete(key)
        } else {
          store.set(key, { name, value, path })
        }
      }
    },
    header(urlPath) {
      return [...store.values()]
        .filter((c) => urlPath.startsWith(c.path))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ')
    },
    get(name) { return [...store.values()].find((c) => c.name === name) },
    countNamed(name) { return [...store.values()].filter((c) => c.name === name).length },
  }
}

async function call(jar, method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (opts.csrf !== false) headers['X-Requested-With'] = 'XMLHttpRequest'
  const cookie = jar.header(`/api${path}`)
  if (cookie && opts.noCookie !== true) headers.Cookie = cookie
  if (opts.cookieOverride) headers.Cookie = opts.cookieOverride

  try {
    const res = await axios({
      method, url: BASE + path, headers,
      ...(body === null || body === undefined ? {} : { data: body }),
      validateStatus: () => true,
    })
    if (res.headers['set-cookie'] && opts.noJar !== true) jar.set(res.headers['set-cookie'])
    return res
  } catch (e) {
    return { status: 0, data: { message: e.message } }
  }
}

// Live sessions for the fixture user, read straight from the table now that
// there is no endpoint for it.
const liveSessions = async () => {
  const r = await pool.query(
    `SELECT s.id, s.revoked_at, s.revoked_reason
     FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE u.email = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [EMAIL]
  )
  return r.rows
}

;(async () => {
  console.log('\n=== 1. Registration issues cookies, not a body token ===')
  const jarA = makeJar()
  const reg = await call(jarA, 'post', '/auth/register', { name: 'ZZ Session Test', email: EMAIL, password: PASS })
  ok('register 201', reg.status === 201, `got ${reg.status} ${JSON.stringify(reg.data?.message)}`)
  ok('no token in response body', !reg.data?.data?.token, JSON.stringify(reg.data?.data || {}).slice(0, 120))
  ok('varadhi_access cookie set', !!jarA.get('varadhi_access'))
  ok('varadhi_refresh cookie set', !!jarA.get('varadhi_refresh'))
  // Path=/ is deliberate: existing users already hold a refresh cookie at '/',
  // so anything else would leave two cookies of the same name coexisting.
  ok('refresh cookie written at Path=/ (overwrites any legacy cookie)',
     jarA.get('varadhi_refresh')?.path === '/', jarA.get('varadhi_refresh')?.path)

  console.log('\n=== 2. Cookie auth works; Bearer no longer does ===')
  const me = await call(jarA, 'get', '/auth/me')
  ok('GET /auth/me with cookie 200', me.status === 200, `got ${me.status}`)
  const noAuth = await call(jarA, 'get', '/auth/me', null, { noCookie: true })
  ok('GET /auth/me without cookie 401', noAuth.status === 401, `got ${noAuth.status}`)

  console.log('\n=== 3. CSRF header guard ===')
  const noCsrf = await call(jarA, 'put', '/auth/change-password', { currentPassword: PASS, newPassword: PASS }, { csrf: false })
  ok('mutation without X-Requested-With 403', noCsrf.status === 403, `got ${noCsrf.status}`)
  ok('CSRF error code correct', noCsrf.data?.code === 'CSRF_HEADER_MISSING', noCsrf.data?.code)
  const getNoCsrf = await call(jarA, 'get', '/auth/me', null, { csrf: false })
  ok('GET without header still allowed', getNoCsrf.status === 200, `got ${getNoCsrf.status}`)

  console.log('\n=== 4. One session row per login ===')
  const afterOne = await liveSessions()
  ok('registration created exactly 1 live session', afterOne.length === 1, `got ${afterOne.length}`)

  const jarB = makeJar()
  const login2 = await call(jarB, 'post', '/auth/login', { email: EMAIL, password: PASS })
  ok('second login 200', login2.status === 200, `got ${login2.status}`)
  const afterTwo = await liveSessions()
  ok('second browser = second session row', afterTwo.length === 2, `got ${afterTwo.length}`)

  console.log('\n=== 5. THE KEY FIX: session id is stable across refresh ===')
  const idsBefore = (await liveSessions()).map((r) => r.id).sort()

  const r1 = await call(jarA, 'post', '/auth/refresh')
  ok('refresh 200', r1.status === 200, `got ${r1.status} ${r1.data?.message}`)
  const sessionIdFromRefresh = r1.data?.data?.sessionId
  const r2 = await call(jarA, 'post', '/auth/refresh')
  ok('second refresh 200', r2.status === 200, `got ${r2.status}`)
  const r3 = await call(jarA, 'post', '/auth/refresh')
  ok('third refresh 200', r3.status === 200, `got ${r3.status}`)
  ok('sessionId identical across all refreshes',
     r2.data?.data?.sessionId === sessionIdFromRefresh &&
     r3.data?.data?.sessionId === sessionIdFromRefresh,
     `${sessionIdFromRefresh} / ${r2.data?.data?.sessionId} / ${r3.data?.data?.sessionId}`)

  const idsAfter = (await liveSessions()).map((r) => r.id).sort()
  ok('still 2 sessions after 3 refreshes', idsAfter.length === 2, `got ${idsAfter.length}`)
  ok('SESSION IDS UNCHANGED IN DB', JSON.stringify(idsBefore) === JSON.stringify(idsAfter),
     `\n        before=${JSON.stringify(idsBefore)}\n        after =${JSON.stringify(idsAfter)}`)
  ok('exactly one live refresh token per session',
     (await pool.query(
       `SELECT 1 FROM user_tokens t JOIN users u ON u.id=t.user_id
        WHERE u.email=$1 AND t.revoked_at IS NULL AND t.expires_at > NOW()
        GROUP BY t.session_id HAVING count(*) > 1`, [EMAIL])).rowCount === 0)

  console.log('\n=== 6. Refresh token reuse detection ===')
  const jarC = makeJar()
  await call(jarC, 'post', '/auth/login', { email: EMAIL, password: PASS })
  const stolen = `varadhi_refresh=${jarC.get('varadhi_refresh').value}`
  await call(jarC, 'post', '/auth/refresh')           // legitimate rotation

  // Inside the grace window a replay is a benign two-tab race: no new
  // credential may be minted, and the session must survive.
  const raced = await call(makeJar(), 'post', '/auth/refresh', null,
    { cookieOverride: stolen, noJar: true })
  const mintedInRace = (raced.headers?.['set-cookie'] || [])
    .find((c) => c.startsWith('varadhi_refresh='))
  ok('replay inside grace window mints NO new refresh cookie', !mintedInRace)
  ok('replay inside grace window does not kill the session', raced.status === 200, `got ${raced.status}`)

  console.log('  (waiting out the 15s grace window...)')
  await new Promise((r) => setTimeout(r, 16000))
  const replay = await call(makeJar(), 'post', '/auth/refresh', null,
    { cookieOverride: stolen, noJar: true })
  ok('replay OUTSIDE grace window rejected', replay.status === 401, `got ${replay.status}`)
  ok('code is TOKEN_REUSE', replay.data?.code === 'TOKEN_REUSE', replay.data?.code)
  const afterReuse = await call(jarA, 'get', '/auth/me')
  ok('reuse revoked ALL sessions for the user', afterReuse.status === 401, `got ${afterReuse.status}`)
  ok('revocation reason recorded as token_reuse',
     (await pool.query(
       `SELECT 1 FROM user_sessions s JOIN users u ON u.id=s.user_id
        WHERE u.email=$1 AND s.revoked_reason='token_reuse'`, [EMAIL])).rowCount > 0)

  console.log('\n=== 7. Password change revokes other sessions, keeps current ===')
  const jarD = makeJar()
  const jarE = makeJar()
  await call(jarD, 'post', '/auth/login', { email: EMAIL, password: PASS })
  await call(jarE, 'post', '/auth/login', { email: EMAIL, password: PASS })
  const cp = await call(jarD, 'put', '/auth/change-password', { currentPassword: PASS, newPassword: NEWPASS })
  ok('change-password 200', cp.status === 200, `got ${cp.status} ${cp.data?.message}`)
  ok('reports revoked count', cp.data?.data?.revokedCount >= 1, JSON.stringify(cp.data?.data))
  const dStill = await call(jarD, 'get', '/auth/me')
  ok('changing session STAYS logged in', dStill.status === 200, `got ${dStill.status}`)
  const eGone = await call(jarE, 'get', '/auth/me')
  ok('other session signed out', eGone.status === 401, `got ${eGone.status}`)
  ok('other session reports SESSION_REVOKED', eGone.data?.code === 'SESSION_REVOKED', eGone.data?.code)

  console.log('\n=== 8. Logout works with an EXPIRED access token ===')
  const jarF = makeJar()
  await call(jarF, 'post', '/auth/login', { email: EMAIL, password: NEWPASS })
  // Simulate expiry by presenting only the refresh cookie.
  const refreshOnly = `varadhi_refresh=${jarF.get('varadhi_refresh').value}`
  const lo = await call(jarF, 'post', '/auth/logout', null, { cookieOverride: refreshOnly, noJar: true })
  ok('logout without access token 200', lo.status === 200, `got ${lo.status}`)
  const afterLogout = await call(jarF, 'get', '/auth/me')
  ok('session really revoked by logout', afterLogout.status === 401, `got ${afterLogout.status}`)

  console.log('\n=== 9. Silent refresh survives real cookie expiry ===')
  /*
   * Regression guard. The access cookie's Max-Age must OUTLIVE the token inside
   * it. When they matched, the browser deleted the cookie at the moment the
   * token expired, the server saw NO_TOKEN instead of TOKEN_EXPIRED, and the
   * client force-logged-out instead of refreshing — every user, every 15 min.
   */
  const jarG = makeJar()
  const gLogin = await call(jarG, 'post', '/auth/login', { email: EMAIL, password: NEWPASS })
  const gAccessCookie = (gLogin.headers?.['set-cookie'] || [])
    .find((c) => c.startsWith('varadhi_access='))
  const cookieMaxAge = Number(/Max-Age=(\d+)/.exec(gAccessCookie)?.[1])
  const rawAccess = gAccessCookie.split('=')[1].split(';')[0]
  const payload = JSON.parse(Buffer.from(rawAccess.split('.')[1], 'base64url'))
  const jwtLifetime = payload.exp - payload.iat

  ok('access cookie outlives the access token',
     cookieMaxAge > jwtLifetime,
     `cookie ${cookieMaxAge}s vs token ${jwtLifetime}s — equal means silent refresh is impossible`)
  ok('access token itself is still short-lived', jwtLifetime <= 900, `${jwtLifetime}s`)

  // Browser-deleted access cookie, refresh cookie intact: must be recoverable.
  const gRefreshOnly = `varadhi_refresh=${jarG.get('varadhi_refresh').value}`
  const gRecover = await call(makeJar(), 'post', '/auth/refresh', null,
    { cookieOverride: gRefreshOnly, noJar: true })
  ok('refresh works with ONLY the refresh cookie present',
     gRecover.status === 200, `got ${gRecover.status} ${gRecover.data?.code || ''}`)

  console.log('\n=== 10. Post-logout contract the login page depends on ===')
  /*
   * After a logout, sibling tabs navigate to the login page and it probes the
   * session. Both probe requests MUST terminate promptly with a recognisable
   * 401 — if either hung, or returned a code the client treats as recoverable
   * forever, the login page would sit on "Checking your session..." and never
   * render the form. That is the exact bug found in 3-tab manual testing.
   */
  const jarH = makeJar()
  await call(jarH, 'post', '/auth/login', { email: EMAIL, password: NEWPASS })
  await call(jarH, 'post', '/auth/logout')

  const t0 = Date.now()
  const probeMe = await call(jarH, 'get', '/auth/me')
  const probeRefresh = await call(jarH, 'post', '/auth/refresh')
  const elapsed = Date.now() - t0

  ok('post-logout /auth/me returns 401', probeMe.status === 401, `got ${probeMe.status}`)
  ok('post-logout /auth/refresh returns 401', probeRefresh.status === 401, `got ${probeRefresh.status}`)
  ok('both carry a machine-readable code',
     typeof probeMe.data?.code === 'string' && typeof probeRefresh.data?.code === 'string',
     `${probeMe.data?.code} / ${probeRefresh.data?.code}`)
  ok('probe pair completes quickly (no hang)', elapsed < 5000, `took ${elapsed}ms`)

  console.log('\n=== 11. Removed Active Sessions API is really gone ===')
  const gone = await call(jarD, 'get', '/sessions')
  ok('GET /api/sessions returns 404', gone.status === 404, `got ${gone.status}`)
  const goneAll = await call(jarD, 'post', '/auth/logout-all')
  ok('POST /auth/logout-all returns 404', goneAll.status === 404, `got ${goneAll.status}`)

  console.log(`\n${'='.repeat(50)}\n  ${passed} passed, ${failed} failed\n${'='.repeat(50)}\n`)

  // Delete the fixture user. Sessions and tokens go with it via ON DELETE
  // CASCADE, so this leaves no trace in user_sessions or user_tokens.
  try {
    const cleaned = await pool.query(
      "DELETE FROM users WHERE email LIKE 'zz-session-test-%' RETURNING id"
    )
    console.log(`  cleaned up ${cleaned.rowCount} fixture user(s)\n`)
  } catch (err) {
    console.error(`  WARNING: fixture cleanup failed: ${err.message}`)
    console.error(`  Remove manually: DELETE FROM users WHERE email = '${EMAIL}';\n`)
  }

  process.exit(failed === 0 ? 0 : 1)
})()
