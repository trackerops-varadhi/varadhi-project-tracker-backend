-- ============================================================================
-- PRODUCTION CUTOVER — move the 29 business tables into the 7 module schemas
-- ============================================================================
--
-- This is the "separate, reviewed plan with its own script" that
-- src/config/migrate-schema-split.js deliberately refuses to be: that script
-- rejects the production project ref by name, with no override, so the
-- production move happens here — deliberately, by a human, with a backup in hand.
--
-- WHAT IT DOES, AND DOES NOT
--   * CREATE SCHEMA x7                   additive
--   * ALTER TABLE ... SET SCHEMA x29     moves tables; DOES NOT COPY ROWS
--   * ALTER SEQUENCE ... SET SCHEMA x1   bug_number_seq follows bugs
--   * ALTER TABLE ... DROP CONSTRAINT    only foreign keys whose two ends would
--                                        land in different schemas
--   * NO INSERT, UPDATE, DELETE, TRUNCATE, DROP TABLE or DROP COLUMN
--   * the 7 legacy Prisma tables are never touched
--
-- Indexes, primary keys, defaults, check constraints, timestamps and every row
-- travel with their table: SET SCHEMA changes a namespace, not contents.
--
-- ORDER — do not improvise
--   1. Back up, and prove the backup restorable.    (docs/MIGRATION-REHEARSAL.md §2)
--   2. Run docs/drift-check.sql. Stop on any stop condition.
--   3. Run PART 0 and SAVE the output. That is the rollback script.
--   4. API into maintenance: the moves take brief exclusive locks.
--   5. Run PART 1 as one block. It commits whole or rolls back whole.
--   6. Run PART 2. Then npm run migrate:baseline, npm run migrate, then deploy.
--
-- Verified 2026-10-05 end to end against a local database provisioned by the
-- legacy migrate.js — the same pre-split layout production has.
-- ============================================================================


-- ============================================================================
-- PART 0 — GENERATE THE ROLLBACK SCRIPT   (read-only; run first, save output)
-- ============================================================================
--
-- ⚠ THIS IS ONLY VALID IF CAPTURED **BEFORE** PART 1 RUNS.
-- The 31 ADD CONSTRAINT statements are read out of the live catalog. Once PART 1
-- has dropped those keys there is nothing left to read, and running PART 0
-- afterwards yields a rollback that moves the tables back but silently restores
-- NONE of the foreign keys.
--
-- Observed in rehearsal, 2026-10-05: a post-cutover capture produced a rollback
-- that left the database at 21 foreign keys instead of 52 — structurally "fine",
-- no errors, and quietly missing every cross-module key. The pre-cutover capture
-- restored all 52.
--
-- So: run PART 0, save the output to a file, and verify it contains
-- **31 ADD CONSTRAINT lines** before you touch PART 1:
--     grep -c 'ADD CONSTRAINT' rollback.sql     # must print 31
WITH owned (tbl, sch) AS (VALUES
  ('users','identity'),('user_sessions','identity'),('user_tokens','identity'),
  ('projects','work'),('project_members','work'),('tasks','work'),('comments','work'),
  ('bugs','defects'),('bug_comments','defects'),('bug_attachments','defects'),
  ('bug_activity_logs','defects'),('bug_sla_rules','defects'),
  ('notifications','notify'),('notification_preferences','notify'),
  ('notification_snoozes','notify'),('notification_action_log','notify'),
  ('notification_logs','notify'),('push_subscriptions','notify'),
  ('push_delivery_retries','notify'),
  ('calendar_connections','integrations'),('calendar_sync_settings','integrations'),
  ('calendar_event_links','integrations'),('calendar_sync_conflicts','integrations'),
  ('teams_webhooks','integrations'),('teams_delivery_log','integrations'),
  ('documents','files'),('folders','files'),
  ('leave_requests','workforce'),('time_logs','workforce')
),
fks AS (
  SELECT con.conname AS name, src.relname AS src_table, tgt.relname AS tgt_table,
         pg_get_constraintdef(con.oid) AS def,
         s.sch AS src_mod, t.sch AS tgt_mod
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = src.relnamespace
    LEFT JOIN owned s ON s.tbl = src.relname
    LEFT JOIN owned t ON t.tbl = tgt.relname
   WHERE con.contype = 'f' AND n.nspname = 'public'
)
SELECT '-- ROLLBACK for the production cutover. Run as one transaction.' AS rollback_sql
UNION ALL SELECT 'BEGIN;'
UNION ALL SELECT format('ALTER TABLE %I.%I SET SCHEMA public;', sch, tbl) FROM owned
UNION ALL SELECT 'ALTER SEQUENCE defects.bug_number_seq SET SCHEMA public;'
UNION ALL SELECT format('ALTER TABLE public.%I ADD CONSTRAINT %I %s;', src_table, name, def)
            FROM fks
           WHERE (src_mod IS NOT NULL OR tgt_mod IS NOT NULL)
             AND src_mod IS DISTINCT FROM tgt_mod
