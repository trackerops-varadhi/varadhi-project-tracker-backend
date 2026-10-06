// SQL for candidates, interviews and candidate_resumes. Joins between these
// three are within-module and therefore fine; nothing here reads another
// module's tables.

const pool = require('../../platform/db').forSchema('people')

/* ── candidates ───────────────────────────────────────────────────────── */

const CANDIDATE_WRITABLE = new Set([
  'full_name', 'applied_for', 'status', 'email', 'phone', 'source', 'product',
  'current_company', 'total_experience_months', 'notice_period_days', 'expected_shift',
  'notes', 'converted_user_id', 'created_by',
])

const assertCandidateCols = (fields) => {
  for (const c of Object.keys(fields)) {
    if (!CANDIDATE_WRITABLE.has(c)) throw new Error(`recruitment.repo: "${c}" is not writable`)
  }
}

// Latest interview and resume count ride along so the pipeline board needs
// one request, not one per card.
const CANDIDATE_SELECT = `
  SELECT c.*,
         (SELECT COUNT(*)::int FROM candidate_resumes r WHERE r.candidate_id = c.id) AS resume_count,
         li.interview_date AS last_interview_date,
         li.outcome        AS last_interview_outcome,
         li.status         AS last_interview_status,
         (SELECT COUNT(*)::int FROM interviews i WHERE i.candidate_id = c.id)       AS interview_count
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT interview_date, outcome, status FROM interviews i
       WHERE i.candidate_id = c.id
       ORDER BY interview_date DESC, created_at DESC LIMIT 1
    ) li ON true`

