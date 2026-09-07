/*
 * Migration compatibility tests.
 * ---------------------------------------------------------------------------
 *   npm run test:migration      (backend must be running on :5000)
 *
 * Proves the localStorage-JWT -> httpOnly-cookie migration does not disturb
 * users who were already logged in. Two populations are exercised through the
 * identical lifecycle:
 *
 *   LEGACY  a session created the way the pre-migration code created them:
 *           old JWT payload (no jti), old user_tokens rows, no user_sessions
 *           row, refresh cookie at Path=/
 *   NEW     a session created by the current code
 *
 * Both must support: authenticate, silent refresh, protected route access,
 * page-reload behaviour, and logout.
 *
 * Run with NODE_ENV=development — production cookies are Secure and are not
 * sent over the plain HTTP this test uses.
 *
 * Fixtures are `zz-`prefixed and deleted at the end. No existing user, password
 * or business row is read or written.
 */

require('dotenv').config()
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const axios = require('axios')
const pool = require('../src/config/db')

const BASE = 'http://localhost:5000/api'
const STAMP = Date.now()
const LEGACY_EMAIL = `zz-mig-legacy-${STAMP}@varadhi.test`
const NEW_EMAIL = `zz-mig-new-${STAMP}@varadhi.test`
const PASSWORD = 'password123'

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; console.log(`  FAIL  ${name}${extra ? `  <- ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex')

// The pre-migration signing shape, reproduced exactly: no jti claim.
const legacySign = (userId, type, sessionId, expiresIn) =>
  jwt.sign({ id: userId, type, sessionId }, process.env.JWT_SECRET, { expiresIn })

// ─── Path-aware cookie jar ──────────────────────────────────────────────────
// Path awareness is the point of several assertions here: a cookie written at a
// different path does not overwrite one at '/', it coexists with it.
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
    seed(name, value, path = '/') { store.set(`${name}|${path}`, { name, value, path }) },
    header(urlPath) {
      return [...store.values()]
        .filter((c) => urlPath.startsWith(c.path))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ')
    },
    countNamed(name) { return [...store.values()].filter((c) => c.name === name).length },
    get(name) { return [...store.values()].find((c) => c.name === name) },
    all() { return [...store.values()] },
  }
}

async function call(jar, method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (opts.csrf !== false) headers['X-Requested-With'] = 'XMLHttpRequest'
  const cookie = jar.header(`/api${path}`)
  if (cookie) headers.Cookie = cookie

  const res = await axios({
    method,
    url: BASE + path,
    headers,
    ...(body === null || body === undefined ? {} : { data: body }),
    validateStatus: () => true,
  })
  if (res.headers['set-cookie']) jar.apply(res.headers['set-cookie'])
  return res
}

// Creates a user plus a session in the exact pre-migration shape.
async function seedLegacyUser(email) {
  const hashed = await bcrypt.hash(PASSWORD, 10)
  const u = await pool.query(
    `INSERT INTO users (name,email,password,role,status)
     VALUES ('ZZ Legacy User',$1,$2,'employee','active') RETURNING id, password`,
    [email, hashed]
  )
  const userId = u.rows[0].id
  const passwordHash = u.rows[0].password
  const sessionId = crypto.randomUUID()

  const access = legacySign(userId, 'access', sessionId, '15m')
  const refresh = legacySign(userId, 'refresh', sessionId, '7d')
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'

  await pool.query(
    `INSERT INTO user_tokens (user_id,token_type,token_hash,session_id,expires_at,user_agent,ip_address)
     VALUES ($1,'access',$2,$3,NOW() + INTERVAL '15 minutes',$4,'10.0.0.9')`,
    [userId, hashToken(access), sessionId, ua]
  )
  await pool.query(
    `INSERT INTO user_tokens (user_id,token_type,token_hash,session_id,refresh_family_id,expires_at,user_agent,ip_address)
     VALUES ($1,'refresh',$2,$3,$3,NOW() + INTERVAL '7 days',$4,'10.0.0.9')`,
    [userId, hashToken(refresh), sessionId, ua]
  )

  return { userId, sessionId, access, refresh, passwordHash }
}

