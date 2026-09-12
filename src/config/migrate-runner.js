#!/usr/bin/env node
/**
 * Root migration runner.
 * ---------------------------------------------------------------------------
 * One command, seven independently-versioned modules.
 *
 *   npm run migrate                 apply every pending migration, all modules
 *   npm run migrate:status          what is applied, what is pending
 *   npm run migrate:baseline        mark 0001 applied WITHOUT running it
 *   npm run migrate:down            roll back one migration per module
 *
 *   node src/config/migrate-runner.js up --module notify
 *   node src/config/migrate-runner.js down --module notify --count 1
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE LEDGER PER MODULE, INSIDE THAT MODULE'S OWN SCHEMA
 *
 *   identity.pgmigrations, work.pgmigrations, defects.pgmigrations, ...
 *
 * not a single shared `public.pgmigrations`. A module owns its migration
 * history exactly as it owns its tables. Three things follow from that:
 *
 *   - a module can be migrated on its own, without coordinating with six
 *     others that have no reason to care;
 *   - when a module is eventually extracted, it takes its directory AND its
 *     version history with it — nothing has to be untangled from a shared
 *     table.
 *
 * The one sharp edge this creates is worth stating, because the first version
 * of the baseline got it wrong: a migration must never drop the schema that
 * holds its own ledger. `DROP SCHEMA notify CASCADE` takes notify.pgmigrations
 * with it, and node-pg-migrate then fails deleting the row for the migration it
 * just reversed — leaving the database migrated and the rollback reported as
 * failed. Baseline `down` therefore drops the module's TABLES, not its schema.
 *
 * The cost is that "what version is the database at?" has seven answers rather
 * than one. `status` prints all seven, and that is the honest shape of a system
 * with seven independently-deployable owners.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE MODULE ORDER BELOW BARELY MATTERS, AND IS FIXED ANYWAY
 *
 * The schema split dropped every cross-module foreign key, so no module's DDL
 * depends on another's. The order is fixed only so that output, failures and
 * logs are reproducible run to run.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SAFETY
 *
 * `down` is destructive — rolling back a baseline drops every table that module
 * owns — so it is refused outright against any non-loopback database. `up` is
 * allowed against a remote target but requires --allow-remote, the same gesture
 * migrate-schema-split.js asks for, so a hosted migration is always something a
 * person typed rather than something a default did.
 *
 * Production is refused by project ref, with no flag that overrides it.
 */

require('dotenv').config()

const path = require('path')
const fs = require('fs')
const { runner } = require('node-pg-migrate')
const { Pool } = require('pg')

/* ── Modules, in fixed order ──────────────────────────────────────────────── */

const MODULES = [
  'identity', 'work', 'defects', 'notify', 'integrations', 'files', 'workforce',
]

const MIGRATIONS_ROOT = path.join(__dirname, '..', '..', 'migrations')
const LEDGER_TABLE = 'pgmigrations'

/* ── Target safety ────────────────────────────────────────────────────────── */

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
  return { url, host, ref, loopback: ['127.0.0.1', 'localhost', '::1'].includes(host) }
}

const refuse = (lines) => {
  console.error(`\n${lines.join('\n')}\n`)
  process.exit(1)
}

const assertSafeTarget = (direction, allowRemote) => {
  const { url, host, ref, loopback } = resolveTarget()

  if (!url) refuse(['REFUSING — DATABASE_URL is not set.'])

  if (ref === PROD_REF) {
    refuse([
      'REFUSING — THIS IS PRODUCTION.',
      `  target host : ${host}`,
      `  project ref : ${ref}`,
      '  No flag overrides this. A production migration is a separate,',
      '  reviewed plan with its own runbook.',
    ])
  }

  if (loopback) return

  if (direction === 'down') {
    refuse([
      'REFUSING — `down` is restricted to a local database.',
      `  target host : ${host}`,
      '  Rolling back the baseline drops every table the module owns. That is a',
      '  data-loss operation and not something a hosted database should accept',
      '  from a CLI flag. Roll a hosted database back from a backup, deliberately.',
    ])
  }

  if (!allowRemote) {
    refuse([
      'REFUSING — hosted target without --allow-remote.',
      `  target host : ${host}`,
      `  project ref : ${ref || '(none found in URL)'}`,
      '  Re-run with --allow-remote to migrate a hosted database on purpose.',
    ])
  }

  if (ref !== DEV_REF) {
    refuse([
      'REFUSING — UNRECOGNISED HOSTED DATABASE.',
      `  target host : ${host}`,
      `  project ref : ${ref || '(none found in URL)'}`,
      `  --allow-remote permits the development project (${DEV_REF}) only.`,
    ])
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const dirFor = (mod) => path.join(MIGRATIONS_ROOT, mod)

const migrationFiles = (mod) => {
  const d = dirFor(mod)
  if (!fs.existsSync(d)) return []
  return fs.readdirSync(d).filter((f) => /\.js$/.test(f)).sort()
}

const makePool = () => new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 2,
})