exports.listCandidates = async ({ status = null, search = null, limit = 100, offset = 0 }) => {
  const params = []
  const where = []
  if (status) { params.push(status); where.push(`c.status = $${params.length}`) }
  if (search) {
    params.push(`%${search}%`)
    where.push(`(c.full_name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.applied_for ILIKE $${params.length})`)
  }
  params.push(limit, offset)
  const { rows } = await pool.query(
    `SELECT *, COUNT(*) OVER()::int AS total_count FROM (${CANDIDATE_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}) x
      ORDER BY updated_at DESC, id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return { rows, total: rows[0]?.total_count ?? 0 }
}

exports.findCandidate = async (id) => {
  const { rows } = await pool.query(`${CANDIDATE_SELECT} WHERE c.id = $1`, [id])
  return rows[0] || null
}

exports.insertCandidate = async (fields, client = pool) => {
  assertCandidateCols(fields)
  const cols = Object.keys(fields)
  const { rows } = await client.query(
    `INSERT INTO candidates (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(fields)
  )
  return rows[0]
}

exports.updateCandidate = async (id, fields, client = pool) => {
  assertCandidateCols(fields)
  const cols = Object.keys(fields)
  if (!cols.length) return true
  const { rowCount } = await client.query(
    `UPDATE candidates SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = NOW()
      WHERE id = $1`,
    [id, ...Object.values(fields)]
  )
  return rowCount > 0
}

exports.deleteCandidate = async (id) => {
  const { rows } = await pool.query(
    `DELETE FROM candidates WHERE id = $1 RETURNING id`, [id]
  )
  return rows[0] || null
}

exports.countCandidatesByStatus = async () => {
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM candidates GROUP BY status`
  )
  return rows
}

/* ── interviews ───────────────────────────────────────────────────────── */

const INTERVIEW_SELECT = `
  SELECT i.*, c.full_name AS candidate_name, c.applied_for, c.status AS candidate_status
    FROM interviews i
    JOIN candidates c ON c.id = i.candidate_id`

exports.listInterviews = async ({
  candidateId = null, interviewerId = null, status = null, from = null, to = null,
} = {}) => {
  const params = []
  const where = []
  if (candidateId) { params.push(candidateId); where.push(`i.candidate_id = $${params.length}`) }
  if (interviewerId) { params.push(interviewerId); where.push(`i.interviewer_id = $${params.length}`) }
  if (status) { params.push(status); where.push(`i.status = $${params.length}`) }
  if (from) { params.push(from); where.push(`i.interview_date >= $${params.length}`) }
  if (to) { params.push(to); where.push(`i.interview_date <= $${params.length}`) }
  const { rows } = await pool.query(
    `${INTERVIEW_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY i.interview_date DESC, i.start_time DESC NULLS LAST, i.created_at DESC`,
    params
  )
  return rows
}

exports.findInterview = async (id) => {
  const { rows } = await pool.query(`${INTERVIEW_SELECT} WHERE i.id = $1`, [id])
  return rows[0] || null
}

exports.nextRoundNumber = async (candidateId, client = pool) => {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(round_number), 0)::int + 1 AS n FROM interviews WHERE candidate_id = $1`,
    [candidateId]
  )
  return rows[0].n
}

const INTERVIEW_WRITABLE = new Set([
  'candidate_id', 'round_number', 'interview_date', 'start_time', 'interview_type',
  'interviewer_id', 'status', 'outcome', 'rating', 'not_selected_reason', 'feedback',
  'candidate_expectations', 'created_by',
])

exports.insertInterview = async (fields, client = pool) => {
  for (const c of Object.keys(fields)) {
    if (!INTERVIEW_WRITABLE.has(c)) throw new Error(`recruitment.repo: "${c}" is not writable`)
  }
  const cols = Object.keys(fields)
  const { rows } = await client.query(
    `INSERT INTO interviews (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(fields)
  )
  return rows[0]
}

exports.updateInterview = async (id, fields, client = pool) => {
  for (const c of Object.keys(fields)) {
    if (!INTERVIEW_WRITABLE.has(c)) throw new Error(`recruitment.repo: "${c}" is not writable`)
  }
  const cols = Object.keys(fields)
  const { rowCount } = await client.query(
    `UPDATE interviews SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = NOW()
      WHERE id = $1`,
    [id, ...Object.values(fields)]
  )
  return rowCount > 0
}

exports.countInterviewsOn = async (date) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM interviews WHERE interview_date = $1 AND status <> 'cancelled'`,
    [date]
  )
  return rows[0].n
}

/** Scheduled rounds whose date has passed with no outcome recorded. */
exports.findFeedbackPending = async (today) => {
  const { rows } = await pool.query(
    `${INTERVIEW_SELECT}
      WHERE i.status = 'scheduled' AND i.interview_date < $1 AND i.interviewer_id IS NOT NULL`,
    [today]
  )
  return rows
}

exports.listExpectations = async () => {
  const { rows } = await pool.query(
    `${INTERVIEW_SELECT}
      WHERE i.candidate_expectations IS NOT NULL AND btrim(i.candidate_expectations) <> ''
      ORDER BY i.interview_date DESC`
  )
  return rows
}

/* ── resumes ──────────────────────────────────────────────────────────── */

exports.listResumes = async (candidateId) => {
  const { rows } = await pool.query(
    `SELECT * FROM candidate_resumes WHERE candidate_id = $1 ORDER BY created_at DESC`,
    [candidateId]
  )
  return rows
}

exports.findResume = async (candidateId, resumeId) => {
  const { rows } = await pool.query(
    `SELECT * FROM candidate_resumes WHERE id = $1 AND candidate_id = $2`,
    [resumeId, candidateId]
  )
  return rows[0] || null
}

exports.insertResume = async ({ candidateId, fileName, fileType, fileSize, storagePath, uploadedBy }) => {
  const { rows } = await pool.query(
    `INSERT INTO candidate_resumes (candidate_id, file_name, file_type, file_size, storage_path, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [candidateId, fileName, fileType, fileSize, storagePath, uploadedBy]
  )
  return rows[0]
}

exports.deleteResume = async (candidateId, resumeId) => {
  const { rows } = await pool.query(
    `DELETE FROM candidate_resumes WHERE id = $1 AND candidate_id = $2 RETURNING storage_path`,
    [resumeId, candidateId]
  )
  return rows[0] || null
}

exports.listResumePaths = async (candidateId) => {
  const { rows } = await pool.query(
    `SELECT storage_path FROM candidate_resumes WHERE candidate_id = $1`, [candidateId]
  )
  return rows.map((r) => r.storage_path)
}

/** All resumes across candidates — the Resume Folder view. */
exports.listAllResumes = async () => {
  const { rows } = await pool.query(
    `SELECT r.*, c.full_name AS candidate_name, c.applied_for, c.status AS candidate_status
       FROM candidate_resumes r JOIN candidates c ON c.id = r.candidate_id
      ORDER BY r.created_at DESC`
  )
  return rows
}

exports.withTransaction = async (fn) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
