// Adds Full Day / Half Day support to leave_requests (Apply Leave modal).
//
// Two changes, both additive — no data is deleted, reset or rewritten:
//
//   1. day_type VARCHAR(10) NOT NULL DEFAULT 'full_day' + CHECK constraint.
//      Existing rows backfill to 'full_day' via the DEFAULT, which is the
//      correct historical value: before this column existed every leave
//      request was implicitly a full day.
//
//   2. days INTEGER -> NUMERIC(5,1). This is REQUIRED, not cosmetic. A
//      half-day stores days = 0.5, and the pg driver rejects that against an
//      INTEGER column outright ('invalid input syntax for type integer:
//      "0.5"'), so every half-day request would 500 without the widening.
//      INTEGER -> NUMERIC is a widening conversion: Postgres rewrites the
//      column in place and every existing whole-number value survives
//      exactly (3 -> 3.0). It is not a lossy or destructive change.
//
// Note: NUMERIC comes back from pg as a *string* ("3.0"), which would render
// as "3.0 Days" in the UI and break arithmetic. config/db.js registers a type
// parser for OID 1700 to hand JS numbers back instead — the two changes belong
// together, don't apply one without the other.
//
// Safe to run repeatedly: ADD COLUMN uses IF NOT EXISTS, the CHECK constraint
// is added only when absent, the type change is a no-op once applied, and the
// whole thing runs in a transaction like every other migration here.
require('dotenv').config()
const pool = require('./db')

async function run() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1. day_type column. Existing rows take the DEFAULT ('full_day').
    await client.query(`
      ALTER TABLE leave_requests
        ADD COLUMN IF NOT EXISTS day_type VARCHAR(10) NOT NULL DEFAULT 'full_day'
    `)

    // Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard on the catalog to
    // keep this migration re-runnable.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'leave_requests_day_type_check'
        ) THEN
          ALTER TABLE leave_requests
            ADD CONSTRAINT leave_requests_day_type_check
            CHECK (day_type IN ('full_day', 'half_day'));
        END IF;
      END
      $$
    `)

    // 2. Widen days so 0.5 is representable. Idempotent: re-running against an
    // already-NUMERIC column is accepted and changes nothing.
    await client.query(`
      ALTER TABLE leave_requests
        ALTER COLUMN days TYPE NUMERIC(5,1)
    `)
    // The old INTEGER default (1) carries over as 1, but restate it so the
    // column default matches the new type exactly.
    await client.query(`
      ALTER TABLE leave_requests
        ALTER COLUMN days SET DEFAULT 1
    `)

    await client.query('COMMIT')
    console.log('✅ leave_requests.day_type + numeric days applied successfully!')
    process.exit(0)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('❌ Leave day_type migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
  }
}

run()
