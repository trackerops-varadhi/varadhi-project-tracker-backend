/*
 * defects — 0001 baseline
 * ---------------------------------------------------------------------------
 * Tables: bugs / bug_comments / bug_attachments / bug_activity_logs / bug_sla_rules
 *
 * WHAT THIS IS
 * The exact shape of the defects schema after the Phase 2 split, captured from a
 * database provisioned by the old migrate.js and then migrated by
 * migrate-schema-split.js. Every later migration in this directory builds on it.
 *
 * WHY RAW SQL RATHER THAN pgm.createTable(...)
 * A baseline's only job is to reproduce an existing schema EXACTLY. Hand-
 * translating 34 statements into the builder API would introduce drift in
 * precisely the place drift is most expensive — the definition every subsequent
 * migration assumes. Later migrations here should use the builder; this one is a
 * faithful transcript.
 *
 * NO CROSS-MODULE FOREIGN KEYS
 * Every constraint below points inside defects. The 31 that crossed a module
 * boundary were dropped by the schema split on purpose and must not come back —
 * a foreign key cannot span two services. Within-module cascades are preserved.
 *
 * ON AN EXISTING DATABASE (dev, production) THIS MUST NOT RUN.
 * Those already hold these tables. Mark it applied instead:
 *     npm run migrate:baseline
 * which writes the ledger row without executing the body.
 */

