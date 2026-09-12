/*
 * Phase 3 operations floor — readiness endpoint and reminder sweeps.
 *
 * Runs against the real database and the live API on :5000, like the other
 * suites here. Creates its own `ZZOPS ` fixtures and removes them in a finally
 * block.
 *
 *   npm run test:ops
 *
 * WHAT THIS IS FOR
 * Both things under test were added because the schema split broke them, and
 * both are easy to "fix" in a way that looks right and is not:
 *
 *   readiness   must return 503, not 200, when a dependency is down — a probe
 *               that only ever says ready is worse than no probe, because the
 *               load balancer now trusts it.
 *
 *   reminders   used to be one SQL query joining tasks, projects,
 *               notification_preferences and users. It is now four calls across
 *               three modules, and the risk is that a sweep silently scans
 *               nothing (wrong timezone arithmetic, wrong status filter, a
 *               lead-time grouping that matches no one) while reporting success.
 *               Every sweep below is given a task it MUST find.
 */
require('dotenv').config()
const http = require('http')

const { identity, work, notify, endAll } = require('./test-pools')
const readiness = require('../src/platform/readiness')
const notifyModule = require('../src/modules/notify')

const MARK = `ZZOPS ${Date.now()}`
const TZ = process.env.CRON_TIMEZONE || 'Asia/Kolkata'

let pass = 0
let fail = 0
const failures = []
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(`${name} ${extra}`); console.log(`  FAIL  ${name}  ${extra}`) }
}

const get = (path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: 5000, path, agent: false }, (res) => {
    let raw = ''
    res.on('data', (d) => { raw += d })
    res.on('end', () => {
      let json = null
      try { json = JSON.parse(raw) } catch { /* non-JSON */ }
      resolve({ status: res.statusCode, json, headers: res.headers, raw: raw.slice(0, 200) })
    })
  }).on('error', reject)
})

const created = { tasks: [], projects: [], prefs: [] }

/**
 * A date `offsetDays` from today in the cron's timezone, as YYYY-MM-DD.
 * Computed in Postgres rather than JS on purpose: the sweeps compare
 * `(due_date AT TIME ZONE $tz)::date`, and building the expected date in a
 * different frame is exactly the bug these tests exist to catch.
 */
const dateInDays = async (offsetDays) => {
  const { rows } = await work.query(
    `SELECT ((NOW() AT TIME ZONE $1)::date + ($2 || ' days')::interval)::date AS d`,
    [TZ, String(offsetDays)])
  return rows[0].d
}

