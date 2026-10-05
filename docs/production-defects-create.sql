-- ============================================================================
-- PRODUCTION: create the defects (Bugs Finder) tables
-- ----------------------------------------------------------------------------
-- WHY: production has NONE of the five bug tables. Verified 2026-10-05 from a
-- production backup: 31 public tables = 24 app tables + 7 legacy Prisma, and
-- zero objects matching "bug". Module 8 was never deployed there.
--
-- So defects is NOT baselined like the other six modules. Its 0001 migration is
-- EXECUTED here, which creates the five tables empty, in the defects schema.
-- Nothing is moved and no existing data is touched.
--
-- This DDL is copied verbatim from migrations/defects/0001_baseline.js, so the
-- result is byte-identical to what npm run migrate would have produced.
-- Run AFTER docs/production-cutover.sql.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS defects;

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

-- record it as applied so the ledger matches a normally-migrated database
CREATE TABLE IF NOT EXISTS defects.pgmigrations (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL);
INSERT INTO defects.pgmigrations (name, run_on) VALUES ('0001_baseline', now());

COMMIT;

-- verify: 5 tables, 1 sequence, 1 ledger row
SELECT count(*) AS defects_tables FROM information_schema.tables WHERE table_schema='defects' AND table_type='BASE TABLE';
SELECT to_regclass('defects.bug_number_seq') AS sequence_created;
SELECT name FROM defects.pgmigrations;