/**
 * The ledger lives in the module's own schema, so the schema has to exist
 * before node-pg-migrate can create or read it. Creating it here rather than
 * letting the baseline do it also means `status` works on a database where
 * nothing has been applied yet.
 */
const ensureSchema = async (pool, mod) => {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${mod}"`)
}

const ledgerRows = async (pool, mod) => {
  try {
    const { rows } = await pool.query(
      `SELECT name, run_on FROM "${mod}"."${LEDGER_TABLE}" ORDER BY id`)
    return rows
  } catch {
    return null // ledger not created yet
  }
}

/* ── Commands ─────────────────────────────────────────────────────────────── */

const runModule = async (mod, { direction, count, dryRun }) => {
  const dir = dirFor(mod)
  if (!fs.existsSync(dir)) {
    console.log(`  ${mod.padEnd(13)} (no migrations directory — skipped)`)
    return { mod, applied: [] }
  }

  const pool = makePool()
  try {
    await ensureSchema(pool, mod)

    const applied = await runner({
      databaseUrl: process.env.DATABASE_URL,
      dir,
      direction,
      count: count === undefined ? Infinity : count,
      migrationsTable: LEDGER_TABLE,
      migrationsSchema: mod,
      // Migrations run with the module's own schema first on the path, so a
      // baseline that says `CREATE TABLE users` lands in identity, not public.
      schema: [mod, 'public'],
      createSchema: true,
      createMigrationsSchema: true,
      // One transaction for the whole module: a module either migrates or does
      // not. A half-migrated schema is the state this system exists to prevent.
      singleTransaction: true,
      noLock: false,
      dryRun: Boolean(dryRun),
      verbose: false,
      log: () => {},
    })

    const names = (applied || []).map((m) => m.name || String(m))
    if (names.length) {
      console.log(`  ${mod.padEnd(13)} ${direction} ${names.length}: ${names.join(', ')}`)
    } else {
      console.log(`  ${mod.padEnd(13)} nothing to do`)
    }
    return { mod, applied: names }
  } finally {
    await pool.end().catch(() => {})
  }
}

const cmdUp = async (opts) => {
  console.log(`\nMigrating up${opts.dryRun ? ' (DRY RUN)' : ''} — ${opts.modules.join(', ')}\n`)
  const results = []
  for (const mod of opts.modules) results.push(await runModule(mod, { ...opts, direction: 'up' }))
  const total = results.reduce((n, r) => n + r.applied.length, 0)
  console.log(`\n${total} migration(s) applied across ${results.length} module(s)\n`)
  return results
}

const cmdDown = async (opts) => {
  console.log(`\nRolling back — ${opts.modules.join(', ')}  (count ${opts.count ?? 1})\n`)
  const results = []
  // Reverse order, mirroring up. Harmless given no cross-module dependencies,
  // but a rollback that undoes in the opposite order to the apply is the shape
  // people expect, and the shape that stays correct if dependencies appear.
  for (const mod of [...opts.modules].reverse()) {
    results.push(await runModule(mod, { ...opts, direction: 'down', count: opts.count ?? 1 }))
  }
  const total = results.reduce((n, r) => n + r.applied.length, 0)
  console.log(`\n${total} migration(s) rolled back\n`)
  return results
}

/**
 * Mark 0001 applied without executing it.
 *
 * This is the whole reason a baseline exists. dev and production already hold
 * these 29 tables; running 0001 against them would fail on the first CREATE
 * TABLE. Writing the ledger row instead says "this database is already at
 * version 0001", so migration 0002 onwards applies normally and the existing
 * database is never re-provisioned.
 *
 * Refuses to baseline a module whose ledger already has rows, so it cannot
 * quietly paper over a real migration history.
 */
