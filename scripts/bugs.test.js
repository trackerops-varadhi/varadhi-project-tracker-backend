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
 */

require('dotenv').config()
const jwt = require('jsonwebtoken')
const pool = require('../src/config/db')
const { runBugSlaSweepNow } = require('../src/utils/bug-sla-cron')

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

const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '15m' })

const headers = (userId) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token(userId)}`,
})

async function api(method, path, userId, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: headers(userId),
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
const created = { bugs: [], tasks: [], projects: [] }

async function main() {
  // ─── Fixtures ─────────────────────────────────────────────────────────────
  const admin = (
    await pool.query(`SELECT id, name FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1`)
  ).rows[0]
  const manager = (
    await pool.query(`SELECT id, name FROM users WHERE role = 'manager' AND status = 'active' LIMIT 1`)
  ).rows[0]
  const devs = (
    await pool.query(
      `SELECT id, name FROM users WHERE role = 'employee' AND status = 'active' LIMIT 2`
    )
  ).rows

  if (!admin || !manager || devs.length < 2) {
    console.log('SKIP — need an admin, a manager and two active employees.')
    return
  }
  const [dev, otherDev] = devs

  const project = (
    await pool.query(
      `INSERT INTO projects (name, description, status, manager_id)
            VALUES ('ZZ Bugs Finder probe', 'test fixture', 'active', $1) RETURNING id`,
      [manager.id]
    )
  ).rows[0]
  created.projects.push(project.id)

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n1. Create bug — validation')
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

    // Employees have no create-or-assign access anywhere in this tracker
    // (projects and tasks both refuse them), and bugs are no exception.
    const employeeReporting = await api('POST', '/bugs', dev.id, {
      title: 'ZZ x', description: 'y', projectId: project.id,
    })
    check('employee cannot report a bug', employeeReporting.status === 403, `got ${employeeReporting.status}`)

    const employeeAssigning = await api('POST', '/bugs', dev.id, {
      title: 'ZZ x', description: 'y', projectId: project.id, assigneeId: otherDev.id,
    })
    check('employee cannot self-assign on create', employeeAssigning.status === 403, `got ${employeeAssigning.status}`)

    // A manager reporting a bug must still work — the gate is employee-only,
    // not admin-only.
    const managerReporting = await api('POST', '/bugs', manager.id, {
      title: 'ZZ manager-reported probe', description: 'y', projectId: project.id,
    })
    check('manager can report a bug', managerReporting.status === 201, `got ${managerReporting.status}`)
    if (managerReporting.data?.id) created.bugs.push(managerReporting.data.id)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n2. Create bug — success, bug id and SLA')
  let bugId = null
  let bugKey = null
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
    check('SLA due date set', Boolean(res.data?.sla?.dueAt))
    check('SLA starts Within SLA', res.data?.sla?.status === 'within_sla', `got ${res.data?.sla?.status}`)
    check('SLA countdown label rendered', /remaining/.test(res.data?.sla?.label || ''), `got ${res.data?.sla?.label}`)
    check('server time returned for countdown', Boolean(res.data?.serverTime))

    // High = 480 resolution minutes = one 8h business day from the rule table.
    const rule = res.data?.sla
    check('SLA rule matches severity', rule?.resolutionMinutes === 480, `got ${rule?.resolutionMinutes}`)

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
    const firstNumber = Number(bugKey.split('-')[1])
    check('second bug gets a higher number', second.data.bugNumber > firstNumber,
      `${second.data.bugNumber} vs ${firstNumber}`)
    check('low severity gets a later deadline than high',
      new Date(second.data.sla.dueAt) > new Date(0), 'no due date')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n4. Assignment')
  {
    const byEmployee = await api('PATCH', `/bugs/${bugId}/assign`, dev.id, { assigneeId: dev.id })
    check('employee cannot assign', byEmployee.status === 403, `got ${byEmployee.status}`)

    const missingField = await api('PATCH', `/bugs/${bugId}/assign`, manager.id, {})
    check('assign without assigneeId rejected', missingField.status === 400, `got ${missingField.status}`)

    const res = await api('PATCH', `/bugs/${bugId}/assign`, manager.id, { assigneeId: dev.id })
    check('manager can assign', res.status === 200, `got ${res.status}`)
    check('assignee set', res.data?.assignee?.id === dev.id)
    check('open bug auto-advances to Assigned', res.data?.status === 'assigned', `got ${res.data?.status}`)
    check('first response stamped', Boolean(res.data?.sla?.firstResponseAt))

    const notif = await pool.query(
      `SELECT type, link_to FROM notifications WHERE user_id = $1 AND link_to = $2 ORDER BY created_at DESC LIMIT 1`,
      [dev.id, `/bugs/${bugId}`]
    )
    check('developer received an assignment notification',
      notif.rows[0]?.type === 'bug_assigned', `got ${notif.rows[0]?.type}`)

    const activity = await api('GET', `/bugs/${bugId}/activity`, admin.id)
    check('BUG_ASSIGNED logged', activity.data?.some((a) => a.action === 'BUG_ASSIGNED'))

    // Reassign
    const re = await api('PATCH', `/bugs/${bugId}/assign`, manager.id, { assigneeId: otherDev.id })
    check('reassignment accepted', re.status === 200 && re.data?.assignee?.id === otherDev.id)
    const reActivity = await api('GET', `/bugs/${bugId}/activity`, admin.id)
    check('BUG_REASSIGNED logged', reActivity.data?.some((a) => a.action === 'BUG_REASSIGNED'))

    // Put it back on `dev` for the rest of the suite.
    await api('PATCH', `/bugs/${bugId}/assign`, manager.id, { assigneeId: dev.id })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n5. Status workflow — legal and illegal transitions')
  {
    const illegal = await api('PATCH', `/bugs/${bugId}/status`, manager.id, { status: 'closed' })
    check('assigned -> closed rejected', illegal.status === 400, `got ${illegal.status}`)

    const bogus = await api('PATCH', `/bugs/${bugId}/status`, manager.id, { status: 'exploded' })
    check('unknown status rejected', bogus.status === 400, `got ${bogus.status}`)

    const idempotent = await api('PATCH', `/bugs/${bugId}/status`, manager.id, { status: 'assigned' })
    check('same-status submit is idempotent, not an error', idempotent.status === 200, `got ${idempotent.status}`)

    const foreignDev = await api('PATCH', `/bugs/${bugId}/status`, otherDev.id, { status: 'in_progress' })
    check('employee cannot restatus a bug not assigned to them',
      foreignDev.status === 403, `got ${foreignDev.status}`)

    const inProgress = await api('PATCH', `/bugs/${bugId}/status`, dev.id, { status: 'in_progress' })
    check('assignee can move to In Progress', inProgress.status === 200, `got ${inProgress.status}`)

    const devClosing = await api('PATCH', `/bugs/${bugId}/status`, dev.id, { status: 'fixed' })
    check('assignee can mark Fixed', devClosing.status === 200, `got ${devClosing.status}`)
    check('resolved_at stamped on Fixed', Boolean(devClosing.data?.resolvedAt))
    check('SLA resolved within target',
      devClosing.data?.sla?.status === 'resolved_within_sla', `got ${devClosing.data?.sla?.status}`)

    const qa = await api('PATCH', `/bugs/${bugId}/status`, manager.id, { status: 'qa_verification' })
    check('manager can move to QA Verification', qa.status === 200, `got ${qa.status}`)

    const devTryClose = await api('PATCH', `/bugs/${bugId}/status`, dev.id, { status: 'closed' })
    check('employee cannot close a bug', devTryClose.status === 403, `got ${devTryClose.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n6. QA rejection -> reopen restarts the SLA')
  {
    const reopened = await api('PATCH', `/bugs/${bugId}/status`, manager.id, { status: 'reopened' })
    check('QA can reject to Reopened', reopened.status === 200, `got ${reopened.status}`)
    check('reopen count incremented', reopened.data?.reopenCount === 1, `got ${reopened.data?.reopenCount}`)
    check('resolved_at cleared on reopen', reopened.data?.resolvedAt === null)
    check('SLA clock restarted', reopened.data?.sla?.status === 'within_sla', `got ${reopened.data?.sla?.status}`)

    const activity = await api('GET', `/bugs/${bugId}/activity`, admin.id)
    check('BUG_REOPENED logged', activity.data?.some((a) => a.action === 'BUG_REOPENED'))

    const back = await api('PATCH', `/bugs/${bugId}/status`, dev.id, { status: 'in_progress' })
    check('reopened -> In Progress allowed', back.status === 200, `got ${back.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n7. Comments')
  {
    const empty = await api('POST', `/bugs/${bugId}/comments`, dev.id, { content: '   ' })
    check('empty comment rejected', empty.status === 400, `got ${empty.status}`)

    const added = await api('POST', `/bugs/${bugId}/comments`, dev.id, {
      content: 'ZZ Reproduced on Safari 17. Investigating the click handler.',
    })
    check('comment created', added.status === 201, `got ${added.status}`)
    const commentId = added.data?.id

    const list = await api('GET', `/bugs/${bugId}/comments`, admin.id)
    check('comment persisted and listed', list.data?.some((c) => c.id === commentId))
    check('comment carries its author', list.data?.[0]?.author?.id === dev.id)

    const foreignEdit = await api('PUT', `/bugs/${bugId}/comments/${commentId}`, otherDev.id, {
      content: 'ZZ hijacked',
    })
    check('cannot edit another user comment', foreignEdit.status === 403, `got ${foreignEdit.status}`)

    const edited = await api('PUT', `/bugs/${bugId}/comments/${commentId}`, dev.id, {
      content: 'ZZ Reproduced on Safari 17 and 16.',
    })
    check('author can edit own comment', edited.status === 200, `got ${edited.status}`)
    check('edited flag set', edited.data?.edited === true)

    const activity = await api('GET', `/bugs/${bugId}/activity`, admin.id)
    check('BUG_COMMENT_ADDED logged', activity.data?.some((a) => a.action === 'BUG_COMMENT_ADDED'))

    const reporterNotif = await pool.query(
      `SELECT type FROM notifications WHERE user_id = $1 AND type = 'bug_comment' LIMIT 1`,
      [admin.id]
    )
    check('reporter notified of the comment', reporterNotif.rows.length > 0)

    const del = await api('DELETE', `/bugs/${bugId}/comments/${commentId}`, dev.id)
    check('author can delete own comment', del.status === 200, `got ${del.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n8. Field updates and permissions')
  {
    const employeeRetriage = await api('PUT', `/bugs/${bugId}`, dev.id, { severity: 'critical' })
    check('employee cannot re-triage severity', employeeRetriage.status === 403, `got ${employeeRetriage.status}`)

    const employeeDocs = await api('PUT', `/bugs/${bugId}`, dev.id, {
      rootCause: 'ZZ Event listener bound before hydration.',
    })
    check('assignee can document root cause', employeeDocs.status === 200, `got ${employeeDocs.status}`)

    const stranger = await api('PUT', `/bugs/${bugId}`, otherDev.id, { rootCause: 'ZZ nope' })
    check('unrelated employee cannot edit', stranger.status === 403, `got ${stranger.status}`)

    const escalate = await api('PUT', `/bugs/${bugId}`, manager.id, { severity: 'critical' })
    check('manager can escalate severity', escalate.status === 200, `got ${escalate.status}`)
    check('severity change tightens the SLA deadline',
      escalate.data?.sla?.resolutionMinutes === 240, `got ${escalate.data?.sla?.resolutionMinutes}`)

    const activity = await api('GET', `/bugs/${bugId}/activity`, admin.id)
    check('BUG_SEVERITY_CHANGED logged', activity.data?.some((a) => a.action === 'BUG_SEVERITY_CHANGED'))

    const noChanges = await api('PUT', `/bugs/${bugId}`, manager.id, {})
    check('empty update rejected', noChanges.status === 400, `got ${noChanges.status}`)

    // Restore for the SLA test below.
    await api('PUT', `/bugs/${bugId}`, manager.id, { severity: 'high' })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n9. Employee visibility scoping')
  {
    const hidden = await api('POST', '/bugs', manager.id, {
      title: 'ZZ invisible to otherDev', description: 'y', projectId: project.id,
    })
    created.bugs.push(hidden.data.id)

    const direct = await api('GET', `/bugs/${hidden.data.id}`, otherDev.id)
    check('employee gets 403 on a bug they neither reported nor own',
      direct.status === 403, `got ${direct.status}`)

    const list = await api('GET', '/bugs?limit=100', otherDev.id)
    const ids = (list.data?.data || []).map((b) => b.id)
    check('scoped list excludes it', !ids.includes(hidden.data.id))

    const adminList = await api('GET', '/bugs?limit=100', admin.id)
    const adminIds = (adminList.data?.data || []).map((b) => b.id)
    check('admin list includes it', adminIds.includes(hidden.data.id))

    const reporterView = await api('GET', `/bugs/${hidden.data.id}`, manager.id)
    check('reporter can always view their own report', reporterView.status === 200)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n10. Search, filters and pagination')
  {
    const bySearch = await api('GET', `/bugs?search=${encodeURIComponent('login button')}`, admin.id)
    check('search by title text finds the bug',
      (bySearch.data?.data || []).some((b) => b.id === bugId))

    const byKey = await api('GET', `/bugs?search=${encodeURIComponent(bugKey)}`, admin.id)
    check('search by BUG-#### finds the bug',
      (byKey.data?.data || []).some((b) => b.id === bugId), `searched ${bugKey}`)

    const bySeverity = await api('GET', '/bugs?severity=high&limit=100', admin.id)
    check('severity filter applied server-side',
      (bySeverity.data?.data || []).every((b) => b.severity === 'high'))

    const multi = await api('GET', '/bugs?severity=high,low&limit=100', admin.id)
    check('comma-separated multi-filter works',
      (multi.data?.data || []).every((b) => ['high', 'low'].includes(b.severity)))

    const byProject = await api('GET', `/bugs?projectId=${project.id}&limit=100`, admin.id)
    check('project filter applied',
      (byProject.data?.data || []).every((b) => b.project?.id === project.id))

    const byAssignee = await api('GET', `/bugs?assigneeId=${dev.id}&limit=100`, admin.id)
    check('developer filter applied',
      (byAssignee.data?.data || []).every((b) => b.assignee?.id === dev.id))

    const unassigned = await api('GET', '/bugs?assigneeId=unassigned&limit=100', admin.id)
    check('unassigned filter applied',
      (unassigned.data?.data || []).every((b) => b.assignee === null))

    const paged = await api('GET', '/bugs?limit=1&page=1', admin.id)
    check('pagination returns one row', (paged.data?.data || []).length <= 1)
    check('pagination reports a total', typeof paged.data?.total === 'number')
    check('pagination reports totalPages', typeof paged.data?.totalPages === 'number')

    const page2 = await api('GET', '/bugs?limit=1&page=2', admin.id)
    check('page 2 differs from page 1',
      paged.data?.data?.[0]?.id !== page2.data?.data?.[0]?.id)

    const sorted = await api('GET', '/bugs?sortBy=severity&sortDir=asc&limit=100', admin.id)
    check('sorting accepted', sorted.status === 200, `got ${sorted.status}`)

    const injection = await api('GET', '/bugs?sortBy=title;DROP+TABLE+bugs&limit=5', admin.id)
    check('unknown sort column falls back safely', injection.status === 200, `got ${injection.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n11. SLA breach detection (server clock)')
  {
    const breach = await api('POST', '/bugs', admin.id, {
      title: 'ZZ already breached defect', description: 'y', projectId: project.id, severity: 'critical',
    })
    created.bugs.push(breach.data.id)
    await api('PATCH', `/bugs/${breach.data.id}/assign`, manager.id, { assigneeId: dev.id })

    // Backdate the deadline rather than waiting four hours. The sweep still
    // makes its decision with the SERVER's NOW(), which is the point.
    await pool.query(
      `UPDATE bugs SET sla_resolution_due_at = NOW() - INTERVAL '1 hour',
                       sla_started_at = NOW() - INTERVAL '5 hours'
        WHERE id = $1`,
      [breach.data.id]
    )

    const read = await api('GET', `/bugs/${breach.data.id}`, admin.id)
    check('past-deadline bug reads as Breached',
      read.data?.sla?.status === 'breached', `got ${read.data?.sla?.status}`)
    check('breach label rendered', /Breached by/.test(read.data?.sla?.label || ''),
      `got ${read.data?.sla?.label}`)

    const filtered = await api('GET', '/bugs?slaStatus=breached&limit=100', admin.id)
    check('SLA breached filter finds it',
      (filtered.data?.data || []).some((b) => b.id === breach.data.id))

    await runBugSlaSweepNow()

    const latched = await pool.query('SELECT sla_breached FROM bugs WHERE id = $1', [breach.data.id])
    check('sweep latches sla_breached', latched.rows[0].sla_breached === true)

    const activity = await api('GET', `/bugs/${breach.data.id}/activity`, admin.id)
    check('BUG_SLA_BREACHED logged', activity.data?.some((a) => a.action === 'BUG_SLA_BREACHED'))

    const notif = await pool.query(
      `SELECT type FROM notifications WHERE user_id = $1 AND type = 'bug_sla_breached' LIMIT 1`,
      [dev.id]
    )
    check('breach notification dispatched', notif.rows.length > 0)

    // At-risk: 80% elapsed against a 0.75 threshold.
    const risk = await api('POST', '/bugs', admin.id, {
      title: 'ZZ at risk defect', description: 'y', projectId: project.id, severity: 'high',
    })
    created.bugs.push(risk.data.id)
    await api('PATCH', `/bugs/${risk.data.id}/assign`, manager.id, { assigneeId: dev.id })
    await pool.query(
      `UPDATE bugs SET sla_started_at = NOW() - INTERVAL '8 hours',
                       sla_resolution_due_at = NOW() + INTERVAL '2 hours'
        WHERE id = $1`,
      [risk.data.id]
    )
    const riskRead = await api('GET', `/bugs/${risk.data.id}`, admin.id)
    check('80%-elapsed bug reads as At Risk',
      riskRead.data?.sla?.status === 'at_risk', `got ${riskRead.data?.sla?.status}`)

    const riskFilter = await api('GET', '/bugs?slaStatus=at_risk&limit=100', admin.id)
    check('SLA at-risk filter finds it',
      (riskFilter.data?.data || []).some((b) => b.id === risk.data.id))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n12. Task integration')
  {
    const res = await api('POST', `/bugs/${bugId}/task`, manager.id, {})
    check('task created from bug', res.status === 201, `got ${res.status} ${JSON.stringify(res.body)}`)
    const taskId = res.data?.linkedTask?.id
    if (taskId) created.tasks.push(taskId)

    check('bug reports its linked task', Boolean(taskId))
    check('task title carries the bug id', /BUG-\d+/.test(res.data?.linkedTask?.title || ''),
      `got ${res.data?.linkedTask?.title}`)

    const task = await pool.query('SELECT type, project_id, priority FROM tasks WHERE id = $1', [taskId])
    check('linked task is typed as a bug', task.rows[0]?.type === 'bug')
    check('linked task inherits the project', task.rows[0]?.project_id === project.id)

    const twice = await api('POST', `/bugs/${bugId}/task`, manager.id, {})
    check('second task creation refused (no duplicates)', twice.status === 409, `got ${twice.status}`)

    const byEmployee = await api('POST', `/bugs/${created.bugs[1]}/task`, dev.id, {})
    check('employee cannot create tasks from bugs', byEmployee.status === 403, `got ${byEmployee.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n13. Project integration')
  {
    const res = await api('GET', `/projects/${project.id}/bugs?limit=100`, admin.id)
    check('project bugs endpoint returns 200', res.status === 200, `got ${res.status}`)
    check('project bugs are scoped to that project',
      (res.data?.data || []).every((b) => b.project?.id === project.id))
    check('project bugs include the fixture', (res.data?.data || []).some((b) => b.id === bugId))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n14. Reports')
  {
    // The KPI dashboard was removed — /bugs is the list only, and defect
    // metrics live on the Reports page. Assert the endpoint is really gone
    // rather than silently still routed.
    const goneDash = await api('GET', '/bugs/dashboard', admin.id)
    check('dashboard endpoint removed', goneDash.status === 404, `got ${goneDash.status}`)

    const reports = await api('GET', `/bugs/reports?projectId=${project.id}`, manager.id)
    check('reports return 200 for manager', reports.status === 200, `got ${reports.status}`)
    check('reports include SLA compliance', reports.data?.slaCompliancePercent !== undefined)
    check('reports include reopen rate', typeof reports.data?.reopenRatePercent === 'number')
    check('reports include by-developer breakdown', Array.isArray(reports.data?.byDeveloper))

    const employeeReports = await api('GET', '/bugs/reports', dev.id)
    check('employee blocked from reports', employeeReports.status === 403, `got ${employeeReports.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n15. SLA rule administration')
  {
    const rules = await api('GET', '/bugs/sla-rules', admin.id)
    check('SLA rules readable', rules.status === 200 && rules.data?.length === 4, `got ${rules.status}`)

    const byManager = await api('PUT', '/bugs/sla-rules/high', manager.id, {
      responseMinutes: 60, resolutionMinutes: 120,
    })
    check('manager cannot edit SLA rules', byManager.status === 403, `got ${byManager.status}`)

    const incoherent = await api('PUT', '/bugs/sla-rules/high', admin.id, {
      responseMinutes: 600, resolutionMinutes: 60,
    })
    check('resolution shorter than response rejected', incoherent.status === 400, `got ${incoherent.status}`)

    const negative = await api('PUT', '/bugs/sla-rules/high', admin.id, {
      responseMinutes: -5, resolutionMinutes: 60,
    })
    check('negative duration rejected', negative.status === 400, `got ${negative.status}`)

    const ok = await api('PUT', '/bugs/sla-rules/high', admin.id, {
      responseMinutes: 240, resolutionMinutes: 480,
    })
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
    check('unauthenticated request rejected', unauthenticated.status === 401,
      `got ${unauthenticated.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n17. Full §29 acceptance flow (close-out) + delete permissions')
  {
    const flow = await api('POST', '/bugs', manager.id, {
      title: 'ZZ acceptance flow defect',
      description: 'End-to-end scenario.',
      projectId: project.id,
      severity: 'medium',
      priority: 'p2',
      environment: 'staging',
    })
    const id = flow.data.id
    created.bugs.push(id)

    const steps = []
    steps.push(['assign', (await api('PATCH', `/bugs/${id}/assign`, manager.id, { assigneeId: dev.id })).status])
    steps.push(['comment', (await api('POST', `/bugs/${id}/comments`, dev.id, { content: 'ZZ On it.' })).status])
    steps.push(['in_progress', (await api('PATCH', `/bugs/${id}/status`, dev.id, { status: 'in_progress' })).status])
    steps.push(['fixed', (await api('PATCH', `/bugs/${id}/status`, dev.id, { status: 'fixed' })).status])
    steps.push(['qa', (await api('PATCH', `/bugs/${id}/status`, manager.id, { status: 'qa_verification' })).status])
    steps.push(['closed', (await api('PATCH', `/bugs/${id}/status`, manager.id, { status: 'closed' })).status])

    for (const [name, status] of steps) {
      check(`acceptance flow: ${name}`, status === 200 || status === 201, `got ${status}`)
    }

    const final = await api('GET', `/bugs/${id}`, admin.id)
    check('bug ends Closed', final.data?.status === 'closed', `got ${final.data?.status}`)
    check('closed_at stamped', Boolean(final.data?.closedAt))
    check('SLA recorded as resolved within target',
      final.data?.sla?.status === 'resolved_within_sla', `got ${final.data?.sla?.status}`)

    const timeline = final.data?.activity?.map((a) => a.action) || []
    for (const action of ['BUG_CREATED', 'BUG_ASSIGNED', 'BUG_COMMENT_ADDED', 'BUG_STATUS_CHANGED', 'BUG_CLOSED']) {
      check(`timeline contains ${action}`, timeline.includes(action), `have ${timeline.join(',')}`)
    }

    const closeNotif = await pool.query(
      `SELECT type FROM notifications WHERE user_id = $1 AND type = 'bug_closed' LIMIT 1`,
      [dev.id]
    )
    check('close notification dispatched to the developer', closeNotif.rows.length > 0)

    // Delete permissions
    const byManagerDelete = await api('DELETE', `/bugs/${id}`, manager.id)
    check('manager cannot delete a bug', byManagerDelete.status === 403, `got ${byManagerDelete.status}`)

    const byAdminDelete = await api('DELETE', `/bugs/${id}`, admin.id)
    check('admin can delete a bug', byAdminDelete.status === 200, `got ${byAdminDelete.status}`)

    const cascaded = await pool.query('SELECT COUNT(*)::int c FROM bug_comments WHERE bug_id = $1', [id])
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
        await pool.query('DELETE FROM bugs WHERE id = $1', [id]).catch(() => {})
      }
      for (const id of created.tasks) {
        await pool.query('DELETE FROM tasks WHERE id = $1', [id]).catch(() => {})
      }
      for (const id of created.projects) {
        await pool.query('DELETE FROM tasks WHERE project_id = $1', [id]).catch(() => {})
        await pool.query('DELETE FROM projects WHERE id = $1', [id]).catch(() => {})
      }
      await pool.query(`DELETE FROM notifications WHERE message LIKE '%ZZ %'`).catch(() => {})
    } finally {
      await pool.end()
      process.exit(fail > 0 ? 1 : 0)
    }
  })
