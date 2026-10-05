/*
 * People (Module 9, HR) integration tests.
 *
 * Runs against the real database and the live API on :5000, like the other
 * suites. Every row it creates is tracked by id and removed in the finally
 * block; candidates and leave/time fixtures carry a 'ZZ ' marker as well.
 *
 *   npm run test:people
 *
 * Covers: admin/manager-only access, the employee directory (user picker,
 * validation, duplicates), attrition (validation, derived status, tenure),
 * interview records (outcome rules, pipeline) and the dashboard figures
 * (headcount, presence, leave planned/unplanned, pending).
 */

require('dotenv').config()
const { identity, people, workforce, endAll } = require('./test-pools')
const { authHeaders } = require('./test-auth')

const API = process.env.TEST_API_BASE || 'http://127.0.0.1:5000/api'
const TZ = process.env.BUSINESS_TZ || 'Asia/Kolkata'

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
  const headers = userId
    ? await authHeaders(userId, { 'user-agent': 'ZZ people.test.js' })
    : { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* empty body */ }
  return { status: res.status, body: json, data: json?.data }
}

const todayIn = (timeZone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const created = { profiles: [], exits: [], candidates: [], timeLogs: [], leaves: [] }

async function main() {
  const today = todayIn(TZ)

  // ─── Fixtures ────────────────────────────────────────────────────────────
  const admin = (await identity.query(
    `SELECT id FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1`)).rows[0]
  const manager = (await identity.query(
    `SELECT id FROM users WHERE role = 'manager' AND status = 'active' LIMIT 1`)).rows[0]
  // Employees with no HR profile yet, so the suite never touches real records.
  const { rows: existing } = await people.query('SELECT user_id FROM employee_profiles')
  const taken = existing.map((r) => r.user_id)
  const employees = (await identity.query(
    `SELECT id, name, email FROM users
      WHERE role = 'employee' AND status = 'active' AND NOT (id = ANY($1::uuid[]))
      ORDER BY created_at LIMIT 2`, [taken])).rows

  if (!admin || !manager || employees.length < 2) {
    console.log('SKIP — need an admin, a manager and two active employees without an HR profile.')
    return
  }
  const [emp, leaver] = employees

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n1. Access control')
  {
    const anon = await api('GET', '/people/dashboard', null)
    check('unauthenticated → 401', anon.status === 401, `got ${anon.status}`)

    for (const path of ['/people/dashboard', '/people/employees', '/people/exits', '/people/interviews',
      '/people/employees/eligible-users']) {
      const r = await api('GET', path, emp.id)
      check(`employee GET ${path} → 403`, r.status === 403, `got ${r.status}`)
    }
    const post = await api('POST', '/people/employees', emp.id, { userId: emp.id, designation: 'x' })
    check('employee cannot create a profile (403)', post.status === 403, `got ${post.status}`)

    const mgr = await api('GET', '/people/dashboard', manager.id)
    check('manager can read the dashboard', mgr.status === 200, `got ${mgr.status}`)
  }

  console.log('\n2. Baseline dashboard')
  const base = (await api('GET', '/people/dashboard', admin.id)).data
  check('dashboard has every section',
    base && base.employees && base.attendance && base.leave && base.recruitment,
    JSON.stringify(base)?.slice(0, 120))
  check('asOf is the business-zone date', base?.asOf === today, `${base?.asOf} vs ${today}`)
  check('week is Monday..Friday',
    base?.attendance?.week?.map((d) => d.day).join(',') === 'Mon,Tue,Wed,Thu,Fri')
  check('pipeline lists all ten candidate statuses',
    Object.keys(base?.recruitment?.pipeline || {}).length === 10)

  console.log('\n3. Employee directory — user picker and validation')
  {
    const eligible = await api('GET', '/people/employees/eligible-users', admin.id)
    check('eligible users lists an unprofiled employee',
      eligible.status === 200 && eligible.data.some((u) => u.id === emp.id))

    const cases = [
      ['missing user', { designation: 'Dev' }, 400],
      ['malformed user id', { userId: 'abc', designation: 'Dev' }, 400],
      ['missing role', { userId: emp.id }, 400],
      ['bad joining date', { userId: emp.id, designation: 'Dev', dateOfJoining: '2024-02-30' }, 400],
      ['unknown user', { userId: '00000000-0000-4000-8000-000000000000', designation: 'Dev' }, 404],
      ['overlong role', { userId: emp.id, designation: 'x'.repeat(121) }, 400],
    ]
    for (const [name, body, want] of cases) {
      const r = await api('POST', '/people/employees', admin.id, body)
      check(`${name} → ${want}`, r.status === want, `got ${r.status} ${r.body?.message}`)
    }
  }

  console.log('\n4. Employee directory — create, duplicate, list')
  {
    const r = await api('POST', '/people/employees', manager.id, {
      userId: emp.id,
      designation: '  ZZ Software Engineer ',
      shift: '9:30 AM - 6:30 PM',
      product: 'Varadhi',
      coreSkills: 'React, Node.js , React,  ',
      dateOfJoining: '2024-01-15',
    })
    check('manager creates a profile (201)', r.status === 201, `got ${r.status} ${r.body?.message}`)
    if (r.data?.id) created.profiles.push(r.data.id)
    check('name and email come from the account', r.data?.name === emp.name && r.data?.email === emp.email)
    check('designation is trimmed', r.data?.designation === 'ZZ Software Engineer')
    check('skills split, trimmed and de-duplicated',
      JSON.stringify(r.data?.coreSkills) === JSON.stringify(['React', 'Node.js']),
      JSON.stringify(r.data?.coreSkills))
    check('new profile is active', r.data?.status === 'active')
    check('tenure is derived from the joining date', r.data?.tenureMonths > 0, `${r.data?.tenureMonths}`)

    const dup = await api('POST', '/people/employees', admin.id, { userId: emp.id, designation: 'Dev' })
    check('second profile for the same user → 409', dup.status === 409, `got ${dup.status}`)

    const eligible = await api('GET', '/people/employees/eligible-users', admin.id)
    check('profiled user drops out of the picker', !eligible.data.some((u) => u.id === emp.id))

    const list = await api('GET', '/people/employees', admin.id)
    check('directory lists the new profile', list.data?.some((e) => e.userId === emp.id))

    const l = await api('POST', '/people/employees', admin.id, {
      userId: leaver.id, designation: 'ZZ QA Engineer', dateOfJoining: '2023-03-01',
    })
    check('second fixture profile created', l.status === 201, `got ${l.status}`)
    if (l.data?.id) created.profiles.push(l.data.id)
  }

  console.log('\n5. Attrition')
  {
    const valid = {
      userId: emp.id, resignationDate: today, lastWorkingDate: addDays(today, 30),
      reasonCategory: 'compensation', reasonDetail: 'ZZ better offer', exitFeedback: 'ZZ good team',
    }
    const cases = [
      ['unknown reason category', { ...valid, reasonCategory: 'bored' }, 400],
      ['last day before resignation', { ...valid, lastWorkingDate: addDays(today, -1) }, 400],
      ['missing reason detail', { ...valid, reasonDetail: '  ' }, 400],
      ['bad exit type', { ...valid, exitType: 'vanished' }, 400],
      ['resigned before joining', { ...valid, resignationDate: '2023-01-01' }, 400],
      ['user without a profile', { ...valid, userId: admin.id }, 404],
    ]
    for (const [name, body, want] of cases) {
      const r = await api('POST', '/people/exits', admin.id, body)
      check(`${name} → ${want}`, r.status === want, `got ${r.status} ${r.body?.message}`)
    }

    const r = await api('POST', '/people/exits', admin.id, valid)
    check('exit recorded (201)', r.status === 201, `got ${r.status} ${r.body?.message}`)
    if (r.data?.id) created.exits.push(r.data.id)
    check('exit snapshots the role', r.data?.designation === 'ZZ Software Engineer')
    check('exit defaults to resignation', r.data?.exitType === 'resignation')
    check('tenure materialised in months', Number.isInteger(r.data?.tenureMonths) && r.data.tenureMonths > 0,
      `${r.data?.tenureMonths}`)

    const again = await api('POST', '/people/exits', admin.id, valid)
    check('second open exit → 409', again.status === 409, `got ${again.status}`)

    const gone = await api('POST', '/people/exits', admin.id, {
      userId: leaver.id, exitType: 'resignation', resignationDate: addDays(today, -40),
      lastWorkingDate: addDays(today, -10), reasonCategory: 'higher_studies', reasonDetail: 'ZZ masters',
    })
    check('past exit recorded', gone.status === 201, `got ${gone.status} ${gone.body?.message}`)
    if (gone.data?.id) created.exits.push(gone.data.id)

    const list = await api('GET', '/people/employees', admin.id)
    const e1 = list.data?.find((e) => e.userId === emp.id)
    const e2 = list.data?.find((e) => e.userId === leaver.id)
    check('future last day → notice_period', e1?.status === 'notice_period', e1?.status)
    check('past last day → exited', e2?.status === 'exited', e2?.status)

    const exits = await api('GET', '/people/exits', admin.id)
    check('exits list carries names', exits.data?.some((x) => x.userId === emp.id && x.name === emp.name))

    const dash = (await api('GET', '/people/dashboard', admin.id)).data
    check('exited employee leaves the headcount; notice period stays',
      dash.employees.total === base.employees.total - 1,
      `${dash.employees.total} vs ${base.employees.total}`)
  }

  console.log('\n6. Interviews')
  {
    const cases = [
      ['missing candidate name', { roleApplied: 'Dev', interviewDate: today, outcome: 'hold' }, 400],
      ['missing date', { candidateName: 'ZZ A', roleApplied: 'Dev', outcome: 'hold' }, 400],
      ['bad outcome', { candidateName: 'ZZ A', roleApplied: 'Dev', interviewDate: today, outcome: 'maybe' }, 400],
    ]
    for (const [name, body, want] of cases) {
      const r = await api('POST', '/people/interviews', admin.id, body)
      check(`${name} → ${want}`, r.status === want, `got ${r.status}`)
    }

    const rej = await api('POST', '/people/interviews', admin.id, {
      candidateName: 'ZZ Kiran', roleApplied: 'Full Stack Developer', interviewDate: today,
      outcome: 'rejected', notSelectedReason: 'ZZ weak SQL', feedback: 'ZZ maybe next year',
      candidateExpectations: 'ZZ flexible shift',
    })
    check('rejected interview saved', rej.status === 201, `got ${rej.status} ${rej.body?.message}`)
    if (rej.data?.candidateId) created.candidates.push(rej.data.candidateId)
    check('rejection keeps its reason', rej.data?.notSelectedReason === 'ZZ weak SQL')
    check('candidate status follows the outcome', rej.data?.candidateStatus === 'rejected')

    const sel = await api('POST', '/people/interviews', manager.id, {
      candidateName: 'ZZ Neha', roleApplied: 'Data Scientist', interviewDate: today,
      outcome: 'selected', notSelectedReason: 'should be dropped',
    })
    check('selected interview saved', sel.status === 201, `got ${sel.status}`)
    if (sel.data?.candidateId) created.candidates.push(sel.data.candidateId)
    check('reason dropped for a non-rejection', sel.data?.notSelectedReason === null)

    const list = await api('GET', '/people/interviews', admin.id)
    check('interview list includes both', ['ZZ Kiran', 'ZZ Neha'].every(
      (n) => list.data?.some((i) => i.candidateName === n)))

    const dash = (await api('GET', '/people/dashboard', admin.id)).data
    check('pipeline selected +1', dash.recruitment.pipeline.selected === base.recruitment.pipeline.selected + 1)
    check('pipeline rejected +1', dash.recruitment.pipeline.rejected === base.recruitment.pipeline.rejected + 1)
    check('interviews today +2', dash.recruitment.interviewsToday === base.recruitment.interviewsToday + 2)
    check('selected/rejected are not active candidates',
      dash.recruitment.activeCandidates === base.recruitment.activeCandidates)
  }

  console.log('\n7. Dashboard — presence and leave')
  {
    // The manager is in the roster and not touched by the exit fixtures.
    const who = manager.id
    const before = (await api('GET', '/people/dashboard', admin.id)).data
    const { rows: [logged] } = await workforce.query(
      'SELECT 1 FROM time_logs WHERE user_id = $1 AND date = $2 LIMIT 1', [who, today])
    const { rows: [onLeave] } = await workforce.query(
      `SELECT 1 FROM leave_requests WHERE user_id = $1 AND status = 'approved'
          AND start_date <= $2 AND end_date >= $2 LIMIT 1`, [who, today])

    const t = await workforce.query(
      `INSERT INTO time_logs (user_id, date, hours, note) VALUES ($1, $2, 1, 'ZZ people test') RETURNING id`,
      [who, today])
    created.timeLogs.push(t.rows[0].id)
    // Raised today for today → unplanned.
    const lv = await workforce.query(
      `INSERT INTO leave_requests (user_id, start_date, end_date, days, type, reason, status)
       VALUES ($1, $2, $2, 1, 'casual', 'ZZ people test', 'approved') RETURNING id`, [who, today])
    created.leaves.push(lv.rows[0].id)
    const pend = await workforce.query(
      `INSERT INTO leave_requests (user_id, start_date, end_date, days, type, reason, status)
       VALUES ($1, $2, $2, 1, 'casual', 'ZZ people test', 'pending') RETURNING id`,
      [who, addDays(today, 20)])
    created.leaves.push(pend.rows[0].id)

    const after = (await api('GET', '/people/dashboard', admin.id)).data
    check('present today counts a time log',
      after.attendance.presentToday === before.attendance.presentToday + (logged ? 0 : 1),
      `${before.attendance.presentToday} → ${after.attendance.presentToday}`)
    const todayBar = after.attendance.week.find((d) => d.date === today)
    if (todayBar) check('this week\'s bar for today matches presentToday', todayBar.present === after.attendance.presentToday)
    check('on leave counts approved leave covering today',
      after.leave.onLeaveToday === before.leave.onLeaveToday + (onLeave ? 0 : 1))
    check('same-day leave is unplanned',
      after.leave.unplanned === before.leave.unplanned + (onLeave ? 0 : 1))
    check('pending leave counted', after.leave.pending === before.leave.pending + 1)
    check('attendance percent is within 0..100',
      after.attendance.attendancePercent >= 0 && after.attendance.attendancePercent <= 100)
  }
}

main()
  .catch((err) => {
    console.error('\nTest run crashed:', err)
    fail += 1
  })
  .finally(async () => {
    try {
      for (const id of created.exits) await people.query('DELETE FROM employee_exits WHERE id = $1', [id]).catch(() => {})
      for (const id of created.profiles) await people.query('DELETE FROM employee_profiles WHERE id = $1', [id]).catch(() => {})
      // interviews go with their candidate (ON DELETE CASCADE).
      for (const id of created.candidates) await people.query('DELETE FROM candidates WHERE id = $1', [id]).catch(() => {})
      for (const id of created.timeLogs) await workforce.query('DELETE FROM time_logs WHERE id = $1', [id]).catch(() => {})
      for (const id of created.leaves) await workforce.query('DELETE FROM leave_requests WHERE id = $1', [id]).catch(() => {})
    } finally {
      console.log(`\n${'─'.repeat(60)}\n  ${pass} passed, ${fail} failed`)
      for (const f of failures) console.log(`    - ${f}`)
      console.log(`${'─'.repeat(60)}\n`)
      await endAll()
      process.exit(fail > 0 ? 1 : 0)
    }
  })
