// SQL for daily_work_status (Module 9, Phase 3) and the attendance reads over
// time_logs. This module owns both tables.

const pool = require('../../platform/db').forSchema('workforce')

exports.upsertWorkStatus = async ({ userId, date, summary, blockers, tomorrowPlan }) => {
  const { rows } = await pool.query(
    `INSERT INTO daily_work_status (user_id, date, summary, blockers, tomorrow_plan)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, date)
     DO UPDATE SET summary = EXCLUDED.summary,
                   blockers = EXCLUDED.blockers,
                   tomorrow_plan = EXCLUDED.tomorrow_plan,
                   updated_at = NOW()
     RETURNING *`,
    [userId, date, summary, blockers, tomorrowPlan]
  )
  return rows[0]
}

exports.listOwnWorkStatus = async (userId, limit = 14) => {
  const { rows } = await pool.query(
    `SELECT * FROM daily_work_status WHERE user_id = $1 ORDER BY date DESC LIMIT $2`,
    [userId, limit]
  )
  return rows
}

exports.listWorkStatusOn = async (date) => {
  const { rows } = await pool.query(`SELECT * FROM daily_work_status WHERE date = $1`, [date])
  return rows
}

/** Users who logged time on `date` but have no work status for it. */
exports.findMissingWorkStatus = async (date) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT t.user_id
       FROM time_logs t
      WHERE t.date = $1 AND t.user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM daily_work_status w WHERE w.user_id = t.user_id AND w.date = $1
        )`,
    [date]
  )
  return rows.map((r) => r.user_id)
}

/**
 * Per user and day in [from, to]: whether anything was logged, the strongest
 * explicit attendance status, and first check-in / last check-out.
 */
exports.attendanceRows = async (from, to) => {
  const { rows } = await pool.query(
    `SELECT user_id, date,
            MIN(check_in)  AS first_check_in,
            MAX(check_out) AS last_check_out,
            SUM(hours)::float AS hours,
            -- 'present' outranks 'wfh' outranks 'half_day' when a day has several logs.
            (ARRAY_AGG(attendance_status ORDER BY
               CASE attendance_status WHEN 'present' THEN 1 WHEN 'wfh' THEN 2
                                      WHEN 'half_day' THEN 3 ELSE 4 END)
               FILTER (WHERE attendance_status IS NOT NULL))[1] AS attendance_status
       FROM time_logs
      WHERE date BETWEEN $1 AND $2 AND user_id IS NOT NULL
      GROUP BY user_id, date`,
    [from, to]
  )
  return rows
}
