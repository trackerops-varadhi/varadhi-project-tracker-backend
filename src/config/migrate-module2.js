/**
 * Module 2 migration — Actionable Push Notifications
 * ---------------------------------------------------------------------------
 * Standalone and fully additive. Every statement is IF NOT EXISTS / ADD COLUMN
 * IF NOT EXISTS, so this is safe to run repeatedly and safe to run against a
 * live database.
 *
 * It is deliberately NOT folded into migrate.js's single transaction: the live
 * schema has drifted from migrate.js (tasks.user_story, tasks.acceptance_criteria
 * and tasks.completed_at were added by hand and appear in neither schema file),
 * so a full migrate.js run is not a reliable prerequisite. The same DDL is
 * mirrored into migrate.js as well, for databases created from scratch.
 *
 *   npm run db:migrate:module2
 */

require('dotenv').config()
const pool = require('./db')

const statements = [
  // -------------------------------------------------------------------------
  // 1. Action state on notifications.
  //
  // `actions` is STORED rather than derived from `type` on read: the set of
  // buttons offered is a property of when the notification was created, so the
  // 172 rows that already exist must not retroactively sprout Approve/Reject.
  //
  // `action_result` stores the first successful response verbatim. A replayed
  // action returns this instead of re-applying — see the idempotency claim in
  // notification-actions.controller.js.
  // -------------------------------------------------------------------------
  {
    label: 'notifications: action columns',
    sql: `
      ALTER TABLE notifications
        ADD COLUMN IF NOT EXISTS actions       JSONB,
        ADD COLUMN IF NOT EXISTS action_taken  VARCHAR(32),
        ADD COLUMN IF NOT EXISTS actioned_at   TIMESTAMP,
        ADD COLUMN IF NOT EXISTS action_result JSONB,
        ADD COLUMN IF NOT EXISTS action_source VARCHAR(20)
    `,
  },

  // -------------------------------------------------------------------------
  // 2. Audit log for delivery + action events (PRD Module 2 business rule:
  //    "Notification delivery and action events are logged for audit").
  //
  // ON DELETE SET NULL, NOT CASCADE: notifications.controller.js#deleteNotification
  // hard-deletes rows, and a cascading audit log would erase exactly the
  // evidence it exists to preserve.
  // -------------------------------------------------------------------------
  {
    label: 'notification_action_log table',
    sql: `
      CREATE TABLE IF NOT EXISTS notification_action_log (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
        user_id         UUID REFERENCES users(id)         ON DELETE SET NULL,
        action          VARCHAR(32) NOT NULL,
        source          VARCHAR(20),
        outcome         VARCHAR(32) NOT NULL,
        resource_type   VARCHAR(32),
        resource_id     UUID,
        detail          JSONB,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `,
  },
  {
    label: 'notification_action_log indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_action_log_notification
        ON notification_action_log (notification_id)
    `,
  },
  {
    label: 'notification_action_log user index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_action_log_user_created
        ON notification_action_log (user_id, created_at DESC)
    `,
  },

  // -------------------------------------------------------------------------
  // 3. Snooze queue (SF4). Drained by a dedicated snooze-cron.js on its own
  //    5-minute schedule — reminder-cron.js (Module 7) is not touched.
  // -------------------------------------------------------------------------
  {
    label: 'notification_snoozes table',
    sql: `
      CREATE TABLE IF NOT EXISTS notification_snoozes (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
        user_id         UUID REFERENCES users(id)         ON DELETE CASCADE,
        wake_at         TIMESTAMP NOT NULL,
        delivered_at    TIMESTAMP,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `,
  },
  {
    label: 'notification_snoozes due index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_snoozes_due
        ON notification_snoozes (wake_at) WHERE delivered_at IS NULL
    `,
  },

  // -------------------------------------------------------------------------
  // 4. Drift repair. schema.sql predates these two columns; a database built
  //    from that file would break notification-engine.js#writeInApp, which
  //    inserts `priority`. No-ops on the live DB, which already has them.
  // -------------------------------------------------------------------------
  {
    label: 'notifications: priority/read_at drift repair',
    sql: `
      ALTER TABLE notifications
        ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'normal',
        ADD COLUMN IF NOT EXISTS read_at  TIMESTAMP
    `,
  },
]

const run = async () => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    console.log('🔄 Running Module 2 migration...')
    for (const { label, sql } of statements) {
      await client.query(sql)
      console.log('   ✓', label)
    }
    await client.query('COMMIT')
    console.log('✅ Module 2 migration complete.')
    process.exit(0)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('❌ Module 2 migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
  }
}

run()
