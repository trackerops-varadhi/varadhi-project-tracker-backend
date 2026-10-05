/*
 * tasks.user_story, tasks.acceptance_criteria, tasks.completed_at
 *
 * WHY THIS EXISTS
 * The 0001 baseline was generated from the legacy `migrate.js` schema, not from the
 * live database, so it omits three columns the era scripts added later and that
 * live code reads today:
 *
 *   user_story, acceptance_criteria   work/repo.js, work/tasks.service.js
 *   completed_at                      the two above plus work/analytics.repo.js,
 *                                     where it drives burndown and throughput
 *
 * Verified 2026-10-05: 29 tables compared against the live development schema,
 * `work.tasks` was baseline=15 columns vs live=18.
 *
 * Consequence without this migration: a database provisioned FROM ZERO (CI,
 * docker compose, a new environment) gets a `tasks` table missing all three, and
 * the application fails with 42703 on the first task query. Databases that
 * already have the columns — development, and production after baselining — are
 * unaffected either way.
 *
 * IDEMPOTENT BY DESIGN. `ADD COLUMN IF NOT EXISTS` is a no-op where the column is
 * already present, which is the case on every existing environment. That is what
 * makes this safe to run against production immediately after `migrate:baseline`.
 *
 * Raw SQL rather than pgm.addColumns: the IF NOT EXISTS behaviour is the whole
 * point here, and expressing it directly leaves no doubt about what runs.
 *
 * Types match the live columns exactly (text, text, timestamp without time zone,
 * all nullable, no defaults) so a from-zero database is identical to the ones in
 * flight. Nullable is also what makes this a metadata-only change: Postgres does
 * not rewrite the table, so it is fast and takes no long lock even on a large
 * `tasks`.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS user_story          text;
    ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS acceptance_criteria text;
    ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS completed_at        timestamp without time zone;
  `)
}

/*
 * Down drops them, which on an existing database would DESTROY data that live
 * code depends on — `completed_at` is how a completed task records when. It is
 * written for completeness and for the from-zero case; think before running it.
 */
exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE work.tasks DROP COLUMN IF EXISTS completed_at;
    ALTER TABLE work.tasks DROP COLUMN IF EXISTS acceptance_criteria;
    ALTER TABLE work.tasks DROP COLUMN IF EXISTS user_story;
  `)
}
