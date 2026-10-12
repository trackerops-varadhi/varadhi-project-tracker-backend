#!/usr/bin/env node
/**
 * Schema documentation generator — the one file that shows the whole database.
 * ---------------------------------------------------------------------------
 *
 *     npm run schema:doc            # introspect DATABASE_URL -> docs/SCHEMA.md
 *     npm run schema:doc -- --check  # fail if the committed doc is out of date
 *     node scripts/gen-schema-doc.js --out docs/SCHEMA.md
 *
 * WHY THIS EXISTS
 * An ORM-backed project keeps one schema file — Prisma's schema.prisma is the
 * usual example — and that file is where everyone looks to answer "what columns
 * does this table have". This backend has no ORM on purpose: the authority is
 * `migrations/<module>/*.js`, seventeen files across eight directories, each
 * holding a diff rather than a shape. There is no wrong place to look, but
 * there was also nowhere right: `src/config/schema.sql` is an empty tombstone
 * and must stay one, and reading eight migration directories to learn a column
 * type is not a thing anyone does, so people read the code's SQL instead and
 * guess.
 *
 * So this is the schema.prisma equivalent, with the dependency arrow the right
 * way round: it is GENERATED FROM the database, never read by the application,
 * and nothing migrates from it. A generated document cannot drift into being a
 * second source of truth, because the moment it disagrees with the database it
 * is simply out of date, and `--check` says so.
 *
 * WHAT IT IS NOT
 * It is not a migration tool, and it writes nothing to any database. Every
 * query here is a SELECT against catalogs — information_schema, pg_catalog,
 * pg_indexes — plus `max(name)` on each module's own ledger. There is no DDL,
 * no INSERT/UPDATE/DELETE, and no table data is read: `reltuples` is the
 * planner's own estimate, taken because it is free, and is labelled as an
 * estimate because that is what it is.
 *
 * SAFETY
 * Production is refused by project ref, using PROD_REF imported from
 * migrate-runner so there is one definition of which database that is. Reading
 * production would be harmless, but the committed doc describes dev, and a doc
 * silently regenerated from a different database is worse than a stale one.
 *
 * NOT HAND-EDITED
 * The output carries a generated-by header. Edit this script, not docs/SCHEMA.md.
 */

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')

const { MODULES, resolveTarget, DEV_REF, PROD_REF } = require('../src/config/migrate-runner')

const DEFAULT_OUT = path.join(__dirname, '..', 'docs', 'SCHEMA.md')

/**
 * WHAT GETS EXPANDED, AND WHY NOT EVERYTHING
 *
 * The first run of this script produced 3,200 lines describing 120 tables in
 * 16 schemas, and almost none of it was this project's. A hosted Postgres is
 * full of schemas nobody here wrote — on Supabase: `auth`, `storage`,
 * `realtime`, `vault`, `graphql`, `pgbouncer`, `extensions`. Documenting
 * Supabase's own `auth.users` next to our `identity.users` is worse than
 * leaving it out: this backend issues its own JWTs and never reads that table,
 * so its presence in our schema document invites exactly the wrong conclusion.
 *
 * `public` is the other case. On dev it holds 29 empty copies of the module
 * tables, left by a pre-split deployment. Expanding them would print a second,
 * plausible-looking definition of nearly every table in the system — a reader
 * could lift columns from a shadow and never know. So `public` is listed by
 * table name only, with the tripwire note, and never expanded.
 *
 * Full detail is therefore exactly the schemas this backend owns: one per
 * module, each with its own ledger. Everything else is named, counted, and
 * left alone.
 */
const OWNED = new Set(MODULES)

// The 7 tables an earlier Prisma-era project left in `public`. They hold 5 rows
// between them, nothing in src/ reads them, and they are on the leave-list in
// migrate-schema-split.js. They are called out rather than hidden, because
// "public holds exactly these and nothing else" is the tripwire the production
// verification scripts use.
const LEGACY_PUBLIC = new Set([
  'ActivityLog', 'Document', 'Project', 'ProjectMember', 'Task', 'User', '_prisma_migrations',
])

/* ── Readable types ───────────────────────────────────────────────────────── */

