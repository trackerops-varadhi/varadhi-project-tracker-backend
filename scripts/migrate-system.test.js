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
 *   - the baseline reproduces the post-split schema exactly — table count is
 *     DERIVED from the migration files and the module list from the runner,
 *     plus the within-module FK and cascade totals and the sequence in defects
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

/*
 * The module list comes from the RUNNER, deliberately not from a copy here.
 *
 * This file used to keep its own array, and it silently fell a module behind
 * when `people` (Module 9) shipped: the runner migrated eight modules while
 * every expectation in this suite described seven, so CI failed on counts that
 * were all correct about the old world. A second list is a second thing to
 * forget. `migrate-runner.js` is the authority for which modules exist and in
 * what order, and `applied in the declared order` below is precisely the
 * assertion that it was followed.
 */
const { MODULES } = require(path.join(BACKEND, 'src', 'config', 'migrate-runner'))

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

/*
 * Within-module cascades only, scoped the same way withinFks() is.
 *
 * This counted EVERY cascading FK in the database, which made it a test of
 * whatever else happened to be installed -- an extension or a stray table in
 * public would move the number. It passed only because nothing else here has
 * one.
 */
const cascades = () => scalar(
  `SELECT count(*)::int FROM pg_constraint con
     JOIN pg_class s ON s.oid = con.conrelid
     JOIN pg_namespace sn ON sn.oid = s.relnamespace
     JOIN pg_class t ON t.oid = con.confrelid
     JOIN pg_namespace tn ON tn.oid = t.relnamespace
    WHERE con.contype='f' AND con.confdeltype='c'
      AND sn.nspname = tn.nspname AND sn.nspname = ANY($1)`, [MODULES])

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

/*
 * Expectations are DERIVED from the migration directory, never hardcoded.
 *
 * The first version of this suite asserted "7 migrations, 29 tables". Adding one
 * ordinary migration (identity/0002) broke eleven assertions that were all
 * describing the old world correctly — a test that has to be edited every time
 * the thing it guards changes legitimately is a test people start ignoring.
 */
const migrationsOf = (mod) => {
  const d = path.join(MIGRATIONS, mod)
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^\d+.*\.js$/.test(f)).sort() : []
}
const expectedMigrations = () =>
  MODULES.reduce((n, m) => n + migrationsOf(m).length, 0)

/**
 * Tables the migration files themselves claim to create.
 *
 * `keep` narrows it to a subset of the files — phase 8 needs "everything
 * except the baselines", because after baselining, those are the only tables a
 * later `up` is allowed to add.
 */
