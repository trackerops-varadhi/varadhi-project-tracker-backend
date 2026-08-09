require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const { startReminderCron } = require('./utils/reminder-cron');
const { startSnoozeCron } = require('./utils/snooze-cron');
const { startPushRetryCron } = require('./utils/push-retry');
const { startCalendarCron } = require('./utils/calendar-cron');
const { startTeamsCron } = require('./utils/teams-cron');
const { startTeamsFanout } = require('./utils/teams-fanout');
const notificationRoutes = require('./routes/notifications.routes');
// const path = require('path')

const app = express()

// ─── Security & Middleware ─────────────────────────────────────────────────────
app.use(helmet())
// CORS allow-list. The service worker's inline notification actions POST from
// the frontend origin exactly as the page does, so they are covered by the
// same entries — no SW-specific origin is needed.
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

app.use(cors({
  origin: process.env.NODE_ENV === 'development'
    ? true
    : function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true)
        } else {
          callback(new Error('Not allowed by CORS'))
        }
      },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// ─── Static file serving (uploads) ────────────────────────────────────────────
// app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Varadhi Backend is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  })
})

// ─── API Routes ────────────────────────────────────────────────────────────────
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

// ─── Error Handlers ────────────────────────────────────────────────────────────
const { errorHandler, notFound } = require('./middleware/error.middleware')
app.use(notFound)
app.use(errorHandler)

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000
app.listen(PORT, () => {
  console.log(`\n🚀 Varadhi Backend running on port ${PORT}`)
    if (process.env.ENABLE_CRON !== 'false') {
    startReminderCron();
    // Module 2 snooze re-delivery. Separate schedule (5-minutely vs hourly)
    // and separate file, but the same on/off switch — ENABLE_CRON=false must
    // stop every background sweep, not just the reminder one.
    startSnoozeCron();
    // Retries transient push delivery failures (AC-10). Same on/off switch;
    // strictly downstream of routing, so it cannot re-notify anyone.
    startPushRetryCron();
    // Module 4: 5-minutely calendar sync, meeting the PRD's ≤5 min latency
    // KPI by polling rather than provider push channels (which would need a
    // publicly reachable callback URL).
    startCalendarCron();
    // Module 5: Teams delivery retries + daily/weekly digests.
    startTeamsCron();
  }

  // Module 5 fan-out subscribes to the notification engine's EventEmitter, so
  // Teams delivery happens on dispatch rather than on a schedule. It is NOT
  // gated by ENABLE_CRON: that switch turns off background *sweeps*, whereas
  // this is part of the request-time notification path — an instance with
  // crons disabled must still post events to configured channels.
  startTeamsFanout();
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`)
  console.log(`🔗 Health check: http://localhost:${PORT}/health\n`)
  
})

module.exports = app
