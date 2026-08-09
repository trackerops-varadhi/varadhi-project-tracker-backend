/*
 * Calendar sync tests (Module 4).
 *
 * Runs the REAL calendar-sync.js against the real database, with an injected
 * mock provider so the whole engine — mapping, dedupe, conflicts, purge — is
 * exercised deterministically and without credentials. Same shape as
 * push-retry.test.js, which injects `send`.
 *
 *   node scripts/calendar-sync.test.js
 */
require('dotenv').config()

const pool = require('../src/config/db')
const sync = require('../src/utils/calendar-sync')
const { createMockProvider } = require('../src/utils/calendar-providers')
const { encrypt } = require('../src/utils/crypto')

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${e}`))
}

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-calendar-suite'

let userId = null
let projectId = null
let taskId = null
let connectionId = null

const MARKER = 'ZZCAL'

const cleanup = async () => {
  await pool.query(`DELETE FROM calendar_connections WHERE user_id = $1`, [userId]).catch(() => {})
  await pool.query(`DELETE FROM tasks WHERE title LIKE '${MARKER}%'`).catch(() => {})
  await pool.query(`DELETE FROM projects WHERE name LIKE '${MARKER}%'`).catch(() => {})
}

async function main() {
  // ── Pure functions first: no DB required ────────────────────────────────
  console.log('\n1. Time zone conversion — a due DATE is a day, not an instant')
  {
    const w = sync.materialiseDueDate('2026-08-14', '09:00')
    check('places the event on the requested calendar day',
      w.start.startsWith('2026-08-14'), JSON.stringify(w))
    check('at the requested local hour', w.start.includes('T09:00:00'), w.start)
    check('emits a naive local time with no Z suffix', !w.start.endsWith('Z'), w.start)
    check('default duration is one hour', w.end.includes('T10:00:00'), w.end)

    // The bug this guards: `new Date('2026-08-14')` is UTC midnight, so any
    // zone west of Greenwich would render the event on the 13th.
    const naive = new Date('2026-08-14')
    check('a naive Date WOULD shift the day in a western zone',
      naive.toISOString().startsWith('2026-08-14T00:00'), naive.toISOString())

    const late = sync.materialiseDueDate('2026-08-14', '23:30')
    check('a late slot rolls the END into the next day',
      late.end.startsWith('2026-08-15'), late.end)

    check('rejects a malformed date', sync.materialiseDueDate('not-a-date') === null)
    check('rejects a null date', sync.materialiseDueDate(null) === null)
    check('tolerates a full timestamp input',
      sync.materialiseDueDate('2026-08-14T00:00:00.000Z', '09:00').start.startsWith('2026-08-14'))

    // DST: Europe/London is UTC+1 in August, UTC+0 in December. Sending a
    // wall-clock time + IANA zone (rather than a fixed offset) is what makes
    // both correct.
    const summer = sync.toTrackerDate('2026-08-14T08:30:00Z', 'Europe/London')
    const winter = sync.toTrackerDate('2026-12-14T23:30:00Z', 'Europe/London')
    check('toTrackerDate honours BST (UTC+1)', summer === '2026-08-14', summer)
    check('toTrackerDate honours GMT (UTC+0)', winter === '2026-12-14', winter)
    check('Asia/Kolkata (+5:30) crosses the date line correctly',
      sync.toTrackerDate('2026-08-13T20:00:00Z', 'Asia/Kolkata') === '2026-08-14',
      sync.toTrackerDate('2026-08-13T20:00:00Z', 'Asia/Kolkata'))
    check('an unknown zone falls back to UTC instead of throwing',
      sync.toTrackerDate('2026-08-14T08:30:00Z', 'Mars/Olympus') === '2026-08-14')
  }

  console.log('\n2. Mapping & transformation — only the permitted fields leave')
  {
    const task = {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Ship the release',
      description: 'Internal notes here',
      due_date: '2026-08-14',
      priority: 'high',
      project_name: 'Website Redesign',
      assignee_secret: 'must-not-appear',
      status: 'todo',
    }
    const mapped = sync.mapTaskToEvent(task, { time_zone: 'Asia/Kolkata', due_time_of_day: '09:00' })

    check('title carries through', mapped.title === 'Ship the release')
    check('description includes a deep link back to the tracker',
      mapped.description.includes(`/tasks/${task.id}`), mapped.description)
    check('project name is included', mapped.description.includes('Website Redesign'))
    check('time zone is attached to the event', mapped.timeZone === 'Asia/Kolkata')
    check('sourceType/sourceId identify the origin',
      mapped.sourceType === 'task' && mapped.sourceId === task.id)

    // The PRD limits the field set explicitly; a calendar is often shared.
    const blob = JSON.stringify(mapped)
    check('unmapped fields are NOT synced', !blob.includes('must-not-appear'), blob)
    check('internal status is NOT synced', !/\bstatus\b/.test(blob))

    check('a task with no due date maps to null',
      sync.mapTaskToEvent({ ...task, due_date: null }) === null)
    check('null task maps to null', sync.mapTaskToEvent(null) === null)

    check('HTML in the description is escaped',
      sync.mapTaskToEvent({ ...task, description: '<img src=x onerror=alert(1)>' }, {})
        .descriptionHtml.includes('&lt;img'), 'not escaped')

    const milestone = sync.mapMilestoneToEvent(
      { id: '22222222-2222-2222-2222-222222222222', name: 'Phase 1', end_date: '2026-09-01' }, {}
    )
    check('milestones map with a distinguishing title',
      milestone.title.startsWith('Milestone:'), milestone.title)
    check('milestone sourceType is milestone', milestone.sourceType === 'milestone')
    check('a project with no end date maps to null',
      sync.mapMilestoneToEvent({ id: 'x', name: 'y' }) === null)
  }

  console.log('\n3. Deduplication — the hash decides whether we call the API at all')
  {
    const base = { title: 'A', description: 'B', start: 'S', end: 'E', timeZone: 'Z', recurrence: null, reminderMinutes: 60 }
    const h1 = sync.contentHash(base)
    const h2 = sync.contentHash({ ...base })

    check('identical payloads hash identically', h1 === h2)
    check('hash is a sha256 hex digest', /^[0-9a-f]{64}$/.test(h1), h1)

    // Key ordering must not matter, or an innocuous refactor of the mapper
    // would invalidate every stored hash and re-push every event for everyone.
    const reordered = { reminderMinutes: 60, timeZone: 'Z', end: 'E', start: 'S', description: 'B', title: 'A', recurrence: null }
    check('property ORDER does not change the hash', sync.contentHash(reordered) === h1)

    check('a changed title changes the hash',
      sync.contentHash({ ...base, title: 'A2' }) !== h1)
    check('a changed start changes the hash',
      sync.contentHash({ ...base, start: 'S2' }) !== h1)
    check('null maps to null hash', sync.contentHash(null) === null)

    const synced = { provider_event_id: 'evt-1', content_hash: h1 }
    check('an unchanged synced link is skipped', sync.isUnchanged(synced, h1) === true)
    check('a changed link is NOT skipped', sync.isUnchanged(synced, 'different') === false)
    check('a never-pushed link is NOT skipped',
      sync.isUnchanged({ provider_event_id: null, content_hash: h1 }, h1) === false)
    check('a link with no stored hash is NOT skipped',
      sync.isUnchanged({ provider_event_id: 'e', content_hash: null }, h1) === false)
  }

  console.log('\n4. Conflict detection — only when BOTH sides moved')
  {
    const link = { provider_event_id: 'evt-1', content_hash: 'hash-A', remote_etag: 'etag-1' }

    check('neither side changed → no conflict',
      sync.detectConflict(link, 'hash-A', { etag: 'etag-1' }) === null)
    check('only the tracker changed → no conflict, just an update',
      sync.detectConflict(link, 'hash-B', { etag: 'etag-1' }) === null)
    check('only the calendar changed → no conflict under tracker authority',
      sync.detectConflict(link, 'hash-A', { etag: 'etag-2' }) === null)

    const both = sync.detectConflict(link, 'hash-B', { etag: 'etag-2' })
    check('BOTH changed → a conflict', both !== null && both.conflictType === 'update',
      JSON.stringify(both))

    const del = sync.detectConflict(link, 'hash-B', { etag: 'etag-2', cancelled: true })
    check('remote deletion + local edit → a deletion conflict',
      del?.conflictType === 'deletion', JSON.stringify(del))

    check('a never-pushed link cannot conflict',
      sync.detectConflict({ provider_event_id: null, content_hash: null }, 'h', { etag: 'e' }) === null)
    check('a missing remote cannot conflict', sync.detectConflict(link, 'hash-B', null) === null)

    check('tracker_wins → push the tracker', sync.resolveConflict(both, 'tracker_wins') === 'push_tracker')
    check('calendar_wins → pull the calendar', sync.resolveConflict(both, 'calendar_wins') === 'pull_calendar')
    check('manual → wait for the user', sync.resolveConflict(both, 'manual') === 'await_user')
    check('an unknown policy defaults to tracker authority',
      sync.resolveConflict(both, 'nonsense') === 'push_tracker')
    check('the default policy is tracker authority (PRD system of record)',
      sync.resolveConflict(both) === 'push_tracker')
  }

  console.log('\n5. Recurrence expansion')
  {
    const from = new Date('2026-08-14T09:00:00Z')
    const daily = sync.expandRecurrence('RRULE:FREQ=DAILY;COUNT=5', { from })
    check('DAILY;COUNT=5 yields five occurrences', daily.length === 5, String(daily.length))
    check('spaced one day apart',
      daily[1] - daily[0] === 86400000, String(daily[1] - daily[0]))

    const weekly = sync.expandRecurrence('FREQ=WEEKLY;COUNT=3', { from })
    check('WEEKLY spacing is seven days',
      weekly[1] - weekly[0] === 7 * 86400000, String(weekly[1] - weekly[0]))

    const interval = sync.expandRecurrence('FREQ=DAILY;INTERVAL=3;COUNT=3', { from })
    check('INTERVAL is honoured',
      interval[1] - interval[0] === 3 * 86400000, String(interval[1] - interval[0]))

    const until = sync.expandRecurrence('FREQ=DAILY;UNTIL=20260818T000000Z', { from })
    check('UNTIL bounds the series', until.length <= 5, String(until.length))

    check('an empty rule yields nothing', sync.expandRecurrence(null).length === 0)
    check('an unsupported FREQ yields nothing rather than guessing',
      sync.expandRecurrence('FREQ=SECONDLY;COUNT=5', { from }).length === 0)
    check('the limit is respected',
      sync.expandRecurrence('FREQ=DAILY', { from, limit: 7 }).length === 7)
  }

  // ── Database-backed integration ─────────────────────────────────────────
  const u = (await pool.query(`SELECT id FROM users WHERE status='active' LIMIT 1`)).rows[0]
  if (!u) {
    console.log('\nSKIP — no active user; database-backed sections not run.')
    return
  }
  userId = u.id
  await cleanup()

  projectId = (await pool.query(
    `INSERT INTO projects (name, description, status) VALUES ($1,'fixture','active') RETURNING id`,
    [`${MARKER} Project`]
  )).rows[0].id

  taskId = (await pool.query(
    `INSERT INTO tasks (title, description, status, priority, project_id, assignee_id, due_date)
     VALUES ($1,'fixture','todo','high',$2,$3, CURRENT_DATE + 3) RETURNING id`,
    [`${MARKER} Task`, projectId, userId]
  )).rows[0].id

  connectionId = (await pool.query(
    `INSERT INTO calendar_connections
       (user_id, provider, account_email, access_token, refresh_token, token_expires_at, status)
     VALUES ($1,'google','demo@example.com',$2,$3, NOW() + interval '1 hour','connected')
     RETURNING id`,
    [userId, encrypt('mock-access-token'), encrypt('mock-refresh-token')]
  )).rows[0].id

  await pool.query(
    `INSERT INTO calendar_sync_settings (connection_id, sync_milestones) VALUES ($1, FALSE)`,
    [connectionId]
  )

  const connection = (await pool.query(
    `SELECT * FROM calendar_connections WHERE id = $1`, [connectionId]
  )).rows[0]

  const provider = createMockProvider('google')
  const links = async () => (await pool.query(
    `SELECT * FROM calendar_event_links WHERE connection_id = $1`, [connectionId]
  )).rows

  // The chosen user may already own real tasks with due dates, which legitimately
  // sync too. Every count assertion below is therefore scoped to THIS test's
  // fixture rather than to the whole calendar — asserting "exactly one event"
  // globally would fail for reasons that have nothing to do with the engine.
  const ownLink = async () => (await links()).find((r) => r.source_id === taskId)
  const ownEvents = () =>
    [...provider.__store.values()].filter((e) => e.sourceId === taskId)

  console.log('\n6. First sync creates events')
  {
    provider.__reset()
    const result = await sync.syncConnection(connection, { provider })

    check('the task was scanned', result.scanned >= 1, JSON.stringify(result))
    check('an event was created', result.created >= 1, JSON.stringify(result))
    check('the mock calendar holds it', provider.__store.size >= 1, String(provider.__store.size))

    const rows = await links()
    const link = rows.find((r) => r.source_id === taskId)
    check('a link row exists', Boolean(link))
    check('the link is marked synced', link?.state === 'synced', link?.state)
    check('a provider event id was stored', Boolean(link?.provider_event_id))
    check('a content hash was stored', Boolean(link?.content_hash))

    const event = ownEvents()[0]
    check('the event carries a tracker deep link',
      String(event?.description).includes(`/tasks/${taskId}`), String(event?.description))
  }

  console.log('\n7. DEDUPE — an unchanged second sync issues ZERO provider writes')
  {
    const before = { ...provider.__calls }
    const result = await sync.syncConnection(connection, { provider })

    check('nothing was created', provider.__calls.create === before.create,
      `${before.create} -> ${provider.__calls.create}`)
    check('nothing was updated', provider.__calls.update === before.update,
      `${before.update} -> ${provider.__calls.update}`)
    check('the item was reported as already up to date', result.skipped >= 1, JSON.stringify(result))
    check('still exactly one event for our task', ownEvents().length === 1,
      String(ownEvents().length))
    check('still exactly one link row for our task',
      (await links()).filter((r) => r.source_id === taskId).length === 1)
  }

  console.log('\n8. A changed due date re-pushes (AC-17)')
  {
    await pool.query(`UPDATE tasks SET due_date = CURRENT_DATE + 10 WHERE id = $1`, [taskId])
    const dirtied = await sync.markSourceDirty('task', taskId)
    check('markSourceDirty flagged the link', dirtied === 1, String(dirtied))

    const before = { ...provider.__calls }
    const result = await sync.syncConnection(connection, { provider })

    check('the existing event was UPDATED, not duplicated',
      provider.__calls.update > before.update, JSON.stringify(result))
    check('no second event was created', provider.__calls.create === before.create)
    check('still exactly one event for our task', ownEvents().length === 1,
      String(ownEvents().length))

    const link = await ownLink()
    check('the stored hash was refreshed', Boolean(link.content_hash))
    check('back to synced', link.state === 'synced', link.state)
  }

  console.log('\n9. Structural dedupe — the DB refuses a duplicate link')
  {
    let rejected = false
    try {
      await pool.query(
        `INSERT INTO calendar_event_links (connection_id, source_type, source_id, state)
         VALUES ($1,'task',$2,'pending')`,
        [connectionId, taskId]
      )
    } catch (err) {
      rejected = err.code === '23505'
    }
    check('a second link for the same source is rejected by UNIQUE', rejected)
  }

  console.log('\n10. Conflict recorded and notified (AC-20)')
  {
    const link = (await links()).find((r) => r.source_id === taskId)

    // Simulate the user editing the event directly in Google...
    provider.__mutateRemotely(link.provider_event_id, { title: 'Edited in Google' })
    // ...while the task also changed in the tracker.
    await pool.query(`UPDATE tasks SET title = $2 WHERE id = $1`, [taskId, `${MARKER} Task renamed`])
    await sync.markSourceDirty('task', taskId)

    const result = await sync.syncConnection(connection, { provider })
    check('a conflict was detected', result.conflicts >= 1, JSON.stringify(result))

    const conflicts = (await pool.query(
      `SELECT * FROM calendar_sync_conflicts WHERE connection_id = $1`, [connectionId]
    )).rows
    check('the conflict was persisted for the UI', conflicts.length >= 1, String(conflicts.length))
    check('auto-resolved as use_tracker under the default policy',
      conflicts[0].resolution === 'use_tracker', conflicts[0].resolution)
    check('and recorded as resolved', Boolean(conflicts[0].resolved_at))

    const notes = (await pool.query(
      `SELECT * FROM notifications
        WHERE user_id = $1 AND type = 'calendar_conflict_detected'`, [userId]
    )).rows
    check('the user was notified of the overwrite (AC-20)', notes.length >= 1, String(notes.length))
  }

  console.log('\n11. A task leaving scope removes its event (AC-18)')
  {
    await pool.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [taskId])
    const result = await sync.syncConnection(connection, { provider })

    check('the orphaned event was removed', result.removed >= 1, JSON.stringify(result))
    check('our task no longer has an event', ownEvents().length === 0,
      String(ownEvents().length))
    check('and its link row was cleaned up', (await ownLink()) === undefined)

    await pool.query(`UPDATE tasks SET status = 'todo' WHERE id = $1`, [taskId])
  }

  console.log('\n12. purgeSource removes events across connections (delete path)')
  {
    await sync.syncConnection(connection, { provider })
    check('re-synced for the purge test', ownEvents().length === 1, String(ownEvents().length))

    const removed = await sync.purgeSource('task', taskId, { provider })
    check('purge reported the removal', removed >= 1, String(removed))
    check('the event is gone from the calendar', ownEvents().length === 0,
      String(ownEvents().length))
    check('and the link row is gone', (await ownLink()) === undefined)
  }

  console.log('\n13. Settings are honoured')
  {
    await pool.query(
      `UPDATE calendar_sync_settings SET sync_tasks = FALSE WHERE connection_id = $1`,
      [connectionId]
    )
    provider.__reset()
    const result = await sync.syncConnection(connection, { provider })

    check('with tasks disabled, nothing is scanned', result.scanned === 0, JSON.stringify(result))
    check('and nothing is created', provider.__calls.create === 0)

    await pool.query(
      `UPDATE calendar_sync_settings SET sync_tasks = TRUE WHERE connection_id = $1`,
      [connectionId]
    )
  }

  console.log('\n14. A broken token disables sync and tells the user')
  {
    const broken = {
      ...connection,
      access_token: encrypt('expired'),
      refresh_token: null,
      token_expires_at: new Date(Date.now() - 60000),
    }
    await pool.query(
      `UPDATE calendar_connections SET refresh_token = NULL, token_expires_at = NOW() - interval '1 minute'
        WHERE id = $1`, [connectionId]
    )

    const result = await sync.syncConnection(broken, { provider })
    check('the sync reports failure rather than throwing', result.failed >= 1, JSON.stringify(result))

    const row = (await pool.query(
      `SELECT status, last_error FROM calendar_connections WHERE id = $1`, [connectionId]
    )).rows[0]
    check('the connection is marked disconnected', row.status === 'disconnected', row.status)
    check('with a stored reason', Boolean(row.last_error))

    const notes = (await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 AND type = 'calendar_sync_failed'`,
      [userId]
    )).rows
    check('the user was told sync stopped (never fails silently)',
      notes.length >= 1, String(notes.length))
  }

  console.log('\n15. Secrets are never stored in the clear')
  {
    const row = (await pool.query(
      `SELECT access_token, refresh_token FROM calendar_connections WHERE id = $1`, [connectionId]
    )).rows[0]
    check('access_token is ciphertext', String(row.access_token || '').startsWith('v1:'),
      String(row.access_token).slice(0, 12))
    check('the plaintext token is absent from the column',
      !String(row.access_token || '').includes('mock-access-token'))
  }
}

main()
  .catch((e) => { console.error('HARNESS ERROR:', e.message, e.stack); fail++ })
  .finally(async () => {
    await cleanup()
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  })
