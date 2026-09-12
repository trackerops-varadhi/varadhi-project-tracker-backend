require('dotenv').config()
// users is owned by identity; after the Phase 2 schema split the default pool's
// search_path (public) can no longer see it.
const pool = require('../platform/db').forSchema('identity')
const bcrypt = require('bcryptjs')

async function seed() {
  try {
    const managerEmail = 'manager@local.test'
    const employeeEmail = 'employee@local.test'

    const managerPass = await bcrypt.hash('Manager123!', 10)
    const employeePass = await bcrypt.hash('Employee123!', 10)

    await pool.query(
      `INSERT INTO users (name,email,password,role,status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, password=EXCLUDED.password, role=EXCLUDED.role, status=EXCLUDED.status`,
      ['Test Manager', managerEmail, managerPass, 'manager', 'active']
    )

    await pool.query(
      `INSERT INTO users (name,email,password,role,status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, password=EXCLUDED.password, role=EXCLUDED.role, status=EXCLUDED.status`,
      ['Test Employee', employeeEmail, employeePass, 'employee', 'active']
    )

    console.log('Seeded test manager and employee.')
    process.exit(0)
  } catch (e) {
    console.error('Seeding error:', e)
    process.exit(1)
  }
}

seed()
