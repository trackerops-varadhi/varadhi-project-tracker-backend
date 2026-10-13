/*
 * Bugs Finder (Module 8) integration tests.
 *
 * Runs against the real database and the live API on :5000, exactly like the
 * existing concurrency/calendar/teams suites. Creates its own 'ZZ '-prefixed
 * fixtures and removes them in a finally block.
 *
 *   npm run test:bugs
 *
 * Covers §28 of the spec: create/read/update/delete, assignment, the status
 * workflow (including illegal transitions), SLA computation, comments,
 * permissions, project/task/notification/activity integration, and the full
 * §29 acceptance flow.
 *
 * ROLE WORKSPACES: the Bugs Finder is QC's (admin + qc). A zz-bugs-qc fixture
 * user plays QC; employees and managers get 403 on /api/bugs and work a bug
 * through its linked task, whose status mirrors onto the bug.
 *
 * ! THIS SUITE RUNS A GLOBAL SWEEP. Before running it against a database other
 *   people use, blank EMAIL_USER, EMAIL_PASS, VAPID_PUBLIC_KEY and
 *   VAPID_PRIVATE_KEY for BOTH the API process and this one. Email and push
 *   degrade to a no-op without them, by design.
 *
 *   The sweep scans every row, not just the ZZ fixtures, so it notifies real
 *   users about real records. Measured on dev 2026-10-13: 5 in-app rows for 4
 *   real users, and with live credentials that would have been 5 emails and 5
 *   push messages nobody asked for. The suite cleans up its own fixtures; it
 *   cannot clean up a notification it caused for someone else.
 */

require('dotenv').config()
// One pool per module, because the tables this suite touches are owned by
// different modules and the Phase 2 schema split put each in its own schema.
// Each query below goes to the pool of the module that owns its table; the
// old single `pool` (src/config/db) can no longer see any of them.
const { defects, identity, notify, work, endAll } = require('./test-pools')
// Through the defects module's public interface — the SLA sweep moved into
// modules/defects/sla-cron.js and is no longer reachable at utils/.
const { runSlaSweepNow: runBugSlaSweepNow } = require('../src/modules/defects')

const API = process.env.TEST_API_BASE || 'http://127.0.0.1:5000/api'

let pass = 0
let fail = 0
const failures = []

const check = (name, condition, extra = '') => {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    failures.push(`${name} ${extra}`)
    console.log(`  FAIL  ${name} ${extra}`)
  }
}

// Real sessions + cookies. The Bearer path this suite used was removed in
// b0bd3ee; see scripts/test-auth.js for the full reasoning.
const { authHeaders } = require('./test-auth')

