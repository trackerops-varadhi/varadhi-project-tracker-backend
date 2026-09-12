/*
 * identity — 0002 rate limit buckets
 * ---------------------------------------------------------------------------
 * Shared storage for the login and password-recovery rate limiters.
 *
 * WHY IT LIVES IN identity
 * The only two limiters in the system guard /auth/login and the recovery
 * endpoints, both owned by identity. Putting the table here keeps the rule this
 * codebase follows everywhere else — a table belongs to the module that reads
 * and writes it — rather than inventing a platform schema for one table.
 *
 * WHY A TABLE AND NOT REDIS
 * An in-memory limiter enforces its quota once per process, so N instances
 * allow N times the configured limit, silently. Fixing that needs shared state,
 * and this project deliberately runs on a single Supabase database — Redis
 * would be a second service and a second bill for tens of requests per minute.
 * See src/middleware/rate-limit-store.js.
 *
 * THIS IS THE FIRST NON-BASELINE MIGRATION, and unlike 0001 it uses the builder
 * API rather than raw SQL. 0001 is a transcript of an existing schema and had to
 * be literal; everything after it should be written this way.
 */

exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createTable({ schema: 'identity', name: 'rate_limit_buckets' }, {
    // The key is "<limiter>:<windowMs>:<ip-or-user>". Namespacing it in the key
    // rather than adding columns means a new limiter needs no migration.
    bucket_key: { type: 'text', primaryKey: true },
    hits: { type: 'integer', notNull: true, default: 0 },
    // Window end, set from the DATABASE clock. Instances with drifting system
    // time must not disagree about when a window closes.
    reset_at: { type: 'timestamptz', notNull: true },
  })

  // Supports the prune sweep. The lookup path is the primary key, so this index
  // exists only so deleting expired rows does not sequentially scan the table.
  pgm.createIndex({ schema: 'identity', name: 'rate_limit_buckets' }, 'reset_at', {
    name: 'idx_rate_limit_buckets_reset_at',
  })
}

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'identity', name: 'rate_limit_buckets' })
}