-- The migration tooling's own objects, which must go before the schemas can be
-- dropped. Learned the hard way in rehearsal: with these present,
-- `DROP SCHEMA ... RESTRICT` fails with "cannot drop schema notify because other
-- objects depend on it", and the whole rollback aborts.
--   <module>.pgmigrations        one version ledger per schema, created by
--                                migrate:baseline — tracking data, not business data
--   identity.rate_limit_buckets  created by migration 0002; ephemeral counters
-- Nothing here existed before the cutover, so dropping them restores the
-- pre-cutover state exactly. RESTRICT is kept on the schemas themselves, so if
-- anything ELSE has appeared the rollback still refuses rather than cascading.
UNION ALL SELECT format('DROP TABLE IF EXISTS %I.pgmigrations;', sch)
            FROM (SELECT DISTINCT sch FROM owned) l
UNION ALL SELECT 'DROP TABLE IF EXISTS identity.rate_limit_buckets;'
UNION ALL SELECT format('DROP SCHEMA IF EXISTS %I RESTRICT;', sch)
            FROM (SELECT DISTINCT sch FROM owned) d
UNION ALL SELECT 'COMMIT;';


-- ============================================================================
-- PART 1 — THE CUTOVER   (one transaction: commits whole, or rolls back whole)
-- ============================================================================
BEGIN;

CREATE TEMP TABLE _owned (tbl text PRIMARY KEY, sch text NOT NULL) ON COMMIT DROP;
INSERT INTO _owned (tbl, sch) VALUES
  ('users','identity'),('user_sessions','identity'),('user_tokens','identity'),
  ('projects','work'),('project_members','work'),('tasks','work'),('comments','work'),
  ('bugs','defects'),('bug_comments','defects'),('bug_attachments','defects'),
  ('bug_activity_logs','defects'),('bug_sla_rules','defects'),
  ('notifications','notify'),('notification_preferences','notify'),
  ('notification_snoozes','notify'),('notification_action_log','notify'),
  ('notification_logs','notify'),('push_subscriptions','notify'),
  ('push_delivery_retries','notify'),
  ('calendar_connections','integrations'),('calendar_sync_settings','integrations'),
  ('calendar_event_links','integrations'),('calendar_sync_conflicts','integrations'),
  ('teams_webhooks','integrations'),('teams_delivery_log','integrations'),
  ('documents','files'),('folders','files'),
  ('leave_requests','workforce'),('time_logs','workforce');

DO $cutover$
DECLARE
  r              record;
  n              int;
  dropped        int := 0;
  moved          int := 0;
  legacy_before  int;
  legacy_after   int;
