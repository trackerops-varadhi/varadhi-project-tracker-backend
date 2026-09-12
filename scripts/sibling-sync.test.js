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
 * The fix resolves sibling rows server-side when the action is applied, so the
 * server — not the client — is authoritative for everyone.
 *
 * SINCE THE PHASE 2 SCHEMA SPLIT that no longer happens in the same transaction
 * as the task update: `tasks` belongs to work and `notifications` to notify, in
 * separate schemas, and nothing spans them. The task write is authoritative and
 * goes first; the claim and the sibling sweep follow in notify's own
 * transaction. Sections 1-6 are unchanged and still pass, because none of that
 * is visible on the happy path. Sections 7 and 8 cover what did change: the
 * task row now carries idempotency, and the window between the two writes is
 * repairable rather than impossible.
 *
 * Runs against a real database and a running API on port 5000. Creates its own
 * fixture (prefixed 'ZZ ') and removes it in a finally block, so a crash mid-run
 * cannot leave rows behind.
 *
 *   node scripts/sibling-sync.test.js
 */
require('dotenv').config()
// One pool per module, because the tables this suite touches are owned by
// different modules and the Phase 2 schema split put each in its own schema.
// Each query below goes to the pool of the module that owns its table; the
// old single `pool` (src/config/db) can no longer see any of them.
const { identity, notify, work } = require('./test-pools')

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
// Real session + cookie; the Bearer path was removed in b0bd3ee.
// See scripts/test-auth.js.
const { authHeaders } = require('./test-auth')

let taskId = null
let linkTo = null

