// People (HR) business logic: validation, status derivation, display
// enrichment and the HR dashboard figures. Knows nothing about req/res.
//
// Every route that reaches this file is already restrictTo('admin','manager'),
// so there is no row-level scoping here — HR records are all-or-nothing.

const repo = require('./repo')
const identity = require('../identity')
const workforce = require('../workforce')

// "Today" for an HR screen is the office's calendar day, not the server's.
// Render runs in UTC, so between midnight and 05:30 IST a UTC "today" would
// still be yesterday and every attendance figure would be a day behind.
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'Asia/Kolkata'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const EXIT_TYPES = ['resignation', 'termination', 'absconded', 'contract_end']
const REASON_CATEGORIES = [
  'better_opportunity', 'compensation', 'relocation', 'higher_studies',
  'personal', 'health', 'work_environment', 'performance', 'other',
]
// The form offers the three outcomes the hiring sheet records.
const INTERVIEW_OUTCOMES = ['selected', 'hold', 'rejected']
const CANDIDATE_STATUSES = [
  'applied', 'screening', 'interview_scheduled', 'interviewed', 'selected',
  'hold', 'rejected', 'offered', 'joined', 'declined',
]
// Still somewhere in the funnel — neither placed, turned away nor gone.
const ACTIVE_CANDIDATE_STATUSES = [
  'applied', 'screening', 'interview_scheduled', 'interviewed', 'hold', 'offered',
]

const MAX_SKILLS = 30

class PeopleError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}
exports.PeopleError = PeopleError

/* ── small helpers ────────────────────────────────────────────────────── */

const todayIn = (timeZone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())

const toUtc = (ymd) => new Date(`${ymd}T00:00:00Z`)
const addDays = (ymd, n) => {
  const d = toUtc(ymd)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const isValidDate = (s) => {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const d = toUtc(s)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

// Whole months from `from` to `to`, never negative.
const monthsBetween = (from, to) => {
  if (!from || !to) return null
  const [y1, m1, d1] = from.split('-').map(Number)
  const [y2, m2, d2] = to.split('-').map(Number)
  const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0)
  return Math.max(0, months)
}

const text = (value, { label, max, required = false }) => {
  const s = value === undefined || value === null ? '' : String(value).trim()
  if (!s) {
    if (required) throw new PeopleError(`${label} is required.`)
    return null
  }
  if (s.length > max) throw new PeopleError(`${label} must be ${max} characters or fewer.`)
  return s
}

const date = (value, { label, required = false }) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new PeopleError(`${label} is required.`)
    return null
  }
  if (!isValidDate(value)) throw new PeopleError(`${label} must be a valid date (YYYY-MM-DD).`)
  return value
}

// Accepts the form's comma-separated string or an array.
const skills = (value) => {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',')
  const cleaned = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))]
  if (cleaned.length > MAX_SKILLS) throw new PeopleError(`At most ${MAX_SKILLS} skills.`)
  if (cleaned.some((s) => s.length > 60)) throw new PeopleError('Each skill must be 60 characters or fewer.')
  return cleaned
}

/**
 * An exit counts against a profile only if it happened after the person
 * (re)joined — a rejoiner's old exit must not mark them as gone.
 */
const relevantExit = (profile, exit) => {
  if (!exit) return null
  const doj = profile?.date_of_joining
  return !doj || exit.resignation_date >= doj ? exit : null
}

const statusFor = (exit, today) => {
  if (!exit) return 'active'
  return exit.last_working_date >= today ? 'notice_period' : 'exited'
}

/* ── mapping ──────────────────────────────────────────────────────────── */

