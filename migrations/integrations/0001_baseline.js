/*
 * integrations — 0001 baseline
 * ---------------------------------------------------------------------------
 * Tables: calendar_connections / calendar_sync_settings / calendar_event_links / calendar_sync_conflicts / teams_webhooks / teams_delivery_log
 *
 * WHAT THIS IS
 * The exact shape of the integrations schema after the Phase 2 split, captured from a
 * database provisioned by the old migrate.js and then migrated by
 * migrate-schema-split.js. Every later migration in this directory builds on it.
 *
 * WHY RAW SQL RATHER THAN pgm.createTable(...)
 * A baseline's only job is to reproduce an existing schema EXACTLY. Hand-
 * translating 31 statements into the builder API would introduce drift in
 * precisely the place drift is most expensive — the definition every subsequent
 * migration assumes. Later migrations here should use the builder; this one is a
 * faithful transcript.
 *
 * NO CROSS-MODULE FOREIGN KEYS
 * Every constraint below points inside integrations. The 31 that crossed a module
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
CREATE SCHEMA IF NOT EXISTS integrations;
CREATE TABLE integrations.calendar_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider character varying(20) NOT NULL,
    account_email character varying(255),
    calendar_id character varying(255),
    access_token text,
    refresh_token text,
    token_expires_at timestamp with time zone,
    sync_token text,
    status character varying(20) DEFAULT 'connected'::character varying NOT NULL,
    last_synced_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT calendar_connections_provider_check CHECK (((provider)::text = ANY ((ARRAY['google'::character varying, 'outlook'::character varying])::text[]))),
    CONSTRAINT calendar_connections_status_check CHECK (((status)::text = ANY ((ARRAY['connected'::character varying, 'disconnected'::character varying, 'error'::character varying, 'paused'::character varying])::text[])))
);
CREATE TABLE integrations.calendar_event_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    connection_id uuid NOT NULL,
    source_type character varying(20) NOT NULL,
    source_id uuid NOT NULL,
    provider_event_id character varying(512),
    content_hash character varying(64),
    remote_etag character varying(512),
    recurrence_rule text,
    state character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    last_pushed_at timestamp with time zone,
    last_pulled_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT calendar_event_links_source_type_check CHECK (((source_type)::text = ANY ((ARRAY['task'::character varying, 'milestone'::character varying, 'meeting'::character varying, 'reminder'::character varying])::text[]))),
    CONSTRAINT calendar_event_links_state_check CHECK (((state)::text = ANY ((ARRAY['pending'::character varying, 'synced'::character varying, 'dirty'::character varying, 'deleted'::character varying, 'error'::character varying])::text[])))
);
CREATE TABLE integrations.calendar_sync_conflicts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    link_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    conflict_type character varying(20) DEFAULT 'update'::character varying NOT NULL,
    field character varying(64),
    tracker_value text,
    provider_value text,
    resolution character varying(20),
    resolved_by uuid,
    resolved_at timestamp with time zone,
    detected_at timestamp with time zone DEFAULT now(),
    CONSTRAINT calendar_sync_conflicts_conflict_type_check CHECK (((conflict_type)::text = ANY ((ARRAY['update'::character varying, 'time'::character varying, 'deletion'::character varying])::text[]))),
    CONSTRAINT calendar_sync_conflicts_resolution_check CHECK (((resolution)::text = ANY ((ARRAY['use_tracker'::character varying, 'use_calendar'::character varying, 'keep_both'::character varying, 'reschedule'::character varying, 'delete_everywhere'::character varying, 'keep_event'::character varying])::text[])))
);
CREATE TABLE integrations.calendar_sync_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    connection_id uuid NOT NULL,
    sync_direction character varying(20) DEFAULT 'two_way'::character varying NOT NULL,
    sync_tasks boolean DEFAULT true NOT NULL,
    sync_meetings boolean DEFAULT true NOT NULL,
    sync_milestones boolean DEFAULT true NOT NULL,
    sync_reminders boolean DEFAULT true NOT NULL,
    default_calendar character varying(20) DEFAULT 'google'::character varying,
    time_zone character varying(64) DEFAULT 'Asia/Kolkata'::character varying NOT NULL,
    due_time_of_day character varying(5) DEFAULT '09:00'::character varying NOT NULL,
    conflict_policy character varying(20) DEFAULT 'tracker_wins'::character varying NOT NULL,
    project_scope uuid[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT calendar_sync_settings_conflict_policy_check CHECK (((conflict_policy)::text = ANY ((ARRAY['tracker_wins'::character varying, 'calendar_wins'::character varying, 'manual'::character varying])::text[]))),
    CONSTRAINT calendar_sync_settings_sync_direction_check CHECK (((sync_direction)::text = ANY ((ARRAY['two_way'::character varying, 'to_calendar'::character varying, 'from_calendar'::character varying])::text[])))
);
CREATE TABLE integrations.teams_delivery_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    webhook_id uuid NOT NULL,
    event_type character varying(100),
    card_kind character varying(40),
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    http_status integer,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    payload jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT teams_delivery_log_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'sent'::character varying, 'failed'::character varying, 'exhausted'::character varying, 'dropped'::character varying])::text[])))
);
CREATE TABLE integrations.teams_webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    name character varying(120),
    webhook_url text NOT NULL,
    url_hint character varying(255) NOT NULL,
    event_types text[] DEFAULT ARRAY['task_assigned'::text, 'task_status_changed'::text, 'task_comment'::text, 'task_reminder'::text, 'review_requested'::text] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    summary_digest character varying(20) DEFAULT 'off'::character varying NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    disabled_reason text,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT teams_webhooks_summary_digest_check CHECK (((summary_digest)::text = ANY ((ARRAY['off'::character varying, 'daily'::character varying, 'weekly'::character varying])::text[])))
);
ALTER TABLE ONLY integrations.calendar_connections
    ADD CONSTRAINT calendar_connections_pkey PRIMARY KEY (id);
ALTER TABLE ONLY integrations.calendar_connections
    ADD CONSTRAINT calendar_connections_user_provider_key UNIQUE (user_id, provider);
ALTER TABLE ONLY integrations.calendar_event_links
    ADD CONSTRAINT calendar_event_links_pkey PRIMARY KEY (id);
ALTER TABLE ONLY integrations.calendar_event_links
    ADD CONSTRAINT calendar_event_links_source_key UNIQUE (connection_id, source_type, source_id);
ALTER TABLE ONLY integrations.calendar_sync_conflicts
    ADD CONSTRAINT calendar_sync_conflicts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY integrations.calendar_sync_settings
    ADD CONSTRAINT calendar_sync_settings_connection_key UNIQUE (connection_id);
ALTER TABLE ONLY integrations.calendar_sync_settings
    ADD CONSTRAINT calendar_sync_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY integrations.teams_delivery_log
    ADD CONSTRAINT teams_delivery_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY integrations.teams_webhooks
    ADD CONSTRAINT teams_webhooks_pkey PRIMARY KEY (id);
ALTER TABLE ONLY integrations.teams_webhooks
    ADD CONSTRAINT teams_webhooks_project_hint_key UNIQUE (project_id, url_hint);
CREATE INDEX idx_calendar_conflicts_unresolved ON integrations.calendar_sync_conflicts USING btree (connection_id, detected_at DESC) WHERE (resolved_at IS NULL);
CREATE INDEX idx_calendar_connections_active ON integrations.calendar_connections USING btree (status, last_synced_at) WHERE ((status)::text = 'connected'::text);
CREATE INDEX idx_calendar_connections_user ON integrations.calendar_connections USING btree (user_id);
CREATE INDEX idx_calendar_links_pending ON integrations.calendar_event_links USING btree (connection_id, state) WHERE ((state)::text = ANY ((ARRAY['pending'::character varying, 'dirty'::character varying])::text[]));
CREATE UNIQUE INDEX idx_calendar_links_provider_event ON integrations.calendar_event_links USING btree (connection_id, provider_event_id) WHERE (provider_event_id IS NOT NULL);
CREATE INDEX idx_calendar_links_source ON integrations.calendar_event_links USING btree (source_type, source_id);
CREATE INDEX idx_teams_delivery_due ON integrations.teams_delivery_log USING btree (next_attempt_at) WHERE ((status)::text = 'pending'::text);
CREATE INDEX idx_teams_delivery_webhook_created ON integrations.teams_delivery_log USING btree (webhook_id, created_at DESC);
CREATE INDEX idx_teams_webhooks_project_enabled ON integrations.teams_webhooks USING btree (project_id) WHERE (enabled = true);
ALTER TABLE ONLY integrations.calendar_event_links
    ADD CONSTRAINT calendar_event_links_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES integrations.calendar_connections(id) ON DELETE CASCADE;
ALTER TABLE ONLY integrations.calendar_sync_conflicts
    ADD CONSTRAINT calendar_sync_conflicts_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES integrations.calendar_connections(id) ON DELETE CASCADE;
ALTER TABLE ONLY integrations.calendar_sync_conflicts
    ADD CONSTRAINT calendar_sync_conflicts_link_id_fkey FOREIGN KEY (link_id) REFERENCES integrations.calendar_event_links(id) ON DELETE CASCADE;
ALTER TABLE ONLY integrations.calendar_sync_settings
    ADD CONSTRAINT calendar_sync_settings_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES integrations.calendar_connections(id) ON DELETE CASCADE;
ALTER TABLE ONLY integrations.teams_delivery_log
    ADD CONSTRAINT teams_delivery_log_webhook_id_fkey FOREIGN KEY (webhook_id) REFERENCES integrations.teams_webhooks(id) ON DELETE CASCADE;
`)
}

/*
 * Down drops exactly what up created — the tables and the sequence — and
 * NOTHING else.
 *
 * It deliberately does NOT "DROP SCHEMA integrations CASCADE", which is the obvious
 * thing to write and is wrong. This module's migration ledger
 * (integrations.pgmigrations) lives in this schema; dropping the schema takes the
 * ledger with it, and node-pg-migrate then fails deleting the ledger row for the
 * migration it just reversed:
 *
 *     relation "integrations.pgmigrations" does not exist
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
DROP TABLE IF EXISTS integrations.calendar_connections CASCADE;
DROP TABLE IF EXISTS integrations.calendar_event_links CASCADE;
DROP TABLE IF EXISTS integrations.calendar_sync_conflicts CASCADE;
DROP TABLE IF EXISTS integrations.calendar_sync_settings CASCADE;
DROP TABLE IF EXISTS integrations.teams_delivery_log CASCADE;
DROP TABLE IF EXISTS integrations.teams_webhooks CASCADE;
`)
}
