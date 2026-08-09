const { Pool, types } = require('pg')

// DATE columns (due_date, start_date, end_date, ...) have no time-of-day or
// timezone component, but pg's default parser builds a JS Date from them
// using this process's local timezone, which silently shifts the calendar
// day once serialized to UTC ISO and re-localized in the browser. Returning
// the raw 'YYYY-MM-DD' string (OID 1082 = date) instead avoids that entirely
// — the frontend formatter treats a bare date string as a local calendar day.
types.setTypeParser(1082, (val) => val)

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
})

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err.message)
  } else {
    console.log('✅ Database connected successfully')
    release()
  }
})

module.exports = pool
