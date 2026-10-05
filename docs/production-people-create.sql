-- ============================================================================
-- PRODUCTION: create the people (HR, Module 9) schema
-- ----------------------------------------------------------------------------
-- WHY BY HAND: src/config/migrate-runner.js refuses the production ref by
-- design, so production DDL is applied from a reviewed script, as with
-- docs/production-defects-create.sql.
--
-- WHAT IT DOES: creates a NEW schema `people` with four EMPTY tables and its
-- migration ledger. It does not read, alter or delete anything that already
-- exists — no other schema is touched. Safe to run while the site is live.
--
-- The DDL below is generated from migrations/people/0001_people_core.js by the
-- node-pg-migrate builder, so it is identical to what `npm run migrate`
-- produced on dev (verified there 2026-10-05, 64/64 people tests passing).
--
-- ORDER: run this BEFORE Render deploys the backend that contains the people
-- module. (The other way round is harmless but /api/people returns 500 until
-- this has run.)
--
-- Runs in one transaction: it either creates everything or nothing. Running it
-- twice stops at the guard with "people schema already exists" and changes
-- nothing.
-- ============================================================================

BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'people') THEN
    RAISE EXCEPTION 'people schema already exists - nothing to do (script already applied?)';
  END IF;
END
$guard$;

CREATE SCHEMA people;

CREATE TABLE "people"."employee_profiles" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "user_id" uuid UNIQUE NOT NULL,
  "date_of_joining" date,
  "designation" varchar(120) NOT NULL,
  "shift" varchar(60),
  "product" varchar(120),
  "core_skills" text[] DEFAULT '{}'::text[] NOT NULL,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT NOW() NOT NULL,
  "updated_at" timestamptz DEFAULT NOW() NOT NULL
);
CREATE TABLE "people"."employee_exits" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "user_id" uuid NOT NULL,
  "exit_type" varchar(20) DEFAULT $pga$resignation$pga$ NOT NULL CHECK (exit_type IN ('resignation','termination','absconded','contract_end')),
  "designation" varchar(120),
  "product" varchar(120),
  "resignation_date" date NOT NULL,
  "last_working_date" date NOT NULL,
  "reason_category" varchar(40) NOT NULL CHECK (reason_category IN ('better_opportunity','compensation','relocation','higher_studies','personal','health','work_environment','performance','other')),
  "reason_detail" text,
  "exit_feedback" text,
  "tenure_months" integer,
  "recorded_by" uuid,
  "created_at" timestamptz DEFAULT NOW() NOT NULL,
  "updated_at" timestamptz DEFAULT NOW() NOT NULL
);
ALTER TABLE "people"."employee_exits"
  ADD CONSTRAINT "employee_exits_dates_order" CHECK (last_working_date >= resignation_date);
CREATE TABLE "people"."candidates" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "full_name" varchar(160) NOT NULL,
  "applied_for" varchar(120) NOT NULL,
  "status" varchar(24) DEFAULT $pga$applied$pga$ NOT NULL CHECK (status IN ('applied','screening','interview_scheduled','interviewed','selected','hold','rejected','offered','joined','declined')),
  "created_by" uuid,
  "created_at" timestamptz DEFAULT NOW() NOT NULL,
  "updated_at" timestamptz DEFAULT NOW() NOT NULL
);
CREATE TABLE "people"."interviews" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "candidate_id" uuid NOT NULL REFERENCES "people"."candidates" ON DELETE CASCADE,
  "round_number" smallint DEFAULT 1 NOT NULL,
  "interview_date" date NOT NULL,
  "outcome" varchar(20) CHECK (outcome IN ('selected','hold','rejected','next_round')),
  "not_selected_reason" text,
  "feedback" text,
  "candidate_expectations" text,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT NOW() NOT NULL,
  "updated_at" timestamptz DEFAULT NOW() NOT NULL
);
CREATE INDEX "idx_employee_profiles_doj" ON "people"."employee_profiles" ("date_of_joining");
CREATE INDEX "idx_employee_exits_user" ON "people"."employee_exits" ("user_id");
CREATE INDEX "idx_employee_exits_resignation_date" ON "people"."employee_exits" ("resignation_date" DESC);
CREATE INDEX "idx_employee_exits_reason" ON "people"."employee_exits" ("reason_category");
CREATE INDEX "idx_candidates_status" ON "people"."candidates" ("status");
CREATE INDEX "idx_interviews_candidate" ON "people"."interviews" ("candidate_id");
CREATE INDEX "idx_interviews_date" ON "people"."interviews" ("interview_date" DESC);

-- Ledger, in the format migrate-runner.js / node-pg-migrate use, so a later
-- `npm run migrate:status` sees 0001 as applied and 0002+ apply normally.
CREATE TABLE people.pgmigrations (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL);
INSERT INTO people.pgmigrations (name, run_on) VALUES ('0001_people_core', now());

COMMIT;

-- ── Verify (expected: 5 tables, 1 ledger row, 0 rows in each data table) ────
SELECT table_name FROM information_schema.tables WHERE table_schema = 'people' ORDER BY 1;
SELECT name FROM people.pgmigrations;
SELECT (SELECT count(*) FROM people.employee_profiles) AS profiles,
       (SELECT count(*) FROM people.employee_exits)    AS exits,
       (SELECT count(*) FROM people.candidates)        AS candidates,
       (SELECT count(*) FROM people.interviews)        AS interviews;
