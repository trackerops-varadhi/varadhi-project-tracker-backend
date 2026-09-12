/**
 * Rate-limit storage.
 * ---------------------------------------------------------------------------
 *   RATE_LIMIT_STORE=memory     per-process counters (default; single instance)
 *   RATE_LIMIT_STORE=postgres   shared counters, correct across instances
 *
 *   MULTI_INSTANCE=true         declares that more than one process is serving
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * An in-memory limiter under N instances is not "a bit weaker" — it is N times
 * the quota, silently. Twenty login attempts per fifteen minutes becomes sixty
 * across three instances, and nothing anywhere reports that the limit being
 * enforced is not the limit that was configured. So: declaring MULTI_INSTANCE
 * while leaving the store on memory is a startup ERROR, not a warning. There is
 * no silent fallback in either direction.
 *
 * WHY POSTGRES AND NOT REDIS
 * Redis is the conventional answer and the better one at volume. It is also a
 * second service, a second bill and a second thing to be down, on a project
 * deliberately running on a single Supabase database. The limiter guards login
 * and password recovery — tens of requests per minute, not tens of thousands —
 * and one indexed upsert per request is comfortably inside what the database
 * already does per page load. If that stops being true, `Store` is a two-method
 * interface and a Redis implementation drops in beside this one.
 *
 * THE TABLE
 * Ships as migrations/identity/0002_rate_limit_buckets.js. Until it is applied,
 * the postgres store FAILS CLOSED at startup with a message naming the
 * migration — it does not create the table on demand, because a limiter that
 * silently provisions its own storage is how you end up with the table in the
 * wrong schema on one instance and not the other.
 */

const db = require('../platform/db')
const { logger } = require('../platform/logger')

const TABLE = 'identity.rate_limit_buckets'

/* ── memory ───────────────────────────────────────────────────────────────── */

class MemoryStore {
  constructor() {
    this.buckets = new Map()
    this.lastSweep = Date.now()
  }

  /**
   * Count this hit and report the bucket.
   * @returns {Promise<{count:number, resetAt:number}>}
   */
  async hit(key, windowMs) {
    const now = Date.now()
    this.sweep(now, windowMs)
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs }
      this.buckets.set(key, fresh)
      return { ...fresh }
    }
    bucket.count += 1
    // A COPY, not the live bucket. Returning the stored object let every caller
    // in a concurrent batch observe the final count rather than the one their
    // own hit produced — twenty simultaneous requests all reading 20 instead of
    // 1..20. The limiter reads `count` immediately so it behaved correctly, but
    // the two stores disagreed: PostgresStore returns a snapshot from RETURNING,
    // and a store interface whose semantics depend on which implementation is
    // configured is a trap for the next caller.
    return { count: bucket.count, resetAt: bucket.resetAt }
  }

  async reset(key) { this.buckets.delete(key) }

  async clear() { this.buckets.clear() }

  // Opportunistic, on request rather than on a timer — nothing to unref at
  // shutdown, and an idle process does no work.
  sweep(now, windowMs) {
    if (now - this.lastSweep < windowMs) return
    this.lastSweep = now
    for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k)
  }

  get name() { return 'memory' }
  async healthy() { return true }
}

/* ── postgres ─────────────────────────────────────────────────────────────── */

class PostgresStore {
  constructor(pool = db.forSchema('identity')) {
    this.pool = pool
  }

  /**
   * One statement: insert the bucket, or bump it if the window is still open,
   * or restart it if the window has closed. Doing this as a single upsert is
   * what makes it correct under concurrency — a read-then-write would let two
   * instances both read count=19 and both allow the twentieth request.
   *
   * The reset decision lives in SQL rather than JS for the same reason: `now()`
   * is the database's clock, so instances with drifting system time cannot
   * disagree about when a window ends.
   */
  async hit(key, windowMs) {
    const { rows } = await this.pool.query(
      `INSERT INTO ${TABLE} AS b (bucket_key, hits, reset_at)
            VALUES ($1, 1, now() + ($2 || ' milliseconds')::interval)
       ON CONFLICT (bucket_key) DO UPDATE
            SET hits = CASE WHEN b.reset_at <= now() THEN 1 ELSE b.hits + 1 END,
                reset_at = CASE WHEN b.reset_at <= now()
                                THEN now() + ($2 || ' milliseconds')::interval
                                ELSE b.reset_at END
         RETURNING hits, reset_at`,
      [key, String(windowMs)])
    const row = rows[0]
    return { count: row.hits, resetAt: new Date(row.reset_at).getTime() }
  }

  async reset(key) {
    await this.pool.query(`DELETE FROM ${TABLE} WHERE bucket_key = $1`, [key])
  }

  async clear() { await this.pool.query(`DELETE FROM ${TABLE}`) }

  /** Expired rows are dead weight; nothing reads them. Call from a sweep. */
  async prune() {
    const { rowCount } = await this.pool.query(
      `DELETE FROM ${TABLE} WHERE reset_at <= now() - interval '1 hour'`)
    return rowCount
  }

  get name() { return 'postgres' }

  async healthy() {
    await this.pool.query(`SELECT 1 FROM ${TABLE} LIMIT 1`)
    return true
  }
}

/* ── selection ────────────────────────────────────────────────────────────── */

let instance = null

const configured = () => (process.env.RATE_LIMIT_STORE || 'memory').toLowerCase()
const isMultiInstance = () => process.env.MULTI_INSTANCE === 'true'

/**
 * The configured store.
 *
 * Throws — deliberately, at startup — when the configuration is unsafe rather
 * than picking something that appears to work.
 */
const getStore = () => {
  if (instance) return instance

  const want = configured()

  if (want === 'memory') {
    if (isMultiInstance()) {
      throw new Error(
        'RATE_LIMIT_STORE=memory is unsafe with MULTI_INSTANCE=true: each ' +
        'process would enforce the full quota independently, so N instances ' +
        'allow N times the configured limit with nothing reporting it. ' +
        'Set RATE_LIMIT_STORE=postgres (and apply ' +
        'migrations/identity/0002_rate_limit_buckets.js), or unset ' +
        'MULTI_INSTANCE if this really is a single process.')
    }
    instance = new MemoryStore()
    return instance
  }

  if (want === 'postgres') { instance = new PostgresStore(); return instance }

  throw new Error(
    `Unknown RATE_LIMIT_STORE="${want}". Expected "memory" or "postgres".`)
}

/**
 * Check the store can actually serve before traffic arrives.
 * Call once at startup; it is what turns "the table was never migrated" from a
 * 500 on someone's login into a refusal to boot.
 */
const verify = async () => {
  const store = getStore()
  try {
    await store.healthy()
    // debug, not info: this runs mid-banner and the banner already prints the
    // store on its own "- Limits:" line. The detail is still there for anyone
    // running at LOG_LEVEL=debug or reading json output.
    logger.debug(`[rate-limit] store ready: ${store.name}`, {
      store: store.name, multiInstance: isMultiInstance(),
    })
    return true
  } catch (err) {
    throw new Error(
      `Rate-limit store "${store.name}" is not usable: ${err.message}. ` +
      (store.name === 'postgres'
        ? `Apply migrations/identity/0002_rate_limit_buckets.js (npm run migrate) to create ${TABLE}.`
        : ''))
  }
}

/** Replace the store. Tests only. */
const _setStore = (s) => { instance = s }
const _reset = () => { instance = null }

module.exports = {
  getStore, verify, MemoryStore, PostgresStore, TABLE,
  isMultiInstance, configured, _setStore, _reset,
}
