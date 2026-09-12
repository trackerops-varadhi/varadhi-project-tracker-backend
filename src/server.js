require('dotenv').config()
const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const helmet = require('helmet')
const morgan = require('morgan')
const { fork } = require('child_process')
const db = require('./config/db')
const { requireCsrfHeader } = require('./middleware/csrf.middleware')
const userTokensMigrationPath = require.resolve('./config/migrate-user-tokens')
const sessionsMigrationPath = require.resolve('./config/migrate-sessions')
const { startReminderCron } = require('./utils/reminder-cron');
// const path = require('path')

const app = express()

/*
 * Trust exactly one proxy hop.
 *
 * Render terminates TLS at its edge and forwards to this process, so without
 * this `req.ip` is Render's internal proxy address — identical for every user
 * on the planet. That would make the IP-keyed login rate limiter throttle the
 * entire company as if it were one client: twenty people share one quota, and
 * the first user to fat-finger their password uses up everyone's attempts.
 *
 * `1` rather than `true` is the security-relevant part. `true` trusts the whole
 * X-Forwarded-For chain, which the client controls, so an attacker could spoof
 * a fresh IP per request and bypass the limiter entirely. Trusting exactly one
 * hop means only the address Render itself appended is believed.
 *
 * Locally there is no proxy, so req.ip is the socket address either way and
 * this changes nothing in development.
 */
app.set('trust proxy', 1)

// â”€â”€â”€ Security & Middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(helmet())
// CORS allow-list. The service worker's inline notification actions POST from
// the frontend origin exactly as the page does, so they are covered by the
// same entries â€” no SW-specific origin is needed.
//
// NOTE: `allowedHeaders` is an allow-list. The action endpoint deliberately
// carries its credential in the request BODY rather than a custom header,
// because adding one here would be required for the preflight to pass.
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://varadhi-project-tracker.vercel.app',
].filter(Boolean)

// `X-Requested-With` MUST be listed here or the CSRF guard becomes an outage:
// the browser sends a preflight for it, the preflight is refused for an
// unlisted header, and every mutation from the real frontend fails. Its
// presence in this allow-list is also precisely what makes it a CSRF defence —
// only origins listed above can get a preflight approved (see
// middleware/csrf.middleware.js).
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}))
// â”€â”€â”€ Request logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Morgan's built-in `dev`/`combined` formats carry access-log metadata that is
// noise in a dev terminal (remote address, user-agent, referrer, the raw
// `"GET /path HTTP/1.1"` request line). Same middleware, same timing source â€”
// just a custom format emitting only the four fields that matter, matching the
// Next.js dev server's line shape:
//
//   GET /api/users 200 in 50ms
//   GET /api/notifications?limit=10 304 in 30ms
//
// Only the request log is affected: errors, warnings, startup banners and
// database/exception output go through console/error.middleware, untouched.

// Colour is opt-out safe: piping to a file, CI or a log collector (no TTY, or
// NO_COLOR set) falls back to plain text so ANSI escapes never reach the log.
const logColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code, text) => (logColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const statusColor = (status) => {
  if (status >= 500) return 31 // red
  if (status >= 400) return 33 // yellow
  if (status >= 300) return 36 // cyan
  return 32                    // green
}

// `req.originalUrl` keeps the querystring and the full mount path, so a request
// routed through `app.use('/api/notifications', ...)` still logs as
// `/api/notifications?limit=10` rather than the router-relative `/`.
morgan.token('clean-url', (req) => req.originalUrl || req.url)

app.use(morgan((tokens, req, res) => {
  // Status is undefined when the client aborts before a response is written.
  const status = Number(tokens.status(req, res))
  const time = tokens['response-time'](req, res)

  return [
    paint(1, tokens.method(req, res)),
    tokens['clean-url'](req, res),
    Number.isNaN(status) ? paint(35, '---') : paint(statusColor(status), status),
    paint(2, `in ${time == null ? '-' : `${Math.round(Number(time))}ms`}`),
  ].join(' ')
}))
app.use(express.json({ limit: '10mb' }))
// Auth V2 — httpOnly cookie support
app.use(cookieParser())

// `express.urlencoded` is deliberately NOT mounted.
//
// It used to be, and it was the real CSRF hole. Auth cookies are SameSite=None
// (forced by the Vercel/Render split — see config/cookies.js), so the browser
// attaches them to cross-site requests. A form-encoded POST is a CORS "simple
// request": no preflight, no custom header possible, cookies sent. So any page
// on the internet could submit a hidden form at this API and have it parsed and
// executed as the logged-in user.
//
// Nothing in this codebase posts form-encoded bodies — the frontend sends JSON
// and file uploads go through multer's multipart parser — so removing it costs
// nothing and closes the hole at the parser rather than relying solely on the
// header check below.
app.use(requireCsrfHeader)
// Forked rather than required so a migration's `process.exit()` cannot take the
// API process down with it.
const forkMigration = (label, migrationPath) =>
  new Promise((resolve) => {
    const migration = fork(migrationPath, [], { silent: true })

    migration.stdout?.on('data', (chunk) => process.stdout.write(chunk))
    migration.stderr?.on('data', (chunk) => process.stderr.write(chunk))

    migration.on('error', (err) => {
      console.error(`${label} migration failed:`, err.message)
      resolve(false)
    })

    migration.on('exit', (code) => {
      if (code !== 0) {
        console.error(`${label} migration exited with code ${code}`)
      }
      resolve(code === 0)
    })
  })

// SEQUENTIAL, not parallel: migrate-sessions backfills a session row for every
// session_id already in user_tokens, so user_tokens has to exist first. Running
// these concurrently would race on a cold database and leave the backfill empty.
const runBootMigrations = async () => {
  try {
    await db.query('SELECT 1')
    await forkMigration('user_tokens', userTokensMigrationPath)
    await forkMigration('user_sessions', sessionsMigrationPath)
  } catch (err) {
    console.error('Boot migrations failed:', err.message)
  }
}

// â”€â”€â”€ Static file serving (uploads) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

// â”€â”€â”€ Health check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Varadhi Backend is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  })
})

