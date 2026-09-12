/*
 * Migration system tests.
 *
 *   npm run test:migrate-system
 *
 * Runs entirely against a DISPOSABLE LOOPBACK database and refuses anything
 * else. It drops and recreates schemas repeatedly, so pointing it at a database
 * anyone cares about would destroy it — hence the guard below, which checks the
 * host before a single statement runs.
 *
 *   SCRATCH_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/varadhi_scratch
 *
 * WHAT IS ACTUALLY BEING TESTED
 * Not "does node-pg-migrate work" — that is its own project's problem. These
 * cover the things THIS system gets to be wrong about:
 *
 *   - the baseline reproduces the post-split schema exactly (29 tables, 21
 *     within-module FKs, 15 cascades, the sequence in defects)
 *   - no migration re-creates a cross-module foreign key, which is the whole
 *     point of the split and the easiest thing to undo by accident
 *   - no migration creates a shadow table in public, the failure split-guard.js
 *     exists to prevent
 *   - a failing migration leaves its module EXACTLY as it was, with no ledger
 *     row — a half-applied schema is the state this system exists to prevent
 *   - down does not take the ledger with it (it did, on the first attempt)
 *   - baseline marks without executing, and refuses to overwrite real history
 */

const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { Pool } = require('pg')

require('dotenv').config()

const BACKEND = path.join(__dirname, '..')
const RUNNER = path.join(BACKEND, 'src', 'config', 'migrate-runner.js')
const MIGRATIONS = path.join(BACKEND, 'migrations')

const URL = process.env.SCRATCH_DATABASE_URL
  || 'postgresql://varadhi_scratch_user:admin123@127.0.0.1:5432/varadhi_scratch'

const host = URL.match(/@([^:/?]+)/)?.[1]
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error(`REFUSING — target host "${host}" is not loopback.`)
  console.error('This suite DROPS SCHEMAS. It runs only against a disposable local database.')
  process.exit(1)
}

const MODULES = ['identity', 'work', 'defects', 'notify', 'integrations', 'files', 'workforce']

let pass = 0
let fail = 0
const failures = []
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(`${name} ${extra}`); console.log(`  FAIL  ${name}  ${extra}`) }
}

const pool = new Pool({ connectionString: URL, max: 3 })
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0]
const scalar = async (sql, params = []) => Object.values(await one(sql, params))[0]