// `card` may be undefined for a hard-deleted account; the row still renders.
const mapEmployee = (row, card, exit, today, onLeaveToday) => {
  const status = statusFor(exit, today)
  const tenureEnd = status === 'exited' ? exit.last_working_date : today
  return {
    id: row.id,
    userId: row.user_id,
    name: card?.name ?? null,
    email: card?.email ?? null,
    avatar: card?.avatar ?? null,
    accountRole: card?.role ?? null,
    accountStatus: card?.status ?? null,
    designation: row.designation,
    shift: row.shift,
    product: row.product,
    coreSkills: row.core_skills || [],
    dateOfJoining: row.date_of_joining,
    tenureMonths: monthsBetween(row.date_of_joining, tenureEnd),
    status,
    onLeaveToday: Boolean(onLeaveToday),
    exit: exit ? {
      id: exit.id,
      exitType: exit.exit_type,
      resignationDate: exit.resignation_date,
      lastWorkingDate: exit.last_working_date,
    } : null,
    createdAt: row.created_at,
  }
}

const mapExit = (row, card) => ({
  id: row.id,
  userId: row.user_id,
  name: card?.name ?? null,
  email: card?.email ?? null,
  exitType: row.exit_type,
  designation: row.designation,
  product: row.product,
  resignationDate: row.resignation_date,
  lastWorkingDate: row.last_working_date,
  reasonCategory: row.reason_category,
  reasonDetail: row.reason_detail,
  exitFeedback: row.exit_feedback,
  tenureMonths: row.tenure_months,
  createdAt: row.created_at,
})

const mapInterview = (row) => ({
  id: row.id,
  candidateId: row.candidate_id,
  candidateName: row.candidate_name,
  roleApplied: row.applied_for,
  candidateStatus: row.candidate_status,
  roundNumber: row.round_number,
  interviewDate: row.interview_date,
  outcome: row.outcome,
  notSelectedReason: row.not_selected_reason,
  feedback: row.feedback,
  candidateExpectations: row.candidate_expectations,
  createdAt: row.created_at,
})

/* ── employees ────────────────────────────────────────────────────────── */

exports.listEmployees = async () => {
  const today = todayIn(BUSINESS_TZ)
  const profiles = await repo.listProfiles()
  if (profiles.length === 0) return []

  const userIds = profiles.map((p) => p.user_id)
  const [cards, exits, leave] = await Promise.all([
    identity.getUserCards(userIds),
    repo.findLatestExits(userIds),
    workforce.getLeaveOverlapping(today, today, BUSINESS_TZ),
  ])
  const exitByUser = new Map(exits.map((e) => [e.user_id, e]))
  const onLeave = new Set(leave.filter((l) => l.status === 'approved').map((l) => l.userId))

  return profiles
    .map((p) => mapEmployee(
      p, cards.get(p.user_id), relevantExit(p, exitByUser.get(p.user_id)), today,
      onLeave.has(p.user_id)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
}

/** Active tracker accounts that do not have an HR profile yet. */
exports.listEligibleUsers = async () => {
  const [users, profiled] = await Promise.all([
    identity.getActiveUsers(),
    repo.listProfileUserIds(),
  ])
  const taken = new Set(profiled)
  return users
    .filter((u) => !taken.has(u.id))
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }))
}

exports.createEmployee = async (currentUser, body = {}) => {
  const userId = String(body.userId || '')
  if (!UUID_RE.test(userId)) throw new PeopleError('Please select a user.')

  const designation = text(body.designation, { label: 'Role', max: 120, required: true })
  const shift = text(body.shift, { label: 'Shift timings', max: 60 })
  const product = text(body.product, { label: 'Product', max: 120 })
  const dateOfJoining = date(body.dateOfJoining, { label: 'Date of joining' })
  const coreSkills = skills(body.coreSkills)

  const account = await identity.getAccountState(userId)
  if (!account) throw new PeopleError('Selected user was not found.', 404)
  if (account.status !== 'active') {
    throw new PeopleError('Only active users can be added to the employee directory.')
  }
  if (await repo.findProfileByUserId(userId)) {
    throw new PeopleError('This user is already in the employee directory.', 409)
  }

  let row
  try {
    row = await repo.insertProfile({
      userId, dateOfJoining, designation, shift, product, coreSkills,
      createdBy: currentUser.id,
    })
  } catch (err) {
    // Two admins adding the same person at once: the UNIQUE(user_id) wins.
    if (err.code === '23505') {
      throw new PeopleError('This user is already in the employee directory.', 409)
    }
    throw err
  }

  const cards = await identity.getUserCards([userId])
  return mapEmployee(row, cards.get(userId), null, todayIn(BUSINESS_TZ), false)
}

