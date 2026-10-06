// SQL for employee_profiles. Every query touches people tables only; names and
// emails resolve through identity.getUserCards() in the service.

const pool = require('../../platform/db').forSchema('people')

// Columns a service may write. Anything else in `fields` is a programming
// error, not user input — the service builds `fields`, never req.body.
const WRITABLE = new Set([
  'employee_code', 'date_of_joining', 'designation', 'shift', 'product', 'core_skills',
  'gender', 'date_of_birth', 'marital_status', 'guardian_name',
  'temporary_address', 'permanent_address', 'aadhaar_encrypted', 'aadhaar_last4',
  'education_qualification', 'college_name', 'year_of_completion', 'previous_company',
  'total_experience_months', 'reporting_manager_id', 'created_by', 'updated_by',
])

const assertWritable = (fields) => {
  for (const col of Object.keys(fields)) {
    if (!WRITABLE.has(col)) throw new Error(`employees.repo: column "${col}" is not writable`)
  }
}

/*
 * Every profile read goes through this: the profile, its latest exit that
 * happened after the person (re)joined, and the employment status DERIVED from
 * that exit — no exit → active, last working day still ahead → notice_period,
 * passed → exited. Deriving it in SQL (not JS) keeps a status filter and the
 * pagination count on the same rows. $1 is always "today" in the business zone.
 */
const PROFILE_CTE = `
  WITH profile AS (
    SELECT p.*,
           x.id                AS exit_id,
           x.exit_type         AS exit_type,
           x.resignation_date  AS exit_resignation_date,
           x.last_working_date AS exit_last_working_date,
           CASE
             WHEN x.id IS NULL THEN 'active'
             WHEN x.last_working_date >= $1::date THEN 'notice_period'
             ELSE 'exited'
           END AS employment_status
      FROM employee_profiles p
      LEFT JOIN LATERAL (
        SELECT e.id, e.exit_type, e.resignation_date, e.last_working_date
          FROM employee_exits e
         WHERE e.user_id = p.user_id
           AND (p.date_of_joining IS NULL OR e.resignation_date >= p.date_of_joining)
         ORDER BY e.resignation_date DESC, e.created_at DESC
         LIMIT 1
      ) x ON true
  )`

// Client sort keys map onto these, and only these (plan §4.5).
const SORTABLE = {
  joined: 'date_of_joining',
  code: 'employee_code',
  designation: 'designation',
  created: 'created_at',
}

exports.SORT_KEYS = Object.keys(SORTABLE)

exports.listProfiles = async ({
  today, userIds = null, status = null, product = null, managerId = null,
  sort = 'created', order = 'desc', limit = 20, offset = 0,
}) => {
  const params = [today]
  const where = []
  if (userIds) { params.push(userIds); where.push(`user_id = ANY($${params.length})`) }
  if (status) { params.push(status); where.push(`employment_status = $${params.length}`) }
  if (product) { params.push(product); where.push(`product = $${params.length}`) }
  if (managerId) { params.push(managerId); where.push(`reporting_manager_id = $${params.length}`) }

  const column = SORTABLE[sort] || SORTABLE.created
  const direction = order === 'asc' ? 'ASC' : 'DESC'
  params.push(limit, offset)

  const { rows } = await pool.query(
    `${PROFILE_CTE}
     SELECT *, COUNT(*) OVER()::int AS total_count
       FROM profile
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${column} ${direction} NULLS LAST, id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return { rows, total: rows[0]?.total_count ?? 0 }
}

/** Every profile, no paging — dashboard and team directory sizes are small. */
exports.listAllProfiles = async (today) => {
  const { rows } = await pool.query(`${PROFILE_CTE} SELECT * FROM profile`, [today])
  return rows
}

exports.findProfile = async (today, userId) => {
  const { rows } = await pool.query(
    `${PROFILE_CTE} SELECT * FROM profile WHERE user_id = $2`, [today, userId]
  )
  return rows[0] || null
}

exports.findProfilesByUserIds = async (today, userIds) => {
  if (!userIds.length) return []
  const { rows } = await pool.query(
    `${PROFILE_CTE} SELECT * FROM profile WHERE user_id = ANY($2)`, [today, userIds]
  )
  return rows
}

exports.listProfileUserIds = async () => {
  const { rows } = await pool.query(`SELECT user_id FROM employee_profiles`)
  return rows.map((r) => r.user_id)
}

exports.findAadhaarBlob = async (userId) => {
  const { rows } = await pool.query(
    `SELECT aadhaar_encrypted FROM employee_profiles WHERE user_id = $1`, [userId]
  )
  return rows[0] ? rows[0].aadhaar_encrypted : undefined
}

exports.insertProfile = async (userId, fields) => {
  assertWritable(fields)
  const cols = ['user_id', ...Object.keys(fields)]
  const values = [userId, ...Object.values(fields)]
  const { rows } = await pool.query(
    `INSERT INTO employee_profiles (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id`,
    values
  )
  return rows[0]
}

/** Returns false when no profile exists for the user. */
exports.updateProfile = async (userId, fields) => {
  assertWritable(fields)
  const cols = Object.keys(fields)
  if (cols.length === 0) return true
  const sets = cols.map((c, i) => `${c} = $${i + 2}`)
  const { rowCount } = await pool.query(
    `UPDATE employee_profiles SET ${sets.join(', ')}, updated_at = NOW() WHERE user_id = $1`,
    [userId, ...Object.values(fields)]
  )
  return rowCount > 0
}

exports.findByEmployeeCode = async (code) => {
  const { rows } = await pool.query(
    `SELECT user_id FROM employee_profiles WHERE lower(employee_code) = lower($1)`, [code]
  )
  return rows[0] || null
}

exports.distinctProducts = async () => {
  const { rows } = await pool.query(
    `SELECT DISTINCT product FROM employee_profiles WHERE product IS NOT NULL ORDER BY product`
  )
  return rows.map((r) => r.product)
}