;(async () => {
  // ───────────────────────────────────────────────────────────────────────
  section('=== SETUP: create a pre-migration user and session ===')
  const legacy = await seedLegacyUser(LEGACY_EMAIL)
  const before = await pool.query('SELECT 1 FROM user_sessions WHERE id=$1', [legacy.sessionId])
  ok('legacy session starts with NO user_sessions row', before.rowCount === 0)

  const { runSessionMigration } = require('../src/config/migrate-sessions')
  const client = await pool.connect()
  try { await client.query('BEGIN'); await runSessionMigration(client); await client.query('COMMIT') }
  finally { client.release() }

  const after = await pool.query(
    'SELECT revoked_at FROM user_sessions WHERE id=$1', [legacy.sessionId]
  )
  ok('backfill created the session row', after.rowCount === 1)
  ok('backfilled session is NOT revoked', after.rows[0]?.revoked_at === null)

  // ───────────────────────────────────────────────────────────────────────
  section('=== A. LEGACY SESSION — full lifecycle ===')
  const legacyJar = makeJar()
  // Reproduce the browser state of a pre-migration user: BOTH cookies at Path=/
  legacyJar.seed('varadhi_access', legacy.access, '/')
  legacyJar.seed('varadhi_refresh', legacy.refresh, '/')

  const lMe = await call(legacyJar, 'get', '/auth/me')
  ok('protected route with legacy cookie', lMe.status === 200, `got ${lMe.status} ${lMe.data?.code || ''}`)
  ok('returns the correct user', lMe.data?.data?.email === LEGACY_EMAIL, lMe.data?.data?.email)

  // The migrated session must be a real, live row — that row is what `protect`
  // resolves the access token against, so without it the legacy user is
  // unauthenticated no matter how valid their token is.
  const lRow = await pool.query(
    `SELECT revoked_at, expires_at > NOW() AS live FROM user_sessions WHERE id = $1`,
    [legacy.sessionId]
  )
  ok('legacy session row is live and unrevoked',
     lRow.rows[0]?.revoked_at === null && lRow.rows[0]?.live === true,
     JSON.stringify(lRow.rows[0]))

  const lRefresh = await call(legacyJar, 'post', '/auth/refresh')
  ok('silent refresh with legacy refresh token', lRefresh.status === 200, `got ${lRefresh.status} ${lRefresh.data?.code || ''}`)
  ok('session id preserved through migration+rotation',
     lRefresh.data?.data?.sessionId === legacy.sessionId,
     `${String(lRefresh.data?.data?.sessionId).slice(0,8)} vs ${legacy.sessionId.slice(0,8)}`)

  // THE DUPLICATE-COOKIE CHECK — the whole reason the path was reverted.
  ok('exactly ONE varadhi_refresh cookie after rotation (no duplicate path)',
     legacyJar.countNamed('varadhi_refresh') === 1,
     `found ${legacyJar.countNamed('varadhi_refresh')}: ${legacyJar.all().filter(c=>c.name==='varadhi_refresh').map(c=>c.path).join(', ')}`)
  ok('refresh cookie still written at Path=/',
     legacyJar.get('varadhi_refresh')?.path === '/',
     legacyJar.get('varadhi_refresh')?.path)

  const lAfterRefresh = await call(legacyJar, 'get', '/auth/me')
  ok('protected route works after refresh', lAfterRefresh.status === 200, `got ${lAfterRefresh.status}`)

  // "Page reload" = a fresh request carrying only the stored cookies.
  const reloadJar = makeJar()
  for (const c of legacyJar.all()) reloadJar.seed(c.name, c.value, c.path)
  const lReload = await call(reloadJar, 'get', '/auth/me')
  ok('page reload keeps the session alive', lReload.status === 200, `got ${lReload.status}`)

  const lLogout = await call(legacyJar, 'post', '/auth/logout')
  ok('legacy session logs out cleanly', lLogout.status === 200, `got ${lLogout.status}`)
  const lAfterLogout = await call(legacyJar, 'get', '/auth/me')
  ok('session dead after logout', lAfterLogout.status === 401, `got ${lAfterLogout.status}`)
  ok('logout cleared the refresh cookie', legacyJar.countNamed('varadhi_refresh') === 0,
     `${legacyJar.countNamed('varadhi_refresh')} left`)

  // ───────────────────────────────────────────────────────────────────────
  section('=== B. LEGACY CREDENTIALS UNCHANGED ===')
  const pwRow = await pool.query('SELECT password FROM users WHERE email=$1', [LEGACY_EMAIL])
  ok('password hash byte-identical after migration',
     pwRow.rows[0]?.password === legacy.passwordHash)
  const reLogin = await call(makeJar(), 'post', '/auth/login', { email: LEGACY_EMAIL, password: PASSWORD })
  ok('existing user logs in with ORIGINAL password', reLogin.status === 200,
     `got ${reLogin.status} ${reLogin.data?.message || ''}`)

  // ───────────────────────────────────────────────────────────────────────
  section('=== C. NEW SESSION — full lifecycle ===')
  const newJar = makeJar()
  const reg = await call(newJar, 'post', '/auth/register',
    { name: 'ZZ New User', email: NEW_EMAIL, password: PASSWORD })
  ok('register 201', reg.status === 201, `got ${reg.status} ${reg.data?.message || ''}`)
  ok('no JWT in response body (httpOnly only)', !reg.data?.data?.token)
  ok('refresh cookie at Path=/', newJar.get('varadhi_refresh')?.path === '/',
     newJar.get('varadhi_refresh')?.path)
  ok('single refresh cookie', newJar.countNamed('varadhi_refresh') === 1)

  const nMe = await call(newJar, 'get', '/auth/me')
  ok('protected route', nMe.status === 200, `got ${nMe.status}`)

  const nRefresh = await call(newJar, 'post', '/auth/refresh')
  ok('silent refresh', nRefresh.status === 200, `got ${nRefresh.status}`)
  ok('still a single refresh cookie after rotation', newJar.countNamed('varadhi_refresh') === 1,
     `found ${newJar.countNamed('varadhi_refresh')}`)

  const nSessionId = nRefresh.data?.data?.sessionId
  const nRefresh2 = await call(newJar, 'post', '/auth/refresh')
  ok('consecutive refresh succeeds', nRefresh2.status === 200, `got ${nRefresh2.status}`)
  ok('session id stable across refreshes', nRefresh2.data?.data?.sessionId === nSessionId)

  const nReloadJar = makeJar()
  for (const c of newJar.all()) nReloadJar.seed(c.name, c.value, c.path)
  ok('page reload keeps session', (await call(nReloadJar, 'get', '/auth/me')).status === 200)

  const nLogout = await call(newJar, 'post', '/auth/logout')
  ok('logout 200', nLogout.status === 200, `got ${nLogout.status}`)
  ok('session dead after logout', (await call(newJar, 'get', '/auth/me')).status === 401)

  // ───────────────────────────────────────────────────────────────────────
  section('=== D. SIGNED-OUT PROBE (login page recovery path) ===')
  // The login page probes /auth/me on mount. With no cookies this must be a
  // plain 401 the client can act on — never a redirect or an error.
  const emptyProbe = await call(makeJar(), 'get', '/auth/me')
  ok('probe with no cookies returns 401', emptyProbe.status === 401, `got ${emptyProbe.status}`)
  ok('401 carries a machine-readable code', typeof emptyProbe.data?.code === 'string', emptyProbe.data?.code)
  const emptyRefresh = await call(makeJar(), 'post', '/auth/refresh')
  ok('refresh with no cookie returns 401', emptyRefresh.status === 401, `got ${emptyRefresh.status}`)

  // ───────────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(56)}\n  ${passed} passed, ${failed} failed\n${'='.repeat(56)}`)

  try {
    const cleaned = await pool.query(
      "DELETE FROM users WHERE email LIKE 'zz-mig-%' RETURNING id"
    )
    console.log(`  cleaned up ${cleaned.rowCount} fixture user(s)\n`)
  } catch (err) {
    console.error(`  WARNING: cleanup failed: ${err.message}`)
    console.error(`  Remove manually: DELETE FROM users WHERE email LIKE 'zz-mig-%';\n`)
  }

  process.exit(failed === 0 ? 0 : 1)
})().catch(async (err) => {
  console.error('\nFATAL:', err.message)
  try { await pool.query("DELETE FROM users WHERE email LIKE 'zz-mig-%'") } catch {}
  process.exit(1)
})