BEGIN
  -- Snapshot the tables in `public` that we do NOT own — the legacy Prisma set,
  -- plus anything else someone left there. Asserted unchanged at the end.
  -- Counted rather than hard-coded, so this works whatever that set turns out
  -- to be: the assertion is "we touched none of them", not "there are seven".
  SELECT count(*) INTO legacy_before
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r'
     AND c.relname NOT IN (SELECT tbl FROM _owned);
  RAISE NOTICE 'public holds % table(s) we do not own; they must all survive', legacy_before;
  -- ── PRECONDITION 1: every owned table is present in public ───────────────
  SELECT count(*) INTO n FROM _owned o
   WHERE to_regclass('public.' || quote_ident(o.tbl)) IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: % expected table(s) missing from public. Run docs/drift-check.sql first.', n;
  END IF;

  -- ── PRECONDITION 2: no module schema exists yet ──────────────────────────
  SELECT count(*) INTO n FROM pg_namespace
   WHERE nspname IN (SELECT DISTINCT sch FROM _owned);
  IF n > 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: % module schema(s) already exist. This database has already been migrated, or partly.', n;
  END IF;

  -- ── PRECONDITION 3: the sequence exists ──────────────────────────────────
  IF to_regclass('public.bug_number_seq') IS NULL THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: public.bug_number_seq is missing; bugs.bug_number would lose its default.';
  END IF;

  RAISE NOTICE 'preconditions OK: 29 tables present, no module schemas, sequence present';

  -- ── CREATE the schemas ───────────────────────────────────────────────────
  FOR r IN SELECT DISTINCT sch FROM _owned ORDER BY sch LOOP
    EXECUTE format('CREATE SCHEMA %I', r.sch);
  END LOOP;

  -- ── DROP foreign keys whose ends would land in different schemas ─────────
  -- Mirrors classify() in migrate-schema-split.js: a key between two legacy
  -- tables stays, a key inside one module stays, anything else goes.
  FOR r IN
    SELECT con.conname AS name, src.relname AS src_table
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace ns ON ns.oid = src.relnamespace
      LEFT JOIN _owned s ON s.tbl = src.relname
      LEFT JOIN _owned t ON t.tbl = tgt.relname
     WHERE con.contype = 'f' AND ns.nspname = 'public'
       AND (s.sch IS NOT NULL OR t.sch IS NOT NULL)
       AND s.sch IS DISTINCT FROM t.sch
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.src_table, r.name);
    dropped := dropped + 1;
    RAISE NOTICE 'dropped cross-module FK %  on public.%', r.name, r.src_table;
  END LOOP;

  -- ── MOVE the tables, then the sequence ───────────────────────────────────
  FOR r IN SELECT tbl, sch FROM _owned ORDER BY sch, tbl LOOP
    EXECUTE format('ALTER TABLE public.%I SET SCHEMA %I', r.tbl, r.sch);
    moved := moved + 1;
  END LOOP;
  EXECUTE 'ALTER SEQUENCE public.bug_number_seq SET SCHEMA defects';

  RAISE NOTICE 'moved % table(s); dropped % cross-module FK(s)', moved, dropped;

  -- ── POSTCONDITION 1: all 29 moved, and each one arrived ──────────────────
  IF moved <> 29 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: moved % table(s), expected 29', moved;
  END IF;
  SELECT count(*) INTO n FROM _owned o
   WHERE to_regclass(quote_ident(o.sch) || '.' || quote_ident(o.tbl)) IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % table(s) missing from their target schema', n;
  END IF;

  -- ── POSTCONDITION 2: nothing of ours is left in public ───────────────────
  SELECT count(*) INTO n
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r'
     AND c.relname IN (SELECT tbl FROM _owned);
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % owned table(s) still in public', n;
  END IF;

  -- ── POSTCONDITION 3: no foreign key crosses a schema boundary ────────────
  SELECT count(*) INTO n
    FROM pg_constraint con
    JOIN pg_class c  ON c.oid = con.conrelid   JOIN pg_namespace n1 ON n1.oid = c.relnamespace
    JOIN pg_class f  ON f.oid = con.confrelid  JOIN pg_namespace n2 ON n2.oid = f.relnamespace
   WHERE con.contype = 'f' AND n1.nspname <> n2.nspname
     AND n1.nspname IN (SELECT DISTINCT sch FROM _owned);
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % cross-schema foreign key(s) remain', n;
  END IF;

  -- ── POSTCONDITION 4: every table we do not own is still there ────────────
  SELECT count(*) INTO legacy_after
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relkind = 'r'
     AND c.relname NOT IN (SELECT tbl FROM _owned);
  IF legacy_after <> legacy_before THEN
    RAISE EXCEPTION
      'POSTCONDITION FAILED: public held % unowned table(s) before and % after — the cutover touched something it must not.',
      legacy_before, legacy_after;
  END IF;

  RAISE NOTICE 'postconditions OK — safe to COMMIT';
END
$cutover$;

COMMIT;


-- ============================================================================
-- PART 2 — VERIFY   (read-only; run after COMMIT)
-- ============================================================================
-- Compare against the before-picture from docs/drift-check.sql queries 7 and 8.
-- Row counts MUST be identical: SET SCHEMA cannot change them, so any difference
-- means something else happened, and the release stops.

SELECT nspname FROM pg_namespace
 WHERE nspname IN ('identity','work','defects','notify','integrations','files','workforce')
 ORDER BY 1;                                              -- expect 7 rows

SELECT table_schema, count(*) AS tables FROM information_schema.tables
 WHERE table_schema IN ('identity','work','defects','notify','integrations','files','workforce')
   AND table_type = 'BASE TABLE' GROUP BY 1 ORDER BY 1;    -- expect 29 across the 7

SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1;
                                                          -- expect ONLY the 7 Prisma tables

SELECT to_regclass('defects.bug_number_seq') AS sequence_moved,
       to_regclass('public.bug_number_seq')  AS must_be_null;

SELECT 'users' AS t, count(*) FROM identity.users
UNION ALL SELECT 'user_sessions', count(*) FROM identity.user_sessions
UNION ALL SELECT 'user_tokens', count(*) FROM identity.user_tokens
UNION ALL SELECT 'projects', count(*) FROM work.projects
UNION ALL SELECT 'project_members', count(*) FROM work.project_members
UNION ALL SELECT 'tasks', count(*) FROM work.tasks
UNION ALL SELECT 'comments', count(*) FROM work.comments
UNION ALL SELECT 'bugs', count(*) FROM defects.bugs
UNION ALL SELECT 'notifications', count(*) FROM notify.notifications
UNION ALL SELECT 'documents', count(*) FROM files.documents
UNION ALL SELECT 'time_logs', count(*) FROM workforce.time_logs
UNION ALL SELECT 'leave_requests', count(*) FROM workforce.leave_requests
 ORDER BY 1;

SELECT 'calendar_connections.access_token' AS col, count(*) AS non_null
  FROM integrations.calendar_connections WHERE access_token IS NOT NULL
UNION ALL SELECT 'teams_webhooks.webhook_url', count(*)
  FROM integrations.teams_webhooks WHERE webhook_url IS NOT NULL;
-- Ciphertext was moved, never re-encrypted. These counts must match the
-- before-picture, and the values must still decrypt — which holds only while
-- ENCRYPTION_KEY stays unset and JWT_SECRET is not rotated.
