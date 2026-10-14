#!/usr/bin/env node
/**
 * Wire one service's database role into .env — the fiddly half of Stage B step 3.
 * ---------------------------------------------------------------------------
 *
 *     node scripts/wire-service-role.js integrations
 *
 * WHY THIS EXISTS
 * Stage B asks the operator to build a connection string "like DATABASE_URL but
 * with a different user and password". That sounds trivial and is not, because
 * of one detail: through Supabase's pooler the username is `<role>.<project-ref>`,
 * not `<role>`. Write `svc_integrations` where the pooler expects
 * `svc_integrations.dbuiauuhajwwpisjevpk` and Postgres answers `Tenant or user
 * not found` — an error that says nothing about the real mistake. Done by hand,
 * five times, that is five chances to lose an afternoon.
 *
 * So this derives the string from the DATABASE_URL already in .env: same host,
 * port, database and query parameters, with only the user and password changed,
 * and the username shaped to match whichever kind of URL that is.
 *
 * WHAT IT TOUCHES
 * Reads .env, appends ONE line to it, prints the ALTER ROLE statement for you to
 * paste into the SQL editor. It never connects to a database — it cannot set the
 * password itself, which is deliberate: that is a person's act, against a target
 * a person chose.
 *
 * It refuses if the variable is already set, rather than appending a second one
 * (dotenv keeps the first, so a duplicate would silently do nothing).
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

require('dotenv').config()

const { SERVICE_NAMES, SERVICES, envVarFor, roleFor } = require('../src/platform/service-map')

const ENV_PATH = path.join(__dirname, '..', '.env')

const die = (msg) => {
  console.error(`\n  ${msg}\n`)
  process.exit(1)
}

const service = process.argv[2]

if (!service || !SERVICE_NAMES.includes(service)) {
  die(`Which service? One of: ${SERVICE_NAMES.join(', ')}\n\n  node scripts/wire-service-role.js integrations`)
}

const role = roleFor(service)
const varName = envVarFor(service)

if (process.env[varName]) {
  die(`${varName} is already set. Nothing to do.\n  Remove that line from .env first if you want a new password.`)
}

if (!process.env.DATABASE_URL) die('DATABASE_URL is not set, so there is no URL to derive from.')
if (!fs.existsSync(ENV_PATH)) die(`No .env at ${ENV_PATH}`)

const base = new URL(process.env.DATABASE_URL)

// Supavisor routes by tenant, and the tenant lives in the username. A direct
// connection to db.<ref>.supabase.co has the ref in the host instead, so the
// username is the bare role. Getting this backwards is the whole reason for
// this script.
const pooled = /\.pooler\.supabase\.com$/.test(base.hostname)
const ref = (base.username.match(/^[a-z0-9_]+\.([a-z0-9]{16,})$/) || [])[1] || null

if (pooled && !ref) {
  die(`DATABASE_URL points at the pooler but its username carries no project ref.\n  Cannot tell what tenant to use. Build this one by hand.`)
}

const user = pooled ? `${role}.${ref}` : role
const password = crypto.randomBytes(24).toString('base64url')

const url = new URL(base.toString())
url.username = encodeURIComponent(user)
url.password = encodeURIComponent(password)

const line = `${varName}=${url.toString()}`

// Append, with a comment saying what it is, so the file stays readable at the
// point someone else reads it in six months.
const current = fs.readFileSync(ENV_PATH, 'utf8')
const prefix = current.endsWith('\n') || current === '' ? '' : '\n'
fs.appendFileSync(
  ENV_PATH,
  `${prefix}\n# ${service} service role (${SERVICES[service].join(', ')}) - Stage B\n${line}\n`,
  'utf8'
)

console.log(`\n  ${varName} written to .env`)
console.log(`    target : ${base.hostname}  (${pooled ? 'pooler' : 'direct'})`)
console.log(`    user   : ${user}`)
console.log(`    schemas: ${SERVICES[service].join(', ')}`)
console.log(`\n  Now paste this into the SQL editor of THAT database, and only that one:\n`)
console.log(`    ALTER ROLE ${role} PASSWORD '${password}';`)
console.log(`\n  Then prove it:\n`)
console.log(`    npm run test:db-roles`)
console.log(`\n  Until the password is set the role cannot connect, so the test will fail`)
console.log(`  with an authentication error. That is the expected state right now.\n`)
