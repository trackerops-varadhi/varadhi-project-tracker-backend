/*
 * user_tokens migration.
 *
 * Holds refresh token hashes and the rotation chain. Session identity lives in
 * `user_sessions` (migrate-sessions.js) — see that file for the split.
 *
 * Restructured to the export + `require.main === module` guard that
 * migrate-bugs.js uses. Previously this file called its migration at module
 * load and then `process.exit()`, which meant merely REQUIRING it from
 * anywhere — migrate.js included — ran the migration and terminated the host
 * process. Forking it (as server.js does) still behaves exactly as before,
 * because a forked file is its own main module.
 */

require('dotenv').config()
const pool = require('./db')

// Statement list is shared with migrate.js so the two can never drift.
const USER_TOKEN_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_tokens (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

     token_type VARCHAR(20) NOT NULL
       CHECK (token_type IN ('access', 'refresh')),

     token_hash TEXT NOT NULL UNIQUE,

     session_id UUID NOT NULL,
     refresh_family_id UUID,

     expires_at TIMESTAMPTZ NOT NULL,
     revoked_at TIMESTAMPTZ,
     replaced_by_token_id UUID REFERENCES user_tokens(id) ON DELETE SET NULL,

     user_agent TEXT,
     ip_address TEXT,

     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE INDEX IF NOT EXISTS idx_user_tokens_user_id
     ON user_tokens (user_id)`,

  `CREATE INDEX IF NOT EXISTS idx_user_tokens_session_id
     ON user_tokens (session_id)`,

  `CREATE INDEX IF NOT EXISTS idx_user_tokens_active_lookup
     ON user_tokens (token_hash, token_type)
     WHERE revoked_at IS NULL`,

  `CREATE INDEX IF NOT EXISTS idx_user_tokens_expiry
     ON user_tokens (expires_at)`,
]

async function runUserTokensMigration(client) {
  for (const statement of USER_TOKEN_MIGRATION_STATEMENTS) {
    await client.query(statement)
  }
}

module.exports = { USER_TOKEN_MIGRATION_STATEMENTS, runUserTokensMigration }

// Only self-execute when invoked directly (`node src/config/migrate-user-tokens.js`,
// or forked from server.js), never when required by migrate.js.
if (require.main === module) {
  ;(async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      console.log('Running user_tokens migration...')
      await runUserTokensMigration(client)
      await client.query('COMMIT')
      console.log('user_tokens migration completed successfully.')
      process.exit(0)
    } catch (err) {
      await client.query('ROLLBACK')
      console.error('user_tokens migration failed:', err.message)
      process.exit(1)
    } finally {
      client.release()
    }
  })()
}
