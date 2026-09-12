/**
 * PHASE 2 — schema ownership split.
 * ---------------------------------------------------------------------------
 * Moves the 29 module-owned tables out of `public` into one schema per module,
 * and drops every foreign key that crosses a module boundary.
 *
 * DRY RUN BY DEFAULT. Prints the plan and changes nothing unless run with
 * `--apply`. There is no `--force`: a surprise in the pre-flight stops the run.
 *
 *     node src/config/migrate-schema-split.js              # inspect only
 *     node src/config/migrate-schema-split.js --apply      # execute
 *     node src/config/migrate-schema-split.js --verify     # check post-state
 *
 * WHAT THIS DOES NOT DO
 *   - It does not touch the 7 legacy Prisma tables (ActivityLog, Document,
 *     Project, ProjectMember, Task, User, _prisma_migrations). They are not in
 *     the approved ownership map, hold 5 rows between them, are referenced by
 *     nothing outside their own set, and are queried by no code in src/. They
 *     stay in `public`, untouched, pending a separate decision.
 *   - It does not drop anything. No DROP TABLE, no DROP COLUMN, no data change.
 *     The only destructive verb is ALTER TABLE ... DROP CONSTRAINT, applied
 *     solely to cross-module foreign keys, and every one is recreatable.
 *   - It does not change search_path. THE APPLICATION WILL NOT WORK until that
 *     is settled — see the note at the bottom of this header.
 *
 * ORDER, and why
 *   1. pre-flight   assert reality matches this file before writing anything
 *   2. CREATE SCHEMA   additive, reversible
 *   3. DROP cross-module FKs   must precede the move: dropping by unqualified
 *      name is unambiguous while everything is still in one schema
 *   4. ALTER TABLE ... SET SCHEMA   indexes, constraints, defaults and
 *      within-module FKs all follow the table automatically
 *   5. ALTER SEQUENCE ... SET SCHEMA   bug_number_seq follows `bugs`
 *
 * All of it runs inside ONE transaction. A failure at any step rolls the whole
 * thing back, so the database is never half-split.
 *
 * REVERSIBILITY
 * Steps 2, 4 and 5 reverse exactly (SET SCHEMA public). Step 3 reverses only if
 * the dropped constraints are recreated, so `--apply` writes the exact
 * recreation DDL to schema-split-rollback.sql before dropping anything. That
 * file is the rollback script; keep it.
 *
 * AFTER THIS RUNS, THE APP IS BROKEN UNTIL search_path IS DECIDED.
 * Every query in the codebase names tables unqualified (`FROM tasks`). With
 * `search_path = "$user", public, extensions`, `tasks` in schema `work` is not
 * found. Three ways forward, and they are NOT equivalent — see the plan.
 */

// Must precede ./db — the pool reads DATABASE_URL at require time. Every other
// migrate-*.js script in this directory does the same.
require('dotenv').config()

/* ── Target safety gate ─────────────────────────────────────────────────── */
//
// This runs BEFORE ./db is required, and that ordering is the whole point:
// platform/db.js builds its pool and fires a connection test at require time,
// so gating inside main() would mean the process had already opened a socket to
// whatever DATABASE_URL named. Exiting here means a production URL is refused
// without this script ever connecting to it.

const APPLY = process.argv.includes('--apply')
const VERIFY = process.argv.includes('--verify')
const ALLOW_REMOTE = process.argv.includes('--allow-remote')

/**
 * The Supabase project refs this script knows about. The ref appears either in
 * the username (`postgres.<ref>` on the session pooler, which is how dev is
 * reached) or in the host (`db.<ref>.supabase.co` on a direct connection, which
 * is how production is reached) — so both are checked.
 */
const DEV_REF = 'dbuiauuhajwwpisjevpk'
const PROD_REF = 'ostmlxuzhprymlchmmak'

