// Indexes for the Module 6/7 leave + time tables (release/v2.0-test).
//
// Both tables shipped without a single index, so every query in
// leaveManagement.controller.js and timeManagement.controller.js is a
// sequential scan. The two hot paths are:
//   - getTimeLogs / getLeaveRequests: filter by user_id, order by date DESC
//   - checkOut: filter by (user_id, date) on EVERY check-out
//
// Safe to run repeatedly: every statement is IF NOT EXISTS, and the whole
// thing is wrapped in a transaction like migrate.js.
require('dotenv').config()
const pool = require('./db')

async function run() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Serves getTimeLogs' employee scoping + its ORDER BY date DESC, and
    // checkOut's (user_id, date) lookup.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_time_logs_user_date
        ON time_logs (user_id, date DESC)
    `)
    // Serves the ?projectId= filter on getTimeLogs.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_time_logs_project
        ON time_logs (project_id)
    `)
    // Serves getLeaveRequests' employee scoping + ORDER BY start_date DESC.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leave_requests_user_start
        ON leave_requests (user_id, start_date DESC)
    `)
    // Serves the ?status= filter, and the pending-approvals view which is
    // the most common manager query.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_leave_requests_status
        ON leave_requests (status)
    `)

    await client.query('COMMIT')
    console.log('✅ Leave/time indexes created successfully!')
    process.exit(0)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('❌ Index migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
  }
}

run()
