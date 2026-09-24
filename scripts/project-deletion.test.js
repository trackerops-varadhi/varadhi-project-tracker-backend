/*
 * project.deleted — cross-module cleanup regression test.
 *
 * THE BUG THIS GUARDS AGAINST
 * ---------------------------
 * Before the Phase 2 schema split, deleting a project was one statement and
 * foreign keys did the rest:
 *
 *   integrations.teams_webhooks.project_id   ON DELETE CASCADE
 *   workforce.time_logs.project_id           ON DELETE CASCADE
 *   files.documents.project_id               ON DELETE SET NULL
 *   defects.bugs.project_id                  ON DELETE SET NULL
 *   defects.bugs.linked_task_id              ON DELETE SET NULL  (tasks cascade
 *                                                                from projects)
 *
 * Every one of those crossed a module schema, so the split dropped them, and
 * for a while nothing replaced them: a deleted project left its time logs and
 * webhooks behind, and bugs and documents pointing at a project that no longer
 * existed — which the Bugs page rendered as a project with no name. Calendar
 * events for the project's milestone and tasks were never cleaned up at all:
 * calendar_event_links has no foreign key to anything, and the tasks' cascade
 * does not go through deleteTask, so task.deleted never fired for them.
 *
 * work now emits project.deleted with the ids of the tasks it took, and each
 * owning module cleans up its own rows. This suite deletes a project through
 * the real API and checks every one of those references, in every module.
 *
 * A CONTROL PROJECT sits beside the target with the same kinds of children.
 * Nothing of its may change — that is what catches a cleanup that matches too
 * much, e.g. a missing WHERE. Two cross-project cases are deliberate: a bug in
 * the control project linked to a task in the target (the link must clear, the
 * bug's project must not), and a bug attachment whose mirrored document
 * belonged to the target (the document must survive, detached).
 *
 * Runs against a real database and a running API on port 5000, like the other
 * suites. Every fixture is inserted directly through the pool of the module
 * that owns the table, prefixed 'ZZ ', and removed in a finally block. No user
 * is created or deleted — the suite acts as an existing admin — so it cannot
 * add to the orphaned-notification debris that hard-deleted fixture users
 * leave behind now that those cascades are gone too.
 *
 * SIDE EFFECTS, kept to none outside the fixture:
 *   - the project's only member is the acting admin, who is excluded from the
 *     "project deleted" fan-out; on a database with one admin nobody is
 *     notified, and any notification that does name the fixture is removed
 *   - the calendar connection is 'disconnected', so purging its links never
 *     calls a provider
 *   - the Teams webhooks are disabled and point at example.invalid, a reserved
 *     name that can never resolve
 *
 *   node scripts/project-deletion.test.js
 */
require('dotenv').config()
const { identity, work, defects, integrations, files, workforce, notify, endAll } =
  require('./test-pools')
const { authHeaders } = require('./test-auth')
const { resolveTarget } = require('../src/config/migrate-runner')
const { encrypt } = require('../src/modules/integrations/crypto')

const API = process.env.TEST_API_BASE || 'http://127.0.0.1:5000/api'

