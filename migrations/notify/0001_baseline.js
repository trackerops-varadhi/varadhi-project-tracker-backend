/*
 * notify — 0001 baseline
 * ---------------------------------------------------------------------------
 * Tables: notifications / notification_preferences / notification_snoozes / notification_action_log / notification_logs / push_subscriptions / push_delivery_retries
 *
 * WHAT THIS IS
 * The exact shape of the notify schema after the Phase 2 split, captured from a
 * database provisioned by the old migrate.js and then migrated by
 * migrate-schema-split.js. Every later migration in this directory builds on it.
 *
 * WHY RAW SQL RATHER THAN pgm.createTable(...)
 * A baseline's only job is to reproduce an existing schema EXACTLY. Hand-
 * translating 29 statements into the builder API would introduce drift in
 * precisely the place drift is most expensive — the definition every subsequent
 * migration assumes. Later migrations here should use the builder; this one is a
 * faithful transcript.
 *
 * NO CROSS-MODULE FOREIGN KEYS
 * Every constraint below points inside notify. The 31 that crossed a module
 * boundary were dropped by the schema split on purpose and must not come back —
 * a foreign key cannot span two services. Within-module cascades are preserved.
 *
 * ON AN EXISTING DATABASE (dev, production) THIS MUST NOT RUN.
 * Those already hold these tables. Mark it applied instead:
 *     npm run migrate:baseline
 * which writes the ledger row without executing the body.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.sql(`
CREATE SCHEMA IF NOT EXISTS notify;
CREATE TABLE notify.notification_action_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid,
    user_id uuid,
    action character varying(32) NOT NULL,
    source character varying(20),
    outcome character varying(32) NOT NULL,
    resource_type character varying(32),
    resource_id uuid,
    detail jsonb,
    created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE notify.notification_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    type character varying(100),
    title character varying(255),
    priority character varying(20),
    status character varying(30) NOT NULL,
    channels jsonb,
    error_message text,
    created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE notify.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    push_enabled boolean DEFAULT true,
    email_enabled boolean DEFAULT false,
    quiet_hours_enabled boolean DEFAULT true,
    quiet_hours_start time without time zone DEFAULT '22:00:00'::time without time zone,
    quiet_hours_end time without time zone DEFAULT '07:00:00'::time without time zone,
    task_assigned boolean DEFAULT true,
    task_status_changed boolean DEFAULT true,
    comment_added boolean DEFAULT true,
    due_date_reminder boolean DEFAULT true,
    project_updates boolean DEFAULT true,
    task_reassigned boolean DEFAULT true,
    due_date_changed boolean DEFAULT true,
    priority_changed boolean DEFAULT true,
    mentions boolean DEFAULT true,
    review_requests boolean DEFAULT true,
    approvals boolean DEFAULT true,
    overdue boolean DEFAULT true,
    documents boolean DEFAULT true,
    system_notifications boolean DEFAULT true,
    reminder_lead_days integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);
CREATE TABLE notify.notification_snoozes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid,
    user_id uuid,
    wake_at timestamp without time zone NOT NULL,
    delivered_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);
CREATE TABLE notify.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    type character varying(100) NOT NULL,
    title character varying(255) NOT NULL,
    message text,
    link_to character varying(500),
    priority character varying(20) DEFAULT 'normal'::character varying,
    is_read boolean DEFAULT false,
    read_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    actions jsonb,
    action_taken character varying(32),
    actioned_at timestamp without time zone,
    action_result jsonb,
    action_source character varying(20)
);
CREATE TABLE notify.push_delivery_retries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid,
    user_id uuid,
    subscription_id uuid,
    payload jsonb NOT NULL,
    send_options jsonb,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    last_status integer,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE notify.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp without time zone DEFAULT now()
);
ALTER TABLE ONLY notify.notification_action_log
    ADD CONSTRAINT notification_action_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY notify.notification_logs
    ADD CONSTRAINT notification_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY notify.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);
ALTER TABLE ONLY notify.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_key UNIQUE (user_id);
ALTER TABLE ONLY notify.notification_snoozes
    ADD CONSTRAINT notification_snoozes_pkey PRIMARY KEY (id);
ALTER TABLE ONLY notify.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE ONLY notify.push_delivery_retries
    ADD CONSTRAINT push_delivery_retries_pkey PRIMARY KEY (id);
ALTER TABLE ONLY notify.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);
ALTER TABLE ONLY notify.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);
CREATE INDEX idx_action_log_notification ON notify.notification_action_log USING btree (notification_id);
CREATE INDEX idx_action_log_user_created ON notify.notification_action_log USING btree (user_id, created_at DESC);
CREATE INDEX idx_notification_logs_user_created ON notify.notification_logs USING btree (user_id, created_at DESC);
CREATE INDEX idx_notifications_dedupe ON notify.notifications USING btree (user_id, type, created_at DESC);
CREATE INDEX idx_notifications_user_created ON notify.notifications USING btree (user_id, created_at DESC);
CREATE INDEX idx_notifications_user_unread ON notify.notifications USING btree (user_id) WHERE (is_read = false);
CREATE INDEX idx_push_retries_due ON notify.push_delivery_retries USING btree (next_attempt_at) WHERE ((status)::text = 'pending'::text);
CREATE INDEX idx_push_subscriptions_user ON notify.push_subscriptions USING btree (user_id);
CREATE INDEX idx_snoozes_due ON notify.notification_snoozes USING btree (wake_at) WHERE (delivered_at IS NULL);
ALTER TABLE ONLY notify.notification_action_log
    ADD CONSTRAINT notification_action_log_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES notify.notifications(id) ON DELETE SET NULL;
ALTER TABLE ONLY notify.notification_snoozes
    ADD CONSTRAINT notification_snoozes_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES notify.notifications(id) ON DELETE CASCADE;
ALTER TABLE ONLY notify.push_delivery_retries
    ADD CONSTRAINT push_delivery_retries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES notify.notifications(id) ON DELETE CASCADE;
`)
}

/*
 * Down drops exactly what up created — the tables and the sequence — and
 * NOTHING else.
 *
 * It deliberately does NOT "DROP SCHEMA notify CASCADE", which is the obvious
 * thing to write and is wrong. This module's migration ledger
 * (notify.pgmigrations) lives in this schema; dropping the schema takes the
 * ledger with it, and node-pg-migrate then fails deleting the ledger row for the
 * migration it just reversed:
 *
 *     relation "notify.pgmigrations" does not exist
 *
 * which leaves the database fully migrated while reporting the rollback as
 * failed. The schema stays, holding only the ledger; the runner recreates it on
 * demand anyway.
 *
 * CASCADE on each table handles the within-module foreign keys, which are
 * preserved by design and would otherwise block the drops.
 *
 * Destructive. The runner refuses "down" against any non-loopback target.
 */
exports.down = (pgm) => {
  pgm.sql(`
DROP TABLE IF EXISTS notify.notification_action_log CASCADE;
DROP TABLE IF EXISTS notify.notification_logs CASCADE;
DROP TABLE IF EXISTS notify.notification_preferences CASCADE;
DROP TABLE IF EXISTS notify.notification_snoozes CASCADE;
DROP TABLE IF EXISTS notify.notifications CASCADE;
DROP TABLE IF EXISTS notify.push_delivery_retries CASCADE;
DROP TABLE IF EXISTS notify.push_subscriptions CASCADE;
`)
}
