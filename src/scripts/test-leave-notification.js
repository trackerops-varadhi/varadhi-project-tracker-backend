require('dotenv').config()
const pool = require('../config/db')

async function run() {
  try {
    // Login as employee
    const loginRes = await fetch('http://localhost:5000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'employee@local.test', password: 'Employee123!' })
    })
    const loginJson = await loginRes.json()
    if (!loginJson.success) {
      console.error('Employee login failed:', loginJson)
      process.exit(1)
    }
    const token = loginJson.data.token

    // Create a leave request
    const leaveRes = await fetch('http://localhost:5000/api/leave-management', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ startDate: '2026-08-10', endDate: '2026-08-12', type: 'annual', reason: 'Testing notifications' })
    })
    const leaveJson = await leaveRes.json()
    console.log('Leave creation response:', leaveJson.message || JSON.stringify(leaveJson))

    // Find manager user id
    const mgrRes = await pool.query('SELECT id FROM users WHERE email = $1', ['manager@local.test'])
    const mgrId = mgrRes.rows[0]?.id
    if (!mgrId) {
      console.error('Manager user not found in DB.')
      process.exit(1)
    }

    // Query recent notifications for manager
    const notifs = await pool.query('SELECT id,type,title,message,is_read,link_to,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10', [mgrId])
    console.log('Manager notifications (most recent):')
    console.dir(notifs.rows, { depth: null })
    process.exit(0)
  } catch (e) {
    console.error('Test failed:', e)
    process.exit(1)
  }
}

run()