// information_schema.data_type says "character varying"; every developer on
// this project says varchar. udt_name is the short form, so it is preferred and
// only widened where the short form loses something.
const UDT_ALIASES = {
  int2: 'smallint', int4: 'integer', int8: 'bigint',
  bool: 'boolean', float4: 'real', float8: 'double precision',
  timestamptz: 'timestamptz', timestamp: 'timestamp', timetz: 'timetz',
  bpchar: 'char',
}

const renderType = (col) => {
  const udt = col.udt_name
  const base = UDT_ALIASES[udt] || udt

  if (col.data_type === 'ARRAY') return `${(UDT_ALIASES[udt.replace(/^_/, '')] || udt.replace(/^_/, ''))}[]`
  if (col.character_maximum_length) return `${base}(${col.character_maximum_length})`
  if (base === 'numeric' && col.numeric_precision) {
    return `numeric(${col.numeric_precision},${col.numeric_scale ?? 0})`
  }
  return base
}

// A default like `nextval('x_id_seq'::regclass)` or a long expression is noise
// in a table of columns; the shape is what matters.
const renderDefault = (raw) => {
  if (raw === null || raw === undefined) return ''
  const d = String(raw)
  if (/^nextval\(/.test(d)) return 'auto'
  if (d.length > 38) return `${d.slice(0, 35)}…`
  return d
}

const escapePipes = (s) => String(s).replace(/\|/g, '\\|')

/**
 * `reltuples` is -1, not 0, for a table ANALYZE has never visited — Postgres 14
 * made that distinction explicit so a planner could tell "empty" from
 * "unknown". Printing "~-1 rows" would be worse than printing nothing.
 */
const renderRows = (approx) =>
  approx === null || approx === undefined || approx < 0
    ? 'row count not analysed'
    : `~${approx} rows (planner estimate)`

/* ── Introspection (every query read-only) ────────────────────────────────── */

async function introspect(pool) {
  // Every schema, with how many tables it holds — one cheap query that covers
  // both the ones expanded below and the ones only named.
  const { rows: schemaRows } = await pool.query(`
    SELECT n.nspname AS schema,
           count(c.oid) FILTER (WHERE c.relkind = 'r')::int AS tables
      FROM pg_namespace n
      LEFT JOIN pg_class c ON c.relnamespace = n.oid
     WHERE n.nspname NOT LIKE 'pg\\_%'
       AND n.nspname <> 'information_schema'
     GROUP BY n.nspname
     ORDER BY n.nspname
  `)

  // Owned, in the module order the runner migrates them in — the order the
  // system is actually built in, rather than alphabetical.
  const present = new Set(schemaRows.map((r) => r.schema))
  const schemas = MODULES.filter((m) => present.has(m))
  const others = schemaRows.filter((r) => !OWNED.has(r.schema) && r.schema !== 'public')

  if (schemas.length === 0) return { schemas: [], others, publicTables: [] }

  // `public` by name only. See the OWNED comment above for why.
  const { rows: publicTables } = await pool.query(`
    SELECT c.relname AS name, c.reltuples::bigint AS approx
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  `)

  const [columns, constraints, indexes, approx, enums, views] = await Promise.all([
    pool.query(`
      SELECT c.table_schema AS schema, c.table_name AS table, c.column_name AS column,
             c.ordinal_position, c.data_type, c.udt_name,
             c.character_maximum_length, c.numeric_precision, c.numeric_scale,
             c.is_nullable, c.column_default
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE t.table_type = 'BASE TABLE'
         AND c.table_schema = ANY($1)
       ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `, [schemas]),

    pool.query(`
      SELECT n.nspname AS schema, cl.relname AS table, con.conname AS name,
             con.contype AS type, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE n.nspname = ANY($1)
       ORDER BY n.nspname, cl.relname, con.contype, con.conname
    `, [schemas]),

    pool.query(`
      SELECT schemaname AS schema, tablename AS table, indexname AS name, indexdef AS def
        FROM pg_indexes
       WHERE schemaname = ANY($1)
       ORDER BY schemaname, tablename, indexname
    `, [schemas]),

    // The planner's estimate, not a count. Free, and never touches a row.
    pool.query(`
      SELECT n.nspname AS schema, c.relname AS table, c.reltuples::bigint AS approx
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname = ANY($1)
    `, [schemas]),

    pool.query(`
      SELECT n.nspname AS schema, t.typname AS name,
             string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS labels
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = ANY($1)
       GROUP BY n.nspname, t.typname
       ORDER BY n.nspname, t.typname
    `, [schemas]),

    pool.query(`
      SELECT table_schema AS schema, table_name AS name
        FROM information_schema.views
       WHERE table_schema = ANY($1)
       ORDER BY table_schema, table_name
    `, [schemas]),
  ])

  return {
    schemas,
    others,
    publicTables,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    approx: approx.rows,
    enums: enums.rows,
    views: views.rows,
  }
}

/**
 * Where each module's own ledger stands. to_regclass first, because naming a
 * missing relation in a query raises 42P01 and would take the whole run with
 * it — the same trap the production precheck script fell into.
 */
async function ledgerState(pool) {
  const out = []
  for (const module of MODULES) {
    // From a repo constant, never input; validated anyway, because this is the
    // one place in the file where an identifier is interpolated.
    if (!/^[a-z_]+$/.test(module)) throw new Error(`Refusing odd module name: ${module}`)

    const { rows } = await pool.query('SELECT to_regclass($1) AS rel', [`${module}.pgmigrations`])
    if (!rows[0].rel) {
      out.push({ module, at: null, applied: 0 })
      continue
    }
    const { rows: led } = await pool.query(
      `SELECT max(name) AS at, count(*)::int AS applied FROM ${module}.pgmigrations`
    )
    out.push({ module, at: led[0].at, applied: led[0].applied })
  }
  return out
}

/* ── Rendering ────────────────────────────────────────────────────────────── */

const groupBy = (rows, key) => {
  const map = new Map()
  for (const r of rows) {
    const k = key(r)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(r)
  }
  return map
}

const CONSTRAINT_LABEL = { p: 'PRIMARY KEY', u: 'UNIQUE', f: 'FOREIGN KEY', c: 'CHECK' }

function render(data, ledger, target) {
  const byTable = groupBy(data.columns, (r) => `${r.schema}.${r.table}`)
  const consByTable = groupBy(data.constraints, (r) => `${r.schema}.${r.table}`)
  const idxByTable = groupBy(data.indexes, (r) => `${r.schema}.${r.table}`)
  const approxByTable = new Map(data.approx.map((r) => [`${r.schema}.${r.table}`, r.approx]))
  const viewsBySchema = groupBy(data.views, (r) => r.schema)

  const L = []
  const tableCount = byTable.size

  L.push('# Database schema')
  L.push('')
  L.push('<!-- GENERATED FILE — do not edit by hand.')
  L.push('     Regenerate with: npm run schema:doc')
  L.push('     Source: scripts/gen-schema-doc.js -->')
  L.push('')
  L.push(`Generated **${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC** from the **${target}** database.`)
  L.push('')
  L.push(
    'This file is generated from a live database, never read by the application, and nothing migrates from it. ' +
    'The authority for the schema remains `migrations/<module>/*.js`; this is the readable view of what those ' +
    'migrations have produced. If it disagrees with the database it is out of date — run `npm run schema:doc`.'
  )
  L.push('')
  L.push(`**${data.schemas.length} module schemas, ${tableCount} tables** — the schemas this backend owns.`)
  L.push('')
  L.push(
    'Schemas this backend does not own are named at the end rather than expanded: documenting the platform\'s own ' +
    '`auth.users` beside our `identity.users` would invite exactly the wrong conclusion, since this backend issues ' +
    'its own tokens and never reads it.'
  )
  L.push('')

  /* Ledger — the version this document describes. */
  L.push('## Migration state')
  L.push('')
  L.push('Each module owns its tables and its own ledger, so "what version is the database at" has one answer per')
  L.push('module. This is the position the rest of this document was read at.')
  L.push('')
  L.push('| Module | Ledger | Applied | At |')
  L.push('| --- | --- | --- | --- |')
  for (const row of ledger) {
    L.push(
      `| \`${row.module}\` | ${row.at === null ? '**missing**' : `\`${row.module}.pgmigrations\``} ` +
      `| ${row.applied} | ${row.at ? `\`${row.at}\`` : '—'} |`
    )
  }
  L.push('')

  /* Enums, if any. */
  if (data.enums.length > 0) {
    L.push('## Enum types')
    L.push('')
    L.push('| Schema | Type | Values |')
    L.push('| --- | --- | --- |')
    for (const e of data.enums) {
      L.push(`| \`${e.schema}\` | \`${e.name}\` | ${escapePipes(e.labels)} |`)
    }
    L.push('')
    L.push(
      'Note: most "status" columns in this project are **varchar with a CHECK constraint**, not enums — a CHECK is ' +
      'alterable in one statement where adding an enum label is not reversible. The CHECK text is listed with each table.'
    )
    L.push('')
  }

  /* One section per schema. */
  for (const schema of data.schemas) {
    // The ledger is migration infrastructure, not part of the domain, and the
    // Migration state table above already says where each one stands.
    const tables = [...byTable.keys()]
      .filter((k) => k.startsWith(`${schema}.`) && !k.endsWith('.pgmigrations'))
      .sort()

    L.push('---')
    L.push('')
    L.push(`## \`${schema}\``)
    L.push('')

    if (tables.length === 0 && !viewsBySchema.has(schema)) {
      L.push('_No tables._')
      L.push('')
      continue
    }

    for (const qualified of tables) {
      const name = qualified.slice(schema.length + 1)
      const cols = byTable.get(qualified)
      const cons = consByTable.get(qualified) || []
      const idx = idxByTable.get(qualified) || []
      const rows = approxByTable.get(qualified)

      // The primary key's columns, so they can be marked in the column table
      // rather than only described underneath it.
      const pk = cons.find((c) => c.type === 'p')
      const pkCols = new Set(
        pk ? (pk.def.match(/\(([^)]*)\)/)?.[1] || '').split(',').map((s) => s.trim().replace(/"/g, '')) : []
      )

      L.push(`### \`${schema}.${name}\``)
      L.push('')
      L.push(`${cols.length} columns · ${renderRows(rows)}`)
      L.push('')
      L.push('| Column | Type | Null | Default |')
      L.push('| --- | --- | --- | --- |')
      for (const c of cols) {
        const marker = pkCols.has(c.column) ? ' 🔑' : ''
        L.push(
          `| \`${c.column}\`${marker} | ${renderType(c)} | ${c.is_nullable === 'YES' ? 'yes' : 'no'} ` +
          `| ${escapePipes(renderDefault(c.column_default)) || '—'} |`
        )
      }
      L.push('')

      const interesting = cons.filter((c) => c.type !== 'p')
      if (interesting.length > 0) {
        L.push('Constraints:')
        L.push('')
        for (const c of interesting) {
          L.push(`- **${CONSTRAINT_LABEL[c.type] || c.type}** \`${c.name}\` — \`${c.def}\``)
        }
        L.push('')
      }

      // Only indexes that are not simply the constraint already listed above.
      const extraIdx = idx.filter((i) => !cons.some((c) => c.name === i.name))
      if (extraIdx.length > 0) {
        L.push('Indexes:')
        L.push('')
        for (const i of extraIdx) {
          L.push(`- \`${i.name}\` — \`${i.def.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, '')}\``)
        }
        L.push('')
      }
    }

    const views = viewsBySchema.get(schema) || []
    if (views.length > 0) {
      L.push(`#### Views in \`${schema}\``)
      L.push('')
      for (const v of views) L.push(`- \`${v.name}\``)
      L.push('')
    }
  }

  /* `public` — names only, deliberately. */
  L.push('---')
  L.push('')
  L.push('## `public` — not on any search_path')
  L.push('')
  L.push('`public` was removed from every pool\'s `search_path` on 2026-10-05, after a pre-split deployment ran the')
  L.push('legacy provisioner and left empty copies of the module tables here — at which point a stray cross-module')
  L.push('query resolved against an empty shadow instead of raising. Nothing in this schema is visible to the')
  L.push('application.')
  L.push('')
  L.push('**Listed by name only, on purpose.** Expanding a shadow would print a second, plausible-looking definition')
  L.push('of nearly every table in the system, and a reader could lift columns from one without ever knowing.')
  L.push('')

  const legacy = data.publicTables.filter((t) => LEGACY_PUBLIC.has(t.name))
  const unexpected = data.publicTables.filter((t) => !LEGACY_PUBLIC.has(t.name))

  L.push(`Legacy Prisma-era tables — expected, untouched, on the leave-list in \`migrate-schema-split.js\`: ` +
    `**${legacy.length}**${legacy.length ? ` (${legacy.map((t) => `\`${t.name}\``).join(', ')})` : ''}.`)
  L.push('')

  if (unexpected.length > 0) {
    L.push(`> **${unexpected.length} table(s) in \`public\` that nothing should have created.**`)
    L.push('>')
    L.push(`> ${unexpected.map((t) => `\`${t.name}\``).join(', ')}`)
    L.push('>')
    L.push('> Each one means some process wrote to `public`. This is the tripwire the production verification')
    L.push('> scripts check — see `docs/production-verify.sql`. On dev these are the 29 shadows from 2026-10-05;')
    L.push('> `npm run test:isolation` reports them as warnings on every run.')
    L.push('')
  }

  /* Everything else: named and counted, never expanded. */
  if (data.others.length > 0) {
    L.push('---')
    L.push('')
    L.push('## Schemas this backend does not own')
    L.push('')
    L.push('Platform schemas belonging to the hosting provider, plus the extension sandbox. No migration in this')
    L.push('repository touches any of them, and `extensions` is the only one on a pool\'s `search_path`.')
    L.push('')
    L.push('| Schema | Tables |')
    L.push('| --- | --- |')
    for (const o of data.others) L.push(`| \`${o.schema}\` | ${o.tables} |`)
    L.push('')
  }

  L.push('---')
  L.push('')
  L.push('Generated by `scripts/gen-schema-doc.js`. See `migrations/README.md` for how migrations are organised and')
  L.push('`docs/ARCHITECTURE.md` for where each module lives.')
  L.push('')

  return L.join('\n')
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

