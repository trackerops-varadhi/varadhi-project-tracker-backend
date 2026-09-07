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
const { startSnoozeCron } = require('./utils/snooze-cron');
const { startPushRetryCron } = require('./utils/push-retry');
const { startCalendarCron } = require('./utils/calendar-cron');
const { startTeamsCron } = require('./utils/teams-cron');
const { startTeamsFanout } = require('./utils/teams-fanout');
const { startBugSlaCron } = require('./utils/bug-sla-cron');
const { startSessionCleanupCron } = require('./utils/session-cleanup-cron');
const notificationRoutes = require('./routes/notifications.routes');
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
  // Both deployment targets are listed: CLAUDE.md documents Vercel while the
  // service has also been served from Render. Keeping both avoids a silent
  // CORS failure whenever FRONTEND_URL and the live origin disagree.
  'https://varadhi-tracker.vercel.app',
  'https://varadhi-project-tracker-frontend.onrender.com',
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
app.use('/api/auth',          require('./routes/auth.routes'))
app.use('/api/users',         require('./routes/users.routes'))
app.use('/api/projects',      require('./routes/projects.routes'))
app.use('/api/tasks',         require('./routes/tasks.routes'))
app.use('/api/dashboard',     require('./routes/dashboard.routes'))
app.use('/api/documents',     require('./routes/documents.routes'))
app.use('/api/reports',       require('./routes/reports.routes'))
app.use('/api/notifications', require('./routes/notifications.routes'))
app.use('/api/notification-actions', require('./routes/notification-actions.routes'))
app.use('/api/folders',       require('./routes/folders.routes'))
app.use('/api/calendar',      require('./routes/calendar.routes'))
app.use('/api/teams',         require('./routes/teams.routes'))
app.use('/api/leave-management', require('./routes/leave-management.routes'))
app.use('/api/time-management', require('./routes/time-management.routes'))
// Module 8: Bugs Finder
app.use('/api/bugs',          require('./routes/bugs.routes'))

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
    // Module 2 snooze re-delivery. Separate schedule (5-minutely vs hourly)
    // and separate file, but the same on/off switch â€” ENABLE_CRON=false must
    // stop every background sweep, not just the reminder one.
    startSnoozeCron();
    // Retries transient push delivery failures (AC-10). Same on/off switch;
    // strictly downstream of routing, so it cannot re-notify anyone.
    startPushRetryCron();
    // Module 4: 5-minutely calendar sync, meeting the PRD's â‰¤5 min latency
    // KPI by polling rather than provider push channels (which would need a
    // publicly reachable callback URL).
    startCalendarCron();
    // Module 5: Teams delivery retries + daily/weekly digests.
    startTeamsCron();
    // Module 8: Bugs Finder SLA sweep â€” flags at-risk and breached defects
    // against the server clock every 5 minutes.
    startBugSlaCron();
    // Daily prune of dead session and token rows, past their audit retention.
    // Deletes only revoked/expired rows, so it can never sign anyone out.
    startSessionCleanupCron();
  }

  // Module 5 fan-out subscribes to the notification engine's EventEmitter, so
  // Teams delivery happens on dispatch rather than on a schedule. It is NOT
  // gated by ENABLE_CRON: that switch turns off background *sweeps*, whereas
  // this is part of the request-time notification path â€” an instance with
  // crons disabled must still post events to configured channels.
  startTeamsFanout();
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