async function main() {
  const admin = (await identity.query(
    `SELECT id, name FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1`)).rows[0]
  const managers = (await identity.query(
    `SELECT id, name FROM users WHERE role = 'manager' AND status = 'active' LIMIT 3`)).rows
  const employee = (await identity.query(
    `SELECT id FROM users WHERE role = 'employee' AND status = 'active' LIMIT 1`)).rows[0]
  const project = (await work.query(`SELECT id FROM projects LIMIT 1`)).rows[0]

  if (!admin || managers.length < 2 || !employee || !project) {
    console.log('SKIP — needs an admin, 2+ managers, an employee and a project.')
    return
  }

  taskId = (await work.query(
    `INSERT INTO tasks (title, description, status, priority, project_id, assignee_id, reporter_id)
     VALUES ('ZZ sibling-sync probe', 'regression fixture', 'in_review', 'medium', $1, $2, $3)
     RETURNING id`,
    [project.id, employee.id, admin.id])).rows[0].id
  linkTo = `/tasks/${taskId}`

  const ids = {}
  for (const u of [admin, ...managers]) {
    ids[u.id] = (await notify.query(
      `INSERT INTO notifications (user_id, type, title, message, link_to, priority, actions)
       VALUES ($1, 'review_requested', 'ZZ Review Requested', 'fixture', $2, 'high', $3::jsonb)
       RETURNING id`,
      [u.id, linkTo, ACTIONS])).rows[0].id
  }

  console.log(`\nFixture: 1 admin + ${managers.length} managers, one row each`)

  // ---- Admin approves through the real endpoint --------------------------
  const res = await fetch(`${API}/notification-actions`, {
    method: 'POST',
    headers: await authHeaders(admin.id, { 'user-agent': 'ZZ sibling-sync.test.js' }),
    body: JSON.stringify({ notificationId: ids[admin.id], action: 'approve', source: 'in_app' }),
  })
  const body = await res.json()

  console.log('\n1. Admin approves')
  check('HTTP 200', res.status === 200, `got ${res.status}`)
  check('status = applied', body.data?.status === 'applied', JSON.stringify(body.data))
  check(`resolved ${managers.length} sibling rows`,
    body.data?.siblingsResolved === managers.length, String(body.data?.siblingsResolved))

  console.log('\n2. Action persisted server-side')
  const actor = (await notify.query(
    'SELECT action_taken, actioned_at FROM notifications WHERE id = $1', [ids[admin.id]])).rows[0]
  check('actor row action_taken = approve', actor.action_taken === 'approve', actor.action_taken)
  check('actor row actioned_at set', Boolean(actor.actioned_at))
  check('task is completed',
    (await work.query('SELECT status FROM tasks WHERE id = $1', [taskId])).rows[0].status === 'completed')

  // ---- The actual regression: a FRESH fetch as every other manager -------
  console.log('\n3. Fresh notification fetch as each other manager')
  for (const m of managers) {
    const r = await fetch(`${API}/notifications?limit=50`, {
      headers: await authHeaders(m.id, { 'user-agent': 'ZZ sibling-sync.test.js' }),
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
    headers: await authHeaders(managers[0].id, { 'user-agent': 'ZZ sibling-sync.test.js' }),
    body: JSON.stringify({ notificationId: ids[managers[0].id], action: 'approve', source: 'in_app' }),
  })
  const staleBody = await stale.json()
  check('a stale approve is refused or reported as already done',
    !(stale.status === 200 && staleBody.data?.status === 'applied'),
    `${stale.status} ${JSON.stringify(staleBody.data || staleBody.message).slice(0, 120)}`)
  check('task still completed (not re-mutated)',
    (await work.query('SELECT status FROM tasks WHERE id = $1', [taskId])).rows[0].status === 'completed')

  console.log('\n5. Unread count is not double-decremented')
  const readCount = (await notify.query(
    `SELECT COUNT(*)::int c FROM notifications
      WHERE link_to = $1 AND type = 'review_requested' AND is_read = true`, [linkTo])).rows[0].c
  check('exactly one row marked read — the actor’s', readCount === 1, `read rows = ${readCount}`)

  console.log('\n6. Siblings of an UNRELATED notification are untouched')
  const other = (await notify.query(
    `INSERT INTO notifications (user_id, type, title, message, link_to, priority, actions)
     VALUES ($1, 'review_requested', 'ZZ Unrelated', 'fixture', '/tasks/zz-unrelated', 'high', $2::jsonb)
     RETURNING id`, [managers[0].id, ACTIONS])).rows[0].id
  const otherRow = (await notify.query(
    'SELECT action_taken FROM notifications WHERE id = $1', [other])).rows[0]
  check('different link_to not resolved', otherRow.action_taken === null, String(otherRow.action_taken))
  await notify.query('DELETE FROM notifications WHERE id = $1', [other])

  /* ═══════════════════════════════════════════════════════════════════════
   * The Phase 2 behaviour change.
   *
   * The task write and the notification claim used to be one transaction.
   * They are in different schemas now, so they are two — the task first and
   * authoritative, the claim second and eventually consistent. Sections 1-6
   * above pass unchanged, which is the point: nothing observable moved on the
   * happy path. What follows covers the parts that DID change.
   * ═══════════════════════════════════════════════════════════════════════ */

  console.log('\n7. The TASK row is the idempotency record, not the notification')
  {
    // Clear the notification claim while leaving the task completed — exactly
    // the state a failed second phase produces. Under the old design the claim
    // was the only guard, so wiping it would let the action apply a second
    // time. Under the new one the task's compare-and-swap refuses, because the
    // task is no longer in the `in_review` state the transition requires.
    await notify.query(
      `UPDATE notifications
          SET action_taken = NULL, actioned_at = NULL, action_result = NULL
        WHERE link_to = $1 AND user_id = $2`, [linkTo, admin.id])

    const before = (await work.query(
      'SELECT status, completed_at FROM tasks WHERE id = $1', [taskId])).rows[0]

    const replay = await fetch(`${API}/notification-actions`, {
      method: 'POST',
      headers: await authHeaders(admin.id, { 'user-agent': 'ZZ sibling-sync.test.js' }),
      body: JSON.stringify({ notificationId: ids[admin.id], action: 'approve', source: 'in_app' }),
    })
    const replayBody = await replay.json()

    check('un-claimed replay is NOT applied again',
      replayBody.data?.status !== 'applied',
      `status=${replayBody.data?.status}`)
    check('it reports superseded — the outcome is already true',
      replayBody.data?.status === 'superseded',
      JSON.stringify(replayBody.data))

    const after = (await work.query(
      'SELECT status, completed_at FROM tasks WHERE id = $1', [taskId])).rows[0]
    check('task still completed', after.status === 'completed', after.status)
    check('completed_at NOT bumped by the replay',
      String(after.completed_at) === String(before.completed_at),
      `${before.completed_at} -> ${after.completed_at}`)
  }

  console.log('\n8. A pending claim is repairable')
  {
    // Reproduce the failure window directly: task applied, notification rows
    // not caught up, and an applied_claim_pending row recording it. This is
    // what actions.controller writes when its second phase throws.
    await notify.query(
      `UPDATE notifications
          SET action_taken = NULL, actioned_at = NULL, action_result = NULL
        WHERE link_to = $1`, [linkTo])

    await notify.query(
      `INSERT INTO notification_action_log
         (notification_id, user_id, action, source, outcome, resource_type, resource_id, detail)
       VALUES ($1, $2, 'approve', 'in_app', 'applied_claim_pending', 'task', $3, $4::jsonb)`,
      [ids[admin.id], admin.id, taskId,
        JSON.stringify({ from: 'in_review', to: 'completed',
          linkTo, notificationType: 'review_requested', error: 'simulated' })])

    // Scoped to the review_requested type on purpose. The approve in section 1
    // also dispatched an OUTCOME notification, which shares this link_to but is
    // a different type — and must stay untouched. Counting every row under the
    // link would fold that one in and assert the wrong number.
    const unclaimedSql = `SELECT COUNT(*)::int c FROM notifications
        WHERE link_to = $1 AND type = 'review_requested' AND action_taken IS NULL`
    const unclaimed = (await notify.query(unclaimedSql, [linkTo])).rows[0].c
    check('window reproduced — rows unclaimed', unclaimed === managers.length + 1,
      `expected ${managers.length + 1}, got ${unclaimed}`)

    const notifyModule = require('../src/modules/notify')
    const report = await notifyModule.reconcilePendingClaims()

    check('reconciler found the pending claim', report.pending >= 1, JSON.stringify(report))
    check('reconciler repaired it', report.reconciled >= 1, JSON.stringify(report))
    check('reconciler reported no failures', report.failed === 0, JSON.stringify(report))

    const actorRow = (await notify.query(
      'SELECT action_taken, actioned_at FROM notifications WHERE id = $1',
      [ids[admin.id]])).rows[0]
    check('actor row claimed by reconciliation', actorRow.action_taken === 'approve',
      String(actorRow.action_taken))
    check('actor row has actioned_at', Boolean(actorRow.actioned_at))

    const stillOpen = (await notify.query(unclaimedSql, [linkTo])).rows[0].c
    check('every sibling retired too', stillOpen === 0, `${stillOpen} still open`)

    // The other side of the same coin: a row under this link_to that is NOT a
    // review_requested must survive reconciliation untouched.
    const bystander = (await notify.query(
      `SELECT COUNT(*)::int c FROM notifications
        WHERE link_to = $1 AND type <> 'review_requested' AND action_taken IS NULL`,
      [linkTo])).rows[0].c
    check('a different-type notification under the same link is left alone',
      bystander >= 1, `${bystander} — the approve outcome notification should still be open`)

    // Idempotent: a second pass must find nothing left and change nothing.
    const second = await notifyModule.reconcilePendingClaims()
    check('second pass is a no-op', second.reconciled === 0, JSON.stringify(second))

    const taskAfter = (await work.query(
      'SELECT status FROM tasks WHERE id = $1', [taskId])).rows[0]
    check('reconciliation never touched the task', taskAfter.status === 'completed',
      taskAfter.status)
  }
}

main()
  .catch((err) => { console.error('HARNESS ERROR:', err.message); fail++ })
  .finally(async () => {
    // Marker-driven teardown: safe even if the run died half way through.
    if (linkTo) {
      await notify.query('DELETE FROM notifications WHERE link_to = $1', [linkTo]).catch(() => {})
    }
    if (taskId) {
      await notify.query('DELETE FROM notification_action_log WHERE resource_id = $1', [taskId]).catch(() => {})
      await work.query('DELETE FROM tasks WHERE id = $1', [taskId]).catch(() => {})
    }
    await notify.query(`DELETE FROM notifications WHERE title LIKE 'ZZ %'`).catch(() => {})
    await work.query(`DELETE FROM tasks WHERE title LIKE 'ZZ %'`).catch(() => {})
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  })
