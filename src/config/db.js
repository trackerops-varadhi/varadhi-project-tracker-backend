const { Pool, types } = require('pg')

// DATE columns (due_date, start_date, end_date, ...) have no time-of-day or
// timezone component, but pg's default parser builds a JS Date from them
// using this process's local timezone, which silently shifts the calendar
// day once serialized to UTC ISO and re-localized in the browser. Returning
// the raw 'YYYY-MM-DD' string (OID 1082 = date) instead avoids that entirely
// — the frontend formatter treats a bare date string as a local calendar day.
types.setTypeParser(1082, (val) => val)

// NUMERIC/DECIMAL columns (leave_requests.days, time_logs.hours, ...) are
// returned by pg as strings to preserve arbitrary precision — 3 comes back as
// "3.0", which renders as "3.0 Days" in the UI and breaks any arithmetic the
// frontend does on the value. These columns hold small quantities well inside
// IEEE-754 exact range (days in 0.5 steps, hours in 0.25 steps), so a JS
// number is a faithful representation. OID 1700 = numeric.
types.setTypeParser(1700, (val) => (val === null ? null : Number(val)))

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  console.error('❌ DATABASE_URL is not set. Add it to varadhi-project-tracker-backend/.env')
}

if (connectionString?.includes('username:password') || connectionString?.includes('your_password')) {
  console.error('❌ DATABASE_URL contains placeholder values. Replace them with your actual PostgreSQL credentials.')
}

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
})

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err)
    if (err.stack) {
      console.error(err.stack)
    }
  } else {
    console.log('✅ Database connected successfully')
    release()
  }
})

module.exports = pool
