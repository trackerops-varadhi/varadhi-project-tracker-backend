-- ============================================================================
-- PRODUCTION: write the migration ledgers, then apply the two real migrations
-- ============================================================================
--
-- Run this AFTER docs/production-cutover.sql has committed.
--
-- WHY THIS FILE EXISTS
-- `npm run migrate:baseline` and `npm run migrate` both refuse the production
-- project ref outright (src/config/migrate-runner.js) — there is no flag that
-- overrides it. That guard is deliberate, so the production equivalent is these
-- statements, run by a human who has just taken a backup.
--
-- WHAT IT DOES
--   PART A  creates one `pgmigrations` ledger per module schema and records
--           `0001_baseline` as applied WITHOUT executing it. The 29 tables
--           already exist — they were just moved — so executing 0001 would be
--           wrong. This is exactly what migrate:baseline does.
--   PART B  applies the only two migrations that follow 0001, and records them.
--           Both are additive and idempotent.
--
--   identity/0002_rate_limit_buckets   new table + index (shared rate limiting)
--   work/0002_task_story_fields        three columns live code reads; the
--                                      baselines omit them because they were
--                                      generated from the legacy migrate.js
--                                      schema. ADD COLUMN IF NOT EXISTS, so on
--                                      production (which already has them) this
--                                      is a no-op.
--
-- NO row is inserted, updated or deleted in any business table.
--
-- Verified 2026-10-05: the same sequence ran green on a local pre-split copy —
-- 7 ledgers written, 2 migrations applied, `migrate:status` then reported
-- 0 pending across all seven modules.
-- ============================================================================

BEGIN;

-- ── PART A: the ledgers ─────────────────────────────────────────────────────
--
-- SIX modules, not seven. `defects` is deliberately absent: production has none
-- of the five bug tables (verified 2026-10-05 from a backup), so there is
-- nothing there to baseline. Its tables are CREATED and its 0001 is EXECUTED by
-- docs/production-defects-create.sql, which writes its own ledger row.
-- Run that file BEFORE this one.
-- Column shape copied from a live ledger: id serial PK, name varchar NOT NULL,
-- run_on timestamp NOT NULL. node-pg-migrate records the migration FILENAME
-- without its extension, which is why the value is '0001_baseline'.

CREATE TABLE IF NOT EXISTS identity.pgmigrations     (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL);
CREATE TABLE IF NOT EXISTS work.pgmigrations         (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL);
CREATE TABLE IF NOT EXISTS notify.pgmigrations       (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL);
CREATE TABLE IF NOT EXISTS integrations.pgmigrations (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL);
CREATE TABLE IF NOT EXISTS files.pgmigrations        (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL);
CREATE TABLE IF NOT EXISTS workforce.pgmigrations    (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL);

-- Guard: refuse to double-baseline. If a ledger already has rows, this database
-- has been through some of this before and needs a human decision, not a rerun.
DO $guard$
DECLARE n int;
BEGIN
  SELECT (SELECT count(*) FROM identity.pgmigrations)
       + (SELECT count(*) FROM work.pgmigrations)
       + (SELECT count(*) FROM notify.pgmigrations)
       + (SELECT count(*) FROM integrations.pgmigrations)
       + (SELECT count(*) FROM files.pgmigrations)
       + (SELECT count(*) FROM workforce.pgmigrations)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'REFUSING: % ledger row(s) already exist. This database has already been baselined.', n;
  END IF;
END
$guard$;

INSERT INTO identity.pgmigrations     (name, run_on) VALUES ('0001_baseline', now());
INSERT INTO work.pgmigrations         (name, run_on) VALUES ('0001_baseline', now());
INSERT INTO notify.pgmigrations       (name, run_on) VALUES ('0001_baseline', now());
INSERT INTO integrations.pgmigrations (name, run_on) VALUES ('0001_baseline', now());
INSERT INTO files.pgmigrations        (name, run_on) VALUES ('0001_baseline', now());
INSERT INTO workforce.pgmigrations    (name, run_on) VALUES ('0001_baseline', now());

-- ── PART B: the two migrations that follow 0001 ─────────────────────────────

-- identity/0002_rate_limit_buckets
CREATE TABLE IF NOT EXISTS identity.rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  hits       integer NOT NULL DEFAULT 0,
  reset_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_reset_at
  ON identity.rate_limit_buckets (reset_at);
INSERT INTO identity.pgmigrations (name, run_on) VALUES ('0002_rate_limit_buckets', now());

-- work/0002_task_story_fields  (no-op where the columns already exist)
ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS user_story          text;
ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS acceptance_criteria text;
ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS completed_at        timestamp without time zone;
INSERT INTO work.pgmigrations (name, run_on) VALUES ('0002_task_story_fields', now());

COMMIT;


-- ============================================================================
-- VERIFY (read-only). `npm run migrate:status` cannot be used against
-- production either, so check the ledgers directly. Expect 9 rows: 7 baselines
-- plus the two 0002s.
-- ============================================================================
SELECT 'identity' AS module, name, run_on FROM identity.pgmigrations
UNION ALL SELECT 'work',         name, run_on FROM work.pgmigrations
UNION ALL SELECT 'defects',      name, run_on FROM defects.pgmigrations
UNION ALL SELECT 'notify',       name, run_on FROM notify.pgmigrations
UNION ALL SELECT 'integrations', name, run_on FROM integrations.pgmigrations
UNION ALL SELECT 'files',        name, run_on FROM files.pgmigrations
UNION ALL SELECT 'workforce',    name, run_on FROM workforce.pgmigrations
 ORDER BY 1, 2;

-- The three columns must now exist (18 total on work.tasks).
SELECT count(*) AS task_columns FROM information_schema.columns
 WHERE table_schema = 'work' AND table_name = 'tasks';
