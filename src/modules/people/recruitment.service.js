// Recruitment (Phase 2): candidates, interview rounds, the resume vault, the
// expectations report and candidate → employee conversion.
//
// Candidates are NOT users. They never enter identity.users until conversion,
// which goes through identity's own invite path.

const repo = require('./recruitment.repo')
const storage = require('./resume-storage')
const employees = require('./employees.service')
const identity = require('../identity')
const notify = require('../notify')
const files = require('../files')
const {
  PeopleError, UUID_RE, hasRole, todayIn, text, date, int, oneOf, uuid, pageArgs,
  notifySafely,
} = require('./shared')

const CANDIDATE_STATUSES = [
  'applied', 'screening', 'interview_scheduled', 'interviewed', 'selected',
  'hold', 'rejected', 'offered', 'joined', 'declined',
]
const SOURCES = ['referral', 'naukri', 'linkedin', 'walk_in', 'campus', 'other']
const INTERVIEW_TYPES = ['telephonic', 'technical', 'hr', 'managerial', 'final']
const INTERVIEW_STATUSES = ['scheduled', 'completed', 'no_show', 'cancelled']
const OUTCOMES = ['selected', 'hold', 'rejected', 'next_round']
// The quick "interview record" form only offers the sheet's three outcomes.
const QUICK_OUTCOMES = ['selected', 'hold', 'rejected']
const RESUME_TYPES = ['pdf', 'doc', 'docx']
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// What a completed round's outcome means for the candidate's pipeline state.
const STATUS_AFTER_OUTCOME = {
  selected: 'selected', hold: 'hold', rejected: 'rejected', next_round: 'interviewed',
}

const notFound = (what) => new PeopleError(`${what} not found.`, 404)
const checkId = (id, what) => {
  if (!UUID_RE.test(String(id || ''))) throw notFound(what)
}

/* ── mapping ──────────────────────────────────────────────────────────── */