// â”€â”€â”€ API Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Cookie transport diagnostics. 404s unless ENABLE_DIAGNOSTICS=true; remove the
// env var once production login is confirmed working.
app.use('/api/diag',          require('./routes/diagnostics.routes'))
// Migrated modules. Each one declares its own base paths in
// modules/<name>/index.js, so a module owns its routing rather than server.js
// knowing the layout of every domain. When a module is later extracted to its
// own service, that same `mount` array becomes the service's route table and
// the gateway rewrite rules derive from it.
//
// As each remaining domain moves out of routes/ + controllers/, delete its
// legacy app.use line above and add the module to this list.
const MODULES = [
  require('./modules/identity'),
  require('./modules/notify'),
  require('./modules/workforce'),
  require('./modules/files'),
  require('./modules/defects'),
  require('./modules/work'),
  // insights owns no tables — it reads through work.analytics and identity, so
  // it is mounted last, after everything it depends on.
  require('./modules/insights'),
  require('./modules/integrations'),
]

for (const mod of MODULES) {
  for (const { path, router } of mod.mount || []) app.use(path, router)
}

// â”€â”€â”€ Error Handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const { errorHandler, notFound } = require('./middleware/error.middleware')
app.use(notFound)
app.use(errorHandler)

// â”€â”€â”€ Start Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PORT = process.env.PORT || 5000
const bootStartedAt = Date.now()

app.listen(PORT, () => {
  const env = process.env.NODE_ENV || 'development'

  // Startup banner mirroring the Next.js dev server's shape, so both terminals
  // read the same way: a titled first line, indented `- key: value` facts, then
  // a `âœ“ Ready in Xms` line once everything is wired.
  console.log('')
  console.log(paint(36, paint(1, 'â—† Varadhi Backend')))
  console.log(`   - Local:    http://localhost:${PORT}`)
  console.log(`   - Health:   http://localhost:${PORT}/health`)
  console.log(`   - Env:      ${env}`)
  runBootMigrations()

  // Each start*Cron/fanout announces itself with its own `[name] scheduled ...`
  // line â€” seven near-identical lines of boot noise. They are collapsed into a
  // single count in the banner below, but only the registration lines: this
  // filter is active for the duration of the calls in this callback and only
  // swallows the "scheduled"/"subscribed" confirmations. Anything unexpected
  // still prints, and console.warn/console.error are never touched, so cron
  // failures and later sweep output stay fully visible.
  const bootLog = console.log
  const registered = []
  console.log = (...args) => {
    const line = typeof args[0] === 'string' ? args[0] : ''
    const match = /^\[([\w-]+)\] (?:.*\b)?(?:scheduled|subscribed)\b/.exec(line)
    if (match) {
      registered.push(match[1])
      return
    }
    bootLog(...args)
  }

  try {
    if (process.env.ENABLE_CRON !== 'false') {
    startReminderCron();
    // Module 8: Bugs Finder SLA sweep â€” flags at-risk and breached defects
    // against the server clock every 5 minutes.
    // Jobs owned by a migrated module. The module says what its jobs are; the
    // platform still decides whether to run them, so ENABLE_CRON keeps working
    // as one switch and a job travels with its module when it is extracted.
    for (const mod of MODULES) {
      for (const job of mod.jobs || []) job.start();
    }
  }

  // Event subscriptions, deliberately OUTSIDE the ENABLE_CRON switch. These fire
  // on the request path, not on a schedule: turning the sweeps off must not stop
  // a notification reaching Teams, or a deleted task's calendar event being
  // reaped. Each module declares its own; all are idempotent.
  for (const mod of MODULES) {
    if (typeof mod.subscribe === 'function') mod.subscribe();
  }
  } finally {
    // Restored in `finally` so a throwing cron registration cannot leave the
    // process with a patched console.log for the rest of its life.
    console.log = bootLog
  }

  const unique = [...new Set(registered)]
  console.log(
    `   - Jobs:     ${unique.length ? `${unique.length} active` : 'disabled'}` +
    (unique.length ? paint(2, ` (${unique.join(', ')})`) : '')
  )
  console.log(paint(32, '   âœ“ Ready') + paint(2, ` in ${Date.now() - bootStartedAt}ms`))
  console.log('')
})

module.exports = app

