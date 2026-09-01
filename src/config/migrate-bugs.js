/*
 * Bugs Finder (Module 8) migration.
 * ---------------------------------------------------------------------------
 * Run against an existing database:
 *
 *   npm run db:migrate:bugs
 *
 * The same statements are mirrored into migrate.js so a from-scratch database
 * matches a migrated one — that mirroring is the convention every previous
 * module here follows (see the Module 2 / Module 4-5 / push-retry blocks).
 *
 * Everything is CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so this is
 * idempotent and additive: it creates only new `bug_*` tables and touches no
 * existing table's structure. Nothing in Version 1.0/2.0 changes shape.
 *
 * TIMESTAMPTZ throughout, matching the Module 4/5 tables rather than the older
 * zone-less ones — SLA maths compares stored deadlines against the server's
 * NOW(), and a zone-less column silently shifts those by the server offset.
 */

require('dotenv').config()
const pool = require('./db')

// Statement list is shared with migrate.js so the two can never drift.
// Each entry runs in order inside one transaction.
const BUG_MIGRATION_STATEMENTS = [
  // ─── SLA rules ────────────────────────────────────────────────────────────
  // Response/resolution targets in MINUTES, keyed by severity. Seeded with the
  // defaults below but editable at runtime by an admin, which is the whole
  // reason this is a table rather than a constant: SLA numbers must be
  // changeable without a redeploy.
  `CREATE TABLE IF NOT EXISTS bug_sla_rules (
     id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     severity            VARCHAR(20) NOT NULL
                           CHECK (severity IN ('critical','high','medium','low')),
     response_minutes    INTEGER NOT NULL CHECK (response_minutes > 0),
     resolution_minutes  INTEGER NOT NULL CHECK (resolution_minutes > 0),
     -- Fraction of the resolution window that must elapse before a bug counts
     -- as "at risk". 0.75 = flagged once three quarters of the time is gone.
     at_risk_threshold   NUMERIC(3,2) NOT NULL DEFAULT 0.75
                           CHECK (at_risk_threshold > 0 AND at_risk_threshold < 1),
     description         TEXT,
     updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT bug_sla_rules_severity_key UNIQUE (severity)
   )`,

  // ─── Bugs ─────────────────────────────────────────────────────────────────
  // bug_number is a human-facing sequential id ("BUG-1042"); the UUID stays the
  // primary key so it matches every other table and every existing FK habit.
  // The sequence is owned by the column so it is never reused or reordered.
  `CREATE SEQUENCE IF NOT EXISTS bug_number_seq START 1000`,

  `CREATE TABLE IF NOT EXISTS bugs (
     id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     bug_number       INTEGER NOT NULL DEFAULT nextval('bug_number_seq'),
     title            VARCHAR(500) NOT NULL,
     description      TEXT NOT NULL,

     status           VARCHAR(30) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','assigned','in_progress','fixed',
                                          'qa_verification','closed','reopened',
                                          'duplicate','rejected','wont_fix','deferred')),
     severity         VARCHAR(20) NOT NULL DEFAULT 'medium'
                        CHECK (severity IN ('critical','high','medium','low')),
     -- Priority is deliberately its own axis from severity: severity is how bad
     -- the defect is, priority is how soon we intend to act on it.
     priority         VARCHAR(10) NOT NULL DEFAULT 'p2'
                        CHECK (priority IN ('p0','p1','p2','p3')),
     environment      VARCHAR(30) NOT NULL DEFAULT 'production'
                        CHECK (environment IN ('production','staging','qa','development','local')),

     project_id       UUID REFERENCES projects(id) ON DELETE SET NULL,
     assignee_id      UUID REFERENCES users(id)    ON DELETE SET NULL,
     reporter_id      UUID REFERENCES users(id)    ON DELETE SET NULL,
     -- Bug -> Task link. ON DELETE SET NULL, never CASCADE: deleting the
     -- development task must not delete the defect record it was raised from.
     linked_task_id   UUID REFERENCES tasks(id)    ON DELETE SET NULL,
     -- Duplicate-of pointer, used by the 'duplicate' terminal status.
     duplicate_of_id  UUID REFERENCES bugs(id)     ON DELETE SET NULL,

     resolution       TEXT,
     root_cause       TEXT,
     steps_to_reproduce TEXT,

     -- ─── SLA ───────────────────────────────────────────────────────────────
     -- Deadlines are materialised at creation (and recomputed on a severity
     -- change) rather than derived on read, so a later edit to bug_sla_rules
     -- cannot retroactively rewrite history on bugs already in flight.
     sla_rule_id      UUID REFERENCES bug_sla_rules(id) ON DELETE SET NULL,
     sla_started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     sla_response_due_at   TIMESTAMPTZ,
     sla_resolution_due_at TIMESTAMPTZ,
     -- First transition out of 'open' — the moment somebody actually responded.
     first_response_at     TIMESTAMPTZ,
     resolved_at           TIMESTAMPTZ,
     closed_at             TIMESTAMPTZ,
     -- Latched once the resolution deadline passes with no resolution, so a
     -- breach stays on the record even after the bug is finally resolved.
     sla_breached          BOOLEAN NOT NULL DEFAULT FALSE,
     sla_breached_at       TIMESTAMPTZ,
     -- Set by the SLA sweep so the at-risk warning notification fires once.
     sla_at_risk_notified_at TIMESTAMPTZ,
     reopen_count     INTEGER NOT NULL DEFAULT 0,

     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT bugs_bug_number_key UNIQUE (bug_number),
     -- A bug can never be its own duplicate.
     CONSTRAINT bugs_duplicate_not_self CHECK (duplicate_of_id IS NULL OR duplicate_of_id <> id)
   )`,

  // Indexes cover every filter the list endpoint exposes (§10/§24 of the spec):
  // status, severity, priority, project, assignee, reporter, environment,
  // date range, and the SLA sweeps.
  `CREATE INDEX IF NOT EXISTS idx_bugs_status        ON bugs (status)`,
  `CREATE INDEX IF NOT EXISTS idx_bugs_severity      ON bugs (severity)`,
  `CREATE INDEX IF NOT EXISTS idx_bugs_priority      ON bugs (priority)`,
  `CREATE INDEX IF NOT EXISTS idx_bugs_project       ON bugs (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bugs_assignee      ON bugs (assignee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bugs_reporter      ON bugs (reporter_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bugs_environment   ON bugs (environment)`,
  `CREATE INDEX IF NOT EXISTS idx_bugs_created       ON bugs (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bugs_linked_task   ON bugs (linked_task_id)`,
  // Partial: the SLA sweep only ever looks at bugs that are still open, and
  // that is a small slice of the table once a backlog accumulates.
  `CREATE INDEX IF NOT EXISTS idx_bugs_sla_open
     ON bugs (sla_resolution_due_at)
     WHERE status NOT IN ('closed','duplicate','rejected','wont_fix','deferred')`,
  // Trigram-free text search over title/description. to_tsvector is computed
  // on the fly in an expression index, so no extra column has to be maintained.
  `CREATE INDEX IF NOT EXISTS idx_bugs_search
     ON bugs USING GIN (to_tsvector('english', title || ' ' || COALESCE(description, '')))`,

  // ─── Comments ─────────────────────────────────────────────────────────────
  // Separate from the shared `comments` table on purpose: that one has a NOT
  // NULL-ish task_id FK and is cascaded from tasks. Adding a nullable bug_id to
  // it would leave every existing task-comment query needing a new guard.
  `CREATE TABLE IF NOT EXISTS bug_comments (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     bug_id      UUID NOT NULL REFERENCES bugs(id)  ON DELETE CASCADE,
     author_id   UUID          REFERENCES users(id) ON DELETE SET NULL,
     content     TEXT NOT NULL,
     edited      BOOLEAN NOT NULL DEFAULT FALSE,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bug_comments_bug ON bug_comments (bug_id, created_at ASC)`,

  // ─── Attachments ──────────────────────────────────────────────────────────
  // document_id links to the row the existing documents pipeline created, so
  // attachments reuse that storage/upload path rather than a second one. The
  // denormalised name/url/type/size columns keep the list render single-query
  // and survive the document row being removed.
  `CREATE TABLE IF NOT EXISTS bug_attachments (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     bug_id       UUID NOT NULL REFERENCES bugs(id)      ON DELETE CASCADE,
     document_id  UUID          REFERENCES documents(id) ON DELETE SET NULL,
     file_name    VARCHAR(500) NOT NULL,
     file_type    VARCHAR(50),
     file_size    BIGINT,
     url          VARCHAR(1000) NOT NULL,
     storage_path VARCHAR(1000),
     uploaded_by  UUID          REFERENCES users(id)     ON DELETE SET NULL,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bug_attachments_bug ON bug_attachments (bug_id, created_at DESC)`,

  // ─── Activity log ─────────────────────────────────────────────────────────
  // A dedicated table rather than the legacy Prisma "ActivityLog": that one has
  // 0 rows, camelCase columns, no user FK and no actor column, and is not
  // written by any live code path. Extending it would mean changing a dead
  // legacy shape rather than reusing a working one.
  `CREATE TABLE IF NOT EXISTS bug_activity_logs (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     bug_id      UUID NOT NULL REFERENCES bugs(id)  ON DELETE CASCADE,
     actor_id    UUID          REFERENCES users(id) ON DELETE SET NULL,
     action      VARCHAR(40) NOT NULL,
     field       VARCHAR(60),
     old_value   TEXT,
     new_value   TEXT,
     detail      JSONB,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_bug_activity_bug ON bug_activity_logs (bug_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bug_activity_action ON bug_activity_logs (action)`,

  // ─── Seed the default SLA rules ───────────────────────────────────────────
  // ON CONFLICT DO NOTHING so re-running never overwrites an admin's edits.
  // Values match the defaults in the spec; "1 business day" is stored as the
  // 8-hour working day the SLA clock actually counts (see utils/bug-sla.js).
  `INSERT INTO bug_sla_rules (severity, response_minutes, resolution_minutes, description)
        VALUES ('critical',  60,   240,  'Response 1 hour, resolution 4 hours'),
               ('high',      240,  480,  'Response 4 hours, resolution 1 business day'),
               ('medium',    480,  1440, 'Response 1 business day, resolution 3 business days'),
               ('low',       960,  2400, 'Response 2 business days, resolution 5 business days')
     ON CONFLICT (severity) DO NOTHING`,
]

async function runBugMigration(client) {
  for (const statement of BUG_MIGRATION_STATEMENTS) {
    await client.query(statement)
  }
}

// Exported so migrate.js can run the identical statements inside its own
// transaction — one source of truth for the Bugs Finder schema.
module.exports = { BUG_MIGRATION_STATEMENTS, runBugMigration }

// Only self-execute when invoked directly (`node src/config/migrate-bugs.js`),
// never when required by migrate.js.
if (require.main === module) {
  ;(async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      console.log('🔄 Running Bugs Finder migration...')
      await runBugMigration(client)
      await client.query('COMMIT')
      console.log('✅ Bugs Finder tables created successfully!')
      process.exit(0)
    } catch (err) {
      await client.query('ROLLBACK')
      console.error('❌ Bugs Finder migration failed:', err.message)
      process.exit(1)
    } finally {
      client.release()
    }
  })()
}
