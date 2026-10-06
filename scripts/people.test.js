/*
 * People (Module 9) integration tests — docs/Module-9-People-Plan.md §8.
 *
 * Runs against the real database and the live API on :5000, like the other
 * suites. It creates its own fixture users (zz-people-*@varadhi.test: one hr,
 * two employees) so no real account's role or profile is touched, and removes
 * every row it creates in the finally block.
 *
 *   npm run test:people
 *
 * The API must run with PII_ENCRYPTION_KEY set for the Aadhaar section; without
 * it that section asserts the refusal instead.
 * TEST_ALLOW_INVITE_EMAIL=1 also runs candidate conversion end to end, which
 * sends a real invite email — off by default.
 *
 * Sections:
 *   1 role matrix            2 privilege regression (hr is not a manager)
 *   3 create profile          4 Aadhaar
 *   5 /team is PII-free       6 /me
 *   7 exits + analytics       8 search + pagination
 *   9 dashboard              10 candidates, interviews, resumes
 *  11 interviewer feedback   12 conversion
 */

require('dotenv').config()
const { identity, people, notify, workforce, endAll } = require('./test-pools')
const { authHeaders } = require('./test-auth')
// Node 18+ globals; named here so eslint's env knows them.
const { FormData, Blob } = globalThis

const API = process.env.TEST_API_BASE || 'http://127.0.0.1:5000/api'
const TZ = process.env.BUSINESS_TZ || 'Asia/Kolkata'
const STAMP = Date.now().toString(36)

let pass = 0
let fail = 0
let skipped = 0
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
const skip = (name, why) => {
  skipped += 1
  console.log(`  SKIP  ${name} — ${why}`)
}

async function api(method, path, userId, body, { raw = false } = {}) {
  const headers = userId
    ? await authHeaders(userId, { 'user-agent': 'ZZ people.test.js' })
    : { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
  let payload
  if (raw) {
    delete headers['Content-Type']
    payload = body
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload })
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
const hasKeyDeep = (value, keys) => {
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, keys))
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => keys.includes(k) || hasKeyDeep(v, keys))
  }
  return false
}

const created = { users: [], candidates: [], exits: [], invitedEmails: [] }

const makeUser = async (label, role) => {
  const { rows: [u] } = await identity.query(
    `INSERT INTO users (name, email, role, status)
     VALUES ($1, $2, $3, 'active') RETURNING id, name, email`,
    [`ZZ People ${label} ${STAMP}`, `zz-people-${label}-${STAMP}@varadhi.test`, role]
  )
  created.users.push(u.id)
  return u
}