const refuse = (lines) => {
  console.error(`\n${lines.join('\n')}\n`)
  process.exit(1)
}

async function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const outFlag = argv.indexOf('--out')
  const out = outFlag !== -1 ? path.resolve(argv[outFlag + 1]) : DEFAULT_OUT

  const { url, host, ref, loopback } = resolveTarget()
  if (!url) refuse(['No DATABASE_URL. Nothing to introspect.'])

  if (ref === PROD_REF) {
    refuse([
      'REFUSING — THIS IS PRODUCTION.',
      '',
      '  Reading production would be harmless, but docs/SCHEMA.md describes dev,',
      '  and a document silently regenerated from a different database is worse',
      '  than a stale one. Point DATABASE_URL at dev, or pass --out somewhere else',
      '  after deciding that is what you want.',
    ])
  }

  // The classification, never the URL: this string goes into a committed file.
  const target = ref === DEV_REF ? 'development (Supabase)' : loopback ? 'local' : `remote host ${host}`

  const pool = new Pool({ connectionString: url, max: 2 })
  try {
    const data = await introspect(pool)
    if (data.schemas.length === 0) refuse(['No application schemas found. Has anything been migrated?'])

    const ledger = await ledgerState(pool)
    const markdown = render(data, ledger, target)

    if (check) {
      const existing = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
      // The generated-at line differs on every run by design, so compare
      // everything except it — otherwise --check could never pass.
      const strip = (s) => s.replace(/^Generated \*\*.*$/m, '')
      if (strip(existing) === strip(markdown)) {
        console.log(`docs/SCHEMA.md is up to date (${target}).`)
        return
      }
      refuse([
        `${path.relative(process.cwd(), out)} is out of date against ${target}.`,
        '  Run: npm run schema:doc',
      ])
    }

    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, markdown, 'utf8')

    const tables = new Set(data.columns.map((c) => `${c.schema}.${c.table}`)).size
    console.log(`\nWrote ${path.relative(process.cwd(), out)}`)
    console.log(`  ${target}: ${data.schemas.length} schemas, ${tables} tables, ${data.enums.length} enum types`)
    console.log(`  ledger: ${ledger.map((l) => `${l.module}@${l.at || 'none'}`).join(', ')}\n`)
  } finally {
    await pool.end()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nSCHEMA DOC FAILED: ${err.message}\n`)
    if (process.env.MIGRATE_DEBUG) console.error(err)
    process.exit(1)
  })
}

module.exports = { renderType, renderDefault }
