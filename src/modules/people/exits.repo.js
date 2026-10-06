// SQL for employee_exits.

const pool = require('../../platform/db').forSchema('people')

exports.listExits = async () => {
  const { rows } = await pool.query(
    `SELECT * FROM employee_exits ORDER BY resignation_date DESC, created_at DESC`
  )
  return rows
}

exports.findExit = async (id) => {
  const { rows } = await pool.query(`SELECT * FROM employee_exits WHERE id = $1`, [id])
  return rows[0] || null
}

// The latest exit per user (all users when `userIds` is null).
exports.findLatestExits = async (userIds = null) => {
  const params = []
  let where = ''
  if (userIds) {
    params.push(userIds)
    where = `WHERE user_id = ANY($1)`
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (user_id) *
       FROM employee_exits ${where}
      ORDER BY user_id, resignation_date DESC, created_at DESC`,
    params
  )
  return rows
}

exports.insertExit = async ({
  userId, exitType, designation, product, resignationDate, lastWorkingDate,
  reasonCategory, reasonDetail, exitFeedback, tenureMonths, recordedBy,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO employee_exits
       (user_id, exit_type, designation, product, resignation_date, last_working_date,
        reason_category, reason_detail, exit_feedback, tenure_months, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [userId, exitType, designation, product, resignationDate, lastWorkingDate,
      reasonCategory, reasonDetail, exitFeedback, tenureMonths, recordedBy]
  )
  return rows[0]
}

const EDITABLE = new Set([
  'exit_type', 'resignation_date', 'last_working_date', 'reason_category',
  'reason_detail', 'exit_feedback', 'tenure_months',
])

exports.updateExit = async (id, fields) => {
  const cols = Object.keys(fields)
  for (const c of cols) if (!EDITABLE.has(c)) throw new Error(`exits.repo: "${c}" is not editable`)
  if (cols.length === 0) return exports.findExit(id)
  const { rows } = await pool.query(
    `UPDATE employee_exits
        SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, ...Object.values(fields)]
  )
  return rows[0] || null
}

/** Attrition analytics over exits whose last working day falls in [from, to]. */
exports.analytics = async (from, to) => {
  const params = [from, to]
  const range = `last_working_date BETWEEN $1 AND $2`
  const [byReason, byType, byMonth, byProduct, totals] = await Promise.all([
    pool.query(`SELECT reason_category AS key, COUNT(*)::int AS count FROM employee_exits
                 WHERE ${range} GROUP BY 1 ORDER BY 2 DESC`, params),
    pool.query(`SELECT exit_type AS key, COUNT(*)::int AS count FROM employee_exits
                 WHERE ${range} GROUP BY 1 ORDER BY 2 DESC`, params),
    pool.query(`SELECT to_char(last_working_date, 'YYYY-MM') AS key, COUNT(*)::int AS count
                  FROM employee_exits WHERE ${range} GROUP BY 1 ORDER BY 1`, params),
    pool.query(`SELECT COALESCE(product, 'Unassigned') AS key, COUNT(*)::int AS count
                  FROM employee_exits WHERE ${range} GROUP BY 1 ORDER BY 2 DESC`, params),
    pool.query(`SELECT COUNT(*)::int AS exits,
                       ROUND(AVG(tenure_months))::int AS avg_tenure_months
                  FROM employee_exits WHERE ${range}`, params),
  ])
  return {
    byReason: byReason.rows, byType: byType.rows, byMonth: byMonth.rows,
    byProduct: byProduct.rows, totals: totals.rows[0],
  }
}
