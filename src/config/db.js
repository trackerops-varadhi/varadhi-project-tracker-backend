const { Pool } = require('pg')

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
    console.log('✅ PostgreSQL connected successfully')
    release()
  }
})

module.exports = pool