const expectedTables = (keep = () => true, mods = MODULES) => {
  let n = 0
  for (const mod of mods) {
    for (const f of migrationsOf(mod)) {
      if (!keep(f)) continue
      const src = fs.readFileSync(path.join(MIGRATIONS, mod, f), 'utf8')
      // Anchored to the start of a line so the phrase "pgm.createTable(...)"
      // inside each baseline's explanatory comment is not counted as a table —
      // it was, and inflated the expectation by exactly seven.
      n += (src.match(/^CREATE TABLE /gm) || []).length
      n += (src.match(/^\s*pgm\.createTable\(/gm) || []).length
    }
  }
  return n
}

/*
 * FK TOPOLOGY TRIPWIRES, and why these two are hardcoded when everything else
 * here is derived.
 *
 * A table count can be read off the migration files; a foreign-key graph
 * cannot be, not without reimplementing enough of node-pg-migrate to resolve
 * shorthands and addConstraint calls -- and an expectation derived by a buggy
 * parser passes for the wrong reason, which is worse than one that has to be
 * edited. So these stay explicit, and the point of them is to notice a
 * relationship being dropped during a schema move.
 *
 * Re-measure after adding a module (the delta must be that module's own
 * tables -- if an existing module's count fell, something was lost):
 *
 *   SELECT sn.nspname, count(*) FILTER (WHERE con.confdeltype='c') AS cascades,
 *          count(*) AS fks
 *     FROM pg_constraint con
 *     JOIN pg_class s ON s.oid=con.conrelid JOIN pg_namespace sn ON sn.oid=s.relnamespace
 *     JOIN pg_class t ON t.oid=con.confrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace
 *    WHERE con.contype='f' AND sn.nspname=tn.nspname GROUP BY 1 ORDER BY 1;
 *
 * 2026-10-15: 23 and 17 across eight modules. They were 21 and 15 for seven;
 * `people` accounts for the entire difference with 2 FKs, both cascading
 * (identity 4/2, work 3/3, defects 5/3, notify 3/2, integrations 5/5,
 * files 1/0, workforce 0/0, people 2/2).
 */
const WITHIN_MODULE_FKS = 23
const WITHIN_MODULE_CASCADES = 17

/* ── Tests ────────────────────────────────────────────────────────────────── */

async function main() {
  console.log(`\nMigration system — disposable database at ${host}\n${'='.repeat(66)}`)

  /* 1. fresh database */
  console.log('\n1. Fresh database migrates in the right order')
  await reset()
  check('starts empty', await tableCount() === 0, String(await tableCount()))

  const up = runner(['up'])
  check('runner exited 0', up.ok, up.out.slice(-200))
  const EXPECTED_MIGRATIONS = expectedMigrations()
  check(`reports ${EXPECTED_MIGRATIONS} migrations applied`,
    up.out.includes(`${EXPECTED_MIGRATIONS} migration(s) applied`),
    up.out.slice(-200))
  // Order is fixed so logs and failures are reproducible.
  // `up N:` — a module with more than one pending migration applies them all,
  // so this must not assume 1. Built with the RegExp constructor and explicit
  // double backslashes: a template literal eats `\s` and `\d`.
  const order = MODULES.filter((m) => new RegExp(`${m}\\s+up \\d+:`).test(up.out))
  check(`all ${MODULES.length} modules applied`, order.length === MODULES.length,
    order.join(','))
  check('applied in the declared order', order.join(',') === MODULES.join(','), order.join(','))

  const EXPECTED_TABLES = expectedTables()
  check(`${EXPECTED_TABLES} module tables created (derived from the migration files)`,
    await tableCount() === EXPECTED_TABLES,
    `${await tableCount()} vs ${EXPECTED_TABLES}`)
  check(`${WITHIN_MODULE_FKS} within-module foreign keys`,
    await withinFks() === WITHIN_MODULE_FKS, String(await withinFks()))
  check(`${WITHIN_MODULE_CASCADES} cascades preserved`,
    await cascades() === WITHIN_MODULE_CASCADES, String(await cascades()))
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
    const want = migrationsOf(m).length
    check(`${m.padEnd(13)} ledger has ${want} row(s)`, await ledgerRows(m) === want,
      `${await ledgerRows(m)} vs ${want}`)
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
  // --count higher than any module has, so every migration is reversed and the
  // database returns to empty. The default (1 per module) would leave a module
  // with two migrations holding its baseline.
  const down = runner(['down', '--count', '99'])
  check('down exits 0', down.ok, down.out.slice(-200))
  check(`reports ${EXPECTED_MIGRATIONS} rolled back`,
    down.out.includes(`${EXPECTED_MIGRATIONS} migration(s) rolled back`),
    down.out.slice(-200))
  check('all module tables gone', await tableCount() === 0, String(await tableCount()))
  // The bug the first implementation had: DROP SCHEMA CASCADE took the ledger
  // with it, and node-pg-migrate then failed deleting its own row.
  const ledgersLeft = await scalar(
    `SELECT count(*)::int FROM pg_class WHERE relname='pgmigrations'`)
  check('ledgers SURVIVE the rollback', ledgersLeft === MODULES.length,
    `${ledgersLeft} — down must not drop the schema holding its own history`)
  for (const m of MODULES) {
    check(`${m.padEnd(13)} ledger emptied`, await ledgerRows(m) === 0,
      String(await ledgerRows(m)))
  }

  /* 6. round trip */
  console.log('\n6. Round trip — up after down')
  const reUp = runner(['up'])
  check('re-up exits 0', reUp.ok, reUp.out.slice(-160))
  check(`${EXPECTED_TABLES} tables again`, await tableCount() === EXPECTED_TABLES,
    String(await tableCount()))
  check('still zero cross-module FKs', await crossModuleFks() === 0)
  check(`still ${WITHIN_MODULE_FKS} within-module FKs`,
    await withinFks() === WITHIN_MODULE_FKS, String(await withinFks()))

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
      const wantFiles = migrationsOf('files').filter((f) => !/deliberate_failure/.test(f)).length
      check('no ledger row for the failed migration',
        await ledgerRows('files') === wantFiles,
        `${await ledgerRows('files')} vs ${wantFiles} — a failure must not be recorded as applied`)
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
    /*
     * THE FIXTURE IS THE TEST HERE, so it is built to match the database this
     * command actually ran against on 2026-10-09, not a convenient stub.
     *
     * It used to create the eight schemas by hand plus a one-column
     * `identity.users`, which worked only while identity/0002 was the sole
     * non-baseline migration. Every later migration that ALTERS a baseline
     * table failed on a fixture that never had the table:
     * 0003_hr_role wanted `users_role_check`, work/0002 wanted `work.tasks`.
     * Those failures said nothing about the migration system.
     *
     * A pre-split database is exactly: every table the old provisioner made,
     * no ledger anywhere, and NO `people` schema — people was born after the
     * split. So build it that way: migrate fully, drop people, drop the
     * ledgers. What `baseline` then has to get right is the real thing it was
     * written for.
     */
    /*
     * A module whose first migration is a *_baseline is a TRANSCRIPT of what
     * the old provisioner already built; any other first migration means the
     * module was born after the split and its tables were never there to
     * baseline. That distinction is read from the files, so a ninth module
     * lands on whichever side it belongs to without editing this test.
     */
    const BASELINEABLE = MODULES.filter((m) => /_baseline\.js$/.test(migrationsOf(m)[0] || ''))
    const POST_SPLIT = MODULES.filter((m) => !BASELINEABLE.includes(m))

    await reset()
    // --count 1 applies each module's 0001 and nothing after it, which is the
    // state the old provisioner left behind. Running a FULL up here instead
    // was the second mistake in this fixture: it also created the later
    // migrations' tables, so the `up` below re-ran 0002 against them and died
    // on `relation "rate_limit_buckets" already exists`.
    const prep = runner(['up', '--count', '1'])
    check('fixture provisions cleanly', prep.ok, prep.out.slice(-160))
    for (const m of POST_SPLIT) await pool.query(`DROP SCHEMA IF EXISTS "${m}" CASCADE`)
    for (const m of BASELINEABLE) {
      await pool.query(`DROP TABLE IF EXISTS "${m}"."pgmigrations"`)
    }
    const provisioned = await tableCount()
    const preSplitTables = expectedTables((f) => /^0001_/.test(f), BASELINEABLE)
    check('fixture looks pre-split (0001 tables only, no ledger, no post-split module)',
      provisioned === preSplitTables && (await ledgerRows('identity')) === null,
      `${provisioned} tables vs ${preSplitTables},`
      + ` identity ledger ${await ledgerRows('identity')}`)

    /*
     * `people/0001_people_core` is a real migration that creates tables, so
     * marking it applied would leave the ledger claiming tables that do not
     * exist — the runner skips it by design and says so.
     */
    const b = runner(['baseline'])
    check('baseline exits 0', b.ok, b.out.slice(-200))
    check(`reports ${BASELINEABLE.length} modules baselined`,
      b.out.includes(`${BASELINEABLE.length} module(s) baselined`), b.out.slice(-160))
    check('says why a post-split module was skipped',
      /is not a baseline — skipped/.test(b.out), b.out.slice(-200))
    check(`it did NOT create the ${expectedTables()} tables`,
      await tableCount() === provisioned,
      `${provisioned} -> ${await tableCount()} — baseline must not execute the body`)
    for (const m of MODULES) {
      // baseline marks ONLY the first migration, whatever else the module has
      // — and nothing at all for a module it skipped.
      const want = BASELINEABLE.includes(m) ? 1 : null
      check(`${m.padEnd(13)} ledger ${want === null ? 'untouched' : 'marked applied (0001 only)'}`,
        await ledgerRows(m) === want, String(await ledgerRows(m)))
    }

    /*
     * A later `up` is not a no-op, and that is the entire point of baselining:
     * an existing database skips the provisioning step and then keeps up with
     * everything since. Pending = every migration except the baselines that
     * were just marked, which includes ALL of a post-split module's.
     */
    const after = runner(['up'])
    const pendingAfterBaseline = expectedMigrations() - BASELINEABLE.length
    check(`a later up applies the ${pendingAfterBaseline} pending migration(s)`,
      after.out.includes(`${pendingAfterBaseline} migration(s) applied`),
      after.out.slice(-200))
    /*
     * The delta is TABLES, not migrations. This asserted one table per
     * migration — true when identity/0002 was the only pending one, false the
     * moment 0003_hr_role shipped, which creates none.
     */
    check('it did NOT re-provision the baseline tables',
      await tableCount() === expectedTables(),
      `${provisioned} -> ${await tableCount()}, expected ${expectedTables()}`)
    check('and the schema is whole again', await crossModuleFks() === 0
      && await withinFks() === WITHIN_MODULE_FKS, String(await withinFks()))

    // Baseline must refuse to paper over an existing history.
    const b2 = runner(['baseline'])
    check('re-baselining is refused as already-recorded',
      /already has \d+ ledger row/.test(b2.out), b2.out.slice(-200))
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

    // The ref is extracted from the pooler username, and the per-service roles
    // added for database isolation connect as `svc_<service>.<ref>` rather than
    // `postgres.<ref>`. While the pattern matched only `postgres.`, these URLs
    // produced no ref at all and the production refusal above — which is keyed
    // on the ref — did not fire for them.
    const prodAsService = 'postgresql://svc_core.ostmlxuzhprymlchmmak:x@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'
    const r7 = runner(['status'], { DATABASE_URL: prodAsService })
    check('production refused when connecting as a service role',
      !r7.ok && /THIS IS PRODUCTION/.test(r7.out), r7.out.slice(-200))

    const devAsService = 'postgresql://svc_integrations.dbuiauuhajwwpisjevpk:x@aws-1-ap-south-1.pooler.supabase.com:5432/postgres'
    const r8 = runner(['up'], { DATABASE_URL: devAsService })
    check('a service role still resolves dev, so remote rules apply',
      !r8.ok && /--allow-remote/.test(r8.out), r8.out.slice(-200))
  }

  /* 10. leave the scratch database in a known good state */
  console.log('\n10. Restore')
  await reset()
  const final = runner(['up'])
  check('final up succeeds', final.ok, final.out.slice(-160))
  check(`${expectedTables()} tables`, await tableCount() === expectedTables(),
    String(await tableCount()))
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
