/**
 * Module 4 + 5 migration — Calendar Sync and Microsoft Teams Webhooks
 * ---------------------------------------------------------------------------
 * Standalone and fully additive, following migrate-module2.js: every statement
 * is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so this is safe to run
 * repeatedly and safe to run against a live database.
 *
 * It is deliberately NOT folded into migrate.js's single transaction for the
 * reason documented there — the live schema has drifted from migrate.js, so a
 * full migrate.js run is not a reliable prerequisite. The same DDL is mirrored
 * into migrate.js for databases created from scratch.
 *
 * TIMESTAMPTZ throughout. migrate-push-retry.js:28-31 records why: the older
 * zone-less TIMESTAMP columns produced an offset bug that defeated backoff
 * scheduling. Calendar sync is entirely about instants in time across zones,
 * so getting this wrong would be considerably worse here.
 *
 *   npm run db:migrate:module45
 */

require('dotenv').config()
const pool = require('./db')

const statements = [
  // ==========================================================================
  // MODULE 4 — Calendar Sync
  // ==========================================================================

  // --------------------------------------------------------------------------
  // One row per (user, provider). The PRD constrains v1 to "one active calendar
  // connection per user per provider", which the UNIQUE constraint enforces at
  // the database rather than trusting every code path to check first.
  //
  // Tokens are stored as ciphertext from utils/crypto.js, never plaintext.
  // They are TEXT, not VARCHAR(n): the encrypted blob is meaningfully longer
  // than the token and providers do not document a maximum length.
  //
  // `sync_token` is the provider's delta cursor (Google syncToken / Graph
  // deltaLink). Keeping it is what makes the inbound pass incremental instead
  // of re-listing the whole calendar every five minutes.
  // --------------------------------------------------------------------------
  {
    label: 'calendar_connections table',
    sql: `
      CREATE TABLE IF NOT EXISTS calendar_connections (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider          VARCHAR(20) NOT NULL CHECK (provider IN ('google','outlook')),
        account_email     VARCHAR(255),
        calendar_id       VARCHAR(255),
        access_token      TEXT,
        refresh_token     TEXT,
        token_expires_at  TIMESTAMPTZ,
        sync_token        TEXT,
        status            VARCHAR(20) NOT NULL DEFAULT 'connected'
                            CHECK (status IN ('connected','disconnected','error','paused')),
        last_synced_at    TIMESTAMPTZ,
        last_error        TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT calendar_connections_user_provider_key UNIQUE (user_id, provider)
      )
    `,
  },
  {
    label: 'calendar_connections user index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_calendar_connections_user
        ON calendar_connections (user_id)
    `,
  },
  // Serves the cron's "which connections are due a sync" sweep.
  {
    label: 'calendar_connections active index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_calendar_connections_active
        ON calendar_connections (status, last_synced_at)
        WHERE status = 'connected'
    `,
  },

  // --------------------------------------------------------------------------
  // Settings live in their own table rather than as columns on the connection
  // because they survive a reconnect: a user who disconnects and reauthorises
  // Google should not silently lose their "milestones only, don't sync
  // reminders" configuration.
  //
  // `project_scope` NULL means "all projects" — distinct from an empty array,
  // which would mean "no projects" and sync nothing. US-5 of the PRD.
  // --------------------------------------------------------------------------
  {
    label: 'calendar_sync_settings table',
    sql: `
      CREATE TABLE IF NOT EXISTS calendar_sync_settings (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        connection_id     UUID NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
        sync_direction    VARCHAR(20) NOT NULL DEFAULT 'two_way'
                            CHECK (sync_direction IN ('two_way','to_calendar','from_calendar')),
        sync_tasks        BOOLEAN NOT NULL DEFAULT TRUE,
        sync_meetings     BOOLEAN NOT NULL DEFAULT TRUE,
        sync_milestones   BOOLEAN NOT NULL DEFAULT TRUE,
        sync_reminders    BOOLEAN NOT NULL DEFAULT TRUE,
        default_calendar  VARCHAR(20) DEFAULT 'google',
        time_zone         VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
        due_time_of_day   VARCHAR(5) NOT NULL DEFAULT '09:00',
        conflict_policy   VARCHAR(20) NOT NULL DEFAULT 'tracker_wins'
                            CHECK (conflict_policy IN ('tracker_wins','calendar_wins','manual')),
        project_scope     UUID[],
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT calendar_sync_settings_connection_key UNIQUE (connection_id)
      )
    `,
  },

  // --------------------------------------------------------------------------
  // The dedupe spine. Every synced item has exactly one link row per connection,
  // and the two UNIQUE constraints are what make duplicate calendar events
  // structurally impossible rather than merely unlikely:
  //
  //   (connection_id, source_type, source_id)   one event per tracker item
  //   (connection_id, provider_event_id)        one tracker item per event
  //
  // A concurrent double-sync therefore collides at the database instead of
  // quietly creating a second event on the user's calendar.
  //
  // `content_hash` is the second dedupe layer and the cheaper one: if the hash
  // of the mapped payload is unchanged, the sync skips the provider write
  // entirely. That is what keeps a 5-minute cron from burning API quota
  // re-pushing identical events (the PRD's rate-limit risk).
  //
  // `remote_etag` is the provider's own version marker, used for the other half
  // of conflict detection — it tells us the calendar side changed.
  // --------------------------------------------------------------------------
  {
    label: 'calendar_event_links table',
    sql: `
      CREATE TABLE IF NOT EXISTS calendar_event_links (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        connection_id     UUID NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
        source_type       VARCHAR(20) NOT NULL
                            CHECK (source_type IN ('task','milestone','meeting','reminder')),
        source_id         UUID NOT NULL,
        provider_event_id VARCHAR(512),
        content_hash      VARCHAR(64),
        remote_etag       VARCHAR(512),
        recurrence_rule   TEXT,
        state             VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending','synced','dirty','deleted','error')),
        last_pushed_at    TIMESTAMPTZ,
        last_pulled_at    TIMESTAMPTZ,
        last_error        TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT calendar_event_links_source_key
          UNIQUE (connection_id, source_type, source_id)
      )
    `,
  },
  // Partial unique: provider_event_id is NULL until the first successful push,
  // and several rows may legitimately sit at NULL simultaneously.
  {
    label: 'calendar_event_links provider event unique',
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_links_provider_event
        ON calendar_event_links (connection_id, provider_event_id)
        WHERE provider_event_id IS NOT NULL
    `,
  },
  // Serves the outbound pass: "which links need pushing".
  {
    label: 'calendar_event_links pending index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_calendar_links_pending
        ON calendar_event_links (connection_id, state)
        WHERE state IN ('pending','dirty')
    `,
  },
  // Serves the task lifecycle hook, which marks links dirty by source_id
  // without knowing which connections exist.
  {
    label: 'calendar_event_links source index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_calendar_links_source
        ON calendar_event_links (source_type, source_id)
    `,
  },

  // --------------------------------------------------------------------------
  // AC-20: a conflict is a *recorded* event, not a transient one. Even under
  // the default tracker_wins policy the user must be "notified of the
  // overwrite", which means there has to be something durable to notify about
  // and to show in the Conflict Resolution UI.
  //
  // ON DELETE CASCADE from the link: if the underlying link is gone, a conflict
  // about it is meaningless.
  // --------------------------------------------------------------------------
  {
    label: 'calendar_sync_conflicts table',
    sql: `
      CREATE TABLE IF NOT EXISTS calendar_sync_conflicts (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        link_id         UUID NOT NULL REFERENCES calendar_event_links(id) ON DELETE CASCADE,
        connection_id   UUID NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
        conflict_type   VARCHAR(20) NOT NULL DEFAULT 'update'
                          CHECK (conflict_type IN ('update','time','deletion')),
        field           VARCHAR(64),
        tracker_value   TEXT,
        provider_value  TEXT,
        resolution      VARCHAR(20)
                          CHECK (resolution IN ('use_tracker','use_calendar','keep_both','reschedule','delete_everywhere','keep_event')),
        resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
        resolved_at     TIMESTAMPTZ,
        detected_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `,
  },
  {
    label: 'calendar_sync_conflicts unresolved index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_calendar_conflicts_unresolved
        ON calendar_sync_conflicts (connection_id, detected_at DESC)
        WHERE resolved_at IS NULL
    `,
  },

  // ==========================================================================
  // MODULE 5 — Microsoft Teams Webhooks
  // ==========================================================================

  // --------------------------------------------------------------------------
  // One webhook per (project, channel) — the PRD's v1 constraint is "one
  // webhook per channel per project", so project_id is NOT unique on its own;
  // a project may post to more than one channel, but not twice to the same one.
  // Uniqueness is enforced on url_hint rather than the ciphertext, because
  // AES-GCM is randomised: encrypting the same URL twice yields different
  // blobs, so a UNIQUE constraint on webhook_url would never fire.
  //
  // `webhook_url` is write-only from the API's perspective — it is decrypted
  // only inside teams-delivery.js at the moment of posting. `url_hint` is the
  // masked form and the ONLY thing any response body or log line may contain.
  //
  // event_types is a TEXT[] of notification-engine type constants. NULL would
  // be ambiguous, so the default is the explicit "sensible starter set".
  // --------------------------------------------------------------------------
  {
    label: 'teams_webhooks table',
    sql: `
      CREATE TABLE IF NOT EXISTS teams_webhooks (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
        name            VARCHAR(120),
        webhook_url     TEXT NOT NULL,
        url_hint        VARCHAR(255) NOT NULL,
        event_types     TEXT[] NOT NULL DEFAULT ARRAY[
                          'task_assigned','task_status_changed','task_comment',
                          'task_reminder','review_requested'
                        ]::TEXT[],
        enabled         BOOLEAN NOT NULL DEFAULT TRUE,
        summary_digest  VARCHAR(20) NOT NULL DEFAULT 'off'
                          CHECK (summary_digest IN ('off','daily','weekly')),
        failure_count   INTEGER NOT NULL DEFAULT 0,
        disabled_reason TEXT,
        last_success_at TIMESTAMPTZ,
        last_failure_at TIMESTAMPTZ,
        created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT teams_webhooks_project_hint_key UNIQUE (project_id, url_hint)
      )
    `,
  },
  // Serves the fan-out hot path: "which enabled webhooks want this project's
  // events". Runs on every dispatched notification, so it must not seq-scan.
  {
    label: 'teams_webhooks active project index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_teams_webhooks_project_enabled
        ON teams_webhooks (project_id)
        WHERE enabled = TRUE
    `,
  },

  // --------------------------------------------------------------------------
  // Delivery log — powers the Webhook Health screen (PRD screen flow 22) and
  // the retry queue in one table.
  //
  // ON DELETE CASCADE is right here, unlike notification_action_log's SET NULL:
  // that log preserves evidence of a user's action, whereas this is operational
  // telemetry about a webhook. Once the webhook is gone the history has no
  // subject and no audit value.
  //
  // `payload` is the rendered Adaptive Card, which contains only what was
  // already posted to the channel — it must never contain the webhook URL.
  // --------------------------------------------------------------------------
  {
    label: 'teams_delivery_log table',
    sql: `
      CREATE TABLE IF NOT EXISTS teams_delivery_log (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        webhook_id      UUID NOT NULL REFERENCES teams_webhooks(id) ON DELETE CASCADE,
        event_type      VARCHAR(100),
        card_kind       VARCHAR(40),
        status          VARCHAR(16) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','sent','failed','exhausted','dropped')),
        http_status     INTEGER,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        payload         JSONB,
        error           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `,
  },
  {
    label: 'teams_delivery_log history index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_teams_delivery_webhook_created
        ON teams_delivery_log (webhook_id, created_at DESC)
    `,
  },
  // Serves the retry sweep.
  {
    label: 'teams_delivery_log retry index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_teams_delivery_due
        ON teams_delivery_log (next_attempt_at)
        WHERE status = 'pending'
    `,
  },
]

const run = async () => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    console.log('🔄 Running Module 4 + 5 migration (Calendar Sync, Teams Webhooks)...')
    for (const { label, sql } of statements) {
      await client.query(sql)
      console.log('   ✓', label)
    }
    await client.query('COMMIT')
    console.log('✅ Module 4 + 5 migration complete.')
    process.exit(0)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('❌ Module 4 + 5 migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
  }
}

run()