/* ── exits ────────────────────────────────────────────────────────────── */

exports.listExits = async () => {
  const rows = await repo.listExits()
  const cards = await identity.getUserCards(rows.map((r) => r.user_id))
  return rows.map((r) => mapExit(r, cards.get(r.user_id)))
}

exports.createExit = async (currentUser, body = {}) => {
  const userId = String(body.userId || '')
  if (!UUID_RE.test(userId)) throw new PeopleError('Please select an employee.')

  const exitType = body.exitType ? String(body.exitType) : 'resignation'
  if (!EXIT_TYPES.includes(exitType)) {
    throw new PeopleError(`Exit type must be one of: ${EXIT_TYPES.join(', ')}.`)
  }
  const resignationDate = date(body.resignationDate, { label: 'Resignation date', required: true })
  const lastWorkingDate = date(body.lastWorkingDate, { label: 'Last working day', required: true })
  if (lastWorkingDate < resignationDate) {
    throw new PeopleError('Last working day cannot be before the resignation date.')
  }
  const reasonCategory = String(body.reasonCategory || '')
  if (!REASON_CATEGORIES.includes(reasonCategory)) {
    throw new PeopleError('Please choose a reason category.')
  }
  const reasonDetail = text(body.reasonDetail, { label: 'Reason', max: 2000, required: true })
  const exitFeedback = text(body.exitFeedback, { label: 'Exit feedback', max: 2000 })

  const profile = await repo.findProfileByUserId(userId)
  if (!profile) {
    throw new PeopleError('Add this person to the employee directory before recording an exit.', 404)
  }
  if (profile.date_of_joining && resignationDate < profile.date_of_joining) {
    throw new PeopleError('Resignation date cannot be before the date of joining.')
  }
  const [latest] = await repo.findLatestExits([userId])
  if (relevantExit(profile, latest)) {
    throw new PeopleError('An exit is already recorded for this employee.', 409)
  }

  const row = await repo.insertExit({
    userId,
    exitType,
    designation: profile.designation,
    product: profile.product,
    resignationDate,
    lastWorkingDate,
    reasonCategory,
    reasonDetail,
    exitFeedback,
    tenureMonths: monthsBetween(profile.date_of_joining, lastWorkingDate),
    recordedBy: currentUser.id,
  })
  const cards = await identity.getUserCards([userId])
  return mapExit(row, cards.get(userId))
}

/* ── interviews ───────────────────────────────────────────────────────── */

exports.listInterviews = async () => (await repo.listInterviews()).map(mapInterview)

exports.createInterview = async (currentUser, body = {}) => {
  const candidateName = text(body.candidateName, { label: 'Candidate name', max: 160, required: true })
  const roleApplied = text(body.roleApplied, { label: 'Role applied for', max: 120, required: true })
  const interviewDate = date(body.interviewDate, { label: 'Interview date', required: true })
  const outcome = String(body.outcome || '')
  if (!INTERVIEW_OUTCOMES.includes(outcome)) {
    throw new PeopleError('Status must be Selected, Hold or Not Selected.')
  }
  // A reason only belongs on a rejection; anything typed for another outcome
  // is dropped rather than stored as a contradiction.
  const notSelectedReason = outcome === 'rejected'
    ? text(body.notSelectedReason, { label: 'Not selected reason', max: 2000 })
    : null
  const feedback = text(body.feedback, { label: 'Future reference', max: 2000 })
  const candidateExpectations = text(body.candidateExpectations, { label: 'Expectations', max: 2000 })

  const row = await repo.insertCandidateWithInterview({
    candidateName,
    appliedFor: roleApplied,
    // The candidate's pipeline state follows the outcome of this interview.
    status: outcome,
    interviewDate,
    outcome,
    notSelectedReason,
    feedback,
    candidateExpectations,
    createdBy: currentUser.id,
  })
  return mapInterview(row)
}

