-- ============================================================================
-- PRODUCTION PRE-CHECK (read-only)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL editor BEFORE any of the production-*.sql
-- scripts. It only SELECTs: nothing is created, altered or deleted.
--
-- It answers one question: which migration scripts has this database already
-- had, and therefore which ones are still to run.
--
-- Expected state AFTER all of Module 9 + the QC role have been applied:
--   identity  0004_qc_role
--   people    0003_recruitment
--   workforce 0003_work_status
--   work      0002_task_story_fields
--   defects / notify / files / integrations   0001_baseline
-- ============================================================================

-- 1. Which module schemas exist?
--    `people` missing  -> production-people-create.sql has NOT been run.
SELECT nspname AS schema_present
FROM pg_namespace
WHERE nspname IN ('identity', 'work', 'defects', 'notify', 'integrations', 'files', 'workforce', 'people')
ORDER BY 1;

-- 2. Latest applied migration per module.
--    Run this after #1. If it fails with 'relation "people.pgmigrations" does
--    not exist', that is the answer to #1 confirmed -- start with
--    production-people-create.sql. (The max() is safe: the names are
--    zero-padded, so alphabetical order is migration order.)
SELECT 'identity'     AS module, max(name) AS latest FROM identity.pgmigrations
UNION ALL SELECT 'work',         max(name) FROM work.pgmigrations
UNION ALL SELECT 'defects',      max(name) FROM defects.pgmigrations
UNION ALL SELECT 'notify',       max(name) FROM notify.pgmigrations
UNION ALL SELECT 'integrations', max(name) FROM integrations.pgmigrations
UNION ALL SELECT 'files',        max(name) FROM files.pgmigrations
UNION ALL SELECT 'workforce',    max(name) FROM workforce.pgmigrations
UNION ALL SELECT 'people',       max(name) FROM people.pgmigrations
ORDER BY 1;

-- 3. Which roles does the users table currently accept?
--    '...employee' only      -> production-module9-full.sql and
--                               production-qc-role.sql both still to run.
--    '...employee, hr'       -> production-qc-role.sql still to run.
--    '...employee, hr, qc'   -> everything is applied.
SELECT pg_get_constraintdef(oid) AS users_role_check
FROM pg_constraint
WHERE conname = 'users_role_check';
