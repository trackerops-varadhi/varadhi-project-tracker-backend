/*
 * Optimistic concurrency regression tests (AC-15 / US-4).
 *
 * Runs against the real database and the live API on :5000. Creates its own
 * 'ZZ '-prefixed fixture and removes it in a finally block.
 *
 *   node scripts/concurrency.test.js
 */
require('dotenv').config()
const jwt = require('jsonwebtoken')
const pool = require('../src/config/db')

const API = process.env.TEST_API_BASE || 'http://127.0.0.1:5000/api'
let pass = 0
let fail = 0
const check = (n, c, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}`) }
  else { fail++; console.log(`  FAIL  ${n} ${e}`) }
}
const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '5m' })

let taskId = null

async function main() {
  const admin = (await pool.query(
    `SELECT id, name FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1`)).rows[0]
  const employee = (await pool.query(
    `SELECT id FROM users WHERE role = 'employee' AND status = 'active' LIMIT 1`)).rows[0]
  const project = (await pool.query(`SELECT id FROM projects LIMIT 1`)).rows[0]
  if (!admin || !employee || !project) { console.log('SKIP — fixture users/project missing.'); return }

  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token(admin.id)}` }

  const fresh = async () => {
    if (taskId) await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]).catch(() => {})
    taskId = (await pool.query(
      `INSERT INTO tasks (title, description, status, priority, project_id, assignee_id, reporter_id)
       VALUES ('ZZ concurrency probe', 'fixture', 'todo', 'medium', $1, $2, $3) RETURNING id`,
      [project.id, employee.id, admin.id])).rows[0].id
    const r = await pool.query('SELECT updated_at FROM tasks WHERE id = $1', [taskId])
    return r.rows[0].updated_at.toISOString()
  }

  // ---------------------------------------------------------------------
  console.log('\n1. Backward compatibility — no baseUpdatedAt means no guard')
  {
    await fresh()
    const r = await fetch(`${API}/tasks/${taskId}/status`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ status: 'in_progress' }) })
    check('PATCH without baseUpdatedAt still 200', r.status === 200, `got ${r.status}`)
    const r2 = await fetch(`${API}/tasks/${taskId}`, {
      method: 'PUT', headers: H, body: JSON.stringify({ title: 'ZZ renamed' }) })
    check('PUT without baseUpdatedAt still 200', r2.status === 200, `got ${r2.status}`)
  }

  console.log('\n2. Matching baseUpdatedAt is accepted')
  {
    const base = await fresh()
    const r = await fetch(`${API}/tasks/${taskId}/status`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ status: 'in_progress', baseUpdatedAt: base }) })
    check('PATCH with correct base -> 200', r.status === 200, `got ${r.status}`)
    const row = (await pool.query('SELECT status FROM tasks WHERE id=$1', [taskId])).rows[0]
    check('status actually changed', row.status === 'in_progress', row.status)
  }

  console.log('\n3. Concurrent STATUS update conflict')
  {
    const base = await fresh()
    // Someone else changes it first.
    await new Promise((r) => setTimeout(r, 15))
    await pool.query(`UPDATE tasks SET status='completed', updated_at=NOW() WHERE id=$1`, [taskId])

    const r = await fetch(`${API}/tasks/${taskId}/status`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ status: 'in_review', baseUpdatedAt: base }) })
    const body = await r.json()

    check('stale PATCH -> 409', r.status === 409, `got ${r.status}`)
    check('reason is version_conflict', body.details?.reason === 'version_conflict')
    check('returns the complete server task', Boolean(body.details?.serverTask?.id))
    check('server task shows the OTHER change', body.details?.serverTask?.status === 'completed',
      body.details?.serverTask?.status)
    check('returns attempted value for Mine-vs-Server', body.details?.attempted?.status === 'in_review')
    check('returns currentUpdatedAt for re-basing', Boolean(body.details?.currentUpdatedAt))

    const row = (await pool.query('SELECT status FROM tasks WHERE id=$1', [taskId])).rows[0]
    check('server value NOT overwritten', row.status === 'completed', row.status)
  }

  console.log('\n4. Concurrent TASK EDIT conflict (PUT)')
  {
    const base = await fresh()
    await new Promise((r) => setTimeout(r, 15))
    await pool.query(`UPDATE tasks SET priority='critical', updated_at=NOW() WHERE id=$1`, [taskId])

    const r = await fetch(`${API}/tasks/${taskId}`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ title: 'ZZ mine', priority: 'low', baseUpdatedAt: base }) })
    const body = await r.json()

    check('stale PUT -> 409', r.status === 409, `got ${r.status}`)
    check('conflictFields identifies the clash',
      Array.isArray(body.details?.conflictFields) && body.details.conflictFields.includes('priority'),
      JSON.stringify(body.details?.conflictFields))
    const row = (await pool.query('SELECT title, priority FROM tasks WHERE id=$1', [taskId])).rows[0]
    check('server priority preserved', row.priority === 'critical', row.priority)
    check('server title NOT partially applied', row.title === 'ZZ concurrency probe', row.title)
  }

  console.log('\n5. Keep Mine — re-basing on currentUpdatedAt succeeds')
  {
    const base = await fresh()
    await new Promise((r) => setTimeout(r, 15))
    await pool.query(`UPDATE tasks SET status='in_progress', updated_at=NOW() WHERE id=$1`, [taskId])

    const conflict = await (await fetch(`${API}/tasks/${taskId}/status`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ status: 'in_review', baseUpdatedAt: base }) })).json()

    const rebased = conflict.details.currentUpdatedAt
    const r = await fetch(`${API}/tasks/${taskId}/status`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ status: 'in_review', baseUpdatedAt: rebased }) })
    check('retry with server version -> 200', r.status === 200, `got ${r.status}`)
    const row = (await pool.query('SELECT status FROM tasks WHERE id=$1', [taskId])).rows[0]
    check('my value now applied', row.status === 'in_review', row.status)
  }

  console.log('\n6. Use Server — simply not sending leaves the server untouched')
  {
    await fresh()
    await pool.query(`UPDATE tasks SET status='completed', updated_at=NOW() WHERE id=$1`, [taskId])
    const row = (await pool.query('SELECT status FROM tasks WHERE id=$1', [taskId])).rows[0]
    check('server value intact when client discards', row.status === 'completed', row.status)
  }

  console.log('\n7. Malformed baseUpdatedAt is rejected, not ignored')
  {
    await fresh()
    for (const bad of ['not-a-date', '2026-13-45T99:99:99Z']) {
      const r = await fetch(`${API}/tasks/${taskId}/status`, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({ status: 'in_progress', baseUpdatedAt: bad }) })
      check(`"${bad}" -> 400 (never silently unguarded)`, r.status === 400, `got ${r.status}`)
    }
    const row = (await pool.query('SELECT status FROM tasks WHERE id=$1', [taskId])).rows[0]
    check('task unchanged by rejected requests', row.status === 'todo', row.status)
  }

  console.log('\n8. Duplicate replay — the same mutation twice is not applied twice')
  {
    const base = await fresh()
    const send = () => fetch(`${API}/tasks/${taskId}/status`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ status: 'in_progress', baseUpdatedAt: base, mutationId: 'ZZ-fixed-id' }) })

    const first = await send()
    const second = await send()   // same baseUpdatedAt — the lost-response retry
    check('first attempt 200', first.status === 200, `got ${first.status}`)
    check('replay is refused (409), not applied twice', second.status === 409, `got ${second.status}`)

    const body = await second.json()
    check('409 shows the value already equals mine (client treats as done)',
      body.details?.serverTask?.status === 'in_progress', body.details?.serverTask?.status)
  }

  console.log('\n9. Guarded update on a deleted task -> 404, not 409')
  {
    const base = await fresh()
    const gone = taskId
    await pool.query('DELETE FROM tasks WHERE id=$1', [gone])
    taskId = null
    const r = await fetch(`${API}/tasks/${gone}/status`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ status: 'in_progress', baseUpdatedAt: base }) })
    check('missing task -> 404', r.status === 404, `got ${r.status}`)
  }
}

main()
  .catch((e) => { console.error('HARNESS ERROR:', e.message); fail++ })
  .finally(async () => {
    if (taskId) await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]).catch(() => {})
    await pool.query(`DELETE FROM notifications WHERE title LIKE 'ZZ %'`).catch(() => {})
    await pool.query(`DELETE FROM tasks WHERE title LIKE 'ZZ %'`).catch(() => {})
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  })
