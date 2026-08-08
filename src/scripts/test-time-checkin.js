require('dotenv').config()
const pool = require('../config/db')

async function run() {
  try {
    // Login
    const loginRes = await fetch('http://localhost:5000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'employee@local.test', password: 'Employee123!' })
    })
    const loginJson = await loginRes.json()
    if (!loginJson.success) {
      console.error('Login failed:', loginJson)
      process.exit(1)
    }
    const token = loginJson.data.token
    console.log('Logged in, token length:', token.length)

    const date = new Date().toISOString().split('T')[0]
    const checkInTime = new Date().toISOString()

    // Check-in
    const inRes = await fetch('http://localhost:5000/api/time-management/check-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ date, checkIn: checkInTime })
    })
    const inJson = await inRes.json()
    console.log('Check-in response:', inJson.message || JSON.stringify(inJson))

    // Wait 1 second and check-out
    await new Promise(r => setTimeout(r, 1000))
    const checkOutTime = new Date().toISOString()
    const outRes = await fetch('http://localhost:5000/api/time-management/check-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ date, checkOut: checkOutTime })
    })
    const outJson = await outRes.json()
    console.log('Check-out response:', outJson.message || JSON.stringify(outJson))

    // Query time logs
    const rows = await pool.query('SELECT * FROM time_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5', [loginJson.data.user.id])
    console.log('Recent time logs:', rows.rows)

    process.exit(0)
  } catch (e) {
    console.error('Test failed:', e)
    process.exit(1)
  }
}

run()
