require('dotenv').config()
const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const helmet = require('helmet')
const morgan = require('morgan')
const { requireCsrfHeader } = require('./middleware/csrf.middleware')
const { requestId } = require('./middleware/request-id.middleware')
const { logger, install: installLogger } = require('./platform/logger')
const metrics = require('./platform/metrics')
const errorTracking = require('./platform/error-tracking')
const leader = require('./platform/leader')
const rateLimitStore = require('./middleware/rate-limit-store')
// const path = require('path')

// Before anything can log. In pretty mode this is a no-op and the terminal
// looks exactly as it did; in json mode it routes the existing 257 console.*
// call sites through the structured logger with correlation ids attached.
installLogger()
errorTracking.installProcessHandlers()

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
// FIRST middleware that matters: everything logged after this carries a
// correlation id, and the response echoes it back so a user can quote the id
// off a failed request and it can be found in the logs.
app.use(requestId)

morgan.token('clean-url', (req) => req.originalUrl || req.url)
morgan.token('req-id', (req) => req.id || '-')

app.use(morgan((tokens, req, res) => {
  // Status is undefined when the client aborts before a response is written.
  const status = Number(tokens.status(req, res))
  const time = tokens['response-time'](req, res)

  // In json mode the request line is a structured event, not a formatted
  // string — returning null tells morgan to emit nothing and lets the logger
  // own the output.
  if (logger.settings().format === 'json') {
    logger.info('http_request', {
      method: tokens.method(req, res),
      url: tokens['clean-url'](req, res),
      status: Number.isNaN(status) ? null : status,
      durationMs: time == null ? null : Math.round(Number(time)),
    })
    return null
  }

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

// ─── Migrations are NOT run from here ────────────────────────────────────────
//
// This process used to fork migrate-user-tokens.js and migrate-sessions.js on
// every boot. That was the second of two migration systems, and the weaker one:
// it applied DDL outside any version ledger, re-ran on every restart, reported
// failures only to the log, and — with N instances — raced itself.
//
// node-pg-migrate is now the single authority (migrations/<module>/, one ledger
// per schema, see migrations/README.md). Schema changes are a deliberate step,
// never a side effect of starting the API:
//
//   local / CI        npm run migrate
//   docker compose    the one-shot `migrate` service, which both backends wait
//                     on via service_completed_successfully
//   production        still pre-split: apply migrate-schema-split.js, then
//                     `npm run migrate:baseline`, before `npm run migrate` can
//                     mean anything there. Deliberately manual — migrate-runner
//                     refuses the production project ref outright.
//
// A database that has not been migrated now fails loudly at /health/ready
// (0-of-7 schemas) instead of being silently patched at boot.

// â”€â”€â”€ Static file serving (uploads) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

// â”€â”€â”€ Health check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// LIVENESS. Answers "is this process up?" and deliberately touches nothing —
// a restart is the remedy for a failure here, so it must not fail for a reason
// a restart cannot fix (a database outage restarts every instance in a loop).
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Varadhi Backend is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  })
})

// READINESS. Answers "should this instance receive traffic?" — database round
// trip, module schemas present, every module pool serving on its own
// search_path. 200 ready / 503 not ready. See platform/readiness.js.
app.get('/health/ready', require('./platform/readiness').handler)

// Prometheus exposition. 404s unless METRICS_ENABLED=true, so operational shape
// is never exposed by default. Recording happens regardless — the numbers cost
// a Map increment and are worth already having the moment someone enables it.
app.get('/metrics', metrics.handler)

// Counts and times every request by ROUTE PATTERN, not URL — a metric labelled
// with task ids is how a metrics backend falls over.
app.use(metrics.httpMiddleware)

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
  require('./modules/people'),
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
// Reports and re-throws. It deliberately does not shape the response —
// errorHandler already owns that, and two handlers disagreeing about the
// envelope is worse than either.
app.use(errorTracking.middleware)
app.use(errorHandler)

// â”€â”€â”€ Service role â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * ONE CODEBASE, THREE WAYS TO RUN IT
 *
 *   all   (default)  serve HTTP and run the scheduled sweeps — today's behaviour
 *   web              serve HTTP only; never runs a sweep
 *   cron             run the sweeps only; never binds a port
 *
 * WHY
 * The nine sweeps share a process with every request. A sweep that stalls on a
 * slow query holds the event loop a request needed; a sweep that throws on boot
 * takes the API down with it; and the web tier cannot be scaled without either
 * multiplying the sweeps or relying on the advisory lock to suppress N-1 of
 * them. Splitting the roles makes "the API is busy" and "a sweep is slow" two
 * separate problems with two separate restart buttons — and it is the first
 * real process boundary in this backend, so it is also the cheapest rehearsal
 * for extracting a module later.
 *
 * `all` REMAINS THE DEFAULT, DELIBERATELY. A deployment that sets nothing
 * behaves exactly as it does today. If `cron` were implied by anything, the
 * failure mode would be an environment where ENABLE_CRON is true, no worker
 * exists, and no sweep runs anywhere — silently. Both halves have to be asked
 * for by name.
 *
 * ENABLE_CRON is unchanged and still wins first: it is the operator's kill
 * switch, and `cron` + ENABLE_CRON=false is a worker deliberately paused.
 */
