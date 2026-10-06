/*
 * people — 0003 recruitment
 * ---------------------------------------------------------------------------
 * Phase 2 of docs/Module-9-People-Plan.md (§2.4–2.6): the full candidate
 * record, interview rounds with an interviewer and a lifecycle, and the
 * resume vault.
 *
 * 0001 created candidates and interviews in the shape the first HR screen
 * needed (one quick "interview record" form). This widens them rather than
 * replacing them, so records already entered survive:
 *   - interviews.status is new; rows that already carry an outcome were
 *     completed interviews and are backfilled as such.
 *   - interview_date stays the date column. start_time is optional.
 *
 * candidate_resumes keeps a storage PATH in a private bucket, never a public
 * URL; downloads are short-lived signed URLs (§7.3).
 */

exports.shorthands = undefined

const T = (name) => ({ schema: 'people', name })

exports.up = (pgm) => {
  pgm.addColumns(T('candidates'), {
    email: { type: 'varchar(255)' },
    phone: { type: 'varchar(20)' },
    source: {
      type: 'varchar(30)',
      check: "source IN ('referral','naukri','linkedin','walk_in','campus','other')",
    },
    product: { type: 'varchar(120)' },
    current_company: { type: 'varchar(200)' },
    total_experience_months: { type: 'integer' },
    notice_period_days: { type: 'integer' },
    expected_shift: { type: 'varchar(60)' },
    notes: { type: 'text' },
    // Set when a selected candidate becomes an employee. Bare uuid.
    converted_user_id: { type: 'uuid' },
  })

  pgm.addColumns(T('interviews'), {
    interview_type: {
      type: 'varchar(24)',
      check: "interview_type IN ('telephonic','technical','hr','managerial','final')",
    },
    start_time: { type: 'time' },
    // Bare uuid → identity.users. The interviewer may record the outcome of
    // their own round even without HR access.
    interviewer_id: { type: 'uuid' },
    status: {
      type: 'varchar(20)', notNull: true, default: 'scheduled',
      check: "status IN ('scheduled','completed','no_show','cancelled')",
    },
    rating: { type: 'smallint', check: 'rating BETWEEN 1 AND 5' },
  })
  pgm.sql(`UPDATE people.interviews SET status = 'completed' WHERE outcome IS NOT NULL`)

  pgm.createTable(T('candidate_resumes'), {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    candidate_id: {
      type: 'uuid', notNull: true,
      references: T('candidates'), onDelete: 'CASCADE',
    },
    file_name: { type: 'varchar(255)', notNull: true },
    file_type: { type: 'varchar(20)' },
    file_size: { type: 'bigint' },
    storage_path: { type: 'varchar(500)', notNull: true },
    uploaded_by: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  })

  pgm.createIndex(T('candidates'), 'email', { name: 'idx_candidates_email' })
  pgm.createIndex(T('interviews'), 'interviewer_id', { name: 'idx_interviews_interviewer' })
  pgm.createIndex(T('interviews'), 'status', { name: 'idx_interviews_status' })
  pgm.createIndex(T('candidate_resumes'), 'candidate_id', { name: 'idx_candidate_resumes_candidate' })
}

exports.down = (pgm) => {
  pgm.dropTable(T('candidate_resumes'))
  pgm.dropIndex(T('interviews'), 'status', { name: 'idx_interviews_status' })
  pgm.dropIndex(T('interviews'), 'interviewer_id', { name: 'idx_interviews_interviewer' })
  pgm.dropIndex(T('candidates'), 'email', { name: 'idx_candidates_email' })
  pgm.dropColumns(T('interviews'), ['interview_type', 'start_time', 'interviewer_id', 'status', 'rating'])
  pgm.dropColumns(T('candidates'), [
    'email', 'phone', 'source', 'product', 'current_company', 'total_experience_months',
    'notice_period_days', 'expected_shift', 'notes', 'converted_user_id',
  ])
}