const cmdBaseline = async (opts) => {
  console.log(`\nBaselining — marking 0001 applied WITHOUT running it\n`)
  const pool = makePool()
  let marked = 0
  try {
    for (const mod of opts.modules) {
      const files = migrationFiles(mod)
      const first = files[0]
      if (!first) { console.log(`  ${mod.padEnd(13)} no migrations — skipped`); continue }

      await ensureSchema(pool, mod)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "${mod}"."${LEDGER_TABLE}" (
          id SERIAL PRIMARY KEY,
          name varchar(255) NOT NULL,
          run_on timestamp NOT NULL
        )`)

      const existing = await pool.query(
        `SELECT count(*)::int AS n FROM "${mod}"."${LEDGER_TABLE}"`)
      if (existing.rows[0].n > 0) {
        console.log(`  ${mod.padEnd(13)} already has ${existing.rows[0].n} ledger row(s) — skipped`)
        continue
      }

      const name = first.replace(/\.js$/, '')
      await pool.query(
        `INSERT INTO "${mod}"."${LEDGER_TABLE}" (name, run_on) VALUES ($1, NOW())`, [name])
      console.log(`  ${mod.padEnd(13)} marked applied: ${name}`)
      marked += 1
    }
  } finally {
    await pool.end().catch(() => {})
  }
  console.log(`\n${marked} module(s) baselined\n`)
}

const cmdStatus = async (opts) => {
  const { host, ref } = resolveTarget()
  console.log(`\nMigration status — ${host}${ref ? ` (${ref})` : ''}\n`)
  const pool = makePool()
  try {
    let pendingTotal = 0
    for (const mod of opts.modules) {
      const files = migrationFiles(mod).map((f) => f.replace(/\.js$/, ''))
      const rows = await ledgerRows(pool, mod)
      if (rows === null) {
        console.log(`  ${mod.padEnd(13)} no ledger        ${files.length} pending: ${files.join(', ') || '-'}`)
        pendingTotal += files.length
        continue
      }
      const applied = rows.map((r) => r.name)
      const pending = files.filter((f) => !applied.includes(f))
      pendingTotal += pending.length
      console.log(
        `  ${mod.padEnd(13)} applied ${String(applied.length).padStart(2)}   ` +
        `pending ${String(pending.length).padStart(2)}   ` +
        `at: ${applied[applied.length - 1] || '(none)'}${pending.length ? `   next: ${pending[0]}` : ''}`)
    }
    console.log(`\n${pendingTotal} pending migration(s) total\n`)
    return pendingTotal
  } finally {
    await pool.end().catch(() => {})
  }
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

const parseArgs = (argv) => {
  const cmd = argv.find((a) => !a.startsWith('-')) || 'up'
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? undefined : argv[i + 1]
  }
  const only = flag('module')
  if (only && !MODULES.includes(only)) {
    refuse([`Unknown module "${only}". Expected one of: ${MODULES.join(', ')}`])
  }
  return {
    cmd,
    modules: only ? [only] : MODULES,
    count: flag('count') === undefined ? undefined : Number(flag('count')),
    allowRemote: argv.includes('--allow-remote'),
    dryRun: argv.includes('--dry-run'),
  }
}

const main = async () => {
  const argv = process.argv.slice(2)
  const opts = parseArgs(argv)

  const COMMANDS = { up: cmdUp, down: cmdDown, status: cmdStatus, baseline: cmdBaseline }
  const fn = COMMANDS[opts.cmd]
  if (!fn) {
    refuse([
      `Unknown command "${opts.cmd}".`,
      '  Expected: up | down | status | baseline',
      '  Flags: --module <name> --count <n> --allow-remote --dry-run',
    ])
  }

  // `status` only reads, so it is safe anywhere except production.
  if (opts.cmd === 'status') {
    const { ref } = resolveTarget()
    if (ref === PROD_REF) refuse(['REFUSING — THIS IS PRODUCTION.'])
  } else {
    assertSafeTarget(opts.cmd === 'down' ? 'down' : 'up', opts.allowRemote)
  }

  await fn(opts)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nMIGRATION FAILED: ${err.message}\n`)
    if (process.env.MIGRATE_DEBUG) console.error(err)
    process.exit(1)
  })
}

module.exports = { MODULES, LEDGER_TABLE, MIGRATIONS_ROOT, resolveTarget, migrationFiles }
