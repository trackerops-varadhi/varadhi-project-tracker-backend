/*
 * Workforce (leave + time, Module 9 Phase 3) integration tests — the first
 * automated coverage workforce has had (docs/Module-9-People-Plan.md §6).
 *
 * Runs against the real database and the live API on :5000. Creates its own
 * zz-workforce-*@varadhi.test users (one hr, two employees, one of whom reports
 * to the other through a people profile) and removes everything in .finally().
 *
 *   npm run test:workforce
 *
 * Sections:
 *   1 planned / unplanned / late notice   2 approve, reject, cancel
 *   3 absence calendar                    4 balances + entitlements
 *   5 daily work status                   6 attendance register
 *   7 nudge + escalation sweeps
 */

require('dotenv').config()
const { identity, people, notify, workforce, endAll } = require('./test-pools')
const { authHeaders } = require('./test-auth')

const API = process.env.TEST_API_BASE || 'http://127.0.0.1:5000/api'
const TZ = process.env.BUSINESS_TZ || 'Asia/Kolkata'
const STAMP = Date.now().toString(36)

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

async function api(method, path, userId, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: await authHeaders(userId, { 'user-agent': 'ZZ workforce.test.js' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* empty body */ }
  return { status: res.status, body: json, data: json?.data }
}

const todayIn = (timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const isWeekend = (ymd) => [0, 6].includes(new Date(`${ymd}T00:00:00Z`).getUTCDay())
const prevWorkingDay = (ymd) => {
  let d = addDays(ymd, -1)
  while (isWeekend(d)) d = addDays(d, -1)
  return d
}

const created = { users: [] }
const makeUser = async (label, role) => {
  const { rows: [u] } = await identity.query(
    `INSERT INTO users (name, email, role, status) VALUES ($1, $2, $3, 'active') RETURNING id, name`,
    [`ZZ Workforce ${label} ${STAMP}`, `zz-workforce-${label}-${STAMP}@varadhi.test`, role]
  )
  created.users.push(u.id)
  return u
}

async function main() {
  const today = todayIn(TZ)
  const year = Number(today.slice(0, 4))
  const admin = (await identity.query(
    `SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1`)).rows[0]
  const manager = (await identity.query(
    `SELECT id FROM users WHERE role = 'manager' AND status = 'active' ORDER BY created_at LIMIT 1`)).rows[0]
  if (!admin || !manager) { console.log('SKIP — need an active admin and manager.'); return }

  const hr = await makeUser('hr', 'hr')
  const lead = await makeUser('lead', 'employee')
  const emp = await makeUser('emp', 'employee')
  // emp reports to lead, so late-notice and escalation have a recipient.
  await people.query(
    `INSERT INTO employee_profiles (user_id, designation, reporting_manager_id) VALUES ($1, 'ZZ Dev', $2)`,
    [emp.id, lead.id])

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n1. Planned / unplanned / late notice')
  const leaveBody = (start, extra = {}) => ({
    startDate: start, endDate: start, type: 'casual', reason: 'ZZ workforce test', ...extra,
  })
  let plannedId
  let lateId
  {
    const far = await api('POST', '/leave-management', emp.id, leaveBody(addDays(today, 20)))
    check('future leave defaults to planned', far.status === 201 && far.data?.planningType === 'planned', `got ${far.status} ${far.data?.planningType}`)
    check('notice days stored', far.data?.noticeDays === 20, `${far.data?.noticeDays}`)
    check('20 days notice is not late', far.data?.isLateNotice === false)
    plannedId = far.data?.id

    const late = await api('POST', '/leave-management', emp.id, leaveBody(addDays(today, 3), { planningType: 'planned' }))
    check('planned with 3 days notice is late', late.data?.isLateNotice === true, JSON.stringify(late.body)?.slice(0, 160))
    lateId = late.data?.id
    // Late-notice dispatch is fire-and-forget; give it a moment.
    await new Promise((r) => { setTimeout(r, 1500) })
    const { rows: [n] } = await notify.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'leave_late_notice'`, [lead.id])
    check('reporting manager told about the short notice', n.n >= 1)

    const same = await api('POST', '/leave-management', emp.id, leaveBody(today, { planningType: 'planned' }))
    check('leave starting today is forced to unplanned', same.data?.planningType === 'unplanned')

    const sudden = await api('POST', '/leave-management', emp.id, leaveBody(addDays(today, 2), { planningType: 'unplanned' }))
    check('future leave can be declared unplanned', sudden.data?.planningType === 'unplanned' && sudden.data?.isLateNotice === false)

    const bad = await api('POST', '/leave-management', emp.id, leaveBody(addDays(today, 5), { planningType: 'maybe' }))
    check('unknown planning type → 400', bad.status === 400)
  }

  console.log('\n2. Approve, reject, cancel')
  {
    const hrApprove = await api('PATCH', `/leave-management/${plannedId}/status`, hr.id, { status: 'approved' })
    check('hr cannot approve (403)', hrApprove.status === 403)
    const other = await api('PATCH', `/leave-management/${plannedId}/cancel`, lead.id)
    check('cannot cancel someone else\'s leave (403)', other.status === 403)
    const cancel = await api('PATCH', `/leave-management/${lateId}/cancel`, emp.id)
    check('owner cancels a pending request', cancel.status === 200 && cancel.data?.status === 'cancelled')
    check('cancelledAt recorded', Boolean(cancel.data?.cancelledAt))
    const approveCancelled = await api('PATCH', `/leave-management/${lateId}/status`, manager.id, { status: 'approved' })
    check('a cancelled request cannot be approved (409)', approveCancelled.status === 409, `got ${approveCancelled.status}`)
    const ok = await api('PATCH', `/leave-management/${plannedId}/status`, manager.id, { status: 'approved' })
    check('manager approves', ok.status === 200 && ok.data?.status === 'approved')
    check('approver and time recorded', ok.data?.approver?.id === manager.id && Boolean(ok.data?.approvedAt))
    const cancelApproved = await api('PATCH', `/leave-management/${plannedId}/cancel`, emp.id)
    check('an approved request cannot be cancelled (409)', cancelApproved.status === 409)
    const hrList = await api('GET', '/leave-management', hr.id)
    check('hr sees other people\'s requests', hrList.data?.some((l) => l.userId === emp.id))
    const empList = await api('GET', '/leave-management', lead.id)
    check('an employee sees only their own', !empList.data?.some((l) => l.userId === emp.id))
  }

  console.log('\n3. Absence calendar')
  {
    const from = addDays(today, 19)
    const cal = await api('GET', `/leave-management/calendar?from=${from}&to=${addDays(today, 21)}`, lead.id)
    check('every role can read the calendar', cal.status === 200)
    check('shows the approved absence', cal.data?.items?.some((i) => i.userId === emp.id && i.status === 'approved'))
    check('carries no reason text', !JSON.stringify(cal.body).includes('ZZ workforce test'))
    check('range over 92 days → 400', (await api('GET', `/leave-management/calendar?from=${today}&to=${addDays(today, 120)}`, lead.id)).status === 400)
    check('reversed range → 400', (await api('GET', `/leave-management/calendar?from=${today}&to=${addDays(today, -1)}`, lead.id)).status === 400)
  }

  console.log('\n4. Balances + entitlements')
  {
    const put = await api('PUT', '/leave-management/balances', hr.id, {
      userId: emp.id, year, leaveType: 'casual', entitled: 12, carriedForward: 1.5,
    })
    check('hr sets an entitlement', put.status === 200, `got ${put.status} ${put.body?.message}`)
    check('manager cannot set entitlements (403)', (await api('PUT', '/leave-management/balances', manager.id, {
      userId: emp.id, year, leaveType: 'casual', entitled: 99,
    })).status === 403)
    check('quarter days rejected', (await api('PUT', '/leave-management/balances', hr.id, {
      userId: emp.id, year, leaveType: 'casual', entitled: 1.25,
    })).status === 400)
    const own = await api('GET', `/leave-management/balances?year=${year}`, emp.id)
    const casual = own.data?.types?.find((t) => t.leaveType === 'casual')
    const startYear = Number(addDays(today, 20).slice(0, 4))
    if (startYear === year) {
      check('used counts the approved day', casual?.used === 1, JSON.stringify(casual))
      check('remaining = entitled + carried − used', casual?.remaining === 12.5, JSON.stringify(casual))
    } else {
      check('entitlement visible', casual?.entitled === 12)
    }
    check('employee cannot read another person\'s balance (403)',
      (await api('GET', `/leave-management/balances?userId=${emp.id}`, lead.id)).status === 403)
    const team = await api('GET', `/leave-management/balances?scope=team&year=${year}`, hr.id)
    check('hr reads team balances', team.status === 200 && team.data?.items?.some((i) => i.userId === emp.id))
    check('employee cannot read team balances (403)',
      (await api('GET', '/leave-management/balances?scope=team', emp.id)).status === 403)
  }

  console.log('\n5. Daily work status')
  {
    const post = await api('POST', '/time-management/work-status', emp.id, {
      summary: 'ZZ built the thing', blockers: 'ZZ none', tomorrowPlan: 'ZZ test it',
    })
    check('submit today (201)', post.status === 201 && post.data?.date === today, `got ${post.status} ${post.body?.message}`)
    const again = await api('POST', '/time-management/work-status', emp.id, { summary: 'ZZ updated summary' })
    check('same day upserts', again.data?.id === post.data?.id && again.data?.summary === 'ZZ updated summary')
    check('empty summary → 400', (await api('POST', '/time-management/work-status', emp.id, { summary: ' ' })).status === 400)
    check('future date → 400', (await api('POST', '/time-management/work-status', emp.id, { summary: 'x', date: addDays(today, 1) })).status === 400)
    check('older than a week → 400', (await api('POST', '/time-management/work-status', emp.id, { summary: 'x', date: addDays(today, -9) })).status === 400)
    const mine = await api('GET', '/time-management/work-status', emp.id)
    check('own status for today returned', mine.data?.today?.summary === 'ZZ updated summary')
    check('employee cannot read the team view (403)',
      (await api('GET', '/time-management/work-status/team', emp.id)).status === 403)
    const team = await api('GET', `/time-management/work-status/team?date=${today}`, manager.id)
    check('manager reads the team view', team.status === 200 &&
      team.data?.items?.find((i) => i.userId === emp.id)?.status?.summary === 'ZZ updated summary')
  }

  console.log('\n6. Attendance register')
  {
    const ci = await api('POST', '/time-management/check-in', lead.id, {
      date: today, checkIn: new Date().toISOString(), attendanceStatus: 'wfh', note: 'ZZ wfh',
    })
    check('check-in with attendance status', ci.status === 201 || ci.status === 200, `got ${ci.status} ${ci.body?.message}`)
    check('bad attendance status → 400', (await api('POST', '/time-management', lead.id, {
      date: today, hours: 1, attendanceStatus: 'sleeping',
    })).status === 400)
    check('employee cannot read attendance (403)', (await api('GET', '/time-management/attendance', emp.id)).status === 403)
    const reg = await api('GET', `/time-management/attendance?from=${today}&to=${today}`, hr.id)
    check('hr reads the register', reg.status === 200, `got ${reg.status} ${reg.body?.message}`)
    const leadDay = reg.data?.items?.find((i) => i.userId === lead.id)?.days?.[0]
    check('wfh shows as wfh', leadDay?.status === 'wfh', JSON.stringify(leadDay))
    const empDay = reg.data?.items?.find((i) => i.userId === emp.id)?.days?.[0]
    check('no log and no leave on a weekday → absent (or weekend)',
      empDay?.status === (isWeekend(today) ? 'weekend' : 'absent'), JSON.stringify(empDay))
    const leaveDay = addDays(today, 20)
    const future = await api('GET', `/time-management/attendance?from=${leaveDay}&to=${leaveDay}`, hr.id)
    const fd = future.data?.items?.find((i) => i.userId === emp.id)?.days?.[0]
    check('approved leave day → on_leave', fd?.status === 'on_leave', JSON.stringify(fd))
    check('range over 31 days → 400',
      (await api('GET', `/time-management/attendance?from=${today}&to=${addDays(today, 40)}`, hr.id)).status === 400)
  }

  console.log('\n7. Nudge + escalation sweeps')
  {
    const wf = require('../src/modules/workforce')
    // lead logged time today (check-in above) and has no status.
    if (!isWeekend(today)) {
      await wf.runWorkStatusNudgeNow()
      const { rows: [n] } = await notify.query(
        `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'work_status_missing'`, [lead.id])
      check('evening nudge reaches someone who logged time without a status', n.n >= 1)
      const { rows: [m] } = await notify.query(
        `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'work_status_missing'
            AND title = 'Daily work status'`, [emp.id])
      check('no nudge for someone who submitted', m.n === 0)
    } else {
      console.log('  SKIP  nudge — weekend')
    }
    // emp logged time on the previous working day with no status → lead escalated.
    await workforce.query(
      `INSERT INTO time_logs (user_id, date, hours, note) VALUES ($1, $2, 2, 'ZZ workforce test')`,
      [emp.id, prevWorkingDay(today)])
    await wf.runWorkStatusEscalateNow()
    const { rows: [e] } = await notify.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'work_status_missing'
          AND title = 'Work status not submitted'`, [lead.id])
    check('missing status escalates to the reporting manager', e.n >= 1)
  }
}

main()
  .catch((err) => {
    console.error('\nTest run crashed:', err)
    fail += 1
  })
  .finally(async () => {
    try {
      const ids = created.users
      await workforce.query('DELETE FROM leave_requests WHERE user_id = ANY($1)', [ids]).catch(() => {})
      await workforce.query('DELETE FROM leave_balances WHERE user_id = ANY($1)', [ids]).catch(() => {})
      await workforce.query('DELETE FROM time_logs WHERE user_id = ANY($1)', [ids]).catch(() => {})
      await workforce.query('DELETE FROM daily_work_status WHERE user_id = ANY($1)', [ids]).catch(() => {})
      await people.query('DELETE FROM employee_profiles WHERE user_id = ANY($1)', [ids]).catch(() => {})
      await notify.query('DELETE FROM notifications WHERE user_id = ANY($1)', [ids]).catch(() => {})
      await identity.query('DELETE FROM users WHERE id = ANY($1)', [ids]).catch(() => {})
    } finally {
      console.log(`\n${'─'.repeat(60)}\n  ${pass} passed, ${fail} failed`)
      for (const f of failures) console.log(`    - ${f}`)
      console.log(`${'─'.repeat(60)}\n`)
      await endAll()
      process.exit(fail > 0 ? 1 : 0)
    }
  })
