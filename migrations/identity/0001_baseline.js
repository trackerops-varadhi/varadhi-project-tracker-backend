/*
 * identity — 0001 baseline
 * ---------------------------------------------------------------------------
 * Tables: users / user_sessions / user_tokens
 *
 * WHAT THIS IS
 * The exact shape of the identity schema after the Phase 2 split, captured from a
 * database provisioned by the old migrate.js and then migrated by
 * migrate-schema-split.js. Every later migration in this directory builds on it.
 *
 * WHY RAW SQL RATHER THAN pgm.createTable(...)
 * A baseline's only job is to reproduce an existing schema EXACTLY. Hand-
 * translating 19 statements into the builder API would introduce drift in
 * precisely the place drift is most expensive — the definition every subsequent
 * migration assumes. Later migrations here should use the builder; this one is a
 * faithful transcript.
 *
 * NO CROSS-MODULE FOREIGN KEYS
 * Every constraint below points inside identity. The 31 that crossed a module
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
CREATE SCHEMA IF NOT EXISTS identity;
CREATE TABLE identity.user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    browser character varying(100),
    os character varying(100),
    device_label character varying(200),
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason character varying(30),
    revoked_by uuid,
    CONSTRAINT user_sessions_revoked_reason_check CHECK (((revoked_reason)::text = ANY ((ARRAY['logout'::character varying, 'logout_all'::character varying, 'user_revoked'::character varying, 'admin_revoked'::character varying, 'password_change'::character varying, 'password_reset'::character varying, 'token_reuse'::character varying, 'account_deactivated'::character varying, 'inactivity'::character varying, 'expired'::character varying, 'migrated'::character varying])::text[])))
);
CREATE TABLE identity.user_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_type character varying(20) NOT NULL,
    token_hash text NOT NULL,
    session_id uuid NOT NULL,
    refresh_family_id uuid,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    replaced_by_token_id uuid,
    user_agent text,
    ip_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_tokens_token_type_check CHECK (((token_type)::text = ANY ((ARRAY['access'::character varying, 'refresh'::character varying])::text[])))
);
CREATE TABLE identity.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    password character varying(255),
    role character varying(50) DEFAULT 'employee'::character varying,
    status character varying(50) DEFAULT 'active'::character varying,
    avatar character varying(500),
    invite_token character varying(255),
    reset_token character varying(255),
    reset_token_expires timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['admin'::character varying, 'manager'::character varying, 'employee'::character varying])::text[]))),
    CONSTRAINT users_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'invited'::character varying])::text[])))
);
ALTER TABLE ONLY identity.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);
ALTER TABLE ONLY identity.user_tokens
    ADD CONSTRAINT user_tokens_pkey PRIMARY KEY (id);
ALTER TABLE ONLY identity.user_tokens
    ADD CONSTRAINT user_tokens_token_hash_key UNIQUE (token_hash);
ALTER TABLE ONLY identity.users
    ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE ONLY identity.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
CREATE INDEX idx_user_sessions_expiry ON identity.user_sessions USING btree (expires_at);
CREATE INDEX idx_user_sessions_user_active ON identity.user_sessions USING btree (user_id, last_active_at DESC) WHERE (revoked_at IS NULL);
CREATE INDEX idx_user_tokens_active_lookup ON identity.user_tokens USING btree (token_hash, token_type) WHERE (revoked_at IS NULL);
CREATE INDEX idx_user_tokens_expiry ON identity.user_tokens USING btree (expires_at);
CREATE INDEX idx_user_tokens_session_id ON identity.user_tokens USING btree (session_id);
CREATE INDEX idx_user_tokens_user_id ON identity.user_tokens USING btree (user_id);
ALTER TABLE ONLY identity.user_sessions
    ADD CONSTRAINT user_sessions_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES identity.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY identity.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY identity.user_tokens
    ADD CONSTRAINT user_tokens_replaced_by_token_id_fkey FOREIGN KEY (replaced_by_token_id) REFERENCES identity.user_tokens(id) ON DELETE SET NULL;
ALTER TABLE ONLY identity.user_tokens
    ADD CONSTRAINT user_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES identity.users(id) ON DELETE CASCADE;
`)
}

/*
 * Down drops exactly what up created — the tables and the sequence — and
 * NOTHING else.
 *
 * It deliberately does NOT "DROP SCHEMA identity CASCADE", which is the obvious
 * thing to write and is wrong. This module's migration ledger
 * (identity.pgmigrations) lives in this schema; dropping the schema takes the
 * ledger with it, and node-pg-migrate then fails deleting the ledger row for the
 * migration it just reversed:
 *
 *     relation "identity.pgmigrations" does not exist
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
DROP TABLE IF EXISTS identity.user_sessions CASCADE;
DROP TABLE IF EXISTS identity.user_tokens CASCADE;
DROP TABLE IF EXISTS identity.users CASCADE;
`)
}
