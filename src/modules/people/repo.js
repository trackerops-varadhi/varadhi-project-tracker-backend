// SQL for the people schema. This module owns employee_profiles,
// employee_exits, candidates and interviews; nothing outside modules/people/
// may query them.
//
// Every query touches people tables only. Names and emails are never joined in
// from identity.users — service.js resolves them through identity.getUserCards().

const pool = require('../../platform/db').forSchema('people')

/* ── Employee profiles ──────────────────────────────────────────────────── */

exports.listProfiles = async () => {
  const { rows } = await pool.query(
    `SELECT * FROM employee_profiles ORDER BY created_at DESC`
  )
  return rows
}

exports.findProfileByUserId = async (userId) => {
  const { rows } = await pool.query(
    `SELECT * FROM employee_profiles WHERE user_id = $1`, [userId]
  )
  return rows[0] || null
}

exports.listProfileUserIds = async () => {
  const { rows } = await pool.query(`SELECT user_id FROM employee_profiles`)
  return rows.map((r) => r.user_id)
}

exports.insertProfile = async ({
  userId, dateOfJoining, designation, shift, product, coreSkills, createdBy,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO employee_profiles
       (user_id, date_of_joining, designation, shift, product, core_skills, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, dateOfJoining, designation, shift, product, coreSkills, createdBy]
  )
  return rows[0]
}

/* ── Exits ──────────────────────────────────────────────────────────────── */

exports.listExits = async () => {
  const { rows } = await pool.query(
    `SELECT * FROM employee_exits ORDER BY resignation_date DESC, created_at DESC`
  )
  return rows
}

// Latest exit per user — the one that decides a person's current status.
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

/* ── Recruitment ────────────────────────────────────────────────────────── */

// A within-module join: candidates and interviews are both people's tables.
const INTERVIEW_SELECT = `
  SELECT i.*, c.full_name AS candidate_name, c.applied_for, c.status AS candidate_status
    FROM interviews i
    JOIN candidates c ON c.id = i.candidate_id`

exports.listInterviews = async () => {
  const { rows } = await pool.query(
    `${INTERVIEW_SELECT} ORDER BY i.interview_date DESC, i.created_at DESC`
  )
  return rows
}

/**
 * The Interview Management form records a candidate and their interview in one
 * step, so both rows go in one transaction — a candidate with no interview, or
 * the reverse, is never left behind by a half-failed save.
 */
exports.insertCandidateWithInterview = async ({
  candidateName, appliedFor, status, interviewDate, outcome,
  notSelectedReason, feedback, candidateExpectations, createdBy,
}) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [candidate] } = await client.query(
      `INSERT INTO candidates (full_name, applied_for, status, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [candidateName, appliedFor, status, createdBy]
    )
    const { rows: [interview] } = await client.query(
      `INSERT INTO interviews
         (candidate_id, interview_date, outcome, not_selected_reason, feedback,
          candidate_expectations, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [candidate.id, interviewDate, outcome, notSelectedReason, feedback,
        candidateExpectations, createdBy]
    )
    await client.query('COMMIT')

    const { rows } = await pool.query(`${INTERVIEW_SELECT} WHERE i.id = $1`, [interview.id])
    return rows[0]
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

exports.countCandidatesByStatus = async () => {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM candidates GROUP BY status`
  )
  return rows
}

exports.countInterviewsOn = async (date) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM interviews WHERE interview_date = $1`, [date]
  )
  return rows[0].n
}