const resolveTarget = () => {
  const url = process.env.DATABASE_URL || ''
  const user = url.match(/^postgres(?:ql)?:\/\/([^:@]+)/)?.[1] || ''
  const host = url.match(/^postgres(?:ql)?:\/\/[^@]+@([^:/?]+)/)?.[1] || '(unparseable)'
  const ref =
    user.match(/^postgres\.([a-z0-9]{16,})$/)?.[1] ||
    host.match(/^db\.([a-z0-9]{16,})\.supabase\.co$/)?.[1] ||
    null
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host)
  return { host, ref, loopback }
}

/**
 * Refuse to --apply anywhere except a local scratch database or the one hosted
 * database we intend to migrate.
 *
 * The only thing otherwise keeping this off a hosted database is that dotenv
 * does not override an already-set DATABASE_URL. That is true, but it is a
 * library default, not a guarantee — and this script drops 31 constraints. One
 * silent regression in how the env is loaded should not be the difference
 * between a scratch run and a live one.
 *
 * --allow-remote alone is NOT enough, because "remote" includes production.
 * A hosted apply must resolve to DEV_REF; production is refused by name and
 * there is no flag that overrides it. When the time comes to migrate
 * production, that is a separate, reviewed plan with its own script — not a
 * flag someone can reach for at 2am on the wrong terminal.
 */
function assertSafeTarget() {
  if (!APPLY) return
  const { host, ref, loopback } = resolveTarget()

  if (ref === PROD_REF) {
    console.error(`\nREFUSING TO APPLY — THIS IS PRODUCTION.\n`)
    console.error(`  target host : ${host}`)
    console.error(`  project ref : ${ref}`)
    console.error(`  No flag overrides this. Production migration is a separate,`)
    console.error(`  reviewed plan. Check the active DATABASE_URL in .env.\n`)
    process.exit(1)
  }

  if (loopback) return

  if (!ALLOW_REMOTE) {
    console.error(`\nREFUSING TO APPLY.\n`)
    console.error(`  target host : ${host}`)
    console.error(`  This is not loopback. --apply is restricted to a local scratch database.`)
    console.error(`  To migrate the development database deliberately, pass --allow-remote.\n`)
    process.exit(1)
  }

  if (ref !== DEV_REF) {
    console.error(`\nREFUSING TO APPLY — UNRECOGNISED HOSTED DATABASE.\n`)
    console.error(`  target host : ${host}`)
    console.error(`  project ref : ${ref || '(none found in URL)'}`)
    console.error(`  --allow-remote permits the development project (${DEV_REF}) only.\n`)
    process.exit(1)
  }
}

// Called here, not in main(), so it decides before the line below opens a socket.
assertSafeTarget()

const pool = require('./db')
const fs = require('fs')
const path = require('path')

/* ── The approved ownership map ─────────────────────────────────────────── */
const OWNERSHIP = {
  identity: ['users', 'user_sessions', 'user_tokens'],
  work: ['projects', 'project_members', 'tasks', 'comments'],
  defects: ['bugs', 'bug_comments', 'bug_attachments', 'bug_activity_logs', 'bug_sla_rules'],
  notify: [
    'notifications', 'notification_preferences', 'notification_snoozes',
    'notification_action_log', 'notification_logs', 'push_subscriptions',
    'push_delivery_retries',
  ],
  integrations: [
    'calendar_connections', 'calendar_sync_settings', 'calendar_event_links',
    'calendar_sync_conflicts', 'teams_webhooks', 'teams_delivery_log',
  ],
  files: ['documents', 'folders'],
  workforce: ['leave_requests', 'time_logs'],
}

// Sequences follow the table that owns them.
const SEQUENCES = { bug_number_seq: 'defects' }

// Left in `public` deliberately — see the header.
const LEAVE_IN_PUBLIC = [
  'ActivityLog', 'Document', 'Project', 'ProjectMember', 'Task', 'User', '_prisma_migrations',
]

const moduleOf = (t) =>
  Object.entries(OWNERSHIP).find(([, ts]) => ts.includes(t))?.[0] || null

const ALL_OWNED = Object.values(OWNERSHIP).flat()

/* ── Catalog reads ──────────────────────────────────────────────────────── */

