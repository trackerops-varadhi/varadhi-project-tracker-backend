require('dotenv').config()
const pool = require('../config/db')

async function run() {
  const client = await pool.connect()
  try {
    console.log('Adding check_in/check_out columns if missing...')
    await client.query('BEGIN')
    await client.query(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS check_in TIMESTAMP`)
    await client.query(`ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS check_out TIMESTAMP`)
    await client.query('COMMIT')
    console.log('Done.')
    process.exit(0)
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('Failed to add columns:', e)
    process.exit(1)
  } finally {
    client.release()
  }
}

run()