/** Run the runner as a child process, the way an operator would. */
const runner = (args, env = {}) => {
  try {
    return {
      ok: true,
      out: execFileSync(process.execPath, [RUNNER, ...args], {
        cwd: BACKEND, encoding: 'utf8', timeout: 180000,
        env: { ...process.env, DATABASE_URL: URL, ...env },
      }),
    }
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`, status: e.status }
  }
}

/* ── Measurements ─────────────────────────────────────────────────────────── */

const tableCount = () => scalar(
  `SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND n.nspname = ANY($1) AND c.relname <> 'pgmigrations'`, [MODULES])

const crossModuleFks = () => scalar(
  `SELECT count(*)::int FROM pg_constraint con
     JOIN pg_class sc ON sc.oid=con.conrelid
     JOIN pg_namespace sn ON sn.oid=sc.relnamespace
     JOIN pg_class tc ON tc.oid=con.confrelid
     JOIN pg_namespace tn ON tn.oid=tc.relnamespace
    WHERE con.contype='f' AND sn.nspname <> tn.nspname`)

const withinFks = () => scalar(
  `SELECT count(*)::int FROM pg_constraint con
     JOIN pg_class sc ON sc.oid=con.conrelid
     JOIN pg_namespace sn ON sn.oid=sc.relnamespace
    WHERE con.contype='f' AND sn.nspname = ANY($1)`, [MODULES])

const cascades = () => scalar(
  `SELECT count(*)::int FROM pg_constraint WHERE contype='f' AND confdeltype='c'`)

const duplicateTables = () => scalar(
  `SELECT count(*)::int FROM (
     SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='r' AND c.relname <> 'pgmigrations'
        AND n.nspname = ANY($1)
      GROUP BY c.relname HAVING count(DISTINCT n.nspname) > 1) x`,
  [[...MODULES, 'public']])

const publicTables = () => scalar(
  `SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND n.nspname='public'`)

const ledgerRows = async (mod) => {
  try { return await scalar(`SELECT count(*)::int FROM "${mod}".pgmigrations`) }
  catch { return null }
}

const reset = () => pool.query(
  `DROP SCHEMA IF EXISTS ${MODULES.join(', ')} CASCADE`)

/* ── Tests ────────────────────────────────────────────────────────────────── */

async function main() {
  console.log(`\nMigration system — disposable database at ${host}\n${'='.repeat(66)}`)

  /* 1. fresh database */
  console.log('\n1. Fresh database migrates in the right order')
  await reset()
  check('starts empty', await tableCount() === 0, String(await tableCount()))

  const up = runner(['up'])
  check('runner exited 0', up.ok, up.out.slice(-200))
  check('reports 7 migrations applied', /7 migration\(s\) applied/.test(up.out),
    up.out.slice(-160))
  // Order is fixed so logs and failures are reproducible.
  const order = MODULES.filter((m) => up.out.includes(`${m.padEnd(13)} up 1`))
  check('all 7 modules applied', order.length === 7, order.join(','))
  check('applied in the declared order', order.join(',') === MODULES.join(','), order.join(','))

  check('29 module tables created', await tableCount() === 29, String(await tableCount()))
  check('21 within-module foreign keys', await withinFks() === 21, String(await withinFks()))
  check('15 cascades preserved', await cascades() === 15, String(await cascades()))
  check('bug_number_seq lives in defects',
    await scalar(`SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE c.relkind='S' AND c.relname='bug_number_seq'`) === 'defects')

  /* 2. the two invariants the split exists to hold */
  console.log('\n2. Split invariants')
  check('ZERO cross-module foreign keys', await crossModuleFks() === 0,
    `${await crossModuleFks()} — a FK across module schemas cannot survive extraction`)
  check('ZERO duplicate / shadow tables', await duplicateTables() === 0,
    String(await duplicateTables()))
  check('nothing created in public', await publicTables() === 0,
    `${await publicTables()} — a fresh database should leave public empty`)

  /* 3. ledger */
  console.log('\n3. Per-module ledger')
  for (const m of MODULES) {
    check(`${m.padEnd(13)} ledger has exactly 1 row`, await ledgerRows(m) === 1,
      String(await ledgerRows(m)))
  }
  const st = runner(['status'])
  check('status reports 0 pending', /0 pending migration\(s\)/.test(st.out), st.out.slice(-120))

  /* 4. idempotency */
  console.log('\n4. Idempotency — re-running up changes nothing')
  const before = await tableCount()
  const again = runner(['up'])
  check('second up exits 0', again.ok, again.out.slice(-160))
  check('reports 0 applied', /0 migration\(s\) applied/.test(again.out), again.out.slice(-120))
  check('table count unchanged', await tableCount() === before,
    `${before} -> ${await tableCount()}`)
  check('still no duplicates', await duplicateTables() === 0)
  const third = runner(['up'])
  check('third up also a no-op', /0 migration\(s\) applied/.test(third.out))

  /* 5. down / rollback */
  console.log('\n5. Rollback')
  const down = runner(['down'])
  check('down exits 0', down.ok, down.out.slice(-200))
  check('reports 7 rolled back', /7 migration\(s\) rolled back/.test(down.out),
    down.out.slice(-160))
  check('all module tables gone', await tableCount() === 0, String(await tableCount()))
  // The bug the first implementation had: DROP SCHEMA CASCADE took the ledger
  // with it, and node-pg-migrate then failed deleting its own row.
  const ledgersLeft = await scalar(
    `SELECT count(*)::int FROM pg_class WHERE relname='pgmigrations'`)
  check('ledgers SURVIVE the rollback', ledgersLeft === 7,
    `${ledgersLeft} — down must not drop the schema holding its own history`)
  for (const m of MODULES) {
    check(`${m.padEnd(13)} ledger row removed`, await ledgerRows(m) === 0,
      String(await ledgerRows(m)))
  }

  /* 6. round trip */
  console.log('\n6. Round trip — up after down')
  const reUp = runner(['up'])
  check('re-up exits 0', reUp.ok, reUp.out.slice(-160))
  check('29 tables again', await tableCount() === 29, String(await tableCount()))
  check('still zero cross-module FKs', await crossModuleFks() === 0)
  check('still 21 within-module FKs', await withinFks() === 21, String(await withinFks()))

  /* 7. failure leaves the module untouched */
  console.log('\n7. A failing migration rolls its module back completely')
  {
    const dir = path.join(MIGRATIONS, 'files')
    const bad = path.join(dir, '0002_deliberate_failure.js')
    fs.writeFileSync(bad, [
      '// TEMPORARY fixture written by migrate-system.test.js. Deleted in teardown.',
      'exports.up = (pgm) => {',
      "  pgm.sql('CREATE TABLE files.zz_should_not_survive (id int);')",
      "  pgm.sql('SELECT 1/0;')  // fails AFTER a successful statement",
      '}',
      'exports.down = () => {}',
      '',
    ].join('\n'), 'utf8')

    try {
      const filesBefore = await tableCount()
      const r = runner(['up', '--module', 'files'])
      check('runner exits non-zero on failure', !r.ok, `exit ${r.status}`)
      check('it says the migration failed', /MIGRATION FAILED/.test(r.out), r.out.slice(-200))

      const survived = await scalar(
        `SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='files' AND c.relname='zz_should_not_survive'`)
      check('the half-created table did NOT survive', survived === 0,
        `${survived} — singleTransaction must roll the whole module back`)
      check('table count unchanged', await tableCount() === filesBefore,
        `${filesBefore} -> ${await tableCount()}`)
      check('no ledger row for the failed migration', await ledgerRows('files') === 1,
        `${await ledgerRows('files')} — a failed migration must not be recorded as applied`)
    } finally {
      fs.unlinkSync(bad)
    }
    // And the module is still migratable afterwards.
    const recover = runner(['up', '--module', 'files'])
    check('module still migratable after a failure', recover.ok, recover.out.slice(-160))
  }

  /* 8. baseline */
  console.log('\n8. Baseline marks without executing')
  {
    await reset()
    // Simulate an already-provisioned database: create the schemas and one
    // table by hand, the way dev and production already look.
    for (const m of MODULES) await pool.query(`CREATE SCHEMA "${m}"`)
    await pool.query('CREATE TABLE identity.users (id uuid PRIMARY KEY)')
    const handmade = await tableCount()

    const b = runner(['baseline'])
    check('baseline exits 0', b.ok, b.out.slice(-200))
    check('reports 7 modules baselined', /7 module\(s\) baselined/.test(b.out), b.out.slice(-160))
    check('it did NOT create the 29 tables', await tableCount() === handmade,
      `${handmade} -> ${await tableCount()} — baseline must not execute the body`)
    for (const m of MODULES) {
      check(`${m.padEnd(13)} marked applied`, await ledgerRows(m) === 1, String(await ledgerRows(m)))
    }
    const after = runner(['up'])
    check('a later up then has nothing to do', /0 migration\(s\) applied/.test(after.out),
      after.out.slice(-140))
    check('and still did not create the tables', await tableCount() === handmade,
      `${handmade} -> ${await tableCount()}`)

    // Baseline must refuse to paper over an existing history.
    const b2 = runner(['baseline'])
    check('re-baselining is refused as already-recorded',
      /already has 1 ledger row/.test(b2.out), b2.out.slice(-200))
  }

  /* 9. target guards */
  console.log('\n9. Target guards')
  {
    const prod = 'postgresql://postgres.ostmlxuzhprymlchmmak:x@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'
    const r1 = runner(['up'], { DATABASE_URL: prod })
    check('production refused for up', !r1.ok && /THIS IS PRODUCTION/.test(r1.out),
      r1.out.slice(-160))
    const r2 = runner(['down'], { DATABASE_URL: prod })
    check('production refused for down', !r2.ok && /THIS IS PRODUCTION/.test(r2.out),
      r2.out.slice(-160))
    const r3 = runner(['status'], { DATABASE_URL: prod })
    check('production refused even for status', !r3.ok && /THIS IS PRODUCTION/.test(r3.out),
      r3.out.slice(-160))

    const devUrl = 'postgresql://postgres.dbuiauuhajwwpisjevpk:x@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'
    const r4 = runner(['down'], { DATABASE_URL: devUrl })
    check('down refused against a hosted database, flag or not',
      !r4.ok && /restricted to a local database/.test(r4.out), r4.out.slice(-200))
    const r5 = runner(['up'], { DATABASE_URL: devUrl })
    check('hosted up refused without --allow-remote',
      !r5.ok && /--allow-remote/.test(r5.out), r5.out.slice(-200))

    const unknown = 'postgresql://postgres.zzzzzzzzzzzzzzzzzz:x@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'
    const r6 = runner(['up', '--allow-remote'], { DATABASE_URL: unknown })
    check('unknown hosted database refused even with --allow-remote',
      !r6.ok && /UNRECOGNISED/.test(r6.out), r6.out.slice(-200))
  }

  /* 10. leave the scratch database in a known good state */
  console.log('\n10. Restore')
  await reset()
  const final = runner(['up'])
  check('final up succeeds', final.ok, final.out.slice(-160))
  check('29 tables', await tableCount() === 29, String(await tableCount()))
  check('0 cross-module FKs', await crossModuleFks() === 0)
}

main()
  .catch((err) => { console.error('\nHARNESS ERROR:', err.message, '\n', err.stack); fail++ })
  .finally(async () => {
    // Remove any stray fixture migration a crash may have left behind.
    for (const m of MODULES) {
      const d = path.join(MIGRATIONS, m)
      if (!fs.existsSync(d)) continue
      for (const f of fs.readdirSync(d)) {
        if (/deliberate_failure/.test(f)) fs.unlinkSync(path.join(d, f))
      }
    }
    console.log(`\n${'='.repeat(66)}\n${pass} passed, ${fail} failed`)
    if (failures.length) {
      console.log('\nFailures:')
      for (const f of failures) console.log(`   - ${f}`)
    }
    await pool.end().catch(() => {})
    process.exit(fail ? 1 : 0)
  })