const listPublicTables = async (c) =>
  (await c.query(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`
  )).rows.map((r) => r.t)

const listForeignKeys = async (c) =>
  (await c.query(
    `SELECT con.conname AS name,
            src.relname AS src_table,
            tgt.relname AS tgt_table,
            pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_class tgt ON tgt.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'
      ORDER BY src.relname, con.conname`
  )).rows

const classify = (fks) => {
  const within = []
  const crossing = []
  const legacy = []
  for (const fk of fks) {
    const a = moduleOf(fk.src_table)
    const b = moduleOf(fk.tgt_table)
    if (!a && !b) legacy.push(fk)
    else if (a && b && a === b) within.push(fk)
    else crossing.push({ ...fk, src_mod: a, tgt_mod: b })
  }
  return { within, crossing, legacy }
}

/* ── Pre-flight ─────────────────────────────────────────────────────────── */

async function preflight(c) {
  const problems = []
  const tables = await listPublicTables(c)

  const missing = ALL_OWNED.filter((t) => !tables.includes(t))
  if (missing.length) problems.push(`owned tables absent from public: ${missing.join(', ')}`)

  const unexpected = tables.filter((t) => !moduleOf(t) && !LEAVE_IN_PUBLIC.includes(t))
  if (unexpected.length) {
    problems.push(`tables in public with no owner and not on the leave-list: ${unexpected.join(', ')}`)
  }

  const [{ can_create }] = (await c.query(
    `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create`
  )).rows
  if (!can_create) problems.push('current role may not CREATE SCHEMA in this database')

  const notOwned = (await c.query(
    `SELECT c.relname AS t FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'
        AND pg_get_userbyid(c.relowner) <> current_user
        AND c.relname = ANY($1)`, [ALL_OWNED]
  )).rows.map((r) => r.t)
  if (notOwned.length) {
    problems.push(`ALTER ... SET SCHEMA needs ownership; not owned by current role: ${notOwned.join(', ')}`)
  }

  return { tables, problems }
}

/* ── Main ───────────────────────────────────────────────────────────────── */

async function verifyPostState(c) {
  console.log('\n=== POST-STATE VERIFICATION ===\n')
  let bad = 0
  for (const [mod, tables] of Object.entries(OWNERSHIP)) {
    const found = (await c.query(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`, [mod]
    )).rows.map((r) => r.t)
    const missing = tables.filter((t) => !found.includes(t))
    const extra = found.filter((t) => !tables.includes(t))
    const ok = !missing.length && !extra.length
    if (!ok) bad++
    console.log(`  ${ok ? 'OK  ' : 'BAD '} ${mod.padEnd(13)} ${found.length}/${tables.length}` +
      `${missing.length ? '  missing: ' + missing.join(', ') : ''}` +
      `${extra.length ? '  unexpected: ' + extra.join(', ') : ''}`)
  }

  const fks = await listForeignKeys(c)
  const { crossing } = classify(fks)
  console.log(`\n  cross-module FKs still present in public: ${crossing.length} (want 0)`)
  if (crossing.length) bad++

  const leftovers = (await listPublicTables(c)).filter((t) => moduleOf(t))
  console.log(`  owned tables still in public: ${leftovers.length} (want 0)` +
    (leftovers.length ? ' -> ' + leftovers.join(', ') : ''))
  if (leftovers.length) bad++

  const [{ nsp }] = (await c.query(
    `SELECT n.nspname AS nsp FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND c.relname = 'bug_number_seq'`
  )).rows || [{ nsp: null }]
  console.log(`  bug_number_seq schema: ${nsp} (want defects)`)
  if (nsp !== 'defects') bad++

  console.log(bad === 0 ? '\n  post-state is correct\n' : `\n  ${bad} problem(s)\n`)
  return bad === 0
}

