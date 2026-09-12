/*
 * files — 0001 baseline
 * ---------------------------------------------------------------------------
 * Tables: documents / folders
 *
 * WHAT THIS IS
 * The exact shape of the files schema after the Phase 2 split, captured from a
 * database provisioned by the old migrate.js and then migrated by
 * migrate-schema-split.js. Every later migration in this directory builds on it.
 *
 * WHY RAW SQL RATHER THAN pgm.createTable(...)
 * A baseline's only job is to reproduce an existing schema EXACTLY. Hand-
 * translating 7 statements into the builder API would introduce drift in
 * precisely the place drift is most expensive — the definition every subsequent
 * migration assumes. Later migrations here should use the builder; this one is a
 * faithful transcript.
 *
 * NO CROSS-MODULE FOREIGN KEYS
 * Every constraint below points inside files. The 31 that crossed a module
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
CREATE SCHEMA IF NOT EXISTS files;
CREATE TABLE files.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(500) NOT NULL,
    original_name character varying(500),
    file_type character varying(50),
    file_size bigint,
    url character varying(1000),
    description text,
    project_id uuid,
    uploaded_by uuid,
    created_at timestamp without time zone DEFAULT now(),
    folder_id uuid
);
CREATE TABLE files.folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);
ALTER TABLE ONLY files.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY files.folders
    ADD CONSTRAINT folders_pkey PRIMARY KEY (id);
CREATE INDEX idx_documents_folder ON files.documents USING btree (folder_id);
ALTER TABLE ONLY files.documents
    ADD CONSTRAINT documents_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES files.folders(id) ON DELETE SET NULL;
`)
}

/*
 * Down drops exactly what up created — the tables and the sequence — and
 * NOTHING else.
 *
 * It deliberately does NOT "DROP SCHEMA files CASCADE", which is the obvious
 * thing to write and is wrong. This module's migration ledger
 * (files.pgmigrations) lives in this schema; dropping the schema takes the
 * ledger with it, and node-pg-migrate then fails deleting the ledger row for the
 * migration it just reversed:
 *
 *     relation "files.pgmigrations" does not exist
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
DROP TABLE IF EXISTS files.documents CASCADE;
DROP TABLE IF EXISTS files.folders CASCADE;
`)
}
