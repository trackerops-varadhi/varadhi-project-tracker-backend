-- ============================================================================
-- PUBLIC SHADOW TABLES -- what is in them (read-only, ONE result table)
-- ----------------------------------------------------------------------------
-- 2026-10-09: production holds public.user_sessions (4 rows) and
-- public.user_tokens (10 rows). The 2026-10-05 cutover MOVED those tables into
-- `identity`, so these two were created afterwards -- by a deployment of the
-- pre-split backend, which forked src/config/migrate-sessions.js and
-- migrate-user-tokens.js on every boot. The current code does not (see the
-- "Migrations are NOT run from here" block in src/server.js).
--
-- Every module pool's search_path is `<module>,extensions` with no `public`,
-- so the live application reads identity.user_sessions / identity.user_tokens
-- and cannot see these rows at all. The question this answers is whether
-- anything in them still matters before they are dropped.
--
-- It SELECTs only, and it reports counts and timestamps. It never selects
-- token_hash, ip_address or user_agent.
--
-- If it fails with "column ... does not exist", the shadow has an older shape
-- than identity's -- say so rather than guessing.
-- ============================================================================

  SELECT 'shadow sessions: rows' AS what, count(*)::text AS value FROM public.user_sessions
UNION ALL SELECT 'shadow sessions: earliest created', COALESCE(min(created_at)::text, '-') FROM public.user_sessions
UNION ALL SELECT 'shadow sessions: latest created',   COALESCE(max(created_at)::text, '-') FROM public.user_sessions
UNION ALL SELECT 'shadow sessions: still unexpired',  count(*)::text FROM public.user_sessions
            WHERE revoked_at IS NULL AND expires_at > now()
UNION ALL SELECT 'shadow sessions: distinct users',   count(DISTINCT user_id)::text FROM public.user_sessions
UNION ALL SELECT 'shadow sessions: users that exist in identity.users',
                 count(*)::text FROM (SELECT DISTINCT user_id FROM public.user_sessions) s
                  WHERE EXISTS (SELECT 1 FROM identity.users u WHERE u.id = s.user_id)

UNION ALL SELECT 'shadow tokens: rows', count(*)::text FROM public.user_tokens
UNION ALL SELECT 'shadow tokens: earliest created', COALESCE(min(created_at)::text, '-') FROM public.user_tokens
UNION ALL SELECT 'shadow tokens: latest created',   COALESCE(max(created_at)::text, '-') FROM public.user_tokens
UNION ALL SELECT 'shadow tokens: still unexpired',  count(*)::text FROM public.user_tokens
            WHERE revoked_at IS NULL AND expires_at > now()
UNION ALL SELECT 'shadow tokens: type ' || token_type, count(*)::text
            FROM public.user_tokens GROUP BY token_type

-- For comparison: did those people simply sign in again afterwards? If the
-- live table holds recent sessions for the same users, nothing was lost.
UNION ALL SELECT 'live sessions: latest created', COALESCE(max(created_at)::text, '-') FROM identity.user_sessions
UNION ALL SELECT 'live sessions: still unexpired', count(*)::text FROM identity.user_sessions
            WHERE revoked_at IS NULL AND expires_at > now()

ORDER BY 1;