async function main() {
  // assertSafeTarget() already ran at require time, above ./db.
  const c = await pool.connect()
  try {
    const [{ db, usr }] = (await c.query(
      `SELECT current_database() AS db, current_user AS usr`)).rows
    console.log(`\nPhase 2 schema split — ${APPLY ? 'APPLY' : VERIFY ? 'VERIFY' : 'DRY RUN'}`)
    console.log(`database=${db}  role=${usr}\n`)

    if (VERIFY) {
      const ok = await verifyPostState(c)
      process.exit(ok ? 0 : 1)
    }

    const { problems } = await preflight(c)
    if (problems.length) {
      console.error('PRE-FLIGHT FAILED — nothing was changed:\n')
      for (const p of problems) console.error('  - ' + p)
      process.exit(1)
    }
    console.log('pre-flight: OK (all 29 owned tables present, owned by this role, CREATE allowed)\n')

    const fks = await listForeignKeys(c)
    const { within, crossing, legacy } = classify(fks)

    console.log(`foreign keys: ${fks.length} total`)
    console.log(`  ${within.length} stay (within a module)`)
    console.log(`  ${legacy.length} stay (between legacy Prisma tables, untouched)`)
    console.log(`  ${crossing.length} to DROP (cross a module boundary)\n`)

    for (const [mod, tables] of Object.entries(OWNERSHIP)) {
      console.log(`  schema ${mod.padEnd(13)} <- ${tables.length} table(s): ${tables.join(', ')}`)
    }

    // Rollback script, written BEFORE anything is dropped.
    const rollback = [
      '-- Rollback for migrate-schema-split.js',
      `-- Generated ${new Date().toISOString()} against database "${db}"`,
      '-- Run inside a transaction. Recreates every dropped cross-module FK and',
      '-- moves every table back to public.',
      'BEGIN;',
      ...Object.entries(OWNERSHIP).flatMap(([mod, ts]) =>
        ts.map((t) => `ALTER TABLE ${mod}."${t}" SET SCHEMA public;`)),
      ...Object.entries(SEQUENCES).map(([s, mod]) =>
        `ALTER SEQUENCE ${mod}."${s}" SET SCHEMA public;`),
      ...crossing.map((fk) =>
        `ALTER TABLE public."${fk.src_table}" ADD CONSTRAINT "${fk.name}" ${fk.def};`),
      ...Object.keys(OWNERSHIP).map((m) => `DROP SCHEMA IF EXISTS ${m} RESTRICT;`),
      'COMMIT;',
      '',
    ].join('\n')

    const rollbackPath = path.join(__dirname, '..', '..', 'schema-split-rollback.sql')

    if (!APPLY) {
      console.log(`\nwould drop ${crossing.length} constraint(s):`)
      for (const fk of crossing) {
        console.log(`  ${fk.src_table}.${fk.name}  (${fk.src_mod} -> ${fk.tgt_mod})`)
      }
      console.log(`\nwould write rollback to: ${rollbackPath}`)
      console.log('\nDRY RUN — nothing was changed. Re-run with --apply to execute.\n')
      return
    }

    fs.writeFileSync(rollbackPath, rollback, 'utf8')
    console.log(`\nrollback script written: ${rollbackPath}`)

    await c.query('BEGIN')

    for (const mod of Object.keys(OWNERSHIP)) {
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${mod}`)
    }
    console.log(`  created ${Object.keys(OWNERSHIP).length} schema(s)`)

    for (const fk of crossing) {
      await c.query(`ALTER TABLE public."${fk.src_table}" DROP CONSTRAINT "${fk.name}"`)
    }
    console.log(`  dropped ${crossing.length} cross-module foreign key(s)`)

    let moved = 0
    for (const [mod, tables] of Object.entries(OWNERSHIP)) {
      for (const t of tables) {
        await c.query(`ALTER TABLE public."${t}" SET SCHEMA ${mod}`)
        moved++
      }
    }
    console.log(`  moved ${moved} table(s)`)

    for (const [seq, mod] of Object.entries(SEQUENCES)) {
      await c.query(`ALTER SEQUENCE public."${seq}" SET SCHEMA ${mod}`)
    }
    console.log(`  moved ${Object.keys(SEQUENCES).length} sequence(s)`)

    await c.query('COMMIT')
    console.log('\nCOMMITTED\n')

    await verifyPostState(c)
  } catch (err) {
    try { await c.query('ROLLBACK') } catch { /* not in a transaction */ }
    console.error('\nFAILED — rolled back, database unchanged:', err.message)
    process.exitCode = 1
  } finally {
    c.release()
    await pool.end()
  }
}

main()