// The development Supabase project — the same ref migrate-runner permits with
// --allow-remote. This suite writes fixtures, so anything that is neither that
// nor a loopback database is refused before a single row is touched.
const DEV_REF = 'dbuiauuhajwwpisjevpk'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`) }
}

const TAG = `ZZ pd ${Date.now().toString(36)}`
const UA = { 'user-agent': 'ZZ project-deletion.test.js' }

// Every fixture id, so the finally block can remove exactly what was created.
const ids = {
  projects: [], tasks: [], timeLogs: [], webhooks: [], documents: [], bugs: [],
  connection: null,
}

const one = async (pool, sql, params) => (await pool.query(sql, params)).rows[0]
const count = async (pool, sql, params) => (await pool.query(sql, params)).rows[0].n

/**
 * Every reference into work.projects / work.tasks that lives outside work, as
 * [label, pool, what $1 holds ('project' or 'task' ids), SQL counting the rows
 * that point at any of them]. After the delete each must be zero.
 */
const REFERENCES = [
  ['integrations.teams_webhooks.project_id', () => integrations, 'project',
    'SELECT count(*)::int n FROM teams_webhooks WHERE project_id = ANY($1::uuid[])'],
  ['integrations.calendar_event_links (milestone)', () => integrations, 'project',
    `SELECT count(*)::int n FROM calendar_event_links
      WHERE source_type = 'milestone' AND source_id = ANY($1::uuid[])`],
  ['integrations.calendar_event_links (task)', () => integrations, 'task',
    `SELECT count(*)::int n FROM calendar_event_links
      WHERE source_type = 'task' AND source_id = ANY($1::uuid[])`],
  ['workforce.time_logs.project_id', () => workforce, 'project',
    'SELECT count(*)::int n FROM time_logs WHERE project_id = ANY($1::uuid[])'],
  ['files.documents.project_id', () => files, 'project',
    'SELECT count(*)::int n FROM documents WHERE project_id = ANY($1::uuid[])'],
  ['defects.bugs.project_id', () => defects, 'project',
    'SELECT count(*)::int n FROM bugs WHERE project_id = ANY($1::uuid[])'],
  ['defects.bugs.linked_task_id', () => defects, 'task',
    'SELECT count(*)::int n FROM bugs WHERE linked_task_id = ANY($1::uuid[])'],
]

const referencesTo = async (projectIds, taskIds) => {
  const out = {}
  for (const [label, pool, kind, sql] of REFERENCES) {
    out[label] = await count(pool(), sql, [kind === 'task' ? taskIds : projectIds])
  }
  return out
}

/**
 * Database-wide dangling references — every row, not only this suite's. Uses
 * the same per-module pools; the existence check goes through work's pool.
 * Run before and after: the delete must not create a single new one.
 */
const danglingEverywhere = async () => {
  const liveProjects = (await work.query('SELECT id FROM projects')).rows.map((r) => r.id)
  const liveTasks = (await work.query('SELECT id FROM tasks')).rows.map((r) => r.id)
  const dangling = async (pool, table, col, live) => count(pool, `
    SELECT count(*)::int n FROM ${table}
     WHERE ${col} IS NOT NULL AND NOT (${col} = ANY($1::uuid[]))`, [live])
  return (
    await dangling(integrations, 'teams_webhooks', 'project_id', liveProjects) +
    await dangling(workforce, 'time_logs', 'project_id', liveProjects) +
    await dangling(files, 'documents', 'project_id', liveProjects) +
    await dangling(defects, 'bugs', 'project_id', liveProjects) +
    await dangling(defects, 'bugs', 'linked_task_id', liveTasks)
  )
}

async function wiring() {
  // In-process: which modules subscribe to project.deleted, and that doing it
  // twice registers nothing new. server.js calls every module's subscribe() on
  // boot, so this is the registration the running API performed.
  console.log('\n0. Subscriber wiring (in-process)')
  const workModule = require('../src/modules/work')
  const owners = ['integrations', 'workforce', 'files', 'defects']
    .map((name) => [name, require(`../src/modules/${name}`)])

  const registered = []
  const realOn = workModule.events.on
  workModule.events.on = (event, handler) => {
    if (event === workModule.events.EVENTS.PROJECT_DELETED) registered.push(handler)
    return realOn(event, handler)
  }
  const quiet = console.log
  try {
    console.log = () => {}
    for (const [, mod] of owners) mod.unsubscribe()
    for (const [, mod] of owners) { mod.subscribe(); mod.subscribe() }
  } finally {
    console.log = quiet
    workModule.events.on = realOn
    for (const [, mod] of owners) mod.unsubscribe()
  }

  check('project.deleted is a declared work event',
    workModule.events.EVENTS.PROJECT_DELETED === 'project.deleted')
  for (const [name, mod] of owners) {
    check(`${name} exposes subscribe()/unsubscribe()`,
      typeof mod.subscribe === 'function' && typeof mod.unsubscribe === 'function')
  }
  // integrations 2 (webhooks · calendar), workforce 1, files 1, defects 1.
  check('5 project.deleted subscribers, and a second subscribe() adds none',
    registered.length === 5, `got ${registered.length}`)
}

async function main() {
  const target = resolveTarget()
  if (!target.loopback && target.ref !== DEV_REF) {
    console.error(`REFUSING — ${target.host} (ref ${target.ref || 'none'}) is neither loopback nor the dev project.`)
    process.exitCode = 1
    return
  }

  await wiring()

  const admin = await one(identity,
    `SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1`)
  // A calendar connection is unique per (user, provider); borrow a user who has
  // no Google connection so a real one is never shadowed or disturbed.
  const takenIds = (await integrations.query(
    `SELECT user_id FROM calendar_connections WHERE provider = 'google'`)).rows.map((r) => r.user_id)
  const calUser = await one(identity,
    `SELECT id FROM users WHERE status = 'active' AND NOT (id = ANY($1::uuid[]))
      ORDER BY created_at LIMIT 1`, [takenIds])
  if (!admin || !calUser) {
    console.log('SKIP — needs an active admin, and an active user with no Google calendar connection.')
    return
  }

  const danglingBefore = await danglingEverywhere()

  /* ── Fixture ─────────────────────────────────────────────────────────── */

  const newProject = async (label) => {
    const p = await one(work,
      `INSERT INTO projects (name, description, manager_id, end_date)
       VALUES ($1, 'project.deleted fixture', $2, CURRENT_DATE + 30) RETURNING id`,
      [`${TAG} ${label}`, admin.id])
    ids.projects.push(p.id)
    return p.id
  }
  const newTask = async (projectId, label) => {
    const t = await one(work,
      `INSERT INTO tasks (title, project_id, reporter_id) VALUES ($1, $2, $3) RETURNING id`,
      [`${TAG} ${label}`, projectId, admin.id])
    ids.tasks.push(t.id)
    return t.id
  }
  const newTimeLog = async (projectId) => {
    const r = await one(workforce,
      `INSERT INTO time_logs (user_id, project_id, date, hours, note)
       VALUES ($1, $2, CURRENT_DATE, 1, $3) RETURNING id`, [admin.id, projectId, TAG])
    ids.timeLogs.push(r.id)
    return r.id
  }
  const newWebhook = async (projectId, hint) => {
    const r = await one(integrations,
      `INSERT INTO teams_webhooks (project_id, name, webhook_url, url_hint, enabled, created_by)
       VALUES ($1, $2, $3, $4, false, $5) RETURNING id`,
      [projectId, TAG, encrypt(`https://example.invalid/${hint}`), `${TAG} ${hint}`, admin.id])
    ids.webhooks.push(r.id)
    return r.id
  }
  const newDocument = async (projectId, label) => {
    const r = await one(files,
      `INSERT INTO documents (name, original_name, file_type, url, project_id, uploaded_by)
       VALUES ($1, $1, 'pdf', 'https://example.invalid/zz.pdf', $2, $3) RETURNING id`,
      [`${TAG} ${label}`, projectId, admin.id])
    ids.documents.push(r.id)
    return r.id
  }
  const newBug = async (projectId, linkedTaskId, label) => {
    const r = await one(defects,
      `INSERT INTO bugs (title, description, project_id, linked_task_id, reporter_id)
       VALUES ($1, 'project.deleted fixture', $2, $3, $4) RETURNING id`,
      [`${TAG} ${label}`, projectId, linkedTaskId, admin.id])
    ids.bugs.push(r.id)
    return r.id
  }

  const P = await newProject('target')
  const C = await newProject('control')

  await work.query('INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)', [P, admin.id])
  const T1 = await newTask(P, 'target task 1')
  const T2 = await newTask(P, 'target task 2')
  const TC = await newTask(C, 'control task')
  await work.query('INSERT INTO comments (content, task_id, author_id) VALUES ($1, $2, $3)',
    [TAG, T1, admin.id])

  const logP1 = await newTimeLog(P)
  const logP2 = await newTimeLog(P)
  const logC = await newTimeLog(C)

  const hookP = await newWebhook(P, 'target')
  const hookC = await newWebhook(C, 'control')
  await integrations.query(
    `INSERT INTO teams_delivery_log (webhook_id, event_type) VALUES ($1, 'task_assigned')`,
    [hookP])

  ids.connection = (await one(integrations,
    `INSERT INTO calendar_connections (user_id, provider, account_email, status)
     VALUES ($1, 'google', 'zz-project-deletion@example.invalid', 'disconnected') RETURNING id`,
    [calUser.id])).id
  const link = (type, sourceId) => integrations.query(
    `INSERT INTO calendar_event_links (connection_id, source_type, source_id, provider_event_id, state)
     VALUES ($1, $2, $3, $4, 'synced')`,
    [ids.connection, type, sourceId, `${TAG}-${type}-${sourceId}`])
  await link('task', T1)
  await link('task', T2)
  await link('milestone', P)
  await link('task', TC)
  await link('milestone', C)

  const docP = await newDocument(P, 'target document')
  const docC = await newDocument(C, 'control document')

  const bugP = await newBug(P, T1, 'target bug')           // both references go
  const bugCross = await newBug(C, T2, 'cross-project bug') // link goes, project stays
  const bugC = await newBug(C, TC, 'control bug')           // untouched
  const mirrorDoc = await newDocument(P, 'bug attachment mirror')
  const attachment = (await one(defects,
    `INSERT INTO bug_attachments (bug_id, document_id, file_name, url, uploaded_by)
     VALUES ($1, $2, $3, 'https://example.invalid/zz.pdf', $4) RETURNING id`,
    [bugP, mirrorDoc, `${TAG}.pdf`, admin.id])).id

  console.log(`\nFixture ${TAG}: target + control project, 3 tasks, 3 time logs, 2 webhooks,`)
  console.log('         5 calendar links, 3 documents, 3 bugs, 1 attachment')

  // Every reference must exist BEFORE, or the "gone" checks below prove nothing.
  console.log('\n1. Before the delete, every reference is live')
  const before = await referencesTo([P], [T1, T2])
  for (const [label, n] of Object.entries(before)) check(`${label} -> ${n} row(s)`, n > 0)

  // A backend pointed at a different database than this suite would 404 here
  // rather than fail confusingly later.
  const seen = await fetch(`${API}/projects/${P}`, { headers: await authHeaders(admin.id, UA) })
  check('the API sees the fixture project (same database as this suite)', seen.status === 200,
    `got ${seen.status}`)
  if (seen.status !== 200) return

  /* ── Act: the real API path ──────────────────────────────────────────── */

  console.log('\n2. DELETE /api/projects/:id as admin')
  const res = await fetch(`${API}/projects/${P}`, {
    method: 'DELETE',
    headers: await authHeaders(admin.id, UA),
  })
  const body = await res.json().catch(() => ({}))
  check('HTTP 200', res.status === 200, `got ${res.status} ${JSON.stringify(body)}`)
  check('success envelope', body.success === true, JSON.stringify(body))

  /* ── work: its own cascades, still inside the schema ─────────────────── */

  console.log('\n3. work — the project and everything in its schema')
  check('project row gone', await count(work, 'SELECT count(*)::int n FROM projects WHERE id=$1', [P]) === 0)
  check('both tasks gone',
    await count(work, 'SELECT count(*)::int n FROM tasks WHERE id = ANY($1::uuid[])', [[T1, T2]]) === 0)
  check('comment gone (cascade from tasks)',
    await count(work, 'SELECT count(*)::int n FROM comments WHERE task_id = $1', [T1]) === 0)
  check('membership gone (cascade from projects)',
    await count(work, 'SELECT count(*)::int n FROM project_members WHERE project_id = $1', [P]) === 0)

  /* ── the dropped cross-module keys ───────────────────────────────────── */

  console.log('\n4. No reference to the project or its tasks survives, in any module')
  const after = await referencesTo([P], [T1, T2])
  for (const [label, n] of Object.entries(after)) check(`${label} -> 0`, n === 0, `still ${n}`)

  console.log('\n5. integrations — CASCADE replaced')
  check('target webhook deleted',
    await count(integrations, 'SELECT count(*)::int n FROM teams_webhooks WHERE id=$1', [hookP]) === 0)
  check('its delivery history went with it (in-schema cascade)',
    await count(integrations, 'SELECT count(*)::int n FROM teams_delivery_log WHERE webhook_id=$1', [hookP]) === 0)
  check('the calendar connection itself is untouched',
    await count(integrations, 'SELECT count(*)::int n FROM calendar_connections WHERE id=$1',
      [ids.connection]) === 1)

  console.log('\n6. workforce — CASCADE replaced')
  check('both target time logs deleted',
    await count(workforce, 'SELECT count(*)::int n FROM time_logs WHERE id = ANY($1::uuid[])',
      [[logP1, logP2]]) === 0)

  console.log('\n7. files — SET NULL replaced: documents kept, detached')
  const docAfter = await one(files, 'SELECT project_id FROM documents WHERE id=$1', [docP])
  check('target document still exists', Boolean(docAfter))
  check('target document project_id is NULL', docAfter && docAfter.project_id === null,
    String(docAfter?.project_id))

  console.log('\n8. defects — SET NULL replaced: bugs kept, references cleared')
  const bP = await one(defects, 'SELECT project_id, linked_task_id FROM bugs WHERE id=$1', [bugP])
  check('target bug still exists', Boolean(bP))
  check('target bug project_id is NULL', bP && bP.project_id === null, String(bP?.project_id))
  check('target bug linked_task_id is NULL', bP && bP.linked_task_id === null, String(bP?.linked_task_id))
  const bX = await one(defects, 'SELECT project_id, linked_task_id FROM bugs WHERE id=$1', [bugCross])
  check('cross-project bug keeps its own project', bX && bX.project_id === C, String(bX?.project_id))
  check('cross-project bug\'s link to the deleted task is cleared', bX && bX.linked_task_id === null,
    String(bX?.linked_task_id))

  // bug_attachments.document_id pointed at documents, which project deletion
  // detaches rather than deletes — so the reference must still resolve.
  const att = await one(defects, 'SELECT document_id FROM bug_attachments WHERE id=$1', [attachment])
  const mirror = await one(files, 'SELECT id, project_id FROM documents WHERE id=$1', [mirrorDoc])
  check('bug attachment kept, still pointing at its document', att && att.document_id === mirrorDoc,
    String(att?.document_id))
  check('...and that document still exists', Boolean(mirror))
  check('...detached from the deleted project', mirror && mirror.project_id === null,
    String(mirror?.project_id))

  console.log('\n9. What a user sees')
  const bugRes = await fetch(`${API}/bugs/${bugP}`, { headers: await authHeaders(admin.id, UA) })
  const bug = (await bugRes.json().catch(() => ({}))).data
  check('GET /api/bugs/:id -> 200', bugRes.status === 200, `got ${bugRes.status}`)
  check('bug shows no project (was: a project with a null name)', bug && bug.project === null,
    JSON.stringify(bug?.project))
  check('bug shows no linked task', bug && bug.linkedTask === null, JSON.stringify(bug?.linkedTask))
  const gone = await fetch(`${API}/projects/${P}`, { headers: await authHeaders(admin.id, UA) })
  check('GET /api/projects/:id -> 404', gone.status === 404, `got ${gone.status}`)

  /* ── scope: nothing belonging to the control project moved ───────────── */

  console.log('\n10. Control project — untouched')
  check('control project exists',
    await count(work, 'SELECT count(*)::int n FROM projects WHERE id=$1', [C]) === 1)
  check('control task exists',
    await count(work, 'SELECT count(*)::int n FROM tasks WHERE id=$1', [TC]) === 1)
  check('control time log exists',
    await count(workforce, 'SELECT count(*)::int n FROM time_logs WHERE id=$1', [logC]) === 1)
  check('control webhook exists',
    await count(integrations, 'SELECT count(*)::int n FROM teams_webhooks WHERE id=$1', [hookC]) === 1)
  check('control task + milestone calendar links exist',
    await count(integrations,
      `SELECT count(*)::int n FROM calendar_event_links
        WHERE (source_type = 'task' AND source_id = $1) OR (source_type = 'milestone' AND source_id = $2)`,
      [TC, C]) === 2)
  const dC = await one(files, 'SELECT project_id FROM documents WHERE id=$1', [docC])
  check('control document still attached to its project', dC && dC.project_id === C, String(dC?.project_id))
  const bC = await one(defects, 'SELECT project_id, linked_task_id FROM bugs WHERE id=$1', [bugC])
  check('control bug keeps project and linked task',
    bC && bC.project_id === C && bC.linked_task_id === TC, JSON.stringify(bC))

  console.log('\n11. Database-wide')
  const danglingAfter = await danglingEverywhere()
  check(`no new dangling project/task references anywhere (${danglingBefore} -> ${danglingAfter})`,
    danglingAfter === danglingBefore)

  console.log('\n12. Deleting again')
  const again = await fetch(`${API}/projects/${P}`, {
    method: 'DELETE',
    headers: await authHeaders(admin.id, UA),
  })
  check('second DELETE -> 404, not 500', again.status === 404, `got ${again.status}`)
  check('control rows still untouched after the 404',
    await count(workforce, 'SELECT count(*)::int n FROM time_logs WHERE id=$1', [logC]) === 1 &&
    await count(integrations, 'SELECT count(*)::int n FROM teams_webhooks WHERE id=$1', [hookC]) === 1)
}

