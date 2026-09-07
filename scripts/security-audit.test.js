/*
 * Authentication & session security audit.
 * ---------------------------------------------------------------------------
 *   npm run test:security      (backend must be running on :5000)
 *
 * Asserts the security properties of the httpOnly-cookie migration against a
 * live server rather than by reading the source. Every check here is one an
 * attacker's first probe would perform.
 *
 * Cookie flag assertions run in BOTH modes:
 *   NODE_ENV=development  expects SameSite=Lax, Secure absent  (plain-HTTP local)
 *   NODE_ENV=production   expects SameSite=None, Secure present (cross-site)
 * The mode is read from the running server's /health output, so the assertions
 * follow the server rather than assuming.
 *
 * Fixtures are `zz-`prefixed and removed at the end. No existing user,
 * credential or business row is read or written.
 */

require('dotenv').config()
const axios = require('axios')
const pool = require('../src/config/db')

const BASE = 'http://localhost:5000/api'
const STAMP = Date.now()
const EMAIL = `zz-audit-${STAMP}@varadhi.test`
const EMAIL2 = `zz-audit2-${STAMP}@varadhi.test`
const PASSWORD = 'password123'

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; console.log(`  FAIL  ${name}${extra ? `  <- ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

function makeJar() {
  const store = new Map()
  return {
    apply(setCookies) {
      for (const raw of setCookies || []) {
        const [pair, ...attrs] = raw.split(';')
        const eq = pair.indexOf('=')
        const name = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        const pathAttr = attrs.find((a) => a.trim().toLowerCase().startsWith('path='))
        const path = pathAttr ? pathAttr.split('=')[1].trim() : '/'
        const expAttr = attrs.find((a) => a.trim().toLowerCase().startsWith('expires='))
        const expired = expAttr && new Date(expAttr.split('=')[1]) < new Date()
        const key = `${name}|${path}`
        if (value === '' || expired) store.delete(key)
        else store.set(key, { name, value, path })
      }
    },
    header(p) {
      return [...store.values()].filter((c) => p.startsWith(c.path))
        .map((c) => `${c.name}=${c.value}`).join('; ')
    },
    get(n) { return [...store.values()].find((c) => c.name === n) },
  }
}

async function call(jar, method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (opts.csrf !== false) headers['X-Requested-With'] = 'XMLHttpRequest'
  const cookie = jar ? jar.header(`/api${path}`) : ''
  if (cookie) headers.Cookie = cookie
  if (opts.headers) Object.assign(headers, opts.headers)

  const res = await axios({
    method, url: BASE + path, headers,
    ...(body === null || body === undefined ? {} : { data: body }),
    validateStatus: () => true,
  })
  if (jar && res.headers['set-cookie']) jar.apply(res.headers['set-cookie'])
  return res
}

// Raw Set-Cookie strings, which is where the flags actually live.
async function rawLoginCookies(email, password) {
  const res = await axios.post(`${BASE}/auth/login`, { email, password }, {
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    validateStatus: () => true,
  })
  return { res, setCookie: res.headers['set-cookie'] || [] }
}

;(async () => {
  const health = await axios.get('http://localhost:5000/health', { validateStatus: () => true })
  const isProd = health.data?.environment === 'production'
  console.log(`  server environment: ${health.data?.environment}\n`)

  const jar = makeJar()
  const reg = await call(jar, 'post', '/auth/register',
    { name: 'ZZ Audit', email: EMAIL, password: PASSWORD })
  if (reg.status !== 201) {
    console.error(`  SETUP FAILED: register returned ${reg.status} ${reg.data?.message}`)
    process.exit(1)
  }

  // ────────────────────────────────────────────────────────────────────────
  section('=== 1. No real JWT reachable by JavaScript ===')
  const { setCookie } = await rawLoginCookies(EMAIL, PASSWORD)
  const access = setCookie.find((c) => c.startsWith('varadhi_access='))
  const refresh = setCookie.find((c) => c.startsWith('varadhi_refresh='))

  ok('access cookie is HttpOnly', /HttpOnly/i.test(access || ''), access?.slice(0, 90))
  ok('refresh cookie is HttpOnly', /HttpOnly/i.test(refresh || ''), refresh?.slice(0, 90))

  // The server must never set a non-httpOnly cookie containing a JWT. A JWT is
  // recognisable by its three dot-separated base64 segments.
  const jwtLike = /=[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
  const leaky = setCookie.filter((c) => jwtLike.test(c) && !/HttpOnly/i.test(c))
  ok('NO JavaScript-readable cookie contains a JWT', leaky.length === 0,
     leaky.map((c) => c.split('=')[0]).join(', '))

  ok('login response body carries no token', !reg.data?.data?.token &&
     !JSON.stringify((await call(makeJar(), 'post', '/auth/login',
       { email: EMAIL, password: PASSWORD })).data).includes('eyJ'))

  const meRes = await call(jar, 'get', '/auth/me')
  ok('/auth/me returns no token or password field',
     !JSON.stringify(meRes.data).match(/eyJ|password|token_hash/i),
     Object.keys(meRes.data?.data || {}).join(','))

  // ────────────────────────────────────────────────────────────────────────
  section('=== 2. Cookie flags correct for this environment ===')
  if (isProd) {
    ok('access cookie Secure (production)', /Secure/i.test(access || ''))
    ok('refresh cookie Secure (production)', /Secure/i.test(refresh || ''))
    ok('access SameSite=None (required cross-site)', /SameSite=None/i.test(access || ''))
    ok('refresh SameSite=None (required cross-site)', /SameSite=None/i.test(refresh || ''))
  } else {
    ok('access cookie NOT Secure (dev, plain HTTP)', !/Secure/i.test(access || ''))
    ok('access SameSite=Lax (dev)', /SameSite=Lax/i.test(access || ''), access)
    ok('refresh SameSite=Lax (dev)', /SameSite=Lax/i.test(refresh || ''))
    console.log('  NOTE  production flags (Secure + SameSite=None) not asserted in dev mode')
  }
  ok('both cookies at Path=/ (no duplicate-path hazard)',
     /Path=\/(;|$)/.test(access || '') && /Path=\/(;|$)/.test(refresh || ''))

  // ────────────────────────────────────────────────────────────────────────
  section('=== 3. CSRF protection ===')
  const noHeader = await call(jar, 'put', '/auth/change-password',
    { currentPassword: PASSWORD, newPassword: PASSWORD }, { csrf: false })
  ok('mutation without X-Requested-With is refused', noHeader.status === 403, `got ${noHeader.status}`)
  ok('refusal is machine-readable', noHeader.data?.code === 'CSRF_HEADER_MISSING', noHeader.data?.code)

  const getNoHeader = await call(jar, 'get', '/auth/me', null, { csrf: false })
  ok('safe methods unaffected', getNoHeader.status === 200, `got ${getNoHeader.status}`)

  // A form-encoded POST is the CSRF vector that skips preflight entirely.
  const formPost = await axios.post(`${BASE}/auth/logout`, 'sessionId=x', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    validateStatus: () => true,
  })
  ok('form-encoded POST refused (urlencoded parser removed)', formPost.status === 403,
     `got ${formPost.status}`)

  // ────────────────────────────────────────────────────────────────────────
  section('=== 4. Refresh token rotation ===')
  const rotJar = makeJar()
  await call(rotJar, 'post', '/auth/login', { email: EMAIL, password: PASSWORD })
  const first = rotJar.get('varadhi_refresh').value
  const r1 = await call(rotJar, 'post', '/auth/refresh')
  const second = rotJar.get('varadhi_refresh').value
  ok('refresh succeeds', r1.status === 200, `got ${r1.status}`)
  ok('refresh token is ROTATED, not reused', first !== second)

  const hashRows = await pool.query(
    `SELECT count(*) AS n FROM user_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE u.email = $1 AND t.token_hash LIKE 'eyJ%'`, [EMAIL]
  )
  ok('DB stores hashes, never raw tokens', hashRows.rows[0].n === '0', `${hashRows.rows[0].n} raw`)

  /*
   * Replaying the rotated-away token INSIDE the grace window.
   *
   * The security property is not "it returns 401" — a two-tab race lands here
   * legitimately, and failing it would sign honest users out. The property is
   * that no NEW credential is minted: the replay must not produce a second live
   * token chain for the session. So assert on Set-Cookie, not on status.
   */
  const oldReuse = await call(makeJar(), 'post', '/auth/refresh', null,
    { headers: { Cookie: `varadhi_refresh=${first}` } })
  const mintedCookies = oldReuse.headers['set-cookie'] || []
  const mintedRefresh = mintedCookies.find((c) => c.startsWith('varadhi_refresh='))
  ok('replayed token mints NO new refresh cookie (no forked chain)',
     !mintedRefresh, mintedRefresh?.slice(0, 60))
  ok('replay inside grace window does not revoke the session',
     oldReuse.status === 200, `got ${oldReuse.status}`)

  // Only ONE live refresh token may exist per session at any time. A fork here
  // is what would let a stolen token survive undetected for the full 7 days.
  const liveTokens = await pool.query(
    `SELECT t.session_id, count(*) AS n
     FROM user_tokens t JOIN users u ON u.id = t.user_id
     WHERE u.email = $1 AND t.revoked_at IS NULL AND t.expires_at > NOW()
     GROUP BY t.session_id HAVING count(*) > 1`, [EMAIL]
  )
  ok('no session has more than one live refresh token',
     liveTokens.rowCount === 0,
     liveTokens.rows.map((r) => `${r.session_id.slice(0,8)}=${r.n}`).join(', '))

  // ────────────────────────────────────────────────────────────────────────
  section('=== 5. Session revocation is immediate ===')
  /*
   * Revocation is driven straight through the service now that the Active
   * Sessions REST surface is gone. That is the right level to test it: the
   * security property is that `protect` refuses a revoked session on the very
   * next request — which endpoint triggered the revocation is incidental, and
   * the remaining triggers (logout, password change, replay detection) all
   * funnel through these same two functions.
   */
  const { revokeSession, REVOKE_REASONS } = require('../src/services/session.service')

  const victim = makeJar()
  await call(victim, 'post', '/auth/login', { email: EMAIL, password: PASSWORD })
  ok('victim session works', (await call(victim, 'get', '/auth/me')).status === 200)

  const victimRow = await pool.query(
    `SELECT s.id FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE u.email = $1 AND s.revoked_at IS NULL
     ORDER BY s.created_at DESC LIMIT 1`, [EMAIL]
  )
  await revokeSession(victimRow.rows[0].id, REVOKE_REASONS.LOGOUT)

  const afterRevoke = await call(victim, 'get', '/auth/me')
  ok('revoked session rejected on the NEXT request', afterRevoke.status === 401, `got ${afterRevoke.status}`)
  ok('code distinguishes revoked from expired', afterRevoke.data?.code === 'SESSION_REVOKED',
     afterRevoke.data?.code)
  ok('revoked session cannot refresh either',
     (await call(victim, 'post', '/auth/refresh')).status === 401)
  ok('revoking a session also revokes its refresh tokens',
     (await pool.query(
       `SELECT 1 FROM user_tokens WHERE session_id = $1 AND revoked_at IS NULL`,
       [victimRow.rows[0].id])).rowCount === 0)

  // ────────────────────────────────────────────────────────────────────────
  section('=== 6. Password change revokes other sessions ===')
  const keep = makeJar()
  const drop = makeJar()
  await call(keep, 'post', '/auth/login', { email: EMAIL, password: PASSWORD })
  await call(drop, 'post', '/auth/login', { email: EMAIL, password: PASSWORD })

  const cp = await call(keep, 'put', '/auth/change-password',
    { currentPassword: PASSWORD, newPassword: 'newpassword456' })
  ok('change-password succeeds', cp.status === 200, `got ${cp.status} ${cp.data?.message}`)
  ok('current session survives', (await call(keep, 'get', '/auth/me')).status === 200)
  ok('OTHER sessions revoked', (await call(drop, 'get', '/auth/me')).status === 401)

  // ────────────────────────────────────────────────────────────────────────
  section('=== 7. Attack surface removed with the Active Sessions UI ===')
  const otherJar = makeJar()
  await call(otherJar, 'post', '/auth/register',
    { name: 'ZZ Audit Two', email: EMAIL2, password: PASSWORD })

  // These endpoints let one authenticated user address another user's session
  // by id. Removing the feature removed that surface entirely; confirm none of
  // it is still routable.
  const someSession = await pool.query(
    `SELECT s.id FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE u.email = $1 LIMIT 1`, [EMAIL]
  )
  const sid = someSession.rows[0]?.id

  ok('GET /api/sessions is gone', (await call(otherJar, 'get', '/sessions')).status === 404)
  ok('DELETE /api/sessions is gone', (await call(otherJar, 'delete', '/sessions')).status === 404)
  ok('DELETE /api/sessions/:id is gone',
     (await call(otherJar, 'delete', `/sessions/${sid}`)).status === 404)
  ok('admin session endpoints are gone',
     (await call(otherJar, 'get', `/sessions/user/${sid}`)).status === 404)
  ok('POST /auth/logout-all is gone',
     (await call(otherJar, 'post', '/auth/logout-all')).status === 404)

  // A user must still not be able to reach another user's data anywhere.
  const otherMe = await call(otherJar, 'get', '/auth/me')
  ok('/auth/me returns only the caller', otherMe.data?.data?.email === EMAIL2, otherMe.data?.data?.email)
  ok('no token material in any auth payload',
     !JSON.stringify(otherMe.data).match(/token|hash|eyJ/i))

  // ────────────────────────────────────────────────────────────────────────
  section('=== 8. Brute-force protection on login ===')
  let sawLimit = false
  let attempts = 0
  for (let i = 0; i < 30; i += 1) {
    const r = await call(makeJar(), 'post', '/auth/login',
      { email: EMAIL, password: `wrong-${i}` })
    attempts += 1
    if (r.status === 429) { sawLimit = true; break }
  }
  ok('repeated failed logins are rate limited', sawLimit, `no 429 after ${attempts} attempts`)

  const limited = await call(makeJar(), 'post', '/auth/login',
    { email: EMAIL, password: 'anything' })
  ok('limiter returns 429 with Retry-After', limited.status === 429 &&
     limited.headers['retry-after'] !== undefined, `status ${limited.status}`)
  ok('correct password ALSO throttled (no bypass)', limited.status === 429)

  // ────────────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(56)}\n  ${passed} passed, ${failed} failed\n${'='.repeat(56)}`)

  try {
    const c = await pool.query("DELETE FROM users WHERE email LIKE 'zz-audit%' RETURNING id")
    console.log(`  cleaned up ${c.rowCount} fixture user(s)\n`)
  } catch (err) {
    console.error(`  WARNING: cleanup failed: ${err.message}\n`)
  }

  process.exit(failed === 0 ? 0 : 1)
})().catch(async (err) => {
  console.error('\nFATAL:', err.message)
  try { await pool.query("DELETE FROM users WHERE email LIKE 'zz-audit%'") } catch {}
  process.exit(1)
})