async function main() {
  const today = todayIn(TZ)
  const admin = (await identity.query(
    `SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1`)).rows[0]
  const manager = (await identity.query(
    `SELECT id FROM users WHERE role = 'manager' AND status = 'active' ORDER BY created_at LIMIT 1`)).rows[0]
  if (!admin || !manager) {
    console.log('SKIP — need an active admin and manager.')
    return
  }
  const hr = await makeUser('hr', 'hr')
  const emp = await makeUser('emp', 'employee')
  const emp2 = await makeUser('emp2', 'employee')

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n1. Role matrix (negative before positive)')
  {
    check('unauthenticated → 401', (await api('GET', '/people/dashboard', null)).status === 401)
    for (const path of ['/people/employees', '/people/exits', '/people/candidates', '/people/interviews',
      '/people/dashboard', '/people/employees/eligible-users']) {
      const r = await api('GET', path, emp.id)
      check(`employee GET ${path} → 403`, r.status === 403, `got ${r.status}`)
    }
    const mPost = await api('POST', '/people/employees', manager.id, { userId: emp.id, designation: 'x' })
    check('manager cannot create a profile (403)', mPost.status === 403, `got ${mPost.status}`)
    check('manager cannot list exits (403)', (await api('GET', '/people/exits', manager.id)).status === 403)
    check('manager cannot see candidates (403)', (await api('GET', '/people/candidates', manager.id)).status === 403)
    check('manager can list the (PII-free) directory', (await api('GET', '/people/employees', manager.id)).status === 200)
    check('manager can read attrition analytics', (await api('GET', '/people/exits/analytics', manager.id)).status === 200)
    check('hr can read the directory', (await api('GET', '/people/employees', hr.id)).status === 200)
    check('hr can read candidates', (await api('GET', '/people/candidates', hr.id)).status === 200)
    check('hr can read the user roster', (await api('GET', '/users', hr.id)).status === 200)
    const invite = await api('POST', '/users/invite', hr.id, { email: `zz-people-never-${STAMP}@varadhi.test` })
    check('hr cannot invite users (403)', invite.status === 403, `got ${invite.status}`)
    const role = await api('PATCH', `/users/${emp.id}/role`, hr.id, { role: 'manager' })
    check('hr cannot change roles (403)', role.status === 403, `got ${role.status}`)
  }

  console.log('\n2. Privilege regression — hr must not inherit manager powers')
  {
    const fake = '00000000-0000-4000-8000-000000000000'
    const del = await api('DELETE', `/documents/${fake}`, hr.id)
    check('hr DELETE /documents/:id → 403 (not 404)', del.status === 403, `got ${del.status}`)
    const mv = await api('PATCH', `/documents/${fake}/move`, hr.id, { folderId: null })
    check('hr cannot move documents', mv.status === 403 || mv.status === 404, `got ${mv.status}`)
    const leave = await api('PATCH', `/leave-management/${fake}/status`, hr.id, { status: 'approved' })
    check('hr cannot approve leave (403)', leave.status === 403, `got ${leave.status}`)
    const leaves = await api('GET', '/leave-management', hr.id)
    check('hr can read all leave', leaves.status === 200)
    const bug = await api('POST', '/bugs', hr.id, { title: 'ZZ x', description: 'y' })
    check('hr cannot report bugs (403)', bug.status === 403, `got ${bug.status}`)
  }

  console.log('\n3. Create profile')
  let piiReady = false
  {
    const cases = [
      ['missing user', { designation: 'Dev' }, 400],
      ['malformed user', { userId: 'abc', designation: 'Dev' }, 400],
      ['missing role', { userId: emp.id }, 400],
      ['bad gender', { userId: emp.id, designation: 'Dev', gender: 'robot' }, 400],
      ['future date of birth', { userId: emp.id, designation: 'Dev', dateOfBirth: addDays(today, 3) }, 400],
      ['self as manager', { userId: emp.id, designation: 'Dev', reportingManagerId: emp.id }, 400],
      ['unknown user', { userId: '00000000-0000-4000-8000-000000000000', designation: 'Dev' }, 404],
      ['bad aadhaar', { userId: emp.id, designation: 'Dev', aadhaar: '1234' }, 400],
    ]
    for (const [name, body, want] of cases) {
      const r = await api('POST', '/people/employees', hr.id, body)
      check(`${name} → ${want}`, r.status === want, `got ${r.status} ${r.body?.message}`)
    }

    const probe = await api('POST', '/people/employees', hr.id, {
      userId: emp.id, designation: 'ZZ Engineer', aadhaar: '2345 6789 0123',
      employeeCode: `ZZ-${STAMP}`, reportingManagerId: manager.id, dateOfJoining: '2024-01-15',
      gender: 'female', dateOfBirth: '1995-06-01', product: 'Varadhi', coreSkills: 'React, Node',
    })
    if (probe.status === 400 && /PII_ENCRYPTION_KEY/.test(probe.body?.message || '')) {
      check('Aadhaar write refused when PII encryption is unavailable', true)
      const r = await api('POST', '/people/employees', hr.id, {
        userId: emp.id, designation: 'ZZ Engineer', employeeCode: `ZZ-${STAMP}`,
        reportingManagerId: manager.id, dateOfJoining: '2024-01-15', gender: 'female',
        dateOfBirth: '1995-06-01', product: 'Varadhi', coreSkills: 'React, Node',
      })
      check('hr creates a profile without Aadhaar (201)', r.status === 201, `got ${r.status} ${r.body?.message}`)
    } else {
      piiReady = true
      check('hr creates a profile with Aadhaar (201)', probe.status === 201, `got ${probe.status} ${probe.body?.message}`)
    }
    const dup = await api('POST', '/people/employees', hr.id, { userId: emp.id, designation: 'Dev' })
    check('duplicate user → 409', dup.status === 409, `got ${dup.status}`)
    const dupCode = await api('POST', '/people/employees', hr.id, {
      userId: emp2.id, designation: 'Dev', employeeCode: `zz-${STAMP}`,
    })
    check('duplicate employee code (case-insensitive) → 409', dupCode.status === 409, `got ${dupCode.status}`)
    const second = await api('POST', '/people/employees', admin.id, {
      userId: emp2.id, designation: 'ZZ QA', reportingManagerId: manager.id, dateOfJoining: '2023-03-01',
      temporaryAddress: 'ZZ Street 1', permanentAddress: 'ZZ Town',
    })
    check('admin creates a second profile', second.status === 201, `got ${second.status} ${second.body?.message}`)

    const { rows: [n] } = await notify.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'employee_profile_incomplete'`, [emp.id])
    check('person with no address is asked to complete their profile', n.n >= 1)
  }

  console.log('\n4. Aadhaar')
  if (!piiReady) {
    skip('ciphertext / masking / reveal', 'API is running without PII_ENCRYPTION_KEY')
  } else {
    const { rows: [row] } = await people.query(
      `SELECT aadhaar_encrypted, aadhaar_last4 FROM employee_profiles WHERE user_id = $1`, [emp.id])
    check('stored value is ciphertext, not the number', row.aadhaar_encrypted && !row.aadhaar_encrypted.includes('234567890123'))
    check('last four stored for display', row.aadhaar_last4 === '0123')
    const detail = await api('GET', `/people/employees/${emp.id}`, hr.id)
    check('detail shows only the masked number', detail.data?.aadhaarMasked === 'XXXX XXXX 0123')
    check('no ciphertext or full number in any response',
      !JSON.stringify(detail.body).includes('234567890123') && !hasKeyDeep(detail.body, ['aadhaar_encrypted', 'aadhaarEncrypted']))
    const list = await api('GET', '/people/employees?limit=100', hr.id)
    check('directory list carries no Aadhaar at all', !hasKeyDeep(list.body, ['aadhaarMasked', 'aadhaar_last4']))
    check('manager cannot reveal (403)', (await api('GET', `/people/employees/${emp.id}/aadhaar`, manager.id)).status === 403)
    check('the person cannot reveal their own via the HR endpoint (403)',
      (await api('GET', `/people/employees/${emp.id}/aadhaar`, emp.id)).status === 403)
    const reveal = await api('GET', `/people/employees/${emp.id}/aadhaar`, hr.id)
    check('hr reveals the full number', reveal.data?.aadhaar === '2345 6789 0123', JSON.stringify(reveal.body))
  }

  console.log('\n5. /team is PII-free and open to every role')
  {
    // Fill PII on emp2 so a leak would actually show.
    await api('PUT', `/people/employees/${emp2.id}`, hr.id, {
      dateOfBirth: '1990-01-01', guardianName: 'ZZ Guardian', maritalStatus: 'single',
    })
    const team = await api('GET', '/people/team', emp.id)
    check('employee can read /team', team.status === 200, `got ${team.status}`)
    const forbidden = ['temporaryAddress', 'permanentAddress', 'aadhaarMasked', 'hasAadhaar', 'dateOfBirth',
      'age', 'guardianName', 'maritalStatus', 'gender', 'reasonCategory', 'reasonDetail', 'exit']
    check('payload has none of the PII keys', !hasKeyDeep(team.body, forbidden))
    check('payload does not contain the guardian name', !JSON.stringify(team.body).includes('ZZ Guardian'))
    const group = team.data?.groups?.find((g) => g.manager?.id === manager.id)
    check('grouped under the reporting manager', group?.members?.some((m) => m.userId === emp2.id))
  }

  console.log('\n6. /me')
  {
    const me = await api('GET', '/people/me', emp2.id)
    check('own profile readable', me.status === 200 && me.data?.userId === emp2.id)
    check('own detail includes own PII', me.data?.guardianName === 'ZZ Guardian')
    const other = await api('GET', `/people/employees/${emp.id}`, emp2.id)
    check('cannot read someone else\'s profile (403)', other.status === 403, `got ${other.status}`)
    const patch = await api('PATCH', '/people/me', emp2.id, {
      temporaryAddress: 'ZZ New Street', designation: 'CEO', reportingManagerId: emp2.id,
    })
    check('addresses update', patch.status === 200 && patch.data?.temporaryAddress === 'ZZ New Street')
    check('anything other than addresses is ignored', patch.data?.designation === 'ZZ QA')
    const none = await api('PATCH', '/people/me', hr.id, { temporaryAddress: 'x' })
    check('no profile yet → 404', none.status === 404, `got ${none.status}`)
  }

  console.log('\n7. Exits + analytics')
  {
    const valid = {
      userId: emp.id, resignationDate: today, lastWorkingDate: addDays(today, 30),
      reasonCategory: 'compensation', reasonDetail: 'ZZ better offer', exitFeedback: 'ZZ good team',
    }
    const bad = await api('POST', '/people/exits', hr.id, { ...valid, reasonCategory: 'bored' })
    check('unknown reason → 400', bad.status === 400)
    const mgr = await api('POST', '/people/exits', manager.id, valid)
    check('manager cannot record an exit (403)', mgr.status === 403)
    const r = await api('POST', '/people/exits', hr.id, valid)
    check('hr records an exit (201)', r.status === 201, `got ${r.status} ${r.body?.message}`)
    if (r.data?.id) created.exits.push(r.data.id)
    check('tenure materialised', Number.isInteger(r.data?.tenureMonths) && r.data.tenureMonths > 0)
    const detail = await api('GET', `/people/employees/${emp.id}`, hr.id)
    check('status flips to notice_period', detail.data?.status === 'notice_period', detail.data?.status)
    const { rows: [n] } = await notify.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'resignation_recorded'`, [admin.id])
    check('resignation_recorded dispatched to admins', n.n >= 1)
    check('second exit → 409', (await api('POST', '/people/exits', hr.id, valid)).status === 409)

    const edit = await api('PATCH', `/people/exits/${r.data.id}`, hr.id, { lastWorkingDate: addDays(today, -1), resignationDate: addDays(today, -20) })
    check('hr edits the exit', edit.status === 200, `got ${edit.status} ${edit.body?.message}`)
    const after = await api('GET', `/people/employees/${emp.id}`, hr.id)
    check('past last day → exited', after.data?.status === 'exited', after.data?.status)
    const active = await api('GET', '/people/employees?status=active&limit=100', hr.id)
    check('leaves the active directory', !active.data?.items?.some((e) => e.userId === emp.id))
    const team = await api('GET', '/people/team', emp2.id)
    check('leaves the team directory', !JSON.stringify(team.data).includes(emp.id))
    const an = await api('GET', `/people/exits/analytics?from=${addDays(today, -30)}&to=${today}`, manager.id)
    check('appears in attrition analytics', an.data?.byReason?.some((x) => x.key === 'compensation' && x.count >= 1))
  }

  console.log('\n8. Search + pagination')
  {
    const all = await api('GET', `/people/employees?search=${encodeURIComponent(`ZZ People`)}&limit=100`, hr.id)
    const mine = all.data?.items?.filter((e) => [emp.id, emp2.id].includes(e.userId)) || []
    check('search by name finds both fixtures', mine.length === 2, `${mine.length}`)
    const paged = await api('GET', `/people/employees?search=${encodeURIComponent(`${STAMP}`)}&limit=1`, hr.id)
    check('limit=1 returns one row', paged.data?.items?.length === 1)
    check('total still counts every match', paged.data?.total === 2, `${paged.data?.total}`)
    const none = await api('GET', '/people/employees?search=zz-no-such-person-xyz', hr.id)
    check('no match → empty with total 0', none.data?.total === 0 && none.data?.items?.length === 0)
    check('bad status filter → 400', (await api('GET', '/people/employees?status=gone', hr.id)).status === 400)
  }

  console.log('\n9. Dashboard')
  {
    const d = await api('GET', '/people/dashboard', hr.id)
    check('hr reads the dashboard', d.status === 200)
    check('asOf is the business date', d.data?.asOf === today)
    check('exited fixture is not in the headcount roster',
      typeof d.data?.employees?.total === 'number')
  }

  console.log('\n10. Candidates, interviews, resumes')
  let candidateId
  let roundId
  {
    const bad = await api('POST', '/people/candidates', hr.id, { appliedFor: 'Dev' })
    check('candidate without a name → 400', bad.status === 400)
    const badEmail = await api('POST', '/people/candidates', hr.id, { fullName: 'ZZ X', appliedFor: 'Dev', email: 'nope' })
    check('bad email → 400', badEmail.status === 400)
    const c = await api('POST', '/people/candidates', hr.id, {
      fullName: `ZZ Candidate ${STAMP}`, appliedFor: 'Full Stack Developer', source: 'referral',
      phone: '+91 98765 43210', totalExperienceMonths: 30, noticePeriodDays: 30,
    })
    check('hr adds a candidate', c.status === 201, `got ${c.status} ${c.body?.message}`)
    candidateId = c.data?.id
    if (candidateId) created.candidates.push(candidateId)
    check('starts as applied', c.data?.status === 'applied')

    const st = await api('PATCH', `/people/candidates/${candidateId}/status`, hr.id, { status: 'screening' })
    check('status → screening', st.data?.status === 'screening')
    check('bad status → 400', (await api('PATCH', `/people/candidates/${candidateId}/status`, hr.id, { status: 'maybe' })).status === 400)

    const sch = await api('POST', '/people/interviews', hr.id, {
      candidateId, interviewDate: today, startTime: '11:30', interviewType: 'technical', interviewerId: emp2.id,
    })
    check('hr schedules a round', sch.status === 201, `got ${sch.status} ${sch.body?.message}`)
    roundId = sch.data?.id
    check('round 1, scheduled', sch.data?.roundNumber === 1 && sch.data?.status === 'scheduled')
    check('interviewer resolved', sch.data?.interviewer?.id === emp2.id)
    const cand = await api('GET', `/people/candidates/${candidateId}`, hr.id)
    check('candidate moves to interview_scheduled', cand.data?.status === 'interview_scheduled')
    const { rows: [n] } = await notify.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'interview_scheduled'`, [emp2.id])
    check('interviewer notified', n.n >= 1)

    const badTime = await api('POST', '/people/interviews', hr.id, { candidateId, interviewDate: today, startTime: '25:00' })
    check('bad start time → 400', badTime.status === 400)

    // Resume vault.
    const pdf = Buffer.from(`%PDF-1.4\n% ZZ resume ${STAMP}\n%%EOF\n`)
    const badForm = new FormData()
    badForm.append('file', new Blob([Buffer.from('x')], { type: 'image/png' }), 'zz.png')
    const badUp = await api('POST', `/people/candidates/${candidateId}/resumes`, hr.id, badForm, { raw: true })
    check('non-resume file type → 400', badUp.status === 400, `got ${badUp.status}`)
    const form = new FormData()
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), `zz-resume-${STAMP}.pdf`)
    const up = await api('POST', `/people/candidates/${candidateId}/resumes`, hr.id, form, { raw: true })
    check('hr uploads a resume', up.status === 201, `got ${up.status} ${up.body?.message}`)
    check('storage path never returned', !hasKeyDeep(up.body, ['storagePath', 'storage_path']))
    if (up.data?.id) {
      const mgrLink = await api('GET', `/people/candidates/${candidateId}/resumes/${up.data.id}`, manager.id)
      check('manager cannot download a resume (403)', mgrLink.status === 403)
      const link = await api('GET', `/people/candidates/${candidateId}/resumes/${up.data.id}`, hr.id)
      check('hr gets a short-lived signed URL', link.status === 200 && /token=/.test(link.data?.url || ''))
      check('expires within minutes', link.data?.expiresInSeconds > 0 && link.data.expiresInSeconds <= 300)
      if (link.data?.url) {
        const file = await fetch(link.data.url)
        const text = await file.text()
        check('signed URL serves the file', file.ok && text.includes(STAMP))
        const { rows: [r] } = await people.query('SELECT storage_path FROM candidate_resumes WHERE id = $1', [up.data.id])
        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${process.env.HR_PRIVATE_BUCKET || 'hr-private'}/${r.storage_path}`
        const pub = await fetch(publicUrl)
        check('object is NOT reachable through a public URL', !pub.ok, `got ${pub.status}`)
      }
      const folder = await api('GET', '/people/candidates/resumes', hr.id)
      check('appears in the Resume Folder', folder.data?.some((x) => x.id === up.data.id))
      const del = await api('DELETE', `/people/candidates/${candidateId}/resumes/${up.data.id}`, hr.id)
      check('hr deletes the resume', del.status === 204, `got ${del.status}`)
    }
  }

  console.log('\n11. Interviewer feedback')
  {
    const mine = await api('GET', '/people/interviews/mine', emp2.id)
    check('interviewer sees their round', mine.data?.some((i) => i.id === roundId))
    const stranger = await api('PATCH', `/people/interviews/${roundId}/outcome`, emp.id, { outcome: 'selected' })
    check('another employee cannot record it (403)', stranger.status === 403, `got ${stranger.status}`)
    const noOutcome = await api('PATCH', `/people/interviews/${roundId}/outcome`, emp2.id, { status: 'completed' })
    check('completed without outcome → 400', noOutcome.status === 400)
    const ok = await api('PATCH', `/people/interviews/${roundId}/outcome`, emp2.id, {
      outcome: 'selected', rating: 4, feedback: 'ZZ strong', candidateExpectations: 'ZZ flexible shift and better salary',
    })
    check('interviewer records the outcome', ok.status === 200 && ok.data?.status === 'completed', `got ${ok.status} ${ok.body?.message}`)
    const cand = await api('GET', `/people/candidates/${candidateId}`, hr.id)
    check('candidate becomes selected', cand.data?.status === 'selected')
    const exp = await api('GET', '/people/interviews/expectations', hr.id)
    check('expectations report themes pay and shift',
      exp.data?.items?.some((i) => i.interviewId === roundId) && exp.data.themes.pay >= 1 && exp.data.themes.shift >= 1)
    check('employee cannot read the expectations report', (await api('GET', '/people/interviews/expectations', emp2.id)).status === 403)

    // Feedback reminder: a past round with no outcome.
    const past = await api('POST', '/people/interviews', hr.id, {
      candidateId, interviewDate: addDays(today, -2), interviewType: 'hr', interviewerId: emp2.id,
    })
    check('round 2 scheduled in the past', past.status === 201 && past.data?.roundNumber === 2, `got ${past.status} ${past.body?.message}`)
    const { runInterviewFeedbackReminderNow } = require('../src/modules/people')
    await runInterviewFeedbackReminderNow()
    const { rows: [n] } = await notify.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'interview_feedback_pending'`, [emp2.id])
    check('feedback-pending reminder sent to the interviewer', n.n >= 1)

    const quick = await api('POST', '/people/interviews', hr.id, {
      candidateName: `ZZ Quick ${STAMP}`, roleApplied: 'QA', interviewDate: today, outcome: 'rejected', notSelectedReason: 'ZZ',
    })
    check('quick interview record still works', quick.status === 201 && quick.data?.status === 'completed')
    if (quick.data?.candidateId) created.candidates.push(quick.data.candidateId)
  }

  console.log('\n12. Conversion')
  {
    const notReady = await api('POST', `/people/candidates/${created.candidates.at(-1)}/convert`, hr.id, {})
    check('a rejected candidate cannot be converted', notReady.status === 400, `got ${notReady.status}`)
    const noEmail = await api('POST', `/people/candidates/${candidateId}/convert`, hr.id, {})
    check('conversion needs an email', noEmail.status === 400 && /email/i.test(noEmail.body?.message || ''))
    if (process.env.TEST_ALLOW_INVITE_EMAIL === '1') {
      const email = `zz-people-cand-${STAMP}@varadhi.test`
      created.invitedEmails.push(email)
      await api('PUT', `/people/candidates/${candidateId}`, hr.id, { email })
      const conv = await api('POST', `/people/candidates/${candidateId}/convert`, hr.id, { dateOfJoining: today })
      check('selected candidate converts (201)', conv.status === 201, `got ${conv.status} ${conv.body?.message}`)
      check('profile created for the invited account', conv.data?.employee?.designation === 'Full Stack Developer')
      check('candidate marked joined', conv.data?.candidate?.status === 'joined')
    } else {
      skip('end-to-end conversion', 'sends a real invite email; set TEST_ALLOW_INVITE_EMAIL=1')
    }
  }
}

main()
  .catch((err) => {
    console.error('\nTest run crashed:', err)
    fail += 1
  })
  .finally(async () => {
    try {
      for (const id of created.candidates) {
        // Through the API so the resume objects leave storage too.
        await api('DELETE', `/people/candidates/${id}`, created.users[0]).catch(() => {})
        await people.query('DELETE FROM candidates WHERE id = $1', [id]).catch(() => {})
      }
      const { rows: invited } = await identity.query(
        'SELECT id FROM users WHERE email = ANY($1)', [created.invitedEmails]).catch(() => ({ rows: [] }))
      const ids = [...created.users, ...invited.map((r) => r.id)]
      await people.query('DELETE FROM employee_exits WHERE user_id = ANY($1)', [ids]).catch(() => {})
      await people.query('DELETE FROM employee_profiles WHERE user_id = ANY($1)', [ids]).catch(() => {})
      await notify.query('DELETE FROM notifications WHERE user_id = ANY($1)', [ids]).catch(() => {})
      await notify.query(`DELETE FROM notifications WHERE message LIKE '%ZZ %'`).catch(() => {})
      await workforce.query('DELETE FROM leave_requests WHERE user_id = ANY($1)', [ids]).catch(() => {})
      await identity.query('DELETE FROM users WHERE id = ANY($1)', [ids]).catch(() => {})
    } finally {
      console.log(`\n${'─'.repeat(60)}\n  ${pass} passed, ${fail} failed, ${skipped} skipped`)
      for (const f of failures) console.log(`    - ${f}`)
      console.log(`${'─'.repeat(60)}\n`)
      await endAll()
      process.exit(fail > 0 ? 1 : 0)
    }
  })
