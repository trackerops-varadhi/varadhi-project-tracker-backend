-- ============================================================================
-- PRODUCTION STATE DUMP (read-only, ONE statement, ONE result table)
-- ----------------------------------------------------------------------------
-- Run this when a guard has refused and the reason is not obvious. It only
-- SELECTs. Paste the whole result back.
--
-- Written 2026-10-09 after production-module9-full.sql refused with
-- "identity.pgmigrations is at 0004_qc_role, expected 0002_rate_limit_buckets"
-- on a database whose `people` schema did not exist minutes earlier. Those two
-- facts cannot both come from this repo's scripts, so the question is what
-- else has written to this database -- and which database this is.
--
-- `run_on` is the evidence: it says when each ledger row was written, so rows
-- written by a script run and rows written by something else separate out by
-- timestamp.
-- ============================================================================

  SELECT 'ledger identity'     AS what, id::text AS seq, name AS value, run_on::text AS at FROM identity.pgmigrations
UNION ALL SELECT 'ledger work',         id::text, name, run_on::text FROM work.pgmigrations
UNION ALL SELECT 'ledger workforce',    id::text, name, run_on::text FROM workforce.pgmigrations
UNION ALL SELECT 'ledger defects',      id::text, name, run_on::text FROM defects.pgmigrations
UNION ALL SELECT 'ledger notify',       id::text, name, run_on::text FROM notify.pgmigrations
UNION ALL SELECT 'ledger integrations', id::text, name, run_on::text FROM integrations.pgmigrations
UNION ALL SELECT 'ledger files',        id::text, name, run_on::text FROM files.pgmigrations

-- Which schemas exist at all.
UNION ALL SELECT 'schema', '', nspname, ''
            FROM pg_namespace
           WHERE nspname IN ('identity', 'work', 'defects', 'notify', 'integrations', 'files', 'workforce', 'people', 'public')

-- The roles the users table accepts, per schema (a pre-split shadow in public
-- must not be mistaken for identity's).
UNION ALL SELECT 'users_role_check', '', n.nspname || ' = ' || pg_get_constraintdef(con.oid), ''
            FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE con.conname = 'users_role_check'

-- Which database this is: row counts only, no data. Production carries real
-- volume where a dev or scratch copy does not. (Keep every comment in this
-- file free of a statement terminator -- a tool that splits the script on one
-- would otherwise cut this single statement in half.)
UNION ALL SELECT 'count identity.users', '', count(*)::text, '' FROM identity.users
UNION ALL SELECT 'count work.projects',  '', count(*)::text, '' FROM work.projects
UNION ALL SELECT 'count work.tasks',     '', count(*)::text, '' FROM work.tasks
UNION ALL SELECT 'count notify.notifications', '', count(*)::text, '' FROM notify.notifications
UNION ALL SELECT 'count defects.bugs',   '', count(*)::text, '' FROM defects.bugs

-- Any table left in public is a pre-split leftover or a shadow copy.
UNION ALL SELECT 'public table', '', table_name, ''
            FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'

ORDER BY 1, 2, 3;

-- ── Run this one separately, only if the `people` schema exists above. ──────
-- SELECT 'ledger people' AS what, id, name, run_on FROM people.pgmigrations ORDER BY id;
