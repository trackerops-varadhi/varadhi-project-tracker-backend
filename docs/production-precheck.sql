-- ============================================================================
-- PRODUCTION PRE-CHECK (read-only, ONE statement, ONE result table)
-- ----------------------------------------------------------------------------
-- Paste the whole file into the Supabase SQL editor and Run. It only SELECTs:
-- nothing is created, altered or deleted.
--
-- It answers one question: which production-*.sql scripts has this database
-- already had, and therefore which are still to run.
--
-- `people` is deliberately NOT read here. Its ledger does not exist until
-- production-people-create.sql has run, and naming a missing relation fails
-- the whole statement (observed 2026-10-09: 42P01 people.pgmigrations) — which
-- hides the rest of the answer. The `schema` rows below report it instead.
--
-- HOW TO READ THE RESULT
--   schema ...            one row per module schema that exists.
--                         `people` absent  -> production-people-create.sql to run.
--   ledger <module>       latest applied migration for that module.
--   users_role_check      '...employee'           -> module9-full AND qc-role to run
--                         '...employee, hr'       -> qc-role to run
--                         '...employee, hr, qc'   -> everything applied
--
-- FULLY APPLIED looks like:
--   schemas   identity work defects notify integrations files workforce people
--   identity  0004_qc_role          work       0002_task_story_fields
--   workforce 0003_work_status      defects    0001_baseline
--   notify / integrations / files   0001_baseline
--   (people's own ledger: 0003_recruitment — check it with the last query below)
-- ============================================================================

  SELECT 'schema' AS what, nspname AS value
    FROM pg_namespace
   WHERE nspname IN ('identity', 'work', 'defects', 'notify', 'integrations', 'files', 'workforce', 'people')
-- max() is safe: the migration names are zero-padded, so alphabetical order is
-- migration order.
UNION ALL SELECT 'ledger identity',     max(name) FROM identity.pgmigrations
UNION ALL SELECT 'ledger work',         max(name) FROM work.pgmigrations
UNION ALL SELECT 'ledger defects',      max(name) FROM defects.pgmigrations
UNION ALL SELECT 'ledger notify',       max(name) FROM notify.pgmigrations
UNION ALL SELECT 'ledger integrations', max(name) FROM integrations.pgmigrations
UNION ALL SELECT 'ledger files',        max(name) FROM files.pgmigrations
UNION ALL SELECT 'ledger workforce',    max(name) FROM workforce.pgmigrations
-- Qualified by schema: a pre-split database can still carry a shadow copy of
-- the constraint in public, and the two must not be confused.
UNION ALL SELECT 'users_role_check ' || n.nspname,
                 pg_get_constraintdef(con.oid)
                   FROM pg_constraint con
                   JOIN pg_class c ON c.oid = con.conrelid
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE con.conname = 'users_role_check'
ORDER BY 1, 2;

-- ── Only once the `people` schema exists, this reports its ledger too. ──────
-- Run it on its own (select these two lines, then Run). Before then it is
-- expected to fail with 42P01 — that failure IS the answer.
-- SELECT 'ledger people' AS what, max(name) AS value FROM people.pgmigrations;