/* ── dashboard ────────────────────────────────────────────────────────── */

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Figures for the HR Management page.
 *
 * The roster is every ACTIVE tracker account minus anyone whose recorded exit
 * is behind them. It is not limited to people with an HR profile: attendance
 * and leave are logged by every account, and a headcount that read zero until
 * HR had keyed in every profile would be wrong for weeks.
 */
exports.getDashboard = async () => {
  const today = todayIn(BUSINESS_TZ)
  // Monday..Friday of the current week. On a weekend, the week just finished.
  const dow = toUtc(today).getUTCDay()
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow)
  const friday = addDays(monday, 4)

  const [users, profiles, exits, presence, leave, pipelineRows, interviewsToday] =
    await Promise.all([
      identity.getActiveUsers(),
      repo.listProfiles(),
      repo.findLatestExits(),
      workforce.getPresenceByDate(monday, friday),
      // Today onward: today's absences plus every still-pending request.
      workforce.getLeaveOverlapping(today, '9999-12-31', BUSINESS_TZ),
      repo.countCandidatesByStatus(),
      repo.countInterviewsOn(today),
    ])

  const profileByUser = new Map(profiles.map((p) => [p.user_id, p]))
  const exitByUser = new Map(exits.map((e) => [e.user_id, e]))
  const roster = new Set(
    users
      .filter((u) => {
        const exit = relevantExit(profileByUser.get(u.id), exitByUser.get(u.id))
        return statusFor(exit, today) !== 'exited'
      })
      .map((u) => u.id)
  )
  const total = roster.size
  const inRoster = (ids) => [...ids].filter((id) => roster.has(id)).length

  const monthPrefix = today.slice(0, 8) // 'YYYY-MM-'
  const newThisMonth = profiles.filter(
    (p) => roster.has(p.user_id) && p.date_of_joining?.startsWith(monthPrefix)
  ).length

  const presentToday = inRoster(presence.get(today) || [])

  const todaysLeave = leave.filter(
    (l) => l.status === 'approved' && l.startDate <= today && l.endDate >= today && roster.has(l.userId)
  )
  // One person, one count, even with two overlapping approved requests.
  const leaveByUser = new Map(todaysLeave.map((l) => [l.userId, l]))
  // Planned = applied for before the leave began; raised on or after the
  // first day means it was unplanned.
  const planned = [...leaveByUser.values()].filter((l) => l.appliedOn < l.startDate).length
  const pendingLeave = leave.filter((l) => l.status === 'pending').length

  const week = []
  for (let i = 0; i < 5; i++) {
    const d = addDays(monday, i)
    week.push({
      date: d,
      day: WEEKDAY[toUtc(d).getUTCDay()],
      present: inRoster(presence.get(d) || []),
      isFuture: d > today,
    })
  }

  const pipeline = Object.fromEntries(CANDIDATE_STATUSES.map((s) => [s, 0]))
  for (const r of pipelineRows) pipeline[r.status] = r.n

  return {
    asOf: today,
    timeZone: BUSINESS_TZ,
    employees: {
      total,
      newThisMonth,
      withProfile: profiles.filter((p) => roster.has(p.user_id)).length,
    },
    attendance: {
      presentToday,
      attendancePercent: total > 0 ? Math.round((presentToday / total) * 1000) / 10 : 0,
      week,
    },
    leave: {
      onLeaveToday: leaveByUser.size,
      planned,
      unplanned: leaveByUser.size - planned,
      pending: pendingLeave,
    },
    recruitment: {
      pipeline,
      activeCandidates: ACTIVE_CANDIDATE_STATUSES.reduce((n, s) => n + pipeline[s], 0),
      interviewsToday,
    },
  }
}

exports.REASON_CATEGORIES = REASON_CATEGORIES
exports.EXIT_TYPES = EXIT_TYPES
