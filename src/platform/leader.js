/**
 * Leader election via PostgreSQL advisory lock.
 * ---------------------------------------------------------------------------
 * Exactly one process in the fleet runs the scheduled sweeps. Everything else
 * serves requests and runs no cron at all.
 *
 * THE PROBLEM THIS SOLVES
 * Every sweep in this system is started unconditionally at boot. With one
 * instance that is correct. With N instances every sweep runs N times: N
 * reminder emails for one overdue task, N SLA escalations, N snooze wake-ups,
 * and N push retries racing each other on the same rows. That is why this
 * codebase has never been safe to scale horizontally, and it is the last thing
 * standing between it and a second instance.
 *
 * WHY A SESSION-LEVEL ADVISORY LOCK
 * `pg_try_advisory_lock` is held by a *session*, not a transaction or a row, and
 * Postgres releases it automatically when that session ends — including when the
 * process is killed, loses the network, or is OOM-ed. There is no lease to renew
 * and no stale lock to clean up after a crash, which is precisely the failure
 * mode a "leader" row in a table gets wrong. The database is already the one
 * component every instance shares, so this adds no infrastructure.
 *
 * THE DEDICATED CLIENT IS LOAD-BEARING
 * The lock lives on ONE client, checked out of no pool, held for the life of the
 * process. Taking it on a pooled connection would be a silent bug: the pool
 * hands that connection to the next caller when the query finishes, and
 * `idleTimeoutMillis` closes it after ten seconds — releasing the lock while the
 * process still believes it is leader, at which point two instances both run
 * cron and nothing reports an error.
 *
 * FAIL CLOSED
 * Anything other than a definite "the lock is mine" means not leader: lock held
 * elsewhere, connection refused, query error, timeout. A split brain running
 * duplicate sweeps is worse than sweeps not running, because the second is
 * visible in monitoring and the first is only visible to users receiving
 * duplicate notifications.
 */

const { Client } = require('pg')
const { logger } = require('./logger')

/**
 * The lock id. Any 64-bit integer; it just has to be the same in every instance
 * and not collide with another advisory lock in the same database. Fixed
 * constant rather than a hash of a string so it is greppable and cannot change
 * under someone by editing a label.
 */
const CRON_LOCK_ID = Number(process.env.CRON_LEADER_LOCK_ID) || 4207310001

const state = {
  client: null,
  isLeader: false,
  acquiredAt: null,
  reason: null,
}

/**
 * Try to become the cron leader.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.lockId]
 * @param {string}  [opts.connectionString]
 * @param {number}  [opts.timeoutMs=5000]
 * @returns {Promise<boolean>} true only if this process now holds the lock
 */
const acquire = async ({
  lockId = CRON_LOCK_ID,
  connectionString = process.env.DATABASE_URL,
  timeoutMs = Number(process.env.CRON_LEADER_TIMEOUT_MS) || 5000,
} = {}) => {
  if (state.isLeader) return true

  if (!connectionString) {
    state.reason = 'DATABASE_URL is not set'
    logger.warn('[leader] not leader — no DATABASE_URL; cron will not start')
    return false
  }

  const client = new Client({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    // A lock nobody can reach is the same as a lock somebody else holds.
    connectionTimeoutMillis: timeoutMs,
    application_name: 'varadhi-cron-leader',
  })

  try {
    await client.connect()

    // statement_timeout so a wedged server cannot hang startup indefinitely.
    await client.query(`SET statement_timeout = ${Math.max(1000, timeoutMs)}`)

    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [lockId])
    const locked = rows[0] && rows[0].locked === true

    if (!locked) {
      state.reason = 'lock held by another instance'
      await client.end().catch(() => {})
      logger.info('[leader] another instance holds the cron lock — not starting cron',
        { lockId })
      return false
    }

    // Hold it. Never released explicitly except by release() or process exit.
    state.client = client
    state.isLeader = true
    state.acquiredAt = new Date()
    state.reason = null

    // If the connection drops, the lock is gone with it. Stop claiming
    // leadership: the truth is now "unknown", and unknown means not leader.
    client.on('error', (err) => {
      logger.error('[leader] lock connection lost — standing down', { err })
      state.isLeader = false
      state.reason = `connection lost: ${err.message}`
      state.client = null
    })

    logger.info('[leader] acquired cron leadership', { lockId, pid: process.pid })
    return true
  } catch (err) {
    // Fail closed: any uncertainty means not leader.
    state.reason = err.message
    await client.end().catch(() => {})
    logger.error('[leader] could not determine leadership — cron will NOT start', { err })
    return false
  }
}

/** Release the lock and stand down. Safe to call when not leader. */
const release = async () => {
  const client = state.client
  state.isLeader = false
  state.client = null
  state.acquiredAt = null
  state.reason = 'released'
  if (!client) return
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [CRON_LOCK_ID])
  } catch { /* ending the session releases it anyway */ }
  await client.end().catch(() => {})
}

const isLeader = () => state.isLeader

const status = () => ({
  isLeader: state.isLeader,
  lockId: CRON_LOCK_ID,
  acquiredAt: state.acquiredAt,
  reason: state.reason,
  pid: process.pid,
})

/**
 * Release on the way out, so a restarting instance does not have to wait for
 * the server to notice a dead session. Best effort — a SIGKILL skips this
 * entirely, which is exactly the case the session-scoped lock already covers.
 */
const installExitHandlers = () => {
  const bye = () => { release().finally(() => process.exit(0)) }
  process.once('SIGINT', bye)
  process.once('SIGTERM', bye)
}

module.exports = {
  acquire, release, isLeader, status, installExitHandlers, CRON_LOCK_ID,
}
