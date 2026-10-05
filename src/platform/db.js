/**
 * Database access.
 * ---------------------------------------------------------------------------
 * ONE Supabase database. One schema per module inside it. This file hands each
 * module a pool whose `search_path` sees only its own schema, so a query for a
 * table another module owns fails loudly instead of silently working.
 *
 *   const pool = require('../../platform/db').forSchema('work')   // module code
 *   const pool = require('./db')                                  // migrations
 *
 * WHY NOT ONE SHARED POOL
 * `search_path` is a per-connection setting. A single pool means a single
 * path, which means every module can reach every table — the boundary would
 * exist only in review comments. A pool per module is what makes it real.
 *
 * WHY `public` IS **NOT** ON THE PATH ANY MORE
 * It used to be, on the reasoning that `public` holds only the seven legacy
 * Prisma tables — so `identity`'s pool asking for `tasks` would find nothing in
 * `identity`, nothing in `public`, and error.
 *
 * That reasoning was conditional on a fact no code controls. On 2026-10-03 a
 * pre-split backend (whose pool sets no search_path, so it works in `public`)
 * was pointed at the development database and ran the legacy provisioner. It
 * created 29 EMPTY copies of the module tables in `public` and then served
 * traffic into them. With those copies present, `public` second on the path
 * turned every stray cross-module query into a silent wrong answer: from the
 * `work` pool, `SELECT count(*) FROM notifications` returned 1 (the empty
 * shadow) while `notify.notifications` held 1442 rows. Isolation measured 0/7.
 *
 * So the path is now the module's own schema plus `extensions`, and nothing
 * else. A cross-module name has nowhere left to resolve and raises 42P01
 * whatever else exists in the database — the guarantee no longer depends on
 * `public` staying clean.
 *
 * `extensions` stays because that is where this database keeps gen_random_uuid,
 * uuid_generate_v4, digest and crypt (verified; `public` holds none of them).
 * Column DEFAULTs are not affected either way: Postgres resolves them to an OID
 * when the column is created, not per query.
 *
 * scripts/schema-isolation.test.js is the regression test for all of this.
 *
 * THIS NOW REQUIRES THE SCHEMA SPLIT TO HAVE RUN. Deployment order matters.
 * While `public` was on the path this code could run against an unsplit
 * database — every table was still in `public`, so every query resolved, and
 * the plan shipped the pools first and the migration second.
 *
 * That is no longer true, and the trade is deliberate. A pre-split deployment
 * now fails fast: the module schemas do not exist, /health/ready reports
 * 0-of-7 schemas and returns 503, and queries raise. The alternative — the old
 * fallback — is exactly what let a stale instance quietly read and write a
 * second copy of the data in `public` for two days without anything failing.
 * Loud and down beats silent and forked.
 *
 * So, in production: migrate FIRST (apply the schema split, baseline the
 * ledgers), verify, and only then deploy this code. See the deployment runbook.
 *
 * CONNECTION BUDGET
 * Eight pools instead of one. Pools open connections lazily and release them
 * after `idleTimeoutMillis`, so the steady state is a handful, not 8 x max.
 * The ceiling still has to fit, and it is tighter than it looks — measured
 * against the dev Supabase instance:
 *
 *   max_connections                                    60
 *   held by Supabase itself (Supavisor, PostgREST,
 *   pg_cron, pg_net, postgres_exporter)                13
 *   ----------------------------------------------------
 *   available to this application                      47
 *
 *   7 module pools x DB_POOL_MAX_PER_MODULE (2)        14
 *   default pool (DB_POOL_MAX_DEFAULT, 4)               4
 *   ----------------------------------------------------
 *   ceiling, one server instance                       18
 *
 * So one instance fits with room to spare, and two fit. Before running a third,
 * or before raising either max, re-measure rather than assuming — the headroom
 * is 47, not 60, and the integration test suites open their own pools on top of
 * whatever the server holds.
 *
 * The default pool is deliberately the smaller of the two budgets. At runtime it
 * serves only the health and readiness probes and the boot-migration gate —
 * `SELECT 1`, one catalogue query, and nothing else. The reminder sweep used to
 * be its other consumer; that moved into modules/notify/reminder-cron.js and
 * now runs on notify's and work's own pools. Its remaining users are migrations
 * and `src/scripts/*`, which run in their own short-lived processes and are
 * sequential. Nothing here needs pg's default of 10.
 *
 * Readiness probes every module pool, which forces all seven open rather than
 * letting them stay lazy — that is accounted for in the ceiling above, and
 * platform/readiness.js explains why a probe that skips the pools cannot
 * honestly report them ready.
 */

const { Pool, types } = require('pg')

/* ── Type parsers ───────────────────────────────────────────────────────── */
// These are global to the `pg` module, so they apply to every pool built here.