const ROLES = ['all', 'web', 'cron']
const SERVICE_ROLE = String(process.env.SERVICE_ROLE || 'all').trim().toLowerCase()

if (!ROLES.includes(SERVICE_ROLE)) {
  console.error(`\nUNKNOWN SERVICE_ROLE "${SERVICE_ROLE}".\n  Expected one of: ${ROLES.join(' | ')}\n`)
  process.exit(1)
}

const SERVES_HTTP = SERVICE_ROLE !== 'cron'
const RUNS_JOBS = SERVICE_ROLE !== 'web'

// â”€â”€â”€ Start Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PORT = process.env.PORT || 5000
const bootStartedAt = Date.now()

const boot = async () => {
  const env = process.env.NODE_ENV || 'development'

  // Startup banner mirroring the Next.js dev server's shape, so both terminals
  // read the same way: a titled first line, indented `- key: value` facts, then
  // a `âœ“ Ready in Xms` line once everything is wired.
  console.log('')
  console.log(paint(36, paint(1, `â—† Varadhi Backend${SERVICE_ROLE === 'all' ? '' : ` (${SERVICE_ROLE})`}`)))
  if (SERVES_HTTP) {
    console.log(`   - Local:    http://localhost:${PORT}`)
    console.log(`   - Health:   http://localhost:${PORT}/health`)
  } else {
    // Said plainly, because a worker with no URL looks broken otherwise.
    console.log(`   - Role:     ${paint(2, 'cron worker — no port, no routes served')}`)
  }
  console.log(`   - Env:      ${env}`)

  // Each start*Cron/fanout announces itself with its own `[name] scheduled ...`
  // line â€” seven near-identical lines of boot noise. They are collapsed into a
  // single count in the banner below, but only the registration lines: this
  // filter is active for the duration of the calls in this callback and only
  // swallows the "scheduled"/"subscribed" confirmations. Anything unexpected
  // still prints, and console.warn/console.error are never touched, so cron
  // failures and later sweep output stay fully visible.
  // Rate-limit store: verified BEFORE traffic, so "the shared table was never
  // migrated" is a refusal to boot rather than a 500 on somebody's login. It
  // also refuses memory-store-plus-MULTI_INSTANCE outright, which is the
  // misconfiguration that silently multiplies every quota by the instance count.
  // Only where there is traffic to limit. A cron worker serves no requests, so
  // an unusable rate-limit store is not a reason to stop its sweeps.
  if (SERVES_HTTP) {
    try {
      await rateLimitStore.verify()
    } catch (err) {
      console.error(`
RATE LIMIT STORE UNUSABLE
  ${err.message}
`)
      process.exit(1)
    }
  }

  // Leadership, only where cron could run at all — no point holding a
  // connection open to win a race nobody is running.
  let cronLeader = false
  if (RUNS_JOBS && process.env.ENABLE_CRON !== 'false') {
    cronLeader = await leader.acquire()
    if (cronLeader) leader.installExitHandlers()
  }

  const bootLog = console.log
  // Scheduled jobs and event subscriptions are counted apart, because they are
  // different things that this banner used to add together: a cron worker with
  // ENABLE_CRON=false reported "Jobs: 5 active" directly above "Cron: disabled",
  // which is two lines contradicting each other. Sweeps run on a clock;
  // subscriptions fire on the request path and are never gated by ENABLE_CRON.
  const registered = { scheduled: [], subscribed: [] }
  console.log = (...args) => {
    const line = typeof args[0] === 'string' ? args[0] : ''
    const match = /^\[([\w-]+)\] (?:.*\b)?(scheduled|subscribed)\b/.exec(line)
    if (match) {
      registered[match[2]].push(match[1])
      return
    }
    bootLog(...args)
  }

  try {
    // TWO gates, in this order.
    //
    // ENABLE_CRON is the operator's switch and still wins first — nothing below
    // can start a sweep while it is false.
    //
    // Leadership is the second gate, and it is what makes a second instance
    // safe. Every sweep here used to start unconditionally, so N instances ran
    // each sweep N times: N reminder emails for one overdue task, N SLA
    // escalations, N snooze wake-ups racing on the same rows. `cronLeader` is
    // false unless this process holds the advisory lock, and it fails closed —
    // any uncertainty (lock held elsewhere, connection refused, query error)
    // means no cron here.
    //
    // RUNS_JOBS is the third gate and the outermost one: with the roles split,
    // the web tier must not start a sweep even when ENABLE_CRON is true, or the
    // web dyno could win the advisory lock and leave the cron worker idle —
    // which would defeat the whole point of having one.
    if (RUNS_JOBS && process.env.ENABLE_CRON !== 'false' && cronLeader) {
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

  const jobs = [...new Set(registered.scheduled)]
  const subs = [...new Set(registered.subscribed)]
  console.log(
    `   - Jobs:     ${jobs.length ? `${jobs.length} scheduled` : 'none'}` +
    (jobs.length ? paint(2, ` (${jobs.join(', ')})`) : '')
  )
  console.log(
    `   - Events:   ${subs.length ? `${subs.length} subscribed` : 'none'}` +
    (subs.length ? paint(2, ` (${subs.join(', ')})`) : '')
  )
  // Say plainly whether this instance is the one running sweeps. With more than
  // one instance, "why did the reminder not send?" is answered by this line.
  if (!RUNS_JOBS) {
    console.log(`   - Cron:     ${paint(2, 'not this role (SERVICE_ROLE=web)')}`)
  } else if (process.env.ENABLE_CRON === 'false') {
    console.log(`   - Cron:     ${paint(2, 'disabled (ENABLE_CRON=false)')}`)
  } else {
    console.log(`   - Cron:     ${cronLeader
      ? paint(32, 'leader') + paint(2, ` (advisory lock ${leader.CRON_LOCK_ID})`)
      : paint(33, 'standby') + paint(2, ` (${leader.status().reason || 'not leader'})`)}`)
  }
  // Rate limits apply to traffic, and a cron worker has none.
  if (SERVES_HTTP) {
    console.log(`   - Limits:   ${paint(2, `${rateLimitStore.configured()} store`
      + (rateLimitStore.isMultiInstance() ? ', multi-instance' : ''))}`)
  }
  console.log(paint(32, '   âœ“ Ready') + paint(2, ` in ${Date.now() - bootStartedAt}ms`))
  console.log('')

  if (!SERVES_HTTP) keepWorkerAlive(cronLeader)
}

/**
 * A cron worker must not exit, and nothing here guarantees it stays up.
 *
 * A web process is held open by its listener. A worker is held open only by its
 * own timers — and there are two ways to have none: ENABLE_CRON=false, or
 * losing the advisory lock, after which leader.acquire() closes the connection
 * it opened. Either way the process would run out of work, exit 0, and Render
 * would restart it, forever, looking like a crash loop while being nothing of
 * the kind.
 *
 * So a standby worker holds itself open and keeps trying for the lock. That
 * also makes a second worker worth running: when the leader is redeployed or
 * killed, Postgres drops its session lock, and whichever standby asks next
 * takes over within one interval instead of sweeps stopping until someone
 * notices.
 */
function keepWorkerAlive(isLeader) {
  if (isLeader) return

  const paused = process.env.ENABLE_CRON === 'false'
  const everyMs = Math.max(10_000, Number(process.env.CRON_LEADER_RETRY_MS) || 60_000)

  if (paused) {
    // Nothing to retry: ENABLE_CRON is read once, at boot, so polling it here
    // would never see a change. One referenced timer holds the process open, so
    // unpausing is a restart rather than a redeploy. Deliberately NOT unref'd —
    // an unref'd timer lets the event loop drain and the process exit, which is
    // the exact behaviour this function exists to prevent.
    console.log(paint(2, '   (paused — holding the worker open; set ENABLE_CRON=true and restart)'))
    setInterval(() => {}, 1 << 30)
    return
  }

  console.log(paint(2, `   (standby — retrying for cron leadership every ${everyMs / 1000}s)`))

  const timer = setInterval(async () => {
    let won = false
    try {
      won = await leader.acquire()
    } catch (err) {
      logger.warn('[leader] retry failed', { error: err.message })
      return
    }
    if (!won) return

    clearInterval(timer)
    leader.installExitHandlers()
    logger.info('[leader] took over cron leadership from a standby worker', { pid: process.pid })

    for (const mod of MODULES) {
      for (const job of mod.jobs || []) job.start()
    }
  }, everyMs)
}

if (SERVES_HTTP) {
  app.listen(PORT, boot)
} else {
  // No port. A Render worker has no inbound traffic and no health check, so
  // binding one would only invite something to connect to it.
  boot().catch((err) => {
    console.error(`\nCRON WORKER FAILED TO START: ${err.message}\n`)
    process.exit(1)
  })
}

module.exports = app

