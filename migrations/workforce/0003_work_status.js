/*
 * workforce — 0003 work status
 * ---------------------------------------------------------------------------
 * Phase 3 of docs/Module-9-People-Plan.md (§2.7):
 *
 *   - time_logs.attendance_status: the sheet's absentee visibility needs a
 *     status (present / wfh / half day), not just hours.
 *   - daily_work_status: "update work status at end of the day". Separate from
 *     time_logs.note because a work status is a narrative owned by the person,
 *     whereas a time log is an accounting row owned by a project.
 */

exports.shorthands = undefined

const TL = { schema: 'workforce', name: 'time_logs' }
const WS = { schema: 'workforce', name: 'daily_work_status' }

exports.up = (pgm) => {
  pgm.addColumns(TL, {
    attendance_status: {
      type: 'varchar(16)',
      check: "attendance_status IN ('present','wfh','half_day','on_leave','absent')",
    },
  })

  pgm.createTable(WS, {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true },
    date: { type: 'date', notNull: true },
    summary: { type: 'text', notNull: true },
    blockers: { type: 'text' },
    tomorrow_plan: { type: 'text' },
    submitted_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  })
  pgm.addConstraint(WS, 'daily_work_status_user_date_key', 'UNIQUE (user_id, date)')
  pgm.createIndex(WS, 'date', { name: 'idx_daily_work_status_date' })
}

exports.down = (pgm) => {
  pgm.dropTable(WS)
  pgm.dropColumns(TL, ['attendance_status'])
}
