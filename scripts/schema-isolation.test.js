/*
 * Schema isolation — the regression test for the boundary the module pools exist
 * to enforce.
 *
 * THE BUG THIS GUARDS AGAINST
 * ---------------------------
 * Each module gets a pool whose `search_path` is its own schema (platform/db.js),
 * so a query for a table another module owns is supposed to fail loudly rather
 * than silently work. For a while the path was `<schema>,public,extensions`, on
 * the reasoning that `public` holds only the seven legacy Prisma tables and so
 * has nothing a stray query could resolve to.
 *
 * That reasoning depended on a fact no code controls. On 2026-10-03 a pre-split
 * backend — whose pool sets no search_path, so it operates in `public` — was
 * pointed at the development database, ran the legacy provisioner, and created
 * 29 empty copies of the module tables in `public`. From that moment every
 * cross-module query resolved against an empty shadow instead of raising: the
 * `work` pool asking for `notifications` got 1 row while `notify.notifications`
 * held 1442. Isolation measured 0 of 7. Nothing errored, so nothing noticed.
 *
 * `public` is off the path now, which makes the guarantee independent of what
 * else is in the database. This suite is what keeps it that way, and it also
 * reports shadow tables directly, because their presence is a live warning that
 * something is writing to the wrong place even when isolation holds.
 *
 * READ-ONLY. Every statement is a SELECT, wrapped in a read-only transaction
 * where it touches the database at all, so this is safe against any environment
 * including one with real data. It writes nothing and needs no fixtures.
 *
 *   node scripts/schema-isolation.test.js
 */
require('dotenv').config()
const db = require('../src/platform/db')

const MODULES = db.MODULE_SCHEMAS

// The seven legacy Prisma tables are expected in `public` and must stay there.
// Anything else in `public` that shares a name with a module table is a shadow.
const LEGACY_PRISMA = [
  'ActivityLog', 'Document', 'Project', 'ProjectMember', 'Task', 'User', '_prisma_migrations',
]

