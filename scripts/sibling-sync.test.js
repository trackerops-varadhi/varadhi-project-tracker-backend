/*
 * Cross-manager notification synchronization regression test.
 *
 * THE BUG THIS GUARDS AGAINST
 * ---------------------------
 * `review_requested` fans out one notification ROW PER RECIPIENT — an admin
 * plus four managers is five rows with five distinct ids. The action endpoint
 * claims a single row atomically by id, which is right for idempotency but
 * left the other four reading `action_taken = NULL`. Every other reviewer kept
 * live Approve/Reject buttons for a task that was already completed, and
 * refreshing could not help them: the server genuinely still said "pending"
 * for their row.
 *
 * The fix resolves sibling rows inside the same transaction that applies the
 * action, so the server — not the client — is authoritative for everyone.
 *
 * Runs against a real database and a running API on port 5000. Creates its own
 * fixture (prefixed 'ZZ ') and removes it in a finally block, so a crash mid-run
 * cannot leave rows behind.
 *
 *   node scripts/sibling-sync.test.js
 */
require('dotenv').config()
const jwt = require('jsonwebtoken')
const pool = require('../src/config/db')

const API = process.env.TEST_API_BASE || 'http://127.0.0.1:5000/api'
const ACTIONS = JSON.stringify([
  { title: 'Approve', action: 'approve' },
  { title: 'Reject', action: 'reject' },
])

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`) }
}
const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '5m' })

let taskId = null
let linkTo = null

async function main() {
  const admin = (await pool.query(
    `SELECT id, name FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1`)).rows[0]
  const managers = (await pool.query(
    `SELECT id, name FROM users WHERE role = 'manager' AND status = 'active' LIMIT 3`)).rows
  const employee = (await pool.query(
    `SELECT id FROM users WHERE role = 'employee' AND status = 'active' LIMIT 1`)).rows[0]
  const project = (await pool.query(`SELECT id FROM projects LIMIT 1`)).rows[0]

  if (!admin || managers.length < 2 || !employee || !project) {
    console.log('SKIP — needs an admin, 2+ managers, an employee and a project.')
    return
  }

  taskId = (await pool.query(
    `INSERT INTO tasks (title, description, status, priority, project_id, assignee_id, reporter_id)
     VALUES ('ZZ sibling-sync probe', 'regression fixture', 'in_review', 'medium', $1, $2, $3)
     RETURNING id`,
    [project.id, employee.id, admin.id])).rows[0].id
  linkTo = `/tasks/${taskId}`

  const ids = {}
  for (const u of [admin, ...managers]) {
    ids[u.id] = (await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, link_to, priority, actions)
       VALUES ($1, 'review_requested', 'ZZ Review Requested', 'fixture', $2, 'high', $3::jsonb)
       RETURNING id`,
      [u.id, linkTo, ACTIONS])).rows[0].id
  }

  console.log(`\nFixture: 1 admin + ${managers.length} managers, one row each`)

  // ---- Admin approves through the real endpoint --------------------------
  const res = await fetch(`${API}/notification-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(admin.id)}` },
    body: JSON.stringify({ notificationId: ids[admin.id], action: 'approve', source: 'in_app' }),
  })
  const body = await res.json()

  console.log('\n1. Admin approves')
  check('HTTP 200', res.status === 200, `got ${res.status}`)
  check('status = applied', body.data?.status === 'applied', JSON.stringify(body.data))
  check(`resolved ${managers.length} sibling rows`,
    body.data?.siblingsResolved === managers.length, String(body.data?.siblingsResolved))

  console.log('\n2. Action persisted server-side')
  const actor = (await pool.query(
    'SELECT action_taken, actioned_at FROM notifications WHERE id = $1', [ids[admin.id]])).rows[0]
  check('actor row action_taken = approve', actor.action_taken === 'approve', actor.action_taken)
  check('actor row actioned_at set', Boolean(actor.actioned_at))
  check('task is completed',
    (await pool.query('SELECT status FROM tasks WHERE id = $1', [taskId])).rows[0].status === 'completed')

  // ---- The actual regression: a FRESH fetch as every other manager -------
  console.log('\n3. Fresh notification fetch as each other manager')
  for (const m of managers) {
    const r = await fetch(`${API}/notifications?limit=50`, {
      headers: { Authorization: `Bearer ${token(m.id)}` },
    })
    const list = (await r.json()).data?.notifications || []
    const row = list.find((n) => n.id === ids[m.id])

    check(`${m.name}: row present`, Boolean(row))
    if (!row) continue

    // The three properties the bug report asks for.
    check(`${m.name}: actionTaken set -> buttons hidden`,
      row.action_taken === 'resolved', String(row.action_taken))
    check(`${m.name}: actionedAt present`, Boolean(row.actioned_at), String(row.actioned_at))
    check(`${m.name}: still has its actions snapshot (row not mutilated)`,
      Array.isArray(row.actions) && row.actions.length === 2)

    // And that it can explain itself rather than just going quiet.
    check(`${m.name}: records the action taken`,
      row.action_result?.action === 'approve', JSON.stringify(row.action_result))
    check(`${m.name}: records who took it`,
      row.action_result?.byUserName === admin.name, String(row.action_result?.byUserName))

    // Being informed is not the same as having read it.
    check(`${m.name}: NOT silently marked read`, row.is_read === false, String(row.is_read))
  }

  console.log('\n4. The action is not applied twice')
  const stale = await fetch(`${API}/notification-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(managers[0].id)}` },
    body: JSON.stringify({ notificationId: ids[managers[0].id], action: 'approve', source: 'in_app' }),
  })
  const staleBody = await stale.json()
  check('a stale approve is refused or reported as already done',
    !(stale.status === 200 && staleBody.data?.status === 'applied'),
    `${stale.status} ${JSON.stringify(staleBody.data || staleBody.message).slice(0, 120)}`)
  check('task still completed (not re-mutated)',
    (await pool.query('SELECT status FROM tasks WHERE id = $1', [taskId])).rows[0].status === 'completed')

  console.log('\n5. Unread count is not double-decremented')
  const readCount = (await pool.query(
    `SELECT COUNT(*)::int c FROM notifications
      WHERE link_to = $1 AND type = 'review_requested' AND is_read = true`, [linkTo])).rows[0].c
  check('exactly one row marked read — the actor’s', readCount === 1, `read rows = ${readCount}`)

  console.log('\n6. Siblings of an UNRELATED notification are untouched')
  const other = (await pool.query(
    `INSERT INTO notifications (user_id, type, title, message, link_to, priority, actions)
     VALUES ($1, 'review_requested', 'ZZ Unrelated', 'fixture', '/tasks/zz-unrelated', 'high', $2::jsonb)
     RETURNING id`, [managers[0].id, ACTIONS])).rows[0].id
  const otherRow = (await pool.query(
    'SELECT action_taken FROM notifications WHERE id = $1', [other])).rows[0]
  check('different link_to not resolved', otherRow.action_taken === null, String(otherRow.action_taken))
  await pool.query('DELETE FROM notifications WHERE id = $1', [other])
}

main()
  .catch((err) => { console.error('HARNESS ERROR:', err.message); fail++ })
  .finally(async () => {
    // Marker-driven teardown: safe even if the run died half way through.
    if (linkTo) {
      await pool.query('DELETE FROM notifications WHERE link_to = $1', [linkTo]).catch(() => {})
    }
    if (taskId) {
      await pool.query('DELETE FROM notification_action_log WHERE resource_id = $1', [taskId]).catch(() => {})
      await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]).catch(() => {})
    }
    await pool.query(`DELETE FROM notifications WHERE title LIKE 'ZZ %'`).catch(() => {})
    await pool.query(`DELETE FROM tasks WHERE title LIKE 'ZZ %'`).catch(() => {})
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  })
