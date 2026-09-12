/**
 * Readiness check.
 * ---------------------------------------------------------------------------
 * `/health` answers "is this process up?" — it returns 200 from the moment
 * express is listening, without touching anything. That is a liveness probe,
 * and it is the right answer for "should this container be restarted?".
 *
 * It is the wrong answer for "should this instance receive traffic?". A process
 * whose database is unreachable, or whose module schemas have not been
 * migrated, answers /health perfectly while failing every real request. This
 * file is the other question.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE
 *
 *   database   a round trip on the default pool. Proves the instance can reach
 *              Postgres at all — the single most common reason an otherwise
 *              healthy process cannot serve.
 *
 *   schemas    all seven module schemas exist. After the Phase 2 split a
 *              database that has not had the split applied looks perfectly
 *              connectable and then fails every module query with `relation
 *              does not exist`. One catalogue query catches a half-migrated or
 *              wrong-database deployment before traffic arrives.
 *
 *   pools      a round trip on each module pool. The pools carry a per-module
 *              `search_path`, so this is the only check that proves the path a
 *              module's queries will actually run under resolves.
 *
 * CONNECTION COST — deliberate, and bounded.
 * Probing every module pool forces all seven open, so this instance holds up to
 * DB_POOL_MAX_PER_MODULE connections per module rather than opening them
 * lazily. That is the budget already measured in platform/db.js (ceiling 18 per
 * instance against 47 available), and a readiness probe that does not touch the
 * pools cannot honestly claim they are ready. If that ever needs to change,
 * READINESS_SKIP_POOLS=true degrades to database + schemas only.
 *
 * PRODUCTION SAFETY.
 * The body names which check failed, never why in detail: error text can carry
 * host names, roles and connection strings, and this endpoint is typically
 * reachable from anywhere the load balancer is. Full detail goes to the logs
 * and, outside production, into the response as well.
 */

const db = require('./db')

const TIMEOUT_MS = Number(process.env.READINESS_TIMEOUT_MS) || 3000
const SKIP_POOLS = process.env.READINESS_SKIP_POOLS === 'true'
const IS_PROD = process.env.NODE_ENV === 'production'

/**
 * A query that cannot hang the probe.
 *
 * A pool with no free connection and an unreachable server leaves `query()`
 * pending indefinitely — without this, a database outage turns the readiness
 * endpoint itself into a hang, and a load balancer waiting on it is worse than
 * one told "not ready".
 */
const withTimeout = (promise, ms, label) => {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const REQUIRED_SCHEMAS = db.MODULE_SCHEMAS

/**
 * Run every check. Never throws — a thrown check is a failed check.
 *
 * @returns {Promise<{ready: boolean, durationMs: number, checks: object}>}
 */
const check = async () => {
  const started = Date.now()
  const checks = {}
  const fail = (name, err) => {
    checks[name] = { ok: false, ...(IS_PROD ? {} : { error: err.message }) }
    console.error(`[readiness] ${name} failed: ${err.message}`)
  }

  // 1. Database reachable at all.
  try {
    await withTimeout(db.query('SELECT 1'), TIMEOUT_MS, 'database')
    checks.database = { ok: true }
  } catch (err) {
    fail('database', err)
    // Everything below needs the database. Report now rather than producing
    // seven more timeouts that all say the same thing.
    return { ready: false, durationMs: Date.now() - started, checks }
  }

  // 2. Every module schema present.
  try {
    const { rows } = await withTimeout(
      db.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)', [REQUIRED_SCHEMAS]),
      TIMEOUT_MS, 'schemas')
    const found = rows.map((r) => r.nspname)
    const missing = REQUIRED_SCHEMAS.filter((s) => !found.includes(s))
    checks.schemas = missing.length
      ? { ok: false, expected: REQUIRED_SCHEMAS.length, found: found.length, missing }
      : { ok: true, count: found.length }
    if (missing.length) {
      console.error(`[readiness] schemas failed: missing ${missing.join(', ')}`)
    }
  } catch (err) {
    fail('schemas', err)
  }

  // 3. Every module pool can serve a query on its own search_path.
  if (SKIP_POOLS) {
    checks.pools = { ok: true, skipped: true }
  } else {
    const results = await Promise.all(REQUIRED_SCHEMAS.map(async (schema) => {
      try {
        const { rows } = await withTimeout(
          db.forSchema(schema).query('SHOW search_path'), TIMEOUT_MS, `pool:${schema}`)
        const path = rows[0].search_path.replace(/"/g, '')
        if (!path.startsWith(schema)) {
          throw new Error(`search_path is "${path}", expected it to start with "${schema}"`)
        }
        return [schema, { ok: true }]
      } catch (err) {
        console.error(`[readiness] pool:${schema} failed: ${err.message}`)
        return [schema, { ok: false, ...(IS_PROD ? {} : { error: err.message }) }]
      }
    }))
    const byModule = Object.fromEntries(results)
    const bad = results.filter(([, v]) => !v.ok).map(([k]) => k)
    checks.pools = bad.length
      ? { ok: false, failed: bad, ...(IS_PROD ? {} : { detail: byModule }) }
      : { ok: true, count: results.length }
  }

  const ready = Object.values(checks).every((c) => c.ok)
  return { ready, durationMs: Date.now() - started, checks }
}

/**
 * Express handler. 200 when ready, 503 when not — the two statuses a load
 * balancer and a Kubernetes readinessProbe both already understand, so no
 * client needs to parse the body to make the routing decision.
 */
const handler = async (req, res) => {
  let result
  try {
    result = await check()
  } catch (err) {
    // check() is written not to throw; if it somehow does, that is itself a
    // reason to take this instance out of rotation rather than 500.
    console.error('[readiness] check threw:', err.message)
    result = {
      ready: false,
      durationMs: 0,
      checks: { readiness: { ok: false, ...(IS_PROD ? {} : { error: err.message }) } },
    }
  }

  // Never cached: a stale "ready" is exactly the wrong answer to this question.
  res.set('Cache-Control', 'no-store')
  res.status(result.ready ? 200 : 503).json({
    status: result.ready ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    durationMs: result.durationMs,
    checks: result.checks,
  })
}

module.exports = { check, handler, REQUIRED_SCHEMAS, TIMEOUT_MS }
