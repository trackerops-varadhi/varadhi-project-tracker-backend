#!/usr/bin/env node
/**
 * Per-service database roles — proof that each one is confined.
 * ---------------------------------------------------------------------------
 *
 *     npm run test:db-roles
 *
 * WHAT IT PROVES
 * For every service with its own credential set, this connects AS that service
 * and asserts both halves of the claim:
 *
 *   it CAN reach every schema its service owns
 *   it is REFUSED on every schema it does not — with 42501, from Postgres
 *
 * The second half is the whole point. `npm run test:isolation` already shows
 * that an unqualified cross-module name raises `42P01` because `public` is off
 * the search_path. That is a test of a convention: a QUALIFIED name like
 * `people.employee_profiles` still worked from the `work` pool, because one
 * role was allowed to read everything. This is what makes it not work.
 *
 * READ-ONLY. Every query here is a SELECT, and the refusals are expected
 * errors, not failures. It creates nothing and changes nothing.
 *
 * SKIPS CLEANLY. With no DATABASE_URL_<SERVICE> set there is nothing to prove
 * and the suite says so and exits 0 — so it can sit in CI from the day it is
 * written, and start asserting the moment the first role is pointed at.
 *
 * Run it against dev before production, one service at a time: set that
 * service's variable, run this, then move on. A failure here means the grants
 * in docs/db-roles.sql did not land as generated, which is exactly what you
 * want to discover before the application connects that way.
 */

require('dotenv').config()

const { Client } = require('pg')

const { SERVICES, SERVICE_NAMES, ALL_SCHEMAS, envVarFor, roleFor } = require('../src/platform/service-map')

let pass = 0
let fail = 0
const failures = []

const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    failures.push(`${name} ${extra}`.trim())
    console.log(`  FAIL  ${name} ${extra}`)
  }
}

const ssl = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false

/**
 * Probe one schema as the connected role.
 *
 * Every module schema carries its own `pgmigrations` ledger, so it is the one
 * table guaranteed to exist in all of them — which makes it the right probe
 * without this file needing to know a single domain table name.
 *
 * @returns {Promise<{ok: boolean, code: string|null}>}
 */
async function probe(client, schema) {
  try {
    await client.query(`SELECT 1 FROM ${schema}.pgmigrations LIMIT 1`)
    return { ok: true, code: null }
  } catch (err) {
    return { ok: false, code: err.code || null }
  }
}

async function main() {
  console.log('\nPer-service database roles\n')

  const configured = SERVICE_NAMES.filter((s) => Boolean(process.env[envVarFor(s)]))

  if (configured.length === 0) {
    console.log('  SKIP  no DATABASE_URL_<SERVICE> is set, so no role is in use yet.')
    console.log('        Apply docs/db-roles.sql, set a password, then point one service at it:')
    console.log(`        ${SERVICE_NAMES.map(envVarFor).join(', ')}`)
    console.log('')
    return
  }

  console.log(`  ${configured.length} of ${SERVICE_NAMES.length} service(s) configured: ${configured.join(', ')}\n`)

  for (const service of configured) {
    const own = SERVICES[service]
    const foreign = ALL_SCHEMAS.filter((s) => !own.includes(s))
    const client = new Client({ connectionString: process.env[envVarFor(service)], ssl, connectionTimeoutMillis: 8000 })

    console.log(`  ${service} (${roleFor(service)})`)

    try {
      await client.connect()
    } catch (err) {
      check(`${service}: connects`, false, err.message)
      continue
    }

    // Connected as the role the grants were written for, and not as the
    // shared superuser by accident — which would make every assertion below
    // pass for the wrong reason.
    const { rows } = await client.query('SELECT current_user AS who, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super')
    check(`${service}: connects as ${roleFor(service)}`, rows[0].who === roleFor(service), `got ${rows[0].who}`)
    check(`${service}: is not a superuser`, rows[0].is_super === false, 'a superuser bypasses every grant')

    for (const schema of own) {
      const r = await probe(client, schema)
      check(`${service}: can read its own ${schema}`, r.ok, r.code ? `got ${r.code}` : '')
    }

    for (const schema of foreign) {
      const r = await probe(client, schema)
      // 42501 = permission denied. 3F000 = schema does not exist, which is what
      // a role without USAGE sees in some paths; either is a refusal.
      const refused = !r.ok && ['42501', '3F000'].includes(r.code)
      check(`${service}: is refused on ${schema}`, refused, r.ok ? 'IT COULD READ IT' : `got ${r.code}`)
    }

    // `public` needs its own assertion rather than a probe, for two reasons.
    //
    // Postgres grants USAGE on schema `public` to the pseudo-role PUBLIC, so
    // every role inherits it and it shows up in any schema-privilege listing.
    // It cannot be revoked per-role — only from PUBLIC, globally, which would
    // also hit the migration role. So the grant stays and the control is at
    // table level: USAGE on a schema reads nothing without a table privilege.
    //
    // And `public` holds 29 shadow copies of the module tables on dev. A role
    // that could read one would see a plausible, empty version of its own data,
    // which is the failure mode the 2026-10-05 search_path change exists to
    // prevent. So: name the tables if any are readable, rather than counting.
    const { rows: leaks } = await client.query(`
      SELECT n.nspname || '.' || c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND has_table_privilege(current_user, c.oid, 'SELECT')
       ORDER BY 1
    `)
    check(
      `${service}: cannot read any table in public`,
      leaks.length === 0,
      leaks.length ? `readable: ${leaks.map((r) => r.name).join(', ')}` : ''
    )

    await client.end().catch(() => {})
    console.log('')
  }
}

main()
  .then(() => {
    if (fail > 0) {
      console.log(`${'─'.repeat(60)}`)
      console.log(`  ${pass} passed, ${fail} failed`)
      for (const f of failures) console.log(`    - ${f}`)
      console.log(`${'─'.repeat(60)}\n`)
      process.exit(1)
    }
    if (pass > 0) {
      console.log(`${'─'.repeat(60)}`)
      console.log(`  ${pass} passed, 0 failed`)
      console.log(`${'─'.repeat(60)}\n`)
    }
    process.exit(0)
  })
  .catch((err) => {
    console.error(`\nDB ROLE TEST CRASHED: ${err.message}\n`)
    process.exit(1)
  })
