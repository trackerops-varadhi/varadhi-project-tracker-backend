/*
 * Failed-push retry queue tests (AC-10).
 *
 * Runs the REAL push-retry.js against the real database, with an injected
 * sender so failures can be simulated deterministically.
 *
 *   node scripts/push-retry.test.js
 */
require('dotenv').config()
const pool = require('../src/config/db')
const retry = require('../src/utils/push-retry')
const engine = require('../src/utils/notification-engine')

let pass = 0, fail = 0
const check = (n, c, e = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${e}`)) }
const err = (status, msg = 'boom') => Object.assign(new Error(msg), { statusCode: status })

let userId = null
let notifId = null
let subId = null

const cleanup = async () => {
  await pool.query(`DELETE FROM push_delivery_retries WHERE user_id = $1`, [userId]).catch(() => {})
  await pool.query(`DELETE FROM push_subscriptions WHERE endpoint LIKE 'ZZ-%'`).catch(() => {})
  await pool.query(`DELETE FROM notifications WHERE title LIKE 'ZZ %'`).catch(() => {})
}

async function main() {
  const u = (await pool.query(`SELECT id FROM users WHERE status='active' LIMIT 1`)).rows[0]
  if (!u) { console.log('SKIP — no active user.'); return }
  userId = u.id

  await cleanup()

  notifId = (await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, priority)
     VALUES ($1,'task_assigned','ZZ retry probe','fixture','high') RETURNING id`, [userId])).rows[0].id
  subId = (await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1,'ZZ-endpoint-1','ZZ-p256dh','ZZ-auth') RETURNING id`, [userId])).rows[0].id

  const enqueue = (error) => retry.enqueueRetry({
    notificationId: notifId, userId, subscriptionId: subId,
    payload: { title: 'ZZ', body: 'x' }, sendOptions: { TTL: 3600 }, error,
  })
  const rowCount = async () => (await pool.query(
    `SELECT COUNT(*)::int c FROM push_delivery_retries WHERE notification_id=$1`, [notifId])).rows[0].c
  const row = async () => (await pool.query(
    `SELECT * FROM push_delivery_retries WHERE notification_id=$1`, [notifId])).rows[0]

  // ---------------------------------------------------------------
  console.log('\n1. Transient vs permanent classification')
  {
    check('no status (network) is transient', retry.isTransient(err(undefined)) === true)
    check('429 rate-limited is transient', retry.isTransient(err(429)) === true)
    check('500 is transient', retry.isTransient(err(500)) === true)
    check('503 is transient', retry.isTransient(err(503)) === true)
    check('404 gone is PERMANENT', retry.isTransient(err(404)) === false)
    check('410 gone is PERMANENT', retry.isTransient(err(410)) === false)
    check('400 bad payload is PERMANENT', retry.isTransient(err(400)) === false)
    check('401 bad VAPID is PERMANENT', retry.isTransient(err(401)) === false)
    check('403 key mismatch is PERMANENT', retry.isTransient(err(403)) === false)
    check('413 too large is PERMANENT', retry.isTransient(err(413)) === false)
  }

  console.log('\n2. Only transient failures are queued')
  {
    await pool.query(`DELETE FROM push_delivery_retries WHERE notification_id=$1`, [notifId])
    for (const s of [404, 410, 400, 401, 403, 413]) await enqueue(err(s))
    check('permanent failures create NO retry rows', (await rowCount()) === 0, String(await rowCount()))

    await enqueue(err(503))
    check('a transient failure creates one row', (await rowCount()) === 1)
    const r = await row()
    check('starts pending', r.status === 'pending', r.status)
    check('attempts = 1', r.attempts === 1, String(r.attempts))
    check('next_attempt_at is in the future (backoff)', new Date(r.next_attempt_at) > new Date())
    check('stores NO secret', !JSON.stringify(r.payload).match(/token|password|vapid/i))
  }

  console.log('\n3. Deduplication — repeated failures never fan out')
  {
    const before = await rowCount()
    for (let i = 0; i < 5; i++) await enqueue(err(500))
    check('still exactly one row per (notification, subscription)',
      (await rowCount()) === before, `${before} -> ${await rowCount()}`)
    const r = await row()
    check('attempts accumulated on the same row instead', r.attempts > 1, String(r.attempts))
  }

  console.log('\n4. Bounded exponential backoff')
  {
    const d0 = retry.backoffMs(0), d1 = retry.backoffMs(1), d2 = retry.backoffMs(2)
    check('doubles each attempt', d1 === d0 * 2 && d2 === d1 * 2, `${d0},${d1},${d2}`)
    check('is capped', retry.backoffMs(99) <= 16 * 60_000, String(retry.backoffMs(99)))
  }

  console.log('\n5. Successful retry marks the row sent — once')
  {
    await pool.query(`DELETE FROM push_delivery_retries WHERE notification_id=$1`, [notifId])
    await enqueue(err(503))
    await pool.query(`UPDATE push_delivery_retries SET next_attempt_at = NOW() - interval '1 minute'
                       WHERE notification_id=$1`, [notifId])

    let sends = 0
    const res = await retry.runPushRetriesNow({ send: async () => { sends++ } })
    check('claimed the due row', res.claimed >= 1, JSON.stringify(res))
    check('sent exactly once', sends === 1, String(sends))
    check('marked sent', (await row()).status === 'sent')

    // A second sweep must not resend it — the duplicate-notification guard.
    const res2 = await retry.runPushRetriesNow({ send: async () => { sends++ } })
    check('a later sweep does not resend', sends === 1, String(sends))
    check('no longer claimed', res2.claimed === 0, JSON.stringify(res2))
  }

  console.log('\n6. Transient failure during retry re-queues with a longer delay')
  {
    await pool.query(`DELETE FROM push_delivery_retries WHERE notification_id=$1`, [notifId])
    await enqueue(err(503))
    await pool.query(`UPDATE push_delivery_retries SET next_attempt_at = NOW() - interval '1 minute'
                       WHERE notification_id=$1`, [notifId])
    const res = await retry.runPushRetriesNow({ send: async () => { throw err(500) } })
    const r = await row()
    check('re-queued as pending', r.status === 'pending', r.status)
    check('attempt counter advanced', r.attempts >= 2, String(r.attempts))
    check('next attempt pushed into the future', new Date(r.next_attempt_at) > new Date())
    check('reported as retried', res.retried === 1, JSON.stringify(res))
  }

  console.log('\n7. Max retries — gives up loudly, never loops forever')
  {
    await pool.query(`DELETE FROM push_delivery_retries WHERE notification_id=$1`, [notifId])
    await enqueue(err(503))
    await pool.query(
      `UPDATE push_delivery_retries
          SET attempts=$2, next_attempt_at = NOW() - interval '1 minute'
        WHERE notification_id=$1`, [notifId, retry.MAX_ATTEMPTS - 1])

    const logs = []
    const origErr = console.error
    console.error = (...a) => logs.push(a.join(' '))
    await retry.runPushRetriesNow({ send: async () => { throw err(500) } })
    console.error = origErr

    const r = await row()
    check('parked as exhausted', r.status === 'exhausted', r.status)
    check('stopped at MAX_ATTEMPTS', r.attempts >= retry.MAX_ATTEMPTS, String(r.attempts))
    check('logged the final failure clearly',
      logs.some((l) => /GIVING UP/.test(l)), JSON.stringify(logs).slice(0, 200))
    check('log names the notification', logs.some((l) => l.includes(notifId)))
    check('log notes the in-app row survives',
      logs.some((l) => /in-app notification remains/i.test(l)))

    const res = await retry.runPushRetriesNow({ send: async () => { throw err(500) } })
    check('exhausted rows are never claimed again', res.claimed === 0, JSON.stringify(res))
  }

  console.log('\n8. A permanent failure discovered during retry stops immediately')
  {
    await pool.query(`DELETE FROM push_delivery_retries WHERE notification_id=$1`, [notifId])
    await enqueue(err(503))
    await pool.query(`UPDATE push_delivery_retries SET next_attempt_at = NOW() - interval '1 minute'
                       WHERE notification_id=$1`, [notifId])
    await retry.runPushRetriesNow({ send: async () => { throw err(410) } })
    const r = await row()
    check('marked failed, not re-queued', r.status === 'failed', r.status)
    check('did not consume the full retry budget', r.attempts < retry.MAX_ATTEMPTS, String(r.attempts))
  }

  console.log('\n9. Deleted subscription is dropped, not retried forever')
  {
    await pool.query(`DELETE FROM push_delivery_retries WHERE notification_id=$1`, [notifId])
    await enqueue(err(503))
    await pool.query(`UPDATE push_delivery_retries SET next_attempt_at = NOW() - interval '1 minute'
                       WHERE notification_id=$1`, [notifId])
    const gone = subId
    await pool.query(`DELETE FROM push_subscriptions WHERE id=$1`, [gone])

    let sends = 0
    await retry.runPushRetriesNow({ send: async () => { sends++ } })
    const r = await row()
    check('never attempted a send', sends === 0, String(sends))
    check('row dropped', r.status === 'dropped', r.status)

    subId = (await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1,'ZZ-endpoint-1','ZZ-p256dh','ZZ-auth') RETURNING id`, [userId])).rows[0].id
  }

  console.log('\n10. Flood guard caps the per-user queue')
  {
    check('a cap exists', retry.MAX_PENDING_PER_USER > 0 && retry.MAX_PENDING_PER_USER <= 200,
      String(retry.MAX_PENDING_PER_USER))
  }

  console.log('\n11. Routing rules are untouched — retry is strictly downstream')
  {
    // The retry path never re-evaluates preferences; it re-sends an already
    // authorised payload. Assert the engine's gates are still the only place
    // those decisions happen.
    check('engine still exports 14 symbols', Object.keys(engine).length === 14, String(Object.keys(engine).length))
    // 7 through Module 5; +4 from Module 8's Bugs Finder (bug_assigned,
    // bug_sla_at_risk, bug_sla_breached, bug_critical_reported) — the bug
    // events worth interrupting somebody for.
    check('PUSH_WORTHY_TYPES still 11', engine.PUSH_WORTHY_TYPES.size === 11, String(engine.PUSH_WORTHY_TYPES.size))
    // 33 at Module 2; +3 integration-health types added by Modules 4 & 5
    // (calendar_sync_failed, calendar_conflict_detected, teams_webhook_disabled);
    // +3 leave/time types; +9 Bugs Finder types added by Module 8.
    // The count is asserted rather than a floor because the point is to notice
    // that types changed at all — a new type needs a frontend icon entry and a
    // deliberate decision about TYPE_CATEGORY_MAP, and this is the tripwire.
    check('48 notification types', Object.keys(engine.NOTIFICATION_TYPES).length === 48,
      String(Object.keys(engine.NOTIFICATION_TYPES).length))
    // The three new types must stay OUT of the category map: each one means an
    // integration the user connected has stopped working, and a per-category
    // preference must not be able to silence that.
    check('integration-health types are not silenceable by category',
      [engine.NOTIFICATION_TYPES.CALENDAR_SYNC_FAILED,
       engine.NOTIFICATION_TYPES.CALENDAR_CONFLICT_DETECTED,
       engine.NOTIFICATION_TYPES.TEAMS_WEBHOOK_DISABLED]
        .every((t) => engine.TYPE_CATEGORY_MAP[t] === undefined))
    // Same rule for the SLA types (Module 8): a missed or nearly-missed
    // resolution commitment is a failure the team must see, not a preference.
    check('bug SLA types are not silenceable by category',
      [engine.NOTIFICATION_TYPES.BUG_SLA_AT_RISK,
       engine.NOTIFICATION_TYPES.BUG_SLA_BREACHED]
        .every((t) => engine.TYPE_CATEGORY_MAP[t] === undefined))
    check('urgent still bypasses quiet hours (TASK_ESCALATION uncategorised)',
      engine.TYPE_CATEGORY_MAP[engine.NOTIFICATION_TYPES.TASK_ESCALATION] === undefined)
    check('dispatchNotification arity unchanged (4)', engine.dispatchNotification.length === 4)
    check('dispatchToMany arity unchanged (6)', engine.dispatchToMany.length === 6)

    // A disabled category never reaches push, so it can never be retried.
    const src = require('fs').readFileSync(`${__dirname}/../src/utils/notification-engine.js`, 'utf8')
    const gateAt = src.indexOf("skipped: 'category_disabled'")
    const pushAt = src.indexOf('const pushResult = await sendPush')
    const retryAt = src.indexOf('enqueueRetry')
    check('category gate precedes push', gateAt > 0 && gateAt < pushAt)
    check('retry enqueue happens after the push attempt', retryAt > pushAt)
  }
}

main()
  .catch((e) => { console.error('HARNESS ERROR:', e.message); fail++ })
  .finally(async () => {
    await cleanup()
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  })
