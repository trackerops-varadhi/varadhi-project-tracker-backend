-- ============================================================================
-- OPTIONAL CLEANUP: drop the two shadow tables in `public`
-- ----------------------------------------------------------------------------
-- !! THIS IS THE ONLY DESTRUCTIVE SCRIPT IN THIS DIRECTORY. !!
-- Run it only if you have decided to. Nothing breaks if you never do.
--
-- WHAT IT DROPS
--   public.user_tokens     10 rows on production 2026-10-09, all token_type
--   public.user_sessions    4 rows                 'refresh'
--
-- WHY THEY ARE SAFE TO DROP
--   * The 2026-10-05 cutover MOVED the real tables into `identity`. These two
--     were re-created afterwards, between 2026-10-06 17:04 and 2026-10-07
--     16:02, by a deployment of the pre-split backend that forked
--     migrate-sessions.js / migrate-user-tokens.js at boot. The current
--     server.js does not (see "Migrations are NOT run from here").
--   * No module pool has `public` on its search_path (src/platform/db.js), so
--     the live application has never read a row of them.
--   * They hold refresh tokens and session rows for one user, who has signed
--     in since -- identity.user_sessions carries sessions newer than anything
--     here. Worst case for that person: one sign-in.
--   * Invite and password-reset tokens are NOT here -- those are columns on
--     the users table.
--
-- WHAT IT DOES NOT TOUCH
--   The 7 legacy Prisma tables, and every module schema. Only these two names,
--   only in `public`.
--
-- One transaction behind a guard. If anything is not as described above it
-- raises and changes nothing.
-- ============================================================================

BEGIN;

DO $guard$
DECLARE
  n          int;
  shadow_max timestamptz;
  live_max   timestamptz;
BEGIN
  -- 1. Both shadows must actually be there.
  IF to_regclass('public.user_sessions') IS NULL OR to_regclass('public.user_tokens') IS NULL THEN
    RAISE EXCEPTION 'public.user_sessions / public.user_tokens not both present - nothing to do (already dropped?)';
  END IF;

  -- 2. The live tables must be there. Dropping the shadow while `identity` is
  --    missing them would take the only copy.
  IF to_regclass('identity.user_sessions') IS NULL OR to_regclass('identity.user_tokens') IS NULL THEN
    RAISE EXCEPTION 'identity.user_sessions / identity.user_tokens missing - this database is not in the expected state. Nothing was changed.';
  END IF;

  -- 3. The live table must demonstrably have taken over: a session created
  --    after the newest shadow row proves sign-ins now land in `identity`.
  EXECUTE 'SELECT max(created_at) FROM public.user_sessions' INTO shadow_max;
  SELECT max(created_at) INTO live_max FROM identity.user_sessions;
  IF live_max IS NULL OR shadow_max IS NULL OR live_max <= shadow_max THEN
    RAISE EXCEPTION
      'identity.user_sessions newest row is %, shadow newest is % - the live table has NOT taken over. Nothing was changed.',
      live_max, shadow_max;
  END IF;

  -- 4. `public` must hold nothing else unexpected. If a wider drift has
  --    appeared, that is a bigger problem than these two tables and this
  --    script must not run first.
  SELECT count(*) INTO n
    FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     AND table_name NOT IN ('ActivityLog', 'Document', 'Project', 'ProjectMember',
                            'Task', 'User', '_prisma_migrations',
                            'user_sessions', 'user_tokens');
  IF n > 0 THEN
    RAISE EXCEPTION
      'public holds % unexpected table(s) besides these two. Run docs/production-verify.sql and resolve that first. Nothing was changed.', n;
  END IF;

  RAISE NOTICE 'guard OK - dropping the two shadows';
END
$guard$;

-- Tokens first: user_tokens.session_id may reference user_sessions.
DROP TABLE public.user_tokens;
DROP TABLE public.user_sessions;

COMMIT;

-- Verify: `public` now holds only the 7 legacy Prisma tables.
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1;
