/*
 * workforce — 0001 baseline
 * ---------------------------------------------------------------------------
 * Tables: leave_requests / time_logs
 *
 * WHAT THIS IS
 * The exact shape of the workforce schema after the Phase 2 split, captured from a
 * database provisioned by the old migrate.js and then migrated by
 * migrate-schema-split.js. Every later migration in this directory builds on it.
 *
 * WHY RAW SQL RATHER THAN pgm.createTable(...)
 * A baseline's only job is to reproduce an existing schema EXACTLY. Hand-
 * translating 9 statements into the builder API would introduce drift in
 * precisely the place drift is most expensive — the definition every subsequent
 * migration assumes. Later migrations here should use the builder; this one is a
 * faithful transcript.
 *
 * NO CROSS-MODULE FOREIGN KEYS
 * Every constraint below points inside workforce. The 31 that crossed a module
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
CREATE SCHEMA IF NOT EXISTS workforce;
CREATE TABLE workforce.leave_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    start_date date NOT NULL,
    end_date date NOT NULL,
    days numeric(5,1) DEFAULT 1 NOT NULL,
    type character varying(30) DEFAULT 'annual'::character varying NOT NULL,
    reason text NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    day_type character varying(10) DEFAULT 'full_day'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT leave_requests_day_type_check CHECK (((day_type)::text = ANY ((ARRAY['full_day'::character varying, 'half_day'::character varying])::text[]))),
    CONSTRAINT leave_requests_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[])))
);
CREATE TABLE workforce.time_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    project_id uuid,
    date date NOT NULL,
    hours numeric(5,2) DEFAULT 0 NOT NULL,
    note text,
    check_in timestamp without time zone,
    check_out timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);
ALTER TABLE ONLY workforce.leave_requests
    ADD CONSTRAINT leave_requests_pkey PRIMARY KEY (id);
ALTER TABLE ONLY workforce.time_logs
    ADD CONSTRAINT time_logs_pkey PRIMARY KEY (id);
CREATE INDEX idx_leave_requests_status ON workforce.leave_requests USING btree (status);
CREATE INDEX idx_leave_requests_user_start ON workforce.leave_requests USING btree (user_id, start_date DESC);
CREATE INDEX idx_time_logs_project ON workforce.time_logs USING btree (project_id);
CREATE INDEX idx_time_logs_user_date ON workforce.time_logs USING btree (user_id, date DESC);
`)
}

/*
 * Down drops exactly what up created — the tables and the sequence — and
 * NOTHING else.
 *
 * It deliberately does NOT "DROP SCHEMA workforce CASCADE", which is the obvious
 * thing to write and is wrong. This module's migration ledger
 * (workforce.pgmigrations) lives in this schema; dropping the schema takes the
 * ledger with it, and node-pg-migrate then fails deleting the ledger row for the
 * migration it just reversed:
 *
 *     relation "workforce.pgmigrations" does not exist
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
DROP TABLE IF EXISTS workforce.leave_requests CASCADE;
DROP TABLE IF EXISTS workforce.time_logs CASCADE;
`)
}
