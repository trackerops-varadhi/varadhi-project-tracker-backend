/*
 * people — 0001 core
 * ---------------------------------------------------------------------------
 * Tables: employee_profiles / employee_exits / candidates / interviews
 *
 * The first HR slice (docs/Module-9-People-Plan.md), cut to what the HR
 * Management screen actually collects today: the Employee Directory, Attrition
 * Management and Interview Management forms. Columns follow the plan's names so
 * the later phases (PII fields, resumes, hr role) add to these tables rather
 * than rename them.
 *
 * NOT A BASELINE
 * Unlike every other module's 0001 this creates new tables, so it must RUN on
 * every database, dev and production alike. `migrate:baseline` skips it — see
 * cmdBaseline in src/config/migrate-runner.js.
 *
 * NO CROSS-MODULE FOREIGN KEYS
 * user_id / created_by / recorded_by are bare uuids pointing at identity.users;
 * names and emails resolve through identity.getUserCards(). The one FK here,
 * interviews → candidates, stays inside the module.
 *
 * Employment status is deliberately NOT a column. It is derived on read from
 * employee_exits (no exit → active, last working day ahead → notice period,
 * passed → exited), so it can never go stale waiting for a sweep to flip it.
 */

exports.shorthands = undefined

const T = (name) => ({ schema: 'people', name })

const timestamps = (pgm) => ({
  created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
})

exports.up = (pgm) => {
  pgm.createTable(T('employee_profiles'), {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // One profile per person. Name and email are NOT copied here — they live in
    // identity.users, and a second copy would drift on the first profile edit.
    user_id: { type: 'uuid', notNull: true, unique: true },
    date_of_joining: { type: 'date' },
    // The job title ("Role" on the sheet), not users.role.
    designation: { type: 'varchar(120)', notNull: true },
    shift: { type: 'varchar(60)' },
    product: { type: 'varchar(120)' },
    // Mirrors work.tasks.tags, the existing array-column precedent.
    core_skills: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    created_by: { type: 'uuid' },
    ...timestamps(pgm),
  })

  pgm.createTable(T('employee_exits'), {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // Not unique: a person can rejoin and leave again.
    user_id: { type: 'uuid', notNull: true },
    exit_type: {
      type: 'varchar(20)', notNull: true, default: 'resignation',
      check: "exit_type IN ('resignation','termination','absconded','contract_end')",
    },
    // Snapshots of the profile at the time of exit, so a later profile edit
    // cannot rewrite an attrition report.
    designation: { type: 'varchar(120)' },
    product: { type: 'varchar(120)' },
    resignation_date: { type: 'date', notNull: true },
    last_working_date: { type: 'date', notNull: true },
    reason_category: {
      type: 'varchar(40)', notNull: true,
      check: "reason_category IN ('better_opportunity','compensation','relocation','higher_studies'," +
        "'personal','health','work_environment','performance','other')",
    },
    reason_detail: { type: 'text' },
    exit_feedback: { type: 'text' },
    // Materialised at record time from date_of_joining, for the same reason bug
    // SLA deadlines are: correcting a DOJ typo later must not change history.
    tenure_months: { type: 'integer' },
    recorded_by: { type: 'uuid' },
    ...timestamps(pgm),
  })
  pgm.addConstraint(T('employee_exits'), 'employee_exits_dates_order',
    'CHECK (last_working_date >= resignation_date)')

  // Candidates are NOT users and never go into identity.users — no login, and
  // they would pollute every user count and @mention resolver.
  pgm.createTable(T('candidates'), {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    full_name: { type: 'varchar(160)', notNull: true },
    applied_for: { type: 'varchar(120)', notNull: true },
    status: {
      type: 'varchar(24)', notNull: true, default: 'applied',
      check: "status IN ('applied','screening','interview_scheduled','interviewed','selected'," +
        "'hold','rejected','offered','joined','declined')",
    },
    created_by: { type: 'uuid' },
    ...timestamps(pgm),
  })

  pgm.createTable(T('interviews'), {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    candidate_id: {
      type: 'uuid', notNull: true,
      references: T('candidates'), onDelete: 'CASCADE',
    },
    round_number: { type: 'smallint', notNull: true, default: 1 },
    // "Interview / Call Date". A date, not a timestamp: the form records the
    // day, and a midnight timestamptz would shift a day across time zones.
    interview_date: { type: 'date', notNull: true },
    outcome: {
      type: 'varchar(20)',
      check: "outcome IN ('selected','hold','rejected','next_round')",
    },
    not_selected_reason: { type: 'text' },
    // "For future reference"
    feedback: { type: 'text' },
    // "Candidates expectations to improve our organisation — Ex: Pay / Shift"
    candidate_expectations: { type: 'text' },
    created_by: { type: 'uuid' },
    ...timestamps(pgm),
  })

  pgm.createIndex(T('employee_profiles'), 'date_of_joining', { name: 'idx_employee_profiles_doj' })
  pgm.createIndex(T('employee_exits'), 'user_id', { name: 'idx_employee_exits_user' })
  pgm.createIndex(T('employee_exits'), [{ name: 'resignation_date', sort: 'DESC' }],
    { name: 'idx_employee_exits_resignation_date' })
  pgm.createIndex(T('employee_exits'), 'reason_category', { name: 'idx_employee_exits_reason' })
  pgm.createIndex(T('candidates'), 'status', { name: 'idx_candidates_status' })
  pgm.createIndex(T('interviews'), 'candidate_id', { name: 'idx_interviews_candidate' })
  pgm.createIndex(T('interviews'), [{ name: 'interview_date', sort: 'DESC' }],
    { name: 'idx_interviews_date' })
}

// Tables, never the schema: people.pgmigrations lives in it (migrations/README.md).
exports.down = (pgm) => {
  pgm.dropTable(T('interviews'))
  pgm.dropTable(T('candidates'))
  pgm.dropTable(T('employee_exits'))
  pgm.dropTable(T('employee_profiles'))
}
