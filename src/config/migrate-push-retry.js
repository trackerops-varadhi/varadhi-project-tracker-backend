/**
 * Additive migration: failed-push retry queue (AC-10, second half).
 *
 * Standalone and idempotent, following the migrate-module2.js precedent: the
 * live database carries hand-applied drift, so a narrow additive script is safe
 * to run against production regardless of how it got to its current shape.
 *
 *   npm run db:migrate:push-retry
 */
require('dotenv').config()
const pool = require('./db')

const STATEMENTS = [
  // One row per (notification, subscription) delivery attempt that failed
  // transiently. Permanent failures are never enqueued — see push-retry.js.
  `CREATE TABLE IF NOT EXISTS push_delivery_retries (
     id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
     user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
     subscription_id UUID,
     payload         JSONB NOT NULL,
     send_options    JSONB,
     attempts        INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_error      TEXT,
     last_status     INTEGER,
     status          VARCHAR(16) NOT NULL DEFAULT 'pending',
     -- TIMESTAMPTZ deliberately, unlike the older tables. A zone-less timestamp
     -- loses the offset: NOW() writes DB-local wall clock and node-postgres
     -- reads it back as CLIENT-local, shifting every value by the client
     -- offset. That made each retry instantly due and defeated backoff.
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // The cron's claim query: due, still pending, oldest first.
  `CREATE INDEX IF NOT EXISTS idx_push_retries_due
     ON push_delivery_retries (next_attempt_at)
     WHERE status = 'pending'`,

  // One retry row per notification+subscription. This is the duplicate guard:
  // a second failure for the same pair updates the existing row rather than
  // queueing a second delivery of the same notification.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_push_retries_unique
     ON push_delivery_retries (notification_id, subscription_id)`,

  `CREATE INDEX IF NOT EXISTS idx_push_retries_user
     ON push_delivery_retries (user_id)`,
]

async function run() {
  const client = await pool.connect()
  try {
    for (const sql of STATEMENTS) {
      await client.query(sql)
      console.log('  ok:', sql.split('\n')[0].trim().slice(0, 68))
    }
    console.log('\npush-retry migration complete.')
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((err) => {
  console.error('push-retry migration failed:', err.message)
  process.exit(1)
})
