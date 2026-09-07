/*
 * Session management migration (Phase 0).
 * ---------------------------------------------------------------------------
 * Run against an existing database:
 *
 *   npm run db:migrate:sessions
 *
 * The same statements are mirrored into migrate.js so a from-scratch database
 * matches a migrated one — the convention every previous module here follows
 * (see the Module 2 / Module 4-5 / push-retry / Bugs Finder blocks).
 *
 * WHAT THIS DOES
 * Introduces `user_sessions`: one row per browser session — the thing a user
 * actually sees and revokes in Settings → Active Sessions. `user_tokens` keeps
 * holding token material; `user_sessions` holds session *identity* and
 * liveness (device, IP, last active, revocation).
 *
 * Splitting them is what makes remote revocation honest. Today a session's
 * identity is `user_tokens.session_id`, which `token.service.js` regenerates on
 * every refresh — the live database currently holds 32 distinct session_ids for
 * 2 users, all phantoms of that churn. Once the session row is the identity, a
 * refresh rotates tokens *underneath* a stable session, so a revoked session
 * stays revoked instead of ceasing to exist 15 minutes later.
 *
 * ZERO BEHAVIOUR CHANGE — deliberately.
 * Everything below is CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS and
 * touches no existing column. Nothing reads or writes `user_sessions` yet, and
 * no constraint is added that existing code could violate. Running this against
 * production changes nothing observable; it only puts the table in place for
 * Phase 1. Nobody is logged out by this migration.
 *
 * DEFERRED ON PURPOSE: the `user_tokens.session_id` foreign key.
 * It belongs in Phase 1, not here. `createTokenPair` currently mints a random
 * session_id and inserts straight into `user_tokens` with no matching session
 * row — adding the FK now would make the very next login fail with a constraint
 * violation. The backfill below exists so that when Phase 1 does add the FK,
 * every historical row already has a parent and the constraint validates
 * without a cleanup DELETE.
 *
 * TIMESTAMPTZ throughout, matching `user_tokens` and the Module 4/5/8 tables
 * rather than the older zone-less ones: expiry and inactivity decisions compare
 * stored timestamps against the server's NOW(), and a zone-less column silently
 * shifts those by the server offset.
 */

require('dotenv').config()
const pool = require('./db')

// Statement list is shared with migrate.js so the two can never drift.
// Each entry runs in order inside one transaction.
const SESSION_MIGRATION_STATEMENTS = [
  // ─── Sessions ───────────────────────────────────────────────────────────
  // One row per browser session. `id` is what Phase 1 will carry in the JWT's
  // `sessionId` claim and what `user_tokens.session_id` will point at, so it
  // must stay stable for the life of the session — across every token
  // rotation — which is the entire point of this table.
  //
  // expires_at mirrors the 7-day refresh window: the session is dead once the
  // longest-lived token that can renew it has expired. Storing it here means
  // "is this session still alive?" is answerable from this row alone, without
  // joining token material on every authenticated request.
  //
  // browser / os / device_label are parsed from user_agent at creation time by
  // the Phase 1 device parser. They are stored rather than derived on read so
  // the Active Sessions list stays cheap and stable — re-parsing a UA string on
  // every render would make a session's label drift if the parser changes.
  // user_agent is kept alongside them as the raw fallback.
  `CREATE TABLE IF NOT EXISTS user_sessions (
     id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

     -- Presentation fields for Settings → Active Sessions
     browser         VARCHAR(100),
     os              VARCHAR(100),
     device_label    VARCHAR(200),
     ip_address      TEXT,
     user_agent      TEXT,

     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at      TIMESTAMPTZ NOT NULL,

     -- Revocation is a soft delete: the row survives so the user can see that a
     -- session was ended and why. revoked_by is NULL for self-service actions
     -- and set to the acting admin's id for an administrative revoke, which is
     -- the audit trail the plan's requirement 3 asks for.
     revoked_at      TIMESTAMPTZ,
     revoked_reason  VARCHAR(30)
                       CHECK (revoked_reason IN (
                         'logout',
                         'logout_all',
                         'user_revoked',
                         'admin_revoked',
                         'password_change',
                         'password_reset',
                         'token_reuse',
                         'account_deactivated',
                         'inactivity',
                         'expired',
                         'migrated'
                       )),
     revoked_by      UUID REFERENCES users(id) ON DELETE SET NULL
   )`,

  // The Active Sessions list is the only user-facing query and always reads
  // "my live sessions, most recently used first". Partial on revoked_at IS NULL
  // so revoked history — which only grows — never bloats the hot index.
  `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active
     ON user_sessions (user_id, last_active_at DESC)
     WHERE revoked_at IS NULL`,

  // Drives the Phase 7 cleanup sweep, which prunes by expiry across all users.
  `CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry
     ON user_sessions (expires_at)`,

  // ─── Backfill ───────────────────────────────────────────────────────────
  // Materialise a session row for every session_id already present in
  // user_tokens, so the Phase 1 foreign key validates against existing data
  // instead of forcing us to delete it.
  //
  // These rows are mostly artefacts of the session-id churn bug (32 sessions
  // for 2 users), so they are backfilled as *history*, not as a working set —
  // Phase 1's cutover revokes everything and everyone re-logs in once, as
  // agreed. What matters here is only that no orphan session_id survives.
  //
  // A session is treated as revoked only when every one of its tokens is
  // revoked; a session with any live token stays live, so this backfill cannot
  // log anybody out. ON CONFLICT DO NOTHING keeps re-runs idempotent.
  `INSERT INTO user_sessions (
     id, user_id, user_agent, ip_address,
     created_at, last_active_at, expires_at,
     revoked_at, revoked_reason
   )
   SELECT
     t.session_id,
     t.user_id,
     (ARRAY_AGG(t.user_agent  ORDER BY t.created_at DESC))[1],
     (ARRAY_AGG(t.ip_address  ORDER BY t.created_at DESC))[1],
     MIN(t.created_at),
     MAX(t.created_at),
     MAX(t.expires_at),
     CASE WHEN COUNT(*) FILTER (WHERE t.revoked_at IS NULL) = 0
          THEN MAX(t.revoked_at) END,
     CASE WHEN COUNT(*) FILTER (WHERE t.revoked_at IS NULL) = 0
          THEN 'migrated' END
   FROM user_tokens t
   GROUP BY t.session_id, t.user_id
   ON CONFLICT (id) DO NOTHING`,
]

async function runSessionMigration(client) {
  for (const statement of SESSION_MIGRATION_STATEMENTS) {
    await client.query(statement)
  }
}

// Exported so migrate.js can run the identical statements inside its own
// transaction — one source of truth for the session schema.
module.exports = { SESSION_MIGRATION_STATEMENTS, runSessionMigration }

// Only self-execute when invoked directly (`node src/config/migrate-sessions.js`),
// never when required by migrate.js.
if (require.main === module) {
  ;(async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      console.log('🔄 Running session management migration...')
      await runSessionMigration(client)

      const { rows } = await client.query(
        `SELECT
           COUNT(*)                                        AS total,
           COUNT(*) FILTER (WHERE revoked_at IS NULL)      AS live
         FROM user_sessions`
      )

      await client.query('COMMIT')
      console.log(
        `✅ user_sessions ready — ${rows[0].total} session(s) backfilled, ` +
        `${rows[0].live} still live.`
      )
      process.exit(0)
    } catch (err) {
      await client.query('ROLLBACK')
      console.error('❌ Session migration failed:', err.message)
      process.exit(1)
    } finally {
      client.release()
    }
  })()
}