let pass = 0
let fail = 0
let warn = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`) }
}
const warning = (text) => { warn++; console.log(`  WARN  ${text}`) }

/* A table each module owns, and one it must not be able to reach. */
const OWN = {
  identity: 'users',
  work: 'tasks',
  defects: 'bugs',
  notify: 'notifications',
  integrations: 'teams_webhooks',
  files: 'documents',
  workforce: 'time_logs',
  people: 'employee_profiles',
}
const FOREIGN = {
  identity: 'tasks',
  work: 'notifications',
  defects: 'users',
  notify: 'tasks',
  integrations: 'users',
  files: 'projects',
  workforce: 'tasks',
  people: 'users',
}

async function main() {
  console.log('\nSchema isolation\n')

  // Skip rather than fail where the schemas have not been created yet: this
  // suite runs in CI against a freshly migrated database and locally against
  // dev, and "not migrated" is a different problem with its own error.
  const { rows: present } = await db.query(
    'SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)', [MODULES]
  )
  if (present.length !== MODULES.length) {
    console.log(`SKIP — ${present.length}/${MODULES.length} module schemas exist. Run \`npm run migrate\` first.`)
    return
  }

  console.log('1. Every module pool reads its own tables')
  for (const schema of MODULES) {
    const table = OWN[schema]
    try {
      await db.forSchema(schema).query(`SELECT 1 FROM ${table} LIMIT 1`)
      check(`${schema} pool reads ${table}`, true)
    } catch (err) {
      check(`${schema} pool reads ${table}`, false, `-> ${err.code} ${err.message.split('\n')[0]}`)
    }
  }

  console.log('\n2. No module pool can reach another module\'s table (must raise 42P01)')
  for (const schema of MODULES) {
    const table = FOREIGN[schema]
    let raised = null
    try {
      const { rows } = await db.forSchema(schema).query(`SELECT count(*)::int n FROM ${table}`)
      check(`${schema} pool + unqualified "${table}" raises`, false,
        `-> RESOLVED and returned ${rows[0].n} row(s). search_path is leaking.`)
      continue
    } catch (err) { raised = err }
    // 42P01 = undefined_table. Anything else means it failed for the wrong reason.
    check(`${schema} pool + unqualified "${table}" raises 42P01`,
      raised.code === '42P01', `-> got ${raised.code} ${raised.message.split('\n')[0]}`)
  }

  console.log('\n3. A module pool can still reach another module through a QUALIFIED name')
  // The boundary is about accidents, not about making cross-schema SQL
  // impossible — migrations and audits need qualified access to work.
  try {
    const { rows } = await db.forSchema('work').query('SELECT count(*)::int n FROM notify.notifications')
    check('work pool reads notify.notifications when qualified', typeof rows[0].n === 'number')
  } catch (err) {
    check('work pool reads notify.notifications when qualified', false, err.message.split('\n')[0])
  }

  console.log('\n4. search_path contains the module schema and no public')
  for (const schema of MODULES) {
    const { rows } = await db.forSchema(schema).query('SHOW search_path')
    const path = rows[0].search_path
    check(`${schema} path = "${path}"`, path.includes(schema) && !/\bpublic\b/.test(path))
  }

  console.log('\n5. public holds no copies of module tables (a shadow means something writes there)')
  const { rows: owned } = await db.query(
    `SELECT table_name t FROM information_schema.tables
      WHERE table_schema = ANY($1) AND table_type = 'BASE TABLE'`, [MODULES]
  )
  const moduleTables = new Set(owned.map((r) => r.t))
  const { rows: pub } = await db.query(
    `SELECT table_name t FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`
  )
  const shadows = pub.map((r) => r.t).filter((t) => moduleTables.has(t) && !LEGACY_PRISMA.includes(t))
  const unexpected = pub.map((r) => r.t).filter((t) => !moduleTables.has(t) && !LEGACY_PRISMA.includes(t))

  // Reported as a warning, not a failure: isolation now holds regardless, and
  // the shadows are quarantined by a separate, reviewed change. This line is
  // here so the day they reappear is the day someone sees it.
  if (shadows.length) {
    warning(`${shadows.length} shadow table(s) in public: ${shadows.slice(0, 8).join(', ')}${shadows.length > 8 ? ' …' : ''}`)
    warning('a pre-split backend or legacy provisioner has run against this database')
  } else {
    check('public has no module-table copies', true)
  }
  if (unexpected.length) warning(`public also holds: ${unexpected.join(', ')}`)

  // The legacy Prisma tables are reported, NOT asserted. They exist on the
  // databases that grew from the Prisma era (dev, production) and legitimately
  // do not exist on one provisioned from the migrations — which is what CI and
  // every fresh environment use. Asserting their presence would fail there for
  // no reason. What matters is that a migration never DELETES them, and that is
  // asserted where it belongs: in the cutover script's postconditions.
  const prismaFound = LEGACY_PRISMA.filter((t) => pub.some((r) => r.t === t))
  if (prismaFound.length === LEGACY_PRISMA.length) {
    check(`all ${LEGACY_PRISMA.length} legacy Prisma tables present and untouched`, true)
  } else if (prismaFound.length === 0) {
    console.log(`  INFO  no legacy Prisma tables here — a database provisioned from the migrations`)
  } else {
    warning(`only ${prismaFound.length} of ${LEGACY_PRISMA.length} legacy Prisma tables present: ${prismaFound.join(', ')}`)
  }

  console.log('\n6. No foreign key crosses a module boundary')
  const { rows: crossing } = await db.query(
    `SELECT n.nspname src, fn.nspname tgt, count(*)::int n
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class f ON f.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = f.relnamespace
      WHERE con.contype = 'f' AND n.nspname = ANY($1) AND fn.nspname <> n.nspname
      GROUP BY 1, 2`, [MODULES]
  )
  check('zero cross-schema foreign keys', crossing.length === 0,
    `-> ${crossing.map((r) => `${r.src}->${r.tgt}(${r.n})`).join(' ')}`)
}

main()
  .catch((err) => { fail++; console.error('\nERROR:', err.stack || err.message) })
  .finally(async () => {
    console.log(`\n${pass} passed, ${fail} failed${warn ? `, ${warn} warning(s)` : ''}\n`)
    await db.endAll().catch(() => {})
    process.exitCode = fail ? 1 : 0
  })