main()
  .catch((err) => { fail++; console.error('\nERROR:', err.stack || err.message) })
  .finally(async () => {
    // Children first, then the projects. Each step is independent so one
    // failure cannot strand the rest. The control project is removed directly,
    // not through the API — so its cross-module children are removed by id
    // here rather than left to an event this path never emits.
    const ignore = () => {}
    await defects.query('DELETE FROM bugs WHERE id = ANY($1::uuid[])', [ids.bugs]).catch(ignore)
    await files.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [ids.documents]).catch(ignore)
    if (ids.connection) {
      await integrations.query('DELETE FROM calendar_connections WHERE id = $1', [ids.connection]).catch(ignore)
    }
    await integrations.query('DELETE FROM teams_webhooks WHERE id = ANY($1::uuid[])', [ids.webhooks]).catch(ignore)
    await workforce.query('DELETE FROM time_logs WHERE id = ANY($1::uuid[])', [ids.timeLogs]).catch(ignore)
    await work.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [ids.projects]).catch(ignore)
    await notify.query('DELETE FROM notifications WHERE message LIKE $1', [`%${TAG}%`]).catch(ignore)

    console.log(`\n${pass} passed, ${fail} failed`)
    await endAll().catch(ignore)
    process.exitCode = fail ? 1 : 0
  })