// DATE columns (due_date, start_date, end_date, ...) have no time-of-day or
// timezone component, but pg's default parser builds a JS Date from them using
// this process's local timezone, which silently shifts the calendar day once
// serialized to UTC ISO and re-localized in the browser. Returning the raw
// 'YYYY-MM-DD' string (OID 1082 = date) avoids that entirely.
types.setTypeParser(1082, (val) => val)

// NUMERIC/DECIMAL columns (leave_requests.days, time_logs.hours, ...) are
// returned by pg as strings to preserve arbitrary precision — 3 comes back as
// "3.0", which renders as "3.0 Days" and breaks frontend arithmetic. These hold
// small quantities well inside IEEE-754 exact range. OID 1700 = numeric.
types.setTypeParser(1700, (val) => (val === null ? null : Number(val)))

/* ── Connection ─────────────────────────────────────────────────────────── */

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  console.error('❌ DATABASE_URL is not set. Add it to varadhi-project-tracker-backend/.env')
}

if (connectionString?.includes('username:password') || connectionString?.includes('your_password')) {
  console.error('❌ DATABASE_URL contains placeholder values. Replace them with your actual PostgreSQL credentials.')
}

const ssl = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false

/**
 * The module schemas. This list is an ALLOW-LIST, not documentation: the schema
 * name is interpolated into a libpq connection option, so an unvetted value
 * would be injected into the connection string. Anything not on this list is
 * refused.
 */
const MODULE_SCHEMAS = [
  'identity', 'work', 'defects', 'notify', 'integrations', 'files', 'workforce', 'people',
]

const PER_MODULE_MAX = Number(process.env.DB_POOL_MAX_PER_MODULE) || 2
const DEFAULT_MAX = Number(process.env.DB_POOL_MAX_DEFAULT) || 4

/* ── Default pool ───────────────────────────────────────────────────────── */
//
// No search_path override: migrations and the schema-split script must see
// every schema, and they run before the module schemas exist.

const defaultPool = new Pool({
  connectionString,
  ssl,
  max: DEFAULT_MAX,
  idleTimeoutMillis: 10_000,
})

// Without this, an error on an idle client is an unhandled 'error' event on the
// pool, which takes the process down. The module pools below each have one; the
// default pool had none, and now that it has an idle timeout its connections
// cycle often enough for that to matter.
defaultPool.on('error', (err) => {
  console.error('[db:default] idle client error:', err.message)
})

defaultPool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err)
    if (err.stack) console.error(err.stack)
  } else {
    // Matches the startup banner's `✓ ...` style in server.js.
    console.log('   ✓ Database connected')
    release()
  }
})

/* ── Per-module pools ───────────────────────────────────────────────────── */

const poolsBySchema = new Map()

/**
 * The pool for one module's schema.
 *
 * Cached: repeated calls for the same schema return the same pool, so a module
 * with several repo files shares one set of connections rather than one per
 * file.
 *
 * @param {string} schema one of MODULE_SCHEMAS
 * @returns {Pool}
 */
const forSchema = (schema) => {
  if (!MODULE_SCHEMAS.includes(schema)) {
    throw new Error(
      `db.forSchema: "${schema}" is not a module schema. ` +
      `Expected one of: ${MODULE_SCHEMAS.join(', ')}`
    )
  }

  const existing = poolsBySchema.get(schema)
  if (existing) return existing

  const pool = new Pool({
    connectionString,
    ssl,
    // libpq connection option, applied when each connection is established, so
    // there is no window where a query runs on the default path.
    // No `public`: see the header. A cross-module name must have nowhere to
    // resolve, even when `public` contains copies of the module tables.
    options: `-c search_path=${schema},extensions`,
    max: PER_MODULE_MAX,
    idleTimeoutMillis: 10_000,
  })

  // A pool error with no listener crashes the process. Log and let the pool
  // discard the bad connection.
  pool.on('error', (err) => {
    console.error(`[db:${schema}] idle client error:`, err.message)
  })

  poolsBySchema.set(schema, pool)
  return pool
}

/* ── Exports ────────────────────────────────────────────────────────────── */
//
// The default export stays the Pool itself so every existing
// `require('./db')` in config/ keeps working unchanged.

module.exports = defaultPool
module.exports.forSchema = forSchema
module.exports.MODULE_SCHEMAS = MODULE_SCHEMAS

/** Every pool currently open, for diagnostics and shutdown. */
module.exports.allPools = () => [defaultPool, ...poolsBySchema.values()]

/** Close every pool. Used by scripts; the server has no graceful shutdown yet. */
module.exports.endAll = async () => {
  await Promise.all(module.exports.allPools().map((p) => p.end().catch(() => {})))
}