async function api(method, path, userId, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: await authHeaders(userId, { 'user-agent': 'ZZ bugs.test.js' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* empty body */
  }
  return { status: res.status, body: json, data: json?.data }
}

// Track everything created so the finally block can remove it.
const created = { bugs: [], tasks: [], projects: [], users: [] }

// Role workspaces: the developer works a bug through its linked task.
const taskStatus = (taskId, userId, status) => api('PATCH', `/tasks/${taskId}/status`, userId, { status })
const bugOf = async (id) => (await api('GET', `/bugs/${id}`, created.users[0])).data

async function main() {
  // ─── Fixtures ─────────────────────────────────────────────────────────────
  const admin = (
    await identity.query(`SELECT id, name FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1`)
  ).rows[0]
  const manager = (
    await identity.query(`SELECT id, name FROM users WHERE role = 'manager' AND status = 'active' LIMIT 1`)
  ).rows[0]
  const devs = (
    await identity.query(
      `SELECT id, name FROM users WHERE role = 'employee' AND status = 'active' LIMIT 2`
    )
  ).rows

  if (!admin || !manager || devs.length < 2) {
    console.log('SKIP — need an admin, a manager and two active employees.')
    return
  }
  const [dev, otherDev] = devs

  // The QC lead is a fixture of its own, so no real account changes role.
  const stamp = Date.now().toString(36)
  const qc = (await identity.query(
    `INSERT INTO users (name, email, role, status) VALUES ($1, $2, 'qc', 'active') RETURNING id, name`,
    [`ZZ Bugs QC ${stamp}`, `zz-bugs-qc-${stamp}@varadhi.test`]
  )).rows[0]
  created.users.push(qc.id)

  const project = (
    await work.query(
      `INSERT INTO projects (name, description, status, manager_id)
            VALUES ('ZZ Bugs Finder probe', 'test fixture', 'active', $1) RETURNING id`,
      [manager.id]
    )
  ).rows[0]
  created.projects.push(project.id)

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n1. Create bug — validation and who may report')
  {
    const noTitle = await api('POST', '/bugs', admin.id, { description: 'x', projectId: project.id })
    check('missing title rejected', noTitle.status === 400, `got ${noTitle.status}`)

    const noDesc = await api('POST', '/bugs', admin.id, { title: 'ZZ x', projectId: project.id })
    check('missing description rejected', noDesc.status === 400, `got ${noDesc.status}`)

    const noProject = await api('POST', '/bugs', admin.id, { title: 'ZZ x', description: 'y' })
    check('missing project rejected', noProject.status === 400, `got ${noProject.status}`)

    const badSeverity = await api('POST', '/bugs', admin.id, {
      title: 'ZZ x', description: 'y', projectId: project.id, severity: 'catastrophic',
    })
    check('invalid severity rejected', badSeverity.status === 400, `got ${badSeverity.status}`)

    const badProject = await api('POST', '/bugs', admin.id, {
      title: 'ZZ x', description: 'y', projectId: '00000000-0000-0000-0000-000000000000',
    })
    check('unknown project rejected with 400 not 500', badProject.status === 400, `got ${badProject.status}`)

    // Role workspaces: the Bugs Finder is QC's. Employees and managers work
    // bugs through tasks and never reach this API.
    const employeeReporting = await api('POST', '/bugs', dev.id, {
      title: 'ZZ x', description: 'y', projectId: project.id,
    })
    check('employee cannot report a bug', employeeReporting.status === 403, `got ${employeeReporting.status}`)

    const managerReporting = await api('POST', '/bugs', manager.id, {
      title: 'ZZ x', description: 'y', projectId: project.id,
    })
    check('manager cannot report a bug', managerReporting.status === 403, `got ${managerReporting.status}`)

    const qcReporting = await api('POST', '/bugs', qc.id, {
      title: 'ZZ qc-reported probe', description: 'y', projectId: project.id,
    })
    check('qc can report a bug', qcReporting.status === 201, `got ${qcReporting.status}`)
    if (qcReporting.data?.id) created.bugs.push(qcReporting.data.id)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n2. Create bug — success, bug id and SLA')
  let bugId = null
  let bugKey = null
  let unassignedBugId = null
  {
    const res = await api('POST', '/bugs', admin.id, {
      title: 'ZZ login button unresponsive',
      description: 'Clicking Sign in does nothing on Safari.',
      stepsToReproduce: '1. Open /auth/login\n2. Click Sign in',
      projectId: project.id,
      severity: 'high',
      priority: 'p1',
      environment: 'production',
    })
    check('create returns 201', res.status === 201, `got ${res.status} ${JSON.stringify(res.body)}`)
    bugId = res.data?.id
    bugKey = res.data?.key
    if (bugId) created.bugs.push(bugId)

    check('bug id auto-generated', /^BUG-\d+$/.test(bugKey || ''), `got ${bugKey}`)
    check('reporter is the authenticated user', res.data?.reporter?.id === admin.id)
    check('unassigned bug starts Open', res.data?.status === 'open', `got ${res.data?.status}`)
    check('unassigned bug has no task yet', res.data?.linkedTask === null)
    check('SLA due date set', Boolean(res.data?.sla?.dueAt))
    check('SLA starts Within SLA', res.data?.sla?.status === 'within_sla', `got ${res.data?.sla?.status}`)
    check('SLA countdown label rendered', /remaining/.test(res.data?.sla?.label || ''), `got ${res.data?.sla?.label}`)
    check('server time returned for countdown', Boolean(res.data?.serverTime))

    // High = 480 resolution minutes = one 8h business day from the rule table.
    check('SLA rule matches severity', res.data?.sla?.resolutionMinutes === 480, `got ${res.data?.sla?.resolutionMinutes}`)

    const activity = await api('GET', `/bugs/${bugId}/activity`, admin.id)
    check('BUG_CREATED logged', activity.data?.some((a) => a.action === 'BUG_CREATED'))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n3. Bug numbering is sequential and unique')
  {
    const second = await api('POST', '/bugs', admin.id, {
      title: 'ZZ second defect', description: 'y', projectId: project.id, severity: 'low',
    })
    created.bugs.push(second.data.id)
    unassignedBugId = second.data.id
    const firstNumber = Number(bugKey.split('-')[1])
    check('second bug gets a higher number', second.data.bugNumber > firstNumber,
      `${second.data.bugNumber} vs ${firstNumber}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n4. Assignment creates the developer\'s task')
  let taskId = null
  {
    check('employee cannot assign', (await api('PATCH', `/bugs/${bugId}/assign`, dev.id, { assigneeId: dev.id })).status === 403)
    check('manager cannot assign', (await api('PATCH', `/bugs/${bugId}/assign`, manager.id, { assigneeId: dev.id })).status === 403)

    const missingField = await api('PATCH', `/bugs/${bugId}/assign`, qc.id, {})
    check('assign without assigneeId rejected', missingField.status === 400, `got ${missingField.status}`)

    const res = await api('PATCH', `/bugs/${bugId}/assign`, qc.id, { assigneeId: dev.id })
    check('qc can assign', res.status === 200, `got ${res.status}`)
    check('assignee set', res.data?.assignee?.id === dev.id)
    check('open bug auto-advances to Assigned', res.data?.status === 'assigned', `got ${res.data?.status}`)
    check('first response stamped', Boolean(res.data?.sla?.firstResponseAt))

    taskId = res.data?.linkedTask?.id
    check('assignment created a linked task', Boolean(taskId))
    const task = (await work.query('SELECT type, project_id, assignee_id, status, title FROM tasks WHERE id = $1', [taskId])).rows[0]
    check('linked task is typed as a bug', task?.type === 'bug')
    check('linked task is the developer\'s', task?.assignee_id === dev.id)
    check('linked task starts To Do', task?.status === 'todo', task?.status)
    check('task title carries the bug key', (task?.title || '').startsWith(bugKey), task?.title)

    const notif = await notify.query(
      `SELECT type, link_to FROM notifications WHERE user_id = $1 AND type = 'bug_assigned' ORDER BY created_at DESC LIMIT 1`,
      [dev.id]
    )
    check('developer notified with a link to the task, not the bug',
      notif.rows[0]?.link_to === `/tasks/${taskId}`, `got ${notif.rows[0]?.link_to}`)

    // Reassign: the task follows the bug.
    const re = await api('PATCH', `/bugs/${bugId}/assign`, qc.id, { assigneeId: otherDev.id })
    check('reassignment accepted', re.status === 200 && re.data?.assignee?.id === otherDev.id)
    check('same task, not a second one', re.data?.linkedTask?.id === taskId)
    const moved = (await work.query('SELECT assignee_id FROM tasks WHERE id = $1', [taskId])).rows[0]
    check('task handed to the new assignee', moved?.assignee_id === otherDev.id)

    // Put it back on `dev` for the rest of the suite.
    await api('PATCH', `/bugs/${bugId}/assign`, qc.id, { assigneeId: dev.id })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n5. Workflow — developer through the task, QC through the bug')
  {
    check('employee has no Bugs module (GET /bugs 403)', (await api('GET', '/bugs', dev.id)).status === 403)
    check('employee cannot open the bug (403)', (await api('GET', `/bugs/${bugId}`, dev.id)).status === 403)

    const illegal = await api('PATCH', `/bugs/${bugId}/status`, qc.id, { status: 'closed' })
    check('assigned -> closed rejected', illegal.status === 400, `got ${illegal.status}`)
    const bogus = await api('PATCH', `/bugs/${bugId}/status`, qc.id, { status: 'exploded' })
    check('unknown status rejected', bogus.status === 400, `got ${bogus.status}`)
    const idempotent = await api('PATCH', `/bugs/${bugId}/status`, qc.id, { status: 'assigned' })
    check('same-status submit is idempotent, not an error', idempotent.status === 200, `got ${idempotent.status}`)

    const stranger = await taskStatus(taskId, otherDev.id, 'in_progress')
    check('another employee cannot move the task', stranger.status === 403, `got ${stranger.status}`)

    const start = await taskStatus(taskId, dev.id, 'in_progress')
    check('developer starts the task', start.status === 200, `got ${start.status}`)
    check('bug follows to In Progress', (await bugOf(bugId))?.status === 'in_progress')

    const done = await taskStatus(taskId, dev.id, 'completed')
    check('developer completes the task', done.status === 200, `got ${done.status}`)
    const fixed = await bugOf(bugId)
    check('bug becomes Fixed', fixed?.status === 'fixed', fixed?.status)
    check('resolved_at stamped on Fixed', Boolean(fixed?.resolvedAt))
    check('SLA resolved within target', fixed?.sla?.status === 'resolved_within_sla', fixed?.sla?.status)
    const activity = await api('GET', `/bugs/${bugId}/activity`, qc.id)
    check('status change attributed to the developer',
      activity.data?.some((a) => a.action === 'BUG_STATUS_CHANGED' && a.newValue === 'fixed' && a.actor?.id === dev.id))
    const ready = await notify.query(
      `SELECT link_to FROM notifications WHERE user_id = $1 AND title LIKE 'Bug fixed%' ORDER BY created_at DESC LIMIT 1`,
      [qc.id]
    )
    check('QC told the fix is ready to verify', ready.rows[0]?.link_to === `/bugs/${bugId}`, `got ${ready.rows[0]?.link_to}`)

    const qa = await api('PATCH', `/bugs/${bugId}/status`, qc.id, { status: 'qa_verification' })
    check('qc moves to QA Verification', qa.status === 200, `got ${qa.status}`)
    const taskNow = (await work.query('SELECT status FROM tasks WHERE id = $1', [taskId])).rows[0]
    check('task stays Completed during QA', taskNow?.status === 'completed', taskNow?.status)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n6. QA rejection -> reopen sends the task back')
  {
    const reopened = await api('PATCH', `/bugs/${bugId}/status`, qc.id, { status: 'reopened' })
    check('QC can reject to Reopened', reopened.status === 200, `got ${reopened.status}`)
    check('reopen count incremented', reopened.data?.reopenCount === 1, `got ${reopened.data?.reopenCount}`)
    check('resolved_at cleared on reopen', reopened.data?.resolvedAt === null)
    check('SLA clock restarted', reopened.data?.sla?.status === 'within_sla', `got ${reopened.data?.sla?.status}`)
    const t = (await work.query('SELECT status FROM tasks WHERE id = $1', [taskId])).rows[0]
    check('task back to To Do', t?.status === 'todo', t?.status)

    const activity = await api('GET', `/bugs/${bugId}/activity`, admin.id)
    check('BUG_REOPENED logged', activity.data?.some((a) => a.action === 'BUG_REOPENED'))

    await taskStatus(taskId, dev.id, 'in_progress')
    check('reopened -> In Progress via the task', (await bugOf(bugId))?.status === 'in_progress')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n7. Comments')
  {
    check('employee cannot comment on the bug (no module)',
      (await api('POST', `/bugs/${bugId}/comments`, dev.id, { content: 'ZZ hi' })).status === 403)

    const empty = await api('POST', `/bugs/${bugId}/comments`, qc.id, { content: '   ' })
    check('empty comment rejected', empty.status === 400, `got ${empty.status}`)

    const added = await api('POST', `/bugs/${bugId}/comments`, qc.id, {
      content: 'ZZ Reproduced on Safari 17. Investigating the click handler.',
    })
    check('comment created', added.status === 201, `got ${added.status}`)
    const commentId = added.data?.id

    const list = await api('GET', `/bugs/${bugId}/comments`, admin.id)
    check('comment persisted and listed', list.data?.some((c) => c.id === commentId))
    check('comment carries its author', list.data?.[0]?.author?.id === qc.id)

    const foreignEdit = await api('PUT', `/bugs/${bugId}/comments/${commentId}`, admin.id, { content: 'ZZ hijacked' })
    check('cannot edit another user comment', foreignEdit.status === 403, `got ${foreignEdit.status}`)

    const edited = await api('PUT', `/bugs/${bugId}/comments/${commentId}`, qc.id, { content: 'ZZ Reproduced on Safari 17 and 16.' })
    check('author can edit own comment', edited.status === 200, `got ${edited.status}`)
    check('edited flag set', edited.data?.edited === true)

    const activity = await api('GET', `/bugs/${bugId}/activity`, admin.id)
    check('BUG_COMMENT_ADDED logged', activity.data?.some((a) => a.action === 'BUG_COMMENT_ADDED'))

    const reporterNotif = await notify.query(
      `SELECT type FROM notifications WHERE user_id = $1 AND type = 'bug_comment' LIMIT 1`, [admin.id])
    check('reporter notified of the comment', reporterNotif.rows.length > 0)

    const del = await api('DELETE', `/bugs/${bugId}/comments/${commentId}`, qc.id)
    check('author can delete own comment', del.status === 200, `got ${del.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n8. Field updates and permissions')
  {
    check('employee cannot edit the bug', (await api('PUT', `/bugs/${bugId}`, dev.id, { rootCause: 'ZZ x' })).status === 403)
    check('manager cannot edit the bug', (await api('PUT', `/bugs/${bugId}`, manager.id, { severity: 'critical' })).status === 403)

    const escalate = await api('PUT', `/bugs/${bugId}`, qc.id, { severity: 'critical' })
    check('qc can escalate severity', escalate.status === 200, `got ${escalate.status}`)
    check('severity change tightens the SLA deadline',
      escalate.data?.sla?.resolutionMinutes === 240, `got ${escalate.data?.sla?.resolutionMinutes}`)

    const activity = await api('GET', `/bugs/${bugId}/activity`, admin.id)
    check('BUG_SEVERITY_CHANGED logged', activity.data?.some((a) => a.action === 'BUG_SEVERITY_CHANGED'))

    const noChanges = await api('PUT', `/bugs/${bugId}`, qc.id, {})
    check('empty update rejected', noChanges.status === 400, `got ${noChanges.status}`)

    await api('PUT', `/bugs/${bugId}`, qc.id, { severity: 'high' })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n9. The bug shows up in the developer\'s task list')
  {
    const detail = await api('GET', `/tasks/${taskId}`, dev.id)
    check('developer opens the task', detail.status === 200, `got ${detail.status}`)
    check('task carries the bug card', detail.data?.bug?.key === bugKey, JSON.stringify(detail.data?.bug)?.slice(0, 120))
    check('bug card has severity and steps',
      detail.data?.bug?.severity === 'high' && /Click Sign in/.test(detail.data?.bug?.stepsToReproduce || ''))
    check('bug card names the QC reporter', detail.data?.bug?.reporter?.id === admin.id)

    const list = await api('GET', '/tasks?limit=100', dev.id)
    const tasks = list.data?.data || []
    const row = tasks.find((t) => t.id === taskId)
    check('bug task is in the same task list', Boolean(row))
    check('and is marked as a bug', row?.type === 'bug' && row?.bug?.key === bugKey)
    const plain = tasks.find((t) => t.id !== taskId)
    if (plain) check('ordinary tasks carry no bug card', plain.bug === null || plain.type === 'bug')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n10. Search, filters and pagination')
  {
    const bySearch = await api('GET', `/bugs?search=${encodeURIComponent('login button')}`, admin.id)
    check('search by title text finds the bug', (bySearch.data?.data || []).some((b) => b.id === bugId))

    const byKey = await api('GET', `/bugs?search=${encodeURIComponent(bugKey)}`, qc.id)
    check('search by BUG-#### finds the bug', (byKey.data?.data || []).some((b) => b.id === bugId), `searched ${bugKey}`)

    const bySeverity = await api('GET', '/bugs?severity=high&limit=100', admin.id)
    check('severity filter applied server-side', (bySeverity.data?.data || []).every((b) => b.severity === 'high'))

    const multi = await api('GET', '/bugs?severity=high,low&limit=100', admin.id)
    check('comma-separated multi-filter works',
      (multi.data?.data || []).every((b) => ['high', 'low'].includes(b.severity)))

    const byProject = await api('GET', `/bugs?projectId=${project.id}&limit=100`, admin.id)
    check('project filter applied', (byProject.data?.data || []).every((b) => b.project?.id === project.id))

    const byAssignee = await api('GET', `/bugs?assigneeId=${dev.id}&limit=100`, admin.id)
    check('developer filter applied', (byAssignee.data?.data || []).every((b) => b.assignee?.id === dev.id))

    const unassigned = await api('GET', '/bugs?assigneeId=unassigned&limit=100', admin.id)
    check('unassigned filter applied', (unassigned.data?.data || []).every((b) => b.assignee === null))

    const paged = await api('GET', '/bugs?limit=1&page=1', admin.id)
    check('pagination returns one row', (paged.data?.data || []).length <= 1)
    check('pagination reports a total', typeof paged.data?.total === 'number')
    check('pagination reports totalPages', typeof paged.data?.totalPages === 'number')

    const page2 = await api('GET', '/bugs?limit=1&page=2', admin.id)
    check('page 2 differs from page 1', paged.data?.data?.[0]?.id !== page2.data?.data?.[0]?.id)

    const sorted = await api('GET', '/bugs?sortBy=severity&sortDir=asc&limit=100', admin.id)
    check('sorting accepted', sorted.status === 200, `got ${sorted.status}`)

    const injection = await api('GET', '/bugs?sortBy=title;DROP+TABLE+bugs&limit=5', admin.id)
    check('unknown sort column falls back safely', injection.status === 200, `got ${injection.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n11. SLA breach detection (server clock)')
  {
    const breach = await api('POST', '/bugs', qc.id, {
      title: 'ZZ already breached defect', description: 'y', projectId: project.id, severity: 'critical',
    })
    created.bugs.push(breach.data.id)
    const assigned = await api('PATCH', `/bugs/${breach.data.id}/assign`, qc.id, { assigneeId: dev.id })
    const breachTask = assigned.data?.linkedTask?.id

    await defects.query(
      `UPDATE bugs SET sla_resolution_due_at = NOW() - INTERVAL '1 hour',
                       sla_started_at = NOW() - INTERVAL '5 hours'
        WHERE id = $1`,
      [breach.data.id]
    )

    const read = await api('GET', `/bugs/${breach.data.id}`, admin.id)
    check('past-deadline bug reads as Breached', read.data?.sla?.status === 'breached', `got ${read.data?.sla?.status}`)
    check('breach label rendered', /Breached by/.test(read.data?.sla?.label || ''), `got ${read.data?.sla?.label}`)

    const filtered = await api('GET', '/bugs?slaStatus=breached&limit=100', admin.id)
    check('SLA breached filter finds it', (filtered.data?.data || []).some((b) => b.id === breach.data.id))

    await runBugSlaSweepNow()

    const latched = await defects.query('SELECT sla_breached FROM bugs WHERE id = $1', [breach.data.id])
    check('sweep latches sla_breached', latched.rows[0].sla_breached === true)

    const activity = await api('GET', `/bugs/${breach.data.id}/activity`, admin.id)
    check('BUG_SLA_BREACHED logged', activity.data?.some((a) => a.action === 'BUG_SLA_BREACHED'))

    const notif = await notify.query(
      `SELECT link_to FROM notifications WHERE user_id = $1 AND type = 'bug_sla_breached' ORDER BY created_at DESC LIMIT 1`,
      [dev.id]
    )
    check('developer\'s breach notice links to their task', notif.rows[0]?.link_to === `/tasks/${breachTask}`, `got ${notif.rows[0]?.link_to}`)
    const leadNotif = await notify.query(
      `SELECT link_to FROM notifications WHERE user_id = $1 AND type = 'bug_sla_breached' LIMIT 1`, [qc.id])
    check('critical breach escalated to QC', leadNotif.rows.length > 0)
    const mgrNotif = await notify.query(
      `SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'bug_sla_breached' AND message LIKE '%ZZ already breached%'`,
      [manager.id])
    check('project manager no longer escalated', mgrNotif.rows.length === 0)

    const risk = await api('POST', '/bugs', qc.id, {
      title: 'ZZ at risk defect', description: 'y', projectId: project.id, severity: 'high',
    })
    created.bugs.push(risk.data.id)
    await api('PATCH', `/bugs/${risk.data.id}/assign`, qc.id, { assigneeId: dev.id })
    await defects.query(
      `UPDATE bugs SET sla_started_at = NOW() - INTERVAL '8 hours',
                       sla_resolution_due_at = NOW() + INTERVAL '2 hours'
        WHERE id = $1`,
      [risk.data.id]
    )
    const riskRead = await api('GET', `/bugs/${risk.data.id}`, admin.id)
    check('80%-elapsed bug reads as At Risk', riskRead.data?.sla?.status === 'at_risk', `got ${riskRead.data?.sla?.status}`)

    const riskFilter = await api('GET', '/bugs?slaStatus=at_risk&limit=100', admin.id)
    check('SLA at-risk filter finds it', (riskFilter.data?.data || []).some((b) => b.id === risk.data.id))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n12. Manual task link and task deletion')
  {
    const twice = await api('POST', `/bugs/${bugId}/task`, qc.id, {})
    check('an assigned bug already has its task (409)', twice.status === 409, `got ${twice.status}`)

    const unassigned = unassignedBugId // 'ZZ second defect', never assigned
    check('manager cannot create tasks from bugs',
      (await api('POST', `/bugs/${unassigned}/task`, manager.id, {})).status === 403)
    const manual = await api('POST', `/bugs/${unassigned}/task`, qc.id, {})
    check('qc can create a task from an unassigned bug', manual.status === 201, `got ${manual.status}`)
    const manualTask = manual.data?.linkedTask?.id
    if (manualTask) created.tasks.push(manualTask)

    const del = await api('DELETE', `/tasks/${manualTask}`, admin.id)
    check('admin deletes the task', del.status === 200, `got ${del.status}`)
    const after = await bugOf(unassigned)
    check('deleting the task unlinks the bug (bug kept)', after && after.linkedTask === null)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n13. Project integration')
  {
    const res = await api('GET', `/projects/${project.id}/bugs?limit=100`, admin.id)
    check('project bugs endpoint returns 200 for admin', res.status === 200, `got ${res.status}`)
    check('project bugs are scoped to that project', (res.data?.data || []).every((b) => b.project?.id === project.id))
    check('project bugs include the fixture', (res.data?.data || []).some((b) => b.id === bugId))
    check('manager has no project Bugs tab (403)',
      (await api('GET', `/projects/${project.id}/bugs`, manager.id)).status === 403)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n14. Reports')
  {
    const goneDash = await api('GET', '/bugs/dashboard', admin.id)
    check('dashboard endpoint removed', goneDash.status === 404, `got ${goneDash.status}`)

    const reports = await api('GET', `/bugs/reports?projectId=${project.id}`, qc.id)
    check('reports return 200 for qc', reports.status === 200, `got ${reports.status}`)
    check('reports include SLA compliance', reports.data?.slaCompliancePercent !== undefined)
    check('reports include reopen rate', typeof reports.data?.reopenRatePercent === 'number')
    check('reports include by-developer breakdown', Array.isArray(reports.data?.byDeveloper))
    check('manager blocked from bug reports', (await api('GET', '/bugs/reports', manager.id)).status === 403)
    check('employee blocked from bug reports', (await api('GET', '/bugs/reports', dev.id)).status === 403)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n15. SLA rule administration')
  {
    const rules = await api('GET', '/bugs/sla-rules', qc.id)
    check('SLA rules readable', rules.status === 200 && rules.data?.length === 4, `got ${rules.status}`)

    const byQc = await api('PUT', '/bugs/sla-rules/high', qc.id, { responseMinutes: 60, resolutionMinutes: 120 })
    check('qc cannot edit SLA rules', byQc.status === 403, `got ${byQc.status}`)

    const incoherent = await api('PUT', '/bugs/sla-rules/high', admin.id, { responseMinutes: 600, resolutionMinutes: 60 })
    check('resolution shorter than response rejected', incoherent.status === 400, `got ${incoherent.status}`)

    const negative = await api('PUT', '/bugs/sla-rules/high', admin.id, { responseMinutes: -5, resolutionMinutes: 60 })
    check('negative duration rejected', negative.status === 400, `got ${negative.status}`)

    const ok = await api('PUT', '/bugs/sla-rules/high', admin.id, { responseMinutes: 240, resolutionMinutes: 480 })
    check('admin can update an SLA rule', ok.status === 200, `got ${ok.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n16. Not-found and malformed ids')
  {
    const missing = await api('GET', '/bugs/00000000-0000-0000-0000-000000000000', admin.id)
    check('unknown bug id returns 404', missing.status === 404, `got ${missing.status}`)

    const malformed = await api('GET', '/bugs/not-a-uuid', admin.id)
    check('malformed id returns 404 not 500', malformed.status === 404, `got ${malformed.status}`)

    const unauthenticated = await fetch(`${API}/bugs`)
    check('unauthenticated request rejected', unauthenticated.status === 401, `got ${unauthenticated.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n17. Acceptance flow: QC reports → developer fixes via task → QC closes')
  {
    const flow = await api('POST', '/bugs', qc.id, {
      title: 'ZZ acceptance flow defect',
      description: 'End-to-end scenario.',
      projectId: project.id,
      severity: 'medium',
      priority: 'p2',
      environment: 'staging',
      assigneeId: dev.id,
    })
    const id = flow.data.id
    created.bugs.push(id)
    const flowTask = flow.data?.linkedTask?.id
    check('assigning on create links a task immediately', Boolean(flowTask))

    const steps = []
    steps.push(['qc comment', (await api('POST', `/bugs/${id}/comments`, qc.id, { content: 'ZZ Please check.' })).status])
    steps.push(['task in_progress', (await taskStatus(flowTask, dev.id, 'in_progress')).status])
    steps.push(['task completed', (await taskStatus(flowTask, dev.id, 'completed')).status])
    steps.push(['qa', (await api('PATCH', `/bugs/${id}/status`, qc.id, { status: 'qa_verification' })).status])
    steps.push(['closed', (await api('PATCH', `/bugs/${id}/status`, qc.id, { status: 'closed' })).status])
    for (const [name, status] of steps) {
      check(`acceptance flow: ${name}`, status === 200 || status === 201, `got ${status}`)
    }

    const final = await api('GET', `/bugs/${id}`, admin.id)
    check('bug ends Closed', final.data?.status === 'closed', `got ${final.data?.status}`)
    check('closed_at stamped', Boolean(final.data?.closedAt))
    check('SLA recorded as resolved within target',
      final.data?.sla?.status === 'resolved_within_sla', `got ${final.data?.sla?.status}`)
    const t = (await work.query('SELECT status FROM tasks WHERE id = $1', [flowTask])).rows[0]
    check('task ends Completed', t?.status === 'completed')

    const timeline = final.data?.activity?.map((a) => a.action) || []
    for (const action of ['BUG_CREATED', 'BUG_ASSIGNED', 'BUG_TASK_CREATED', 'BUG_COMMENT_ADDED', 'BUG_STATUS_CHANGED', 'BUG_CLOSED']) {
      check(`timeline contains ${action}`, timeline.includes(action), `have ${timeline.join(',')}`)
    }

    const closeNotif = await notify.query(
      `SELECT link_to FROM notifications WHERE user_id = $1 AND type = 'bug_closed' ORDER BY created_at DESC LIMIT 1`,
      [dev.id]
    )
    check('developer told it closed, linked to their task', closeNotif.rows[0]?.link_to === `/tasks/${flowTask}`)

    check('qc cannot delete a bug', (await api('DELETE', `/bugs/${id}`, qc.id)).status === 403)
    const byAdminDelete = await api('DELETE', `/bugs/${id}`, admin.id)
    check('admin can delete a bug', byAdminDelete.status === 200, `got ${byAdminDelete.status}`)

    const cascaded = await defects.query('SELECT COUNT(*)::int c FROM bug_comments WHERE bug_id = $1', [id])
    check('comments cascade with the bug', cascaded.rows[0].c === 0)
    created.bugs = created.bugs.filter((b) => b !== id)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${pass} passed, ${fail} failed`)
  if (failures.length) {
    console.log('\n  Failures:')
    for (const f of failures) console.log(`    - ${f}`)
  }
  console.log(`${'─'.repeat(60)}\n`)
}

main()
  .catch((err) => {
    console.error('\nTest run crashed:', err)
    fail += 1
  })
  .finally(async () => {
    // Fixture cleanup — always runs, even after a crash.
    try {
      for (const id of created.bugs) {
        await defects.query('DELETE FROM bugs WHERE id = $1', [id]).catch(() => {})
      }
      for (const id of created.tasks) {
        await work.query('DELETE FROM tasks WHERE id = $1', [id]).catch(() => {})
      }
      for (const id of created.projects) {
        await work.query('DELETE FROM tasks WHERE project_id = $1', [id]).catch(() => {})
        await work.query('DELETE FROM projects WHERE id = $1', [id]).catch(() => {})
      }
      await notify.query(`DELETE FROM notifications WHERE message LIKE '%ZZ %'`).catch(() => {})
      await notify.query('DELETE FROM notifications WHERE user_id = ANY($1)', [created.users]).catch(() => {})
      await identity.query('DELETE FROM users WHERE id = ANY($1)', [created.users]).catch(() => {})
    } finally {
      await endAll()
      process.exit(fail > 0 ? 1 : 0)
    }
  })