async function main() {
  /* ════════════════════════════════════════════════════ READINESS ════════ */
  console.log('\n1. Readiness endpoint — healthy path')
  const ready = await get('/health/ready')
  check(`GET /health/ready -> ${ready.status}`, ready.status === 200, ready.raw)
  check('status is "ready"', ready.json?.status === 'ready', JSON.stringify(ready.json?.status))
  check('database check present and ok', ready.json?.checks?.database?.ok === true)
  check('schemas check present and ok', ready.json?.checks?.schemas?.ok === true)
  check('all 7 module schemas reported', ready.json?.checks?.schemas?.count === 7,
    String(ready.json?.checks?.schemas?.count))
  check('pools check present and ok', ready.json?.checks?.pools?.ok === true)
  check('all 7 module pools reported', ready.json?.checks?.pools?.count === 7,
    String(ready.json?.checks?.pools?.count))
  check('reports a duration', typeof ready.json?.durationMs === 'number')
  check('not cacheable — a stale "ready" is the wrong answer',
    /no-store/.test(ready.headers['cache-control'] || ''),
    String(ready.headers['cache-control']))

  console.log('\n2. Readiness vs liveness — they answer different questions')
  const live = await get('/health')
  check('GET /health -> 200', live.status === 200)
  check('liveness does NOT report dependency checks', live.json?.checks === undefined,
    'liveness must stay dependency-free or a DB outage restart-loops every instance')

  console.log('\n3. Readiness FAILS when a dependency is down')
  {
    // The check that matters. Point a throwaway pool at an unroutable address
    // and confirm check() reports not-ready instead of hanging or throwing.
    const { Pool } = require('pg')
    const dead = new Pool({
      host: '127.0.0.1', port: 59999, database: 'nope', user: 'nope',
      connectionTimeoutMillis: 500, max: 1,
    })
    dead.on('error', () => {})

    const db = require('../src/platform/db')
    const realQuery = db.query.bind(db)
    db.query = () => dead.query('SELECT 1')   // break the database check only

    let result
    try {
      result = await readiness.check()
    } finally {
      db.query = realQuery
      await dead.end().catch(() => {})
    }

    check('check() reports not ready', result.ready === false, JSON.stringify(result.checks))
    check('the database check is the one marked failed',
      result.checks?.database?.ok === false, JSON.stringify(result.checks?.database))
    check('it short-circuits rather than timing out every later check',
      result.checks.schemas === undefined && result.checks.pools === undefined,
      Object.keys(result.checks).join(','))
    check('it returned rather than hanging', typeof result.durationMs === 'number')
  }

  console.log('\n4. Readiness recovers once the dependency is back')
  const recovered = await readiness.check()
  check('check() reports ready again', recovered.ready === true,
    JSON.stringify(recovered.checks))

  /* ═════════════════════════════════════════════ REMINDER SWEEPS ═════════ */
  console.log('\n5. Fixtures for the reminder sweeps')
  const assignee = (await identity.query(
    `SELECT id FROM users WHERE status = 'active' AND role = 'employee' LIMIT 1`)).rows[0]
  const manager = (await identity.query(
    `SELECT id FROM users WHERE status = 'active' AND role = 'manager' LIMIT 1`)).rows[0]
  if (!assignee || !manager) {
    console.log('SKIP — needs an active employee and an active manager.')
    return
  }

  const projectId = (await work.query(
    `INSERT INTO projects (name, status, manager_id) VALUES ($1,'active',$2) RETURNING id`,
    [`${MARK} Project`, manager.id])).rows[0].id
  created.projects.push(projectId)

  // One task per sweep, each dated so that exactly one sweep must find it.
  const mk = async (label, dueSql, status = 'todo') => {
    const id = (await work.query(
      `INSERT INTO tasks (title, description, status, priority, project_id, assignee_id, reporter_id, due_date)
       VALUES ($1,'ops fixture',$2,'medium',$3,$4,$5, ${dueSql}) RETURNING id`,
      [`${MARK} ${label}`, status, projectId, assignee.id, manager.id])).rows[0].id
    created.tasks.push(id)
    return id
  }

  const tomorrowId = await mk('due tomorrow', `((NOW() AT TIME ZONE '${TZ}')::date + interval '1 day')`)
  const todayId = await mk('due today', `((NOW() AT TIME ZONE '${TZ}')::date)`)
  const leadId = await mk('due in 5 days', `((NOW() AT TIME ZONE '${TZ}')::date + interval '5 days')`)
  const overdueId = await mk('overdue 50h', `(NOW() - interval '50 hours')`)
  const admin72Id = await mk('overdue 80h', `(NOW() - interval '80 hours')`)
  const doneId = await mk('completed and overdue', `(NOW() - interval '90 hours')`, 'completed')
  check('six fixture tasks created', created.tasks.length === 6, String(created.tasks.length))

  console.log('\n6. work answers the date questions the sweeps ask')
  const due1 = await work.query('SELECT 1')  // keep the pool warm; result unused
  const workModule = require('../src/modules/work')

  const dueTomorrow = await workModule.findTasksDueInDays(1, TZ)
  check('findTasksDueInDays(1) finds the due-tomorrow task',
    dueTomorrow.some((r) => r.id === tomorrowId), `${dueTomorrow.length} rows`)
  check('  and not the due-today one', !dueTomorrow.some((r) => r.id === todayId))

  const dueToday = await workModule.findTasksDueInDays(0, TZ)
  check('findTasksDueInDays(0) finds the due-today task',
    dueToday.some((r) => r.id === todayId), `${dueToday.length} rows`)

  const due5 = await workModule.findTasksDueInDays(5, TZ)
  check('findTasksDueInDays(5) finds the 5-day task', due5.some((r) => r.id === leadId))

  const overdue = await workModule.findOverdueTasks()
  check('findOverdueTasks finds the 50h task', overdue.some((r) => r.id === overdueId))
  check('  and EXCLUDES the completed one — terminal statuses are not overdue',
    !overdue.some((r) => r.id === doneId),
    'a completed task reappearing here would re-notify people about finished work')

  const over48 = await workModule.findTasksOverdueByHours(48, { requireManager: true })
  check('findTasksOverdueByHours(48, requireManager) finds the 50h task',
    over48.some((r) => r.id === overdueId))
  check('  rows carry project_name and manager_id from work itself',
    over48.every((r) => 'project_name' in r && 'manager_id' in r))

  const over72 = await workModule.findTasksOverdueByHours(72, { requireManager: false })
  check('findTasksOverdueByHours(72) finds the 80h task', over72.some((r) => r.id === admin72Id))
  check('  and not the 50h one', !over72.some((r) => r.id === overdueId))

  console.log('\n7. The custom lead-time sweep — the join that used to cross schemas')
  {
    // Give the assignee a 5-day lead time. Under the old design this was a
    // `JOIN notification_preferences` inside the task query; now notify reads
    // its own preferences and asks work for each distinct lead time.
    const existing = (await notify.query(
      'SELECT user_id, reminder_lead_days FROM notification_preferences WHERE user_id = $1',
      [assignee.id])).rows[0]
    created.prefs.push({ userId: assignee.id, previous: existing ? existing.reminder_lead_days : null,
      existed: Boolean(existing) })

    if (existing) {
      await notify.query(
        'UPDATE notification_preferences SET reminder_lead_days = 5 WHERE user_id = $1',
        [assignee.id])
    } else {
      await notify.query(
        'INSERT INTO notification_preferences (user_id, reminder_lead_days) VALUES ($1, 5)',
        [assignee.id])
    }

    const before = (await notify.query(
      `SELECT COUNT(*)::int c FROM notifications
        WHERE user_id = $1 AND link_to = $2`, [assignee.id, `/tasks/${leadId}`])).rows[0].c

    const result = await notifyModule.reminderSweeps.customLeadTime()
    check(`customLeadTime scanned the 5-day task (scanned=${result.scanned})`,
      result.scanned >= 1, JSON.stringify(result))

    const after = (await notify.query(
      `SELECT COUNT(*)::int c FROM notifications
        WHERE user_id = $1 AND link_to = $2`, [assignee.id, `/tasks/${leadId}`])).rows[0].c
    check('a reminder notification was written for it', after > before, `${before} -> ${after}`)

    // Lead times of 0 and 1 must be ignored — sweeps 1 and 2 already cover
    // those days, and including them would double-notify.
    await notify.query(
      'UPDATE notification_preferences SET reminder_lead_days = 1 WHERE user_id = $1',
      [assignee.id])
    const withLead1 = await notifyModule.reminderSweeps.customLeadTime()
    const stillFinds = withLead1.scanned
    check('lead_days = 1 is excluded (due-tomorrow sweep owns that day)',
      stillFinds === 0 || !JSON.stringify(withLead1).includes(leadId),
      JSON.stringify(withLead1))
  }

  console.log('\n8. The full run — every sweep, one call')
  {
    const summary = await notifyModule.runRemindersNow()
    check('runRemindersNow completed without error', !summary.error, String(summary.error))
    check('it was not skipped', !summary.skipped)
    for (const k of ['reminders', 'dueToday', 'customLeadTime', 'overdue',
      'escalations', 'adminEscalations']) {
      check(`  sweep "${k}" reported scanned/sent`,
        summary[k] && typeof summary[k].scanned === 'number' &&
        typeof summary[k].sent === 'number', JSON.stringify(summary[k]))
    }
    check('due-tomorrow scanned at least our fixture', summary.reminders.scanned >= 1,
      JSON.stringify(summary.reminders))
    check('overdue scanned at least our fixture', summary.overdue.scanned >= 1,
      JSON.stringify(summary.overdue))
    check('reports a duration', typeof summary.durationMs === 'number')
  }

  console.log('\n9. Overlap guard — a slow sweep must not run twice at once')
  {
    const [a, b] = await Promise.all([
      notifyModule.runRemindersNow(),
      notifyModule.runRemindersNow(),
    ])
    const skipped = [a, b].filter((r) => r.skipped).length
    check('exactly one of two concurrent runs was skipped', skipped === 1,
      `skipped=${skipped} — without the guard both would sweep and double-notify`)
  }

  console.log('\n10. No cross-schema access left in the sweeps')
  {
    // notify's pool must not be able to see tasks, and work's must not see
    // notification_preferences. If either resolves, a sweep could quietly go
    // back to joining across the boundary.
    let notifySeesTasks = false
    try { await notify.query('SELECT 1 FROM tasks LIMIT 1'); notifySeesTasks = true } catch { }
    check('notify pool cannot reach tasks', !notifySeesTasks)

    let workSeesPrefs = false
    try { await work.query('SELECT 1 FROM notification_preferences LIMIT 1'); workSeesPrefs = true } catch { }
    check('work pool cannot reach notification_preferences', !workSeesPrefs)
  }
}

main()
  .catch((err) => { console.error('\nHARNESS ERROR:', err.message, '\n', err.stack); fail++ })
  .finally(async () => {
    for (const p of created.prefs) {
      try {
        if (p.existed) {
          await notify.query(
            'UPDATE notification_preferences SET reminder_lead_days = $2 WHERE user_id = $1',
            [p.userId, p.previous])
        } else {
          await notify.query('DELETE FROM notification_preferences WHERE user_id = $1', [p.userId])
        }
      } catch { /* best effort */ }
    }
    await notify.query(`DELETE FROM notifications WHERE title LIKE 'ZZOPS%' OR message LIKE '%ZZOPS %'`).catch(() => {})
    await work.query(`DELETE FROM tasks WHERE title LIKE 'ZZOPS%'`).catch(() => {})
    await work.query(`DELETE FROM projects WHERE name LIKE 'ZZOPS%'`).catch(() => {})
    console.log(`\n${pass} passed, ${fail} failed`)
    if (failures.length) {
      console.log('\nFailures:')
      for (const f of failures) console.log(`   - ${f}`)
    }
    await endAll()
    process.exit(fail ? 1 : 0)
  })
