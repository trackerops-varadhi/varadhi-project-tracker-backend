/*
 * workforce — 0002 leave policy
 * ---------------------------------------------------------------------------
 * Phase 3 of docs/Module-9-People-Plan.md (§2.7): the spreadsheet's planned vs
 * unplanned distinction, notice tracking, who approved and when, cancellation,
 * and per-person leave entitlements.
 *
 * Existing requests are BACKFILLED from their own dates (planned when it was
 * raised before the leave began), so history reads correctly from day one.
 * That is the only data this touches, and only the new columns.
 *
 * leave_balances stores what a person is ENTITLED to (and carries forward).
 * "Used" is deliberately not a column: it is summed from approved requests on
 * read, so it can never drift from the requests themselves.
 */

exports.shorthands = undefined

const LR = { schema: 'workforce', name: 'leave_requests' }
const LB = { schema: 'workforce', name: 'leave_balances' }

exports.up = (pgm) => {
  pgm.addColumns(LR, {
    planning_type: {
      type: 'varchar(12)', notNull: true, default: 'planned',
      check: "planning_type IN ('planned','unplanned')",
    },
    // start_date minus the business day the request was raised, stored at insert.
    notice_days: { type: 'integer' },
    // planned AND fewer than 7 days' notice.
    is_late_notice: { type: 'boolean', notNull: true, default: false },
    approver_id: { type: 'uuid' },
    approved_at: { type: 'timestamptz' },
    cancelled_at: { type: 'timestamptz' },
  })

  // created_at is a zone-less NOW() from a UTC session; read it as UTC and
  // take the office's calendar day.
  pgm.sql(`
    UPDATE workforce.leave_requests
       SET notice_days    = start_date - ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date,
           planning_type  = CASE WHEN ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date < start_date
                                 THEN 'planned' ELSE 'unplanned' END
     WHERE created_at IS NOT NULL`)
  pgm.sql(`
    UPDATE workforce.leave_requests
       SET is_late_notice = (planning_type = 'planned' AND notice_days < 7)
     WHERE notice_days IS NOT NULL`)

  // Owners may now withdraw a pending request.
  pgm.dropConstraint(LR, 'leave_requests_status_check')
  pgm.addConstraint(LR, 'leave_requests_status_check',
    "CHECK (status IN ('pending','approved','rejected','cancelled'))")

  pgm.createTable(LB, {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true },
    year: { type: 'smallint', notNull: true },
    leave_type: { type: 'varchar(30)', notNull: true },
    entitled: { type: 'numeric(5,1)', notNull: true, default: 0 },
    carried_forward: { type: 'numeric(5,1)', notNull: true, default: 0 },
    updated_by: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  })
  pgm.addConstraint(LB, 'leave_balances_user_year_type_key', 'UNIQUE (user_id, year, leave_type)')
  pgm.addConstraint(LB, 'leave_balances_non_negative', 'CHECK (entitled >= 0 AND carried_forward >= 0)')
  pgm.createIndex(LR, ['start_date', 'end_date'], { name: 'idx_leave_requests_dates' })
}

exports.down = (pgm) => {
  pgm.dropIndex(LR, ['start_date', 'end_date'], { name: 'idx_leave_requests_dates' })
  pgm.dropTable(LB)
  pgm.dropConstraint(LR, 'leave_requests_status_check')
  pgm.addConstraint(LR, 'leave_requests_status_check',
    "CHECK (status IN ('pending','approved','rejected'))")
  pgm.dropColumns(LR, ['planning_type', 'notice_days', 'is_late_notice', 'approver_id', 'approved_at', 'cancelled_at'])
}