const mapCandidate = (row) => ({
  id: row.id,
  fullName: row.full_name,
  appliedFor: row.applied_for,
  status: row.status,
  email: row.email,
  phone: row.phone,
  source: row.source,
  product: row.product,
  currentCompany: row.current_company,
  totalExperienceMonths: row.total_experience_months,
  noticePeriodDays: row.notice_period_days,
  expectedShift: row.expected_shift,
  notes: row.notes,
  convertedUserId: row.converted_user_id,
  resumeCount: row.resume_count ?? 0,
  interviewCount: row.interview_count ?? 0,
  lastInterview: row.last_interview_date ? {
    date: row.last_interview_date,
    outcome: row.last_interview_outcome,
    status: row.last_interview_status,
  } : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const mapInterview = (row, cards = new Map()) => {
  const interviewer = cards.get(row.interviewer_id)
  return {
    id: row.id,
    candidateId: row.candidate_id,
    candidateName: row.candidate_name,
    roleApplied: row.applied_for,
    candidateStatus: row.candidate_status,
    roundNumber: row.round_number,
    interviewType: row.interview_type,
    interviewDate: row.interview_date,
    startTime: row.start_time ? String(row.start_time).slice(0, 5) : null,
    interviewer: interviewer ? { id: interviewer.id, name: interviewer.name } : null,
    status: row.status,
    outcome: row.outcome,
    rating: row.rating,
    notSelectedReason: row.not_selected_reason,
    feedback: row.feedback,
    candidateExpectations: row.candidate_expectations,
    createdAt: row.created_at,
  }
}

// The storage path never leaves the server — only metadata does.
const mapResume = (row) => ({
  id: row.id,
  candidateId: row.candidate_id,
  fileName: row.file_name,
  fileType: row.file_type,
  fileSize: row.file_size == null ? null : Number(row.file_size),
  createdAt: row.created_at,
  ...(row.candidate_name ? {
    candidateName: row.candidate_name, appliedFor: row.applied_for, candidateStatus: row.candidate_status,
  } : {}),
})

const withInterviewers = async (rows) => {
  const cards = await identity.getUserCards(rows.map((r) => r.interviewer_id))
  return rows.map((r) => mapInterview(r, cards))
}

/* ── candidates ───────────────────────────────────────────────────────── */

const buildCandidateFields = (body, { partial }) => {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
  const want = (k) => !partial || has(k)
  const f = {}
  if (want('fullName')) f.full_name = text(body.fullName, { label: 'Candidate name', max: 160, required: true })
  if (want('appliedFor')) f.applied_for = text(body.appliedFor, { label: 'Role applied for', max: 120, required: true })
  if (want('email')) {
    f.email = text(body.email, { label: 'Email', max: 255 })
    if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) throw new PeopleError('Email is not valid.')
  }
  if (want('phone')) {
    f.phone = text(body.phone, { label: 'Phone', max: 20 })
    if (f.phone && !/^[+\d][\d\s-]{6,19}$/.test(f.phone)) throw new PeopleError('Phone number is not valid.')
  }
  if (want('source')) f.source = oneOf(body.source, SOURCES, { label: 'Source' })
  if (want('product')) f.product = text(body.product, { label: 'Product', max: 120 })
  if (want('currentCompany')) f.current_company = text(body.currentCompany, { label: 'Current company', max: 200 })
  if (want('totalExperienceMonths')) f.total_experience_months = int(body.totalExperienceMonths, { label: 'Experience (months)', max: 720 })
  if (want('noticePeriodDays')) f.notice_period_days = int(body.noticePeriodDays, { label: 'Notice period (days)', max: 365 })
  if (want('expectedShift')) f.expected_shift = text(body.expectedShift, { label: 'Expected shift', max: 60 })
  if (want('notes')) f.notes = text(body.notes, { label: 'Notes', max: 4000 })
  return f
}

exports.listCandidates = async (query = {}) => {
  const { page, limit, offset } = pageArgs(query, 100)
  const status = query.status && query.status !== 'all'
    ? oneOf(query.status, CANDIDATE_STATUSES, { label: 'Status' }) : null
  const search = String(query.search || '').trim() || null
  const { rows, total } = await repo.listCandidates({ status, search, limit, offset })
  return { items: rows.map(mapCandidate), total, page, limit }
}

exports.getCandidate = async (id) => {
  checkId(id, 'Candidate')
  const row = await repo.findCandidate(id)
  if (!row) throw notFound('Candidate')
  const [interviews, resumes] = await Promise.all([
    repo.listInterviews({ candidateId: id }),
    repo.listResumes(id),
  ])
  return {
    ...mapCandidate(row),
    interviews: await withInterviewers(interviews),
    resumes: resumes.map(mapResume),
  }
}

exports.createCandidate = async (currentUser, body = {}) => {
  const fields = buildCandidateFields(body, { partial: false })
  fields.status = oneOf(body.status, CANDIDATE_STATUSES, { label: 'Status', fallback: 'applied' })
  const { id } = await repo.insertCandidate({ ...fields, created_by: currentUser.id })
  return exports.getCandidate(id)
}

exports.updateCandidate = async (currentUser, id, body = {}) => {
  checkId(id, 'Candidate')
  const fields = buildCandidateFields(body, { partial: true })
  if (!(await repo.updateCandidate(id, fields))) throw notFound('Candidate')
  return exports.getCandidate(id)
}

const announceStatus = (currentUser, candidate, from, to) => notifySafely(() =>
  notify.dispatchToRoles({
    roles: ['hr'],
    type: notify.TYPES.CANDIDATE_STATUS_CHANGED,
    title: 'Candidate status changed',
    message: `${candidate.full_name ?? candidate.fullName} (${candidate.applied_for ?? candidate.appliedFor}): ${from} → ${to}`,
    linkTo: `/recruitment/${candidate.id}`,
    priority: 'low',
    excludeUserId: currentUser.id,
  }))

exports.setCandidateStatus = async (currentUser, id, status) => {
  checkId(id, 'Candidate')
  const next = oneOf(status, CANDIDATE_STATUSES, { label: 'Status', required: true })
  const row = await repo.findCandidate(id)
  if (!row) throw notFound('Candidate')
  if (row.converted_user_id && next !== 'joined') {
    throw new PeopleError('This candidate has already been converted to an employee.', 409)
  }
  if (row.status !== next) {
    await repo.updateCandidate(id, { status: next })
    await announceStatus(currentUser, row, row.status, next)
  }
  return exports.getCandidate(id)
}

exports.deleteCandidate = async (id) => {
  checkId(id, 'Candidate')
  const paths = await repo.listResumePaths(id)
  const deleted = await repo.deleteCandidate(id) // interviews + resume rows cascade
  if (!deleted) throw notFound('Candidate')
  await storage.remove(paths)
}

/**
 * Selected candidate → employee: invite an account through identity (the same
 * invite email as the Users screen), create their HR profile, and mark the
 * candidate joined. The profile input is validated BEFORE the invite.
 */
exports.convertCandidate = async (currentUser, id, body = {}) => {
  checkId(id, 'Candidate')
  const row = await repo.findCandidate(id)
  if (!row) throw notFound('Candidate')
  if (row.converted_user_id) throw new PeopleError('This candidate has already been converted.', 409)
  if (!['selected', 'offered'].includes(row.status)) {
    throw new PeopleError('Only a selected or offered candidate can be converted to an employee.')
  }
  if (!row.email) throw new PeopleError('Add the candidate\'s email before converting — the invite is sent there.')

  const profileInput = {
    designation: body.designation || row.applied_for,
    product: body.product ?? row.product,
    shift: body.shift ?? row.expected_shift,
    dateOfJoining: body.dateOfJoining,
    reportingManagerId: body.reportingManagerId,
    employeeCode: body.employeeCode,
    coreSkills: body.coreSkills,
  }
  await employees.validateProfileInput(profileInput)

  let account
  try {
    account = await identity.inviteUser(currentUser, { email: row.email, role: 'employee', name: row.full_name })
  } catch (err) {
    if (err instanceof identity.InviteError) {
      throw new PeopleError(`Could not invite ${row.email}: ${err.message}`, err.status === 404 ? 404 : 409)
    }
    throw err
  }

  const profile = await employees.createEmployee(currentUser, { userId: account.id, ...profileInput })
  await repo.updateCandidate(id, { status: 'joined', converted_user_id: account.id })
  await announceStatus(currentUser, row, row.status, 'joined')
  return { candidate: await exports.getCandidate(id), employee: profile }
}

/* ── resumes ──────────────────────────────────────────────────────────── */

exports.uploadResume = async (currentUser, candidateId, file) => {
  checkId(candidateId, 'Candidate')
  if (!file) throw new PeopleError('Choose a resume file to upload.')
  const ext = await files.getFileExtension(file.originalname)
  if (!RESUME_TYPES.includes(ext)) throw new PeopleError('Resumes must be PDF, DOC or DOCX files.')
  if (!(await repo.findCandidate(candidateId))) throw notFound('Candidate')

  const path = await storage.upload({
    buffer: file.buffer, fileName: file.originalname, mimeType: file.mimetype, candidateId,
  })
  try {
    const row = await repo.insertResume({
      candidateId, fileName: file.originalname, fileType: ext, fileSize: file.size,
      storagePath: path, uploadedBy: currentUser.id,
    })
    return mapResume(row)
  } catch (err) {
    await storage.remove(path) // never leave an object nothing points at
    throw err
  }
}

exports.getResumeLink = async (candidateId, resumeId) => {
  checkId(candidateId, 'Resume')
  checkId(resumeId, 'Resume')
  const row = await repo.findResume(candidateId, resumeId)
  if (!row) throw notFound('Resume')
  return { ...(await storage.signedUrl(row.storage_path, row.file_name)), fileName: row.file_name }
}

exports.deleteResume = async (candidateId, resumeId) => {
  checkId(candidateId, 'Resume')
  checkId(resumeId, 'Resume')
  const row = await repo.deleteResume(candidateId, resumeId)
  if (!row) throw notFound('Resume')
  await storage.remove(row.storage_path)
}

exports.listAllResumes = async () => (await repo.listAllResumes()).map(mapResume)

/* ── interviews ───────────────────────────────────────────────────────── */

exports.listInterviews = async (query = {}) => {
  const filters = {
    candidateId: query.candidateId ? uuid(query.candidateId, { label: 'Candidate' }) : null,
    interviewerId: query.interviewerId ? uuid(query.interviewerId, { label: 'Interviewer' }) : null,
    status: query.status && query.status !== 'all'
      ? oneOf(query.status, INTERVIEW_STATUSES, { label: 'Status' }) : null,
    from: date(query.from, { label: 'From' }),
    to: date(query.to, { label: 'To' }),
  }
  return withInterviewers(await repo.listInterviews(filters))
}

/** Rounds assigned to the caller — any role can be an interviewer. */
exports.listMyInterviews = async (currentUser) =>
  withInterviewers(await repo.listInterviews({ interviewerId: currentUser.id }))

const checkInterviewer = async (interviewerId) => {
  if (!interviewerId) return
  const account = await identity.getAccountState(interviewerId)
  if (!account) throw new PeopleError('Interviewer was not found.', 404)
  if (account.status !== 'active') throw new PeopleError('Interviewer must be an active user.')
}

/**
 * Two shapes, both on POST /interviews:
 *   - `candidateId` → schedule the next round for an existing candidate.
 *   - `candidateName` → the HR screen's quick record: create the candidate and
 *     a completed interview with its outcome in one transaction.
 */
exports.createInterview = async (currentUser, body = {}) => {
  if (body.candidateId) return scheduleRound(currentUser, body)
  return quickRecord(currentUser, body)
}

const scheduleRound = async (currentUser, body) => {
  const candidateId = uuid(body.candidateId, { label: 'a candidate', required: true })
  const interviewDate = date(body.interviewDate, { label: 'Interview date', required: true })
  const startTime = text(body.startTime, { label: 'Start time', max: 5 })
  if (startTime && !TIME_RE.test(startTime)) throw new PeopleError('Start time must be HH:MM.')
  const interviewType = oneOf(body.interviewType, INTERVIEW_TYPES, { label: 'Interview type' })
  const interviewerId = uuid(body.interviewerId, { label: 'Interviewer' })
  await checkInterviewer(interviewerId)

  const candidate = await repo.findCandidate(candidateId)
  if (!candidate) throw notFound('Candidate')
  if (['joined', 'declined', 'rejected'].includes(candidate.status)) {
    throw new PeopleError(`Cannot schedule an interview for a ${candidate.status} candidate.`)
  }

  const { id } = await repo.withTransaction(async (client) => {
    const roundNumber = await repo.nextRoundNumber(candidateId, client)
    const created = await repo.insertInterview({
      candidate_id: candidateId, round_number: roundNumber, interview_date: interviewDate,
      start_time: startTime, interview_type: interviewType, interviewer_id: interviewerId,
      status: 'scheduled', created_by: currentUser.id,
    }, client)
    if (['applied', 'screening', 'interviewed', 'hold'].includes(candidate.status)) {
      await repo.updateCandidate(candidateId, { status: 'interview_scheduled' }, client)
    }
    return created
  })

  const [dto] = await withInterviewers([await repo.findInterview(id)])
  if (interviewerId && interviewerId !== currentUser.id) {
    await notifySafely(() => notify.dispatch({
      userId: interviewerId,
      type: notify.TYPES.INTERVIEW_SCHEDULED,
      title: 'Interview scheduled',
      message: `You are interviewing ${dto.candidateName} (${dto.roleApplied}), round ${dto.roundNumber}, on ${dto.interviewDate}${dto.startTime ? ` at ${dto.startTime}` : ''}.`,
      linkTo: '/my-interviews',
      priority: 'normal',
    }))
  }
  return dto
}

const quickRecord = async (currentUser, body) => {
  const candidateName = text(body.candidateName, { label: 'Candidate name', max: 160, required: true })
  const roleApplied = text(body.roleApplied, { label: 'Role applied for', max: 120, required: true })
  const interviewDate = date(body.interviewDate, { label: 'Interview date', required: true })
  const outcome = String(body.outcome || '')
  if (!QUICK_OUTCOMES.includes(outcome)) {
    throw new PeopleError('Status must be Selected, Hold or Not Selected.')
  }
  // A reason only belongs on a rejection; anything typed for another outcome
  // is dropped rather than stored as a contradiction.
  const notSelectedReason = outcome === 'rejected'
    ? text(body.notSelectedReason, { label: 'Not selected reason', max: 2000 }) : null
  const feedback = text(body.feedback, { label: 'Future reference', max: 2000 })
  const candidateExpectations = text(body.candidateExpectations, { label: 'Expectations', max: 2000 })

  const { id } = await repo.withTransaction(async (client) => {
    const candidate = await repo.insertCandidate({
      full_name: candidateName, applied_for: roleApplied, status: outcome, created_by: currentUser.id,
    }, client)
    return repo.insertInterview({
      candidate_id: candidate.id, interview_date: interviewDate, status: 'completed', outcome,
      not_selected_reason: notSelectedReason, feedback, candidate_expectations: candidateExpectations,
      created_by: currentUser.id,
    }, client)
  })
  const [dto] = await withInterviewers([await repo.findInterview(id)])
  return dto
}

/**
 * Record what happened in a round. Allowed for admin/hr, or the round's own
 * interviewer — whatever their role (plan §3.2).
 */
exports.recordOutcome = async (currentUser, id, body = {}) => {
  checkId(id, 'Interview')
  const row = await repo.findInterview(id)
  if (!row) throw notFound('Interview')
  const isInterviewer = row.interviewer_id && row.interviewer_id === currentUser.id
  if (!hasRole(currentUser, ['admin', 'hr']) && !isInterviewer) {
    throw new PeopleError('Only HR or the assigned interviewer can record this round.', 403)
  }

  const status = oneOf(body.status, INTERVIEW_STATUSES, { label: 'Status', fallback: 'completed' })
  if (status === 'scheduled') throw new PeopleError('Use completed, no_show or cancelled.')
  const f = { status }
  if (status === 'completed') {
    f.outcome = oneOf(body.outcome, OUTCOMES, { label: 'Outcome', required: true })
    f.rating = int(body.rating, { label: 'Rating', min: 1, max: 5 })
    f.not_selected_reason = f.outcome === 'rejected'
      ? text(body.notSelectedReason, { label: 'Not selected reason', max: 2000 }) : null
    f.feedback = text(body.feedback, { label: 'Feedback', max: 4000 })
    f.candidate_expectations = text(body.candidateExpectations, { label: 'Expectations', max: 2000 })
  } else {
    f.outcome = null
    f.rating = null
  }

  await repo.updateInterview(id, f)

  if (status === 'completed') {
    const next = STATUS_AFTER_OUTCOME[f.outcome]
    const candidate = await repo.findCandidate(row.candidate_id)
    if (candidate && candidate.status !== next && !candidate.converted_user_id) {
      await repo.updateCandidate(row.candidate_id, { status: next })
      await announceStatus(currentUser, candidate, candidate.status, next)
    }
  }
  const [dto] = await withInterviewers([await repo.findInterview(id)])
  return dto
}

/* ── expectations report ──────────────────────────────────────────────── */

// Plain keyword buckets — explainable, and good enough to answer "what do
// candidates keep asking for?" without pretending to be NLP.
const THEMES = [
  ['pay', /\b(pay|salary|ctc|compensation|hike|package)\b/i],
  ['shift', /\b(shift|timing|timings|hours|night)\b/i],
  ['remote', /\b(remote|wfh|work from home|hybrid)\b/i],
  ['growth', /\b(growth|learning|career|promotion|training)\b/i],
  ['location', /\b(location|relocat\w*|commute|travel)\b/i],
]

exports.expectationsReport = async () => {
  const rows = await repo.listExpectations()
  const themes = Object.fromEntries(THEMES.map(([k]) => [k, 0]))
  let other = 0
  for (const r of rows) {
    const hits = THEMES.filter(([, re]) => re.test(r.candidate_expectations))
    hits.forEach(([k]) => { themes[k] += 1 })
    if (!hits.length) other += 1
  }
  return {
    total: rows.length,
    themes: { ...themes, other },
    items: rows.map((r) => ({
      interviewId: r.id,
      candidateId: r.candidate_id,
      candidateName: r.candidate_name,
      roleApplied: r.applied_for,
      interviewDate: r.interview_date,
      outcome: r.outcome,
      expectations: r.candidate_expectations,
    })),
  }
}

/* ── background sweep ─────────────────────────────────────────────────── */

/** Remind interviewers whose round has passed with no outcome recorded. */
exports.sweepFeedbackPending = async () => {
  const pending = await repo.findFeedbackPending(todayIn())
  for (const r of pending) {
    await notify.dispatch({
      userId: r.interviewer_id,
      type: notify.TYPES.INTERVIEW_FEEDBACK_PENDING,
      title: 'Interview feedback pending',
      message: `Please record the outcome of ${r.candidate_name}'s round ${r.round_number} (${r.interview_date}).`,
      linkTo: '/my-interviews',
      priority: 'normal',
      dedupeWindowMinutes: 60 * 20,
    })
  }
  return { pending: pending.length }
}

exports.CANDIDATE_STATUSES = CANDIDATE_STATUSES