/* eslint-disable camelcase */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.sql(`
CREATE SCHEMA IF NOT EXISTS defects;
CREATE TABLE defects.bug_activity_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bug_id uuid NOT NULL,
    actor_id uuid,
    action character varying(40) NOT NULL,
    field character varying(60),
    old_value text,
    new_value text,
    detail jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE defects.bug_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bug_id uuid NOT NULL,
    document_id uuid,
    file_name character varying(500) NOT NULL,
    file_type character varying(50),
    file_size bigint,
    url character varying(1000) NOT NULL,
    storage_path character varying(1000),
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE defects.bug_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bug_id uuid NOT NULL,
    author_id uuid,
    content text NOT NULL,
    edited boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE defects.bug_number_seq
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
CREATE TABLE defects.bug_sla_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    severity character varying(20) NOT NULL,
    response_minutes integer NOT NULL,
    resolution_minutes integer NOT NULL,
    at_risk_threshold numeric(3,2) DEFAULT 0.75 NOT NULL,
    description text,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bug_sla_rules_at_risk_threshold_check CHECK (((at_risk_threshold > (0)::numeric) AND (at_risk_threshold < (1)::numeric))),
    CONSTRAINT bug_sla_rules_resolution_minutes_check CHECK ((resolution_minutes > 0)),
    CONSTRAINT bug_sla_rules_response_minutes_check CHECK ((response_minutes > 0)),
    CONSTRAINT bug_sla_rules_severity_check CHECK (((severity)::text = ANY ((ARRAY['critical'::character varying, 'high'::character varying, 'medium'::character varying, 'low'::character varying])::text[])))
);
CREATE TABLE defects.bugs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bug_number integer DEFAULT nextval('defects.bug_number_seq'::regclass) NOT NULL,
    title character varying(500) NOT NULL,
    description text NOT NULL,
    status character varying(30) DEFAULT 'open'::character varying NOT NULL,
    severity character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    priority character varying(10) DEFAULT 'p2'::character varying NOT NULL,
    environment character varying(30) DEFAULT 'production'::character varying NOT NULL,
    project_id uuid,
    assignee_id uuid,
    reporter_id uuid,
    linked_task_id uuid,
    duplicate_of_id uuid,
    resolution text,
    root_cause text,
    steps_to_reproduce text,
    sla_rule_id uuid,
    sla_started_at timestamp with time zone DEFAULT now() NOT NULL,
    sla_response_due_at timestamp with time zone,
    sla_resolution_due_at timestamp with time zone,
    first_response_at timestamp with time zone,
    resolved_at timestamp with time zone,
    closed_at timestamp with time zone,
    sla_breached boolean DEFAULT false NOT NULL,
    sla_breached_at timestamp with time zone,
    sla_at_risk_notified_at timestamp with time zone,
    reopen_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bugs_duplicate_not_self CHECK (((duplicate_of_id IS NULL) OR (duplicate_of_id <> id))),
    CONSTRAINT bugs_environment_check CHECK (((environment)::text = ANY ((ARRAY['production'::character varying, 'staging'::character varying, 'qa'::character varying, 'development'::character varying, 'local'::character varying])::text[]))),
    CONSTRAINT bugs_priority_check CHECK (((priority)::text = ANY ((ARRAY['p0'::character varying, 'p1'::character varying, 'p2'::character varying, 'p3'::character varying])::text[]))),
    CONSTRAINT bugs_severity_check CHECK (((severity)::text = ANY ((ARRAY['critical'::character varying, 'high'::character varying, 'medium'::character varying, 'low'::character varying])::text[]))),
    CONSTRAINT bugs_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'assigned'::character varying, 'in_progress'::character varying, 'fixed'::character varying, 'qa_verification'::character varying, 'closed'::character varying, 'reopened'::character varying, 'duplicate'::character varying, 'rejected'::character varying, 'wont_fix'::character varying, 'deferred'::character varying])::text[])))
);
ALTER TABLE ONLY defects.bug_activity_logs
    ADD CONSTRAINT bug_activity_logs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY defects.bug_attachments
    ADD CONSTRAINT bug_attachments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY defects.bug_comments
    ADD CONSTRAINT bug_comments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY defects.bug_sla_rules
    ADD CONSTRAINT bug_sla_rules_pkey PRIMARY KEY (id);
ALTER TABLE ONLY defects.bug_sla_rules
    ADD CONSTRAINT bug_sla_rules_severity_key UNIQUE (severity);
ALTER TABLE ONLY defects.bugs
    ADD CONSTRAINT bugs_bug_number_key UNIQUE (bug_number);
ALTER TABLE ONLY defects.bugs
    ADD CONSTRAINT bugs_pkey PRIMARY KEY (id);
CREATE INDEX idx_bug_activity_action ON defects.bug_activity_logs USING btree (action);
CREATE INDEX idx_bug_activity_bug ON defects.bug_activity_logs USING btree (bug_id, created_at DESC);
CREATE INDEX idx_bug_attachments_bug ON defects.bug_attachments USING btree (bug_id, created_at DESC);
CREATE INDEX idx_bug_comments_bug ON defects.bug_comments USING btree (bug_id, created_at);
CREATE INDEX idx_bugs_assignee ON defects.bugs USING btree (assignee_id);
CREATE INDEX idx_bugs_created ON defects.bugs USING btree (created_at DESC);
CREATE INDEX idx_bugs_environment ON defects.bugs USING btree (environment);
CREATE INDEX idx_bugs_linked_task ON defects.bugs USING btree (linked_task_id);
CREATE INDEX idx_bugs_priority ON defects.bugs USING btree (priority);
CREATE INDEX idx_bugs_project ON defects.bugs USING btree (project_id);
CREATE INDEX idx_bugs_reporter ON defects.bugs USING btree (reporter_id);
CREATE INDEX idx_bugs_search ON defects.bugs USING gin (to_tsvector('english'::regconfig, (((title)::text || ' '::text) || COALESCE(description, ''::text))));
CREATE INDEX idx_bugs_severity ON defects.bugs USING btree (severity);
CREATE INDEX idx_bugs_sla_open ON defects.bugs USING btree (sla_resolution_due_at) WHERE ((status)::text <> ALL ((ARRAY['closed'::character varying, 'duplicate'::character varying, 'rejected'::character varying, 'wont_fix'::character varying, 'deferred'::character varying])::text[]));
CREATE INDEX idx_bugs_status ON defects.bugs USING btree (status);
ALTER TABLE ONLY defects.bug_activity_logs
    ADD CONSTRAINT bug_activity_logs_bug_id_fkey FOREIGN KEY (bug_id) REFERENCES defects.bugs(id) ON DELETE CASCADE;
ALTER TABLE ONLY defects.bug_attachments
    ADD CONSTRAINT bug_attachments_bug_id_fkey FOREIGN KEY (bug_id) REFERENCES defects.bugs(id) ON DELETE CASCADE;
ALTER TABLE ONLY defects.bug_comments
    ADD CONSTRAINT bug_comments_bug_id_fkey FOREIGN KEY (bug_id) REFERENCES defects.bugs(id) ON DELETE CASCADE;
ALTER TABLE ONLY defects.bugs
    ADD CONSTRAINT bugs_duplicate_of_id_fkey FOREIGN KEY (duplicate_of_id) REFERENCES defects.bugs(id) ON DELETE SET NULL;
ALTER TABLE ONLY defects.bugs
    ADD CONSTRAINT bugs_sla_rule_id_fkey FOREIGN KEY (sla_rule_id) REFERENCES defects.bug_sla_rules(id) ON DELETE SET NULL;
`)
}

/*
 * Down drops exactly what up created — the tables and the sequence — and
 * NOTHING else.
 *
 * It deliberately does NOT "DROP SCHEMA defects CASCADE", which is the obvious
 * thing to write and is wrong. This module's migration ledger
 * (defects.pgmigrations) lives in this schema; dropping the schema takes the
 * ledger with it, and node-pg-migrate then fails deleting the ledger row for the
 * migration it just reversed:
 *
 *     relation "defects.pgmigrations" does not exist
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
DROP TABLE IF EXISTS defects.bug_activity_logs CASCADE;
DROP TABLE IF EXISTS defects.bug_attachments CASCADE;
DROP TABLE IF EXISTS defects.bug_comments CASCADE;
DROP TABLE IF EXISTS defects.bug_sla_rules CASCADE;
DROP TABLE IF EXISTS defects.bugs CASCADE;
DROP SEQUENCE IF EXISTS defects.bug_number_seq CASCADE;
`)
}
