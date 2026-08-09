require('dotenv').config()
const pool = require('./db')

const createTables = async () => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    console.log('🔄 Running migrations...')

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255),
        role VARCHAR(50) DEFAULT 'employee' CHECK (role IN ('admin','manager','employee')),
        status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active','inactive','invited')),
        avatar VARCHAR(500),
        invite_token VARCHAR(255),
        reset_token VARCHAR(255),
        reset_token_expires TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Projects table
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active','on_hold','completed','archived')),
        manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
        start_date DATE,
        end_date DATE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Project members junction table
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_members (
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (project_id, user_id)
      )
    `)

    // Tasks table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(500) NOT NULL,
        description TEXT,
        status VARCHAR(50) DEFAULT 'todo' CHECK (status IN ('todo','in_progress','in_review','completed')),
        priority VARCHAR(50) DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
        type VARCHAR(50) DEFAULT 'feature' CHECK (type IN ('feature','bug','infra','research','design')),
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
        reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
        due_date DATE,
        estimated_hours DECIMAL(5,2),
        actual_hours DECIMAL(5,2),
        tags TEXT[],
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Comments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        content TEXT NOT NULL,
        task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
        author_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Documents table
    await client.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(500) NOT NULL,
        original_name VARCHAR(500),
        file_type VARCHAR(50),
        file_size BIGINT,
        url VARCHAR(1000),
        description TEXT,
        project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
        uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Notifications table
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  link_to VARCHAR(500),
  priority VARCHAR(20) DEFAULT 'normal',
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
)
    `)
// Notification Preferences table
await client.query(`
  CREATE TABLE IF NOT EXISTS notification_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    push_enabled BOOLEAN DEFAULT TRUE,
    email_enabled BOOLEAN DEFAULT FALSE,
    quiet_hours_enabled BOOLEAN DEFAULT TRUE,
    quiet_hours_start TIME DEFAULT '22:00',
    quiet_hours_end TIME DEFAULT '07:00',
    task_assigned BOOLEAN DEFAULT TRUE,
    task_status_changed BOOLEAN DEFAULT TRUE,
    comment_added BOOLEAN DEFAULT TRUE,
    due_date_reminder BOOLEAN DEFAULT TRUE,
    project_updates BOOLEAN DEFAULT TRUE,
    task_reassigned BOOLEAN DEFAULT TRUE,
    due_date_changed BOOLEAN DEFAULT TRUE,
    priority_changed BOOLEAN DEFAULT TRUE,
    mentions BOOLEAN DEFAULT TRUE,
    review_requests BOOLEAN DEFAULT TRUE,
    approvals BOOLEAN DEFAULT TRUE,
    overdue BOOLEAN DEFAULT TRUE,
    documents BOOLEAN DEFAULT TRUE,
    system_notifications BOOLEAN DEFAULT TRUE,
    reminder_lead_days INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )
`)
// Backfill new preference columns onto tables created before this migration.
await client.query(`
  ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS quiet_hours_enabled BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS task_assigned BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS task_status_changed BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS comment_added BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS due_date_reminder BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS project_updates BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS task_reassigned BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS due_date_changed BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS priority_changed BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS mentions BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS review_requests BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS approvals BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS overdue BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS documents BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS system_notifications BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS reminder_lead_days INTEGER
`)
// Push Subscriptions table
await client.query(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )
`)
await client.query(`
  INSERT INTO notification_preferences (user_id)
  SELECT id FROM users
  ON CONFLICT (user_id) DO NOTHING
`)
// Notification read paths. The dedupe index is the important one:
// notification-engine.js#isDuplicate runs on EVERY dispatch and without this
// it sequentially scans the whole notifications table.
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications (user_id, created_at DESC)
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications (user_id) WHERE is_read = false
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_notifications_dedupe
    ON notifications (user_id, type, created_at DESC)
`)
// Serves notification-engine.js#sendPush's per-user subscription lookup.
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
    ON push_subscriptions (user_id)
`)
// --- Module 2: actionable notifications ---------------------------------
// Mirrored from migrate-module2.js so a from-scratch database matches a
// migrated one. That file remains the one to run against an existing DB.
await client.query(`
  ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS actions       JSONB,
    ADD COLUMN IF NOT EXISTS action_taken  VARCHAR(32),
    ADD COLUMN IF NOT EXISTS actioned_at   TIMESTAMP,
    ADD COLUMN IF NOT EXISTS action_result JSONB,
    ADD COLUMN IF NOT EXISTS action_source VARCHAR(20)
`)
await client.query(`
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
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_action_log_notification
    ON notification_action_log (notification_id)
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_action_log_user_created
    ON notification_action_log (user_id, created_at DESC)
`)
await client.query(`
  CREATE TABLE IF NOT EXISTS notification_snoozes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id)         ON DELETE CASCADE,
    wake_at         TIMESTAMP NOT NULL,
    delivered_at    TIMESTAMP,
    created_at      TIMESTAMP DEFAULT NOW()
  )
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_snoozes_due
    ON notification_snoozes (wake_at) WHERE delivered_at IS NULL
`)
// --- Modules 4 & 5: calendar sync + Teams webhooks ------------------------
// Mirrored from migrate-module45.js for the same reason as Module 2 above:
// that file remains the one to run against an existing DB. TIMESTAMPTZ
// throughout — see the note in migrate-push-retry.js about the offset bug
// the zone-less columns caused.
await client.query(`
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
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_calendar_connections_user
    ON calendar_connections (user_id)
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_calendar_connections_active
    ON calendar_connections (status, last_synced_at) WHERE status = 'connected'
`)
await client.query(`
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
`)
await client.query(`
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
`)
await client.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_links_provider_event
    ON calendar_event_links (connection_id, provider_event_id)
    WHERE provider_event_id IS NOT NULL
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_calendar_links_pending
    ON calendar_event_links (connection_id, state) WHERE state IN ('pending','dirty')
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_calendar_links_source
    ON calendar_event_links (source_type, source_id)
`)
await client.query(`
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
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_calendar_conflicts_unresolved
    ON calendar_sync_conflicts (connection_id, detected_at DESC) WHERE resolved_at IS NULL
`)
await client.query(`
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
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_teams_webhooks_project_enabled
    ON teams_webhooks (project_id) WHERE enabled = TRUE
`)
await client.query(`
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
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_teams_delivery_webhook_created
    ON teams_delivery_log (webhook_id, created_at DESC)
`)
await client.query(`
  CREATE INDEX IF NOT EXISTS idx_teams_delivery_due
    ON teams_delivery_log (next_attempt_at) WHERE status = 'pending'
`)

    // Leave requests table
    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        days INTEGER NOT NULL DEFAULT 1,
        type VARCHAR(30) NOT NULL DEFAULT 'annual',
        reason TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)

    // Time logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS time_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        hours NUMERIC(5,2) NOT NULL DEFAULT 0,
        note TEXT,
        check_in TIMESTAMP,
        check_out TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)

    await client.query('COMMIT')
    console.log('✅ All tables created successfully!')
    process.exit(0)
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('❌ Migration failed:', err.message)
    process.exit(1)
  } finally {
    client.release()
  }
}

createTables()
