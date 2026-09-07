/**
 * Session cleanup cron
 * ---------------------------------------------------------------------------
 * Prunes `user_sessions` and `user_tokens` rows that are dead and past their
 * audit retention. Structure mirrors snooze-cron.js / bug-sla-cron.js — the
 * isRunning overlap guard, cron.validate before scheduling, and a runXNow()
 * export — so all the sweeps behave alike operationally.
 *
 * WHY THIS EXISTS
 * Every login writes a session row, and every refresh writes a token row. At
 * ~20 users that is small, but it is monotonic: nothing in the system ever
 * removes them, so the tables only grow. This keeps them bounded.
 *
 * WHY IT DELETES RATHER THAN JUST MARKS
 * Revocation is already a soft delete — a revoked session keeps its row, its
 * reason and its actor so "who signed me out?" stays answerable. This job is
 * the second stage: once that answer has stopped being useful, the row goes.
 *
 * SAFETY — this deletes ONLY dead rows.
 * Every statement below requires a row to be revoked or expired AND older than
 * its retention window. A live session is unreachable by all of them: it has
 * revoked_at IS NULL and expires_at in the future, so neither predicate can
 * match it no matter how old it is. There is no scenario where this job signs
 * anybody out.
 *
 * It touches `user_sessions` and `user_tokens` and nothing else. No user
 * account, credential, or business row is read or written.
 */

const cron = require('node-cron')
const db = require('../config/db')

// Daily at 03:30 — off-peak for an India-hours internal team, and offset from
// the top of the hour so it does not pile onto the hourly reminder sweep.
const SCHEDULE = process.env.SESSION_CLEANUP_CRON_SCHEDULE || '30 3 * * *'
const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Kolkata'

/*
 * Retention windows.
 *
 * Sessions keep 30 days because they are the audit trail: "an admin signed me
 * out three weeks ago" is a question people actually ask, and the row carries
 * revoked_reason and revoked_by to answer it.
 *
 * Tokens keep 7 days because they carry no audit value of their own — only a
 * hash and a rotation link. Once the refresh window they belong to has closed,
 * the session row already records everything worth knowing.
 */
const SESSION_RETENTION_DAYS = Number(process.env.SESSION_RETENTION_DAYS) || 30
const TOKEN_RETENTION_DAYS = Number(process.env.TOKEN_RETENTION_DAYS) || 7

let task = null
let isRunning = false

/**
 * One sweep. Exported so it can be run manually or from a test without the
 * scheduler.
 *
 * Order matters: tokens are deleted before sessions. `user_tokens.session_id`
 * has no FK cascade to `user_sessions`, so deleting a session first would leave
 * its token rows behind as orphans that the token predicate might not match.
 */
async function cleanupSessions() {
  const client = await db.connect()

  try {
    await client.query('BEGIN')

    // 1. Dead refresh tokens. Revoked or expired, and past retention.
    //    A live token — not revoked, not expired — cannot match either branch.
    const tokens = await client.query(
      `DELETE FROM user_tokens
       WHERE (
               (revoked_at IS NOT NULL AND revoked_at  < NOW() - ($1 || ' days')::interval)
            OR (expires_at < NOW()      AND expires_at < NOW() - ($1 || ' days')::interval)
           )
       RETURNING id`,
      [TOKEN_RETENTION_DAYS]
    )

    // 2. Dead sessions, same shape.
    const sessions = await client.query(
      `DELETE FROM user_sessions
       WHERE (
               (revoked_at IS NOT NULL AND revoked_at  < NOW() - ($1 || ' days')::interval)
            OR (expires_at < NOW()      AND expires_at < NOW() - ($1 || ' days')::interval)
           )
       RETURNING id`,
      [SESSION_RETENTION_DAYS]
    )

    /*
     * 3. Mark lapsed-but-unrevoked sessions as expired.
     *
     * A session nobody used for 7 days is already refused by the middleware
     * (`expires_at > NOW()` fails), so this changes no access decision. It
     * exists so the row states WHY it is dead instead of leaving revoked_reason
     * NULL, which reads as "still live" to anyone querying the table directly.
     * Bounded to the retention window so it cannot rewrite ancient history.
     */
    const expired = await client.query(
      `UPDATE user_sessions
       SET revoked_at = expires_at,
           revoked_reason = 'expired'
       WHERE revoked_at IS NULL
         AND expires_at < NOW()
       RETURNING id`
    )

    await client.query('COMMIT')

    const summary = {
      tokensDeleted: tokens.rowCount,
      sessionsDeleted: sessions.rowCount,
      sessionsMarkedExpired: expired.rowCount,
    }

    // Only speak up when something happened. A daily "nothing to do" line for
    // years is noise that trains people to ignore the log.
    if (
      summary.tokensDeleted ||
      summary.sessionsDeleted ||
      summary.sessionsMarkedExpired
    ) {
      console.log(
        `[session-cleanup] removed ${summary.tokensDeleted} token(s), ` +
          `${summary.sessionsDeleted} session(s); ` +
          `marked ${summary.sessionsMarkedExpired} expired`
      )
    }

    return summary
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Scheduler entry point. Never throws — a failed sweep must not take the API
 * process down, and the next tick will retry.
 */
async function runSessionCleanupNow() {
  if (isRunning) {
    console.warn('[session-cleanup] previous sweep still running — skipped.')
    return null
  }

  isRunning = true

  try {
    return await cleanupSessions()
  } catch (err) {
    console.error('[session-cleanup] sweep failed:', err.message)
    return null
  } finally {
    isRunning = false
  }
}

function startSessionCleanupCron() {
  if (task) return task

  if (!cron.validate(SCHEDULE)) {
    console.error(
      `[session-cleanup] invalid schedule "${SCHEDULE}" — cron not started.`
    )
    return null
  }

  task = cron.schedule(SCHEDULE, runSessionCleanupNow, {
    scheduled: true,
    timezone: TIMEZONE,
  })

  console.log(`[session-cleanup] scheduled "${SCHEDULE}" (${TIMEZONE})`)
  return task
}

function stopSessionCleanupCron() {
  if (task) {
    task.stop()
    task = null
  }
}

module.exports = {
  startSessionCleanupCron,
  stopSessionCleanupCron,
  runSessionCleanupNow,
  cleanupSessions,
  SESSION_RETENTION_DAYS,
  TOKEN_RETENTION_DAYS,
}
