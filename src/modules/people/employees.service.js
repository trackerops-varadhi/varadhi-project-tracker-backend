// Employee profiles: validation, PII handling, display enrichment and the
// PII-free team directory. Knows nothing about req/res.
//
// Gates live in employees.routes.js; the one rule routes cannot express —
// "admin/hr, or the person themselves" — is enforced here.

const repo = require('./employees.repo')
const identity = require('../identity')
const notify = require('../notify')
const pii = require('./pii')
const {
  PeopleError, hasRole, todayIn, monthsBetween, yearsBetween,
  text, date, int, oneOf, uuid, skills, pageArgs, notifySafely, BUSINESS_TZ,
} = require('./shared')

// Roles that may see PII and write profiles (plan §3.2).
const HR_ROLES = ['admin', 'hr']

const GENDERS = ['male', 'female', 'other', 'undisclosed']
const MARITAL_STATUSES = ['single', 'married', 'other', 'undisclosed']
const STATUSES = ['active', 'notice_period', 'exited']

// Lazy: workforce's leave service asks people for reporting managers, so a
// top-level require in both directions would be a cycle.
const workforce = () => require('../workforce')

/* ── field validation ─────────────────────────────────────────────────── */

/**
 * body → { column: value } for the columns present in `body`.
 * `partial` (an update) skips absent keys; a create requires the role.
 */
const buildFields = (body, { partial }) => {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
  const want = (k) => !partial || has(k)
  const f = {}

  if (want('designation')) f.designation = text(body.designation, { label: 'Role', max: 120, required: true })
  if (want('employeeCode')) f.employee_code = text(body.employeeCode, { label: 'Employee code', max: 30 })
  if (want('dateOfJoining')) f.date_of_joining = date(body.dateOfJoining, { label: 'Date of joining' })
  if (want('shift')) f.shift = text(body.shift, { label: 'Shift timings', max: 60 })
  if (want('product')) f.product = text(body.product, { label: 'Product', max: 120 })
  if (want('coreSkills')) f.core_skills = skills(body.coreSkills)
  if (want('gender')) f.gender = oneOf(body.gender, GENDERS, { label: 'Gender' })
  if (want('dateOfBirth')) f.date_of_birth = date(body.dateOfBirth, { label: 'Date of birth' })
  if (want('maritalStatus')) f.marital_status = oneOf(body.maritalStatus, MARITAL_STATUSES, { label: 'Marital status' })
  if (want('guardianName')) f.guardian_name = text(body.guardianName, { label: 'Husband / father name', max: 160 })
  if (want('temporaryAddress')) f.temporary_address = text(body.temporaryAddress, { label: 'Temporary address', max: 1000 })
  if (want('permanentAddress')) f.permanent_address = text(body.permanentAddress, { label: 'Permanent address', max: 1000 })
  if (want('educationQualification')) f.education_qualification = text(body.educationQualification, { label: 'Education qualification', max: 160 })
  if (want('collegeName')) f.college_name = text(body.collegeName, { label: 'College name', max: 200 })
  if (want('yearOfCompletion')) f.year_of_completion = int(body.yearOfCompletion, { label: 'Year of completion', min: 1950, max: 2100 })
  if (want('previousCompany')) f.previous_company = text(body.previousCompany, { label: 'Previous company', max: 200 })
  if (want('totalExperienceMonths')) f.total_experience_months = int(body.totalExperienceMonths, { label: 'Total experience (months)', max: 720 })
  if (want('reportingManagerId')) f.reporting_manager_id = uuid(body.reportingManagerId, { label: 'Reporting manager' })

  // Aadhaar: a non-empty value is sealed; an explicit null clears it; an empty
  // string (an untouched form field) leaves whatever is stored alone.
  if (has('aadhaar')) {
    if (body.aadhaar === null) {
      f.aadhaar_encrypted = null
      f.aadhaar_last4 = null
    } else if (String(body.aadhaar).trim() !== '') {
      const sealed = pii.sealAadhaar(body.aadhaar)
      f.aadhaar_encrypted = sealed.aadhaarEncrypted
      f.aadhaar_last4 = sealed.aadhaarLast4
    }
  }

  if (f.date_of_birth && f.date_of_birth > todayIn()) {
    throw new PeopleError('Date of birth cannot be in the future.')
  }
  return f
}

const checkManager = async (managerId, userId) => {
  if (!managerId) return
  if (managerId === userId) throw new PeopleError('A person cannot report to themselves.')
  const account = await identity.getAccountState(managerId)
  if (!account) throw new PeopleError('Reporting manager was not found.', 404)
  if (account.status !== 'active') throw new PeopleError('Reporting manager must be an active user.')
}

const checkEmployeeCode = async (code, userId) => {
  if (!code) return
  const owner = await repo.findByEmployeeCode(code)
  if (owner && owner.user_id !== userId) {
    throw new PeopleError(`Employee code ${code} is already in use.`, 409)
  }
}

/* ── mapping ──────────────────────────────────────────────────────────── */

const card = (c) => (c ? { id: c.id, name: c.name, email: c.email, avatar: c.avatar ?? null } : null)

const tenureEnd = (row, today) =>
  row.employment_status === 'exited' ? row.exit_last_working_date : today

/** PII-free: safe for the directory list and the all-roles team view. */
const mapSummary = (row, cards, today, onLeave) => {
  const person = cards.get(row.user_id)
  return {
    id: row.id,
    userId: row.user_id,
    name: person?.name ?? null,
    email: person?.email ?? null,
    avatar: person?.avatar ?? null,
    accountStatus: person?.status ?? null,
    employeeCode: row.employee_code,
    designation: row.designation,
    product: row.product,
    shift: row.shift,
    coreSkills: row.core_skills || [],
    dateOfJoining: row.date_of_joining,
    tenureMonths: monthsBetween(row.date_of_joining, tenureEnd(row, today)),
    status: row.employment_status,
    onLeaveToday: onLeave.has(row.user_id),
    reportingManager: card(cards.get(row.reporting_manager_id)),
    exit: row.exit_id ? {
      id: row.exit_id,
      exitType: row.exit_type,
      resignationDate: row.exit_resignation_date,
      lastWorkingDate: row.exit_last_working_date,
    } : null,
    createdAt: row.created_at,
  }
}

/** Full record, for admin/hr or the person themselves. Aadhaar stays masked. */
const mapDetail = (row, cards, today, onLeave) => ({
  ...mapSummary(row, cards, today, onLeave),
  gender: row.gender,
  dateOfBirth: row.date_of_birth,
  age: yearsBetween(row.date_of_birth, today),
  maritalStatus: row.marital_status,
  guardianName: row.guardian_name,
  temporaryAddress: row.temporary_address,
  permanentAddress: row.permanent_address,
  aadhaarMasked: pii.maskAadhaar(row.aadhaar_last4),
  hasAadhaar: Boolean(row.aadhaar_last4),
  educationQualification: row.education_qualification,
  collegeName: row.college_name,
  yearOfCompletion: row.year_of_completion,
  previousCompany: row.previous_company,
  totalExperienceMonths: row.total_experience_months,
  updatedAt: row.updated_at,
})

// One identity call and one leave call per page, never per row.
const enrich = async (rows, today, mapper) => {
  const ids = rows.flatMap((r) => [r.user_id, r.reporting_manager_id]).filter(Boolean)
  const [cards, leave] = await Promise.all([
    identity.getUserCards(ids),
    rows.length ? workforce().getLeaveOverlapping(today, today, BUSINESS_TZ) : [],
  ])
  const onLeave = new Set(leave.filter((l) => l.status === 'approved').map((l) => l.userId))
  return rows.map((r) => mapper(r, cards, today, onLeave))
}

/* ── reads ────────────────────────────────────────────────────────────── */

exports.listEmployees = async (query = {}) => {
  const today = todayIn()
  const { page, limit, offset } = pageArgs(query)

  // Search by name/email through identity, then filter with one = ANY()
  // predicate so the pagination total stays correct (plan §4.5).
  let userIds = null
  const term = String(query.search || '').trim()
  if (term) {
    userIds = await identity.searchUserIds(term)
    if (userIds.length === 0) return { items: [], total: 0, page, limit }
  }

  const status = query.status && query.status !== 'all'
    ? oneOf(query.status, STATUSES, { label: 'Status' }) : null
  const managerId = query.managerId && query.managerId !== 'all'
    ? uuid(query.managerId, { label: 'Manager' }) : null

  const { rows, total } = await repo.listProfiles({
    today, userIds, status, managerId,
    product: query.product && query.product !== 'all' ? String(query.product) : null,
    sort: repo.SORT_KEYS.includes(query.sort) ? query.sort : 'created',
    order: query.order === 'asc' ? 'asc' : 'desc',
    limit, offset,
  })
  return { items: await enrich(rows, today, mapSummary), total, page, limit }
}

exports.listProducts = async () => repo.distinctProducts()

/** Active tracker accounts that do not have an HR profile yet. */
exports.listEligibleUsers = async () => {
  const [users, profiled] = await Promise.all([identity.getActiveUsers(), repo.listProfileUserIds()])
  const taken = new Set(profiled)
  return users
    .filter((u) => !taken.has(u.id))
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }))
}

const loadDetail = async (userId) => {
  const today = todayIn()
  const row = await repo.findProfile(today, userId)
  if (!row) return null
  const [dto] = await enrich([row], today, mapDetail)
  return dto
}

exports.getEmployee = async (currentUser, userId) => {
  uuid(userId, { label: 'User', required: true })
  if (!hasRole(currentUser, HR_ROLES) && currentUser.id !== userId) {
    throw new PeopleError('You can only view your own profile.', 403)
  }
  const dto = await loadDetail(userId)
  if (!dto) throw new PeopleError('Employee profile not found.', 404)
  return dto
}

exports.getMe = async (currentUser) => loadDetail(currentUser.id)

/* ── writes ───────────────────────────────────────────────────────────── */

const PROFILE_GAPS = [
  ['temporary_address', 'temporary address'],
  ['permanent_address', 'permanent address'],
]

exports.createEmployee = async (currentUser, body = {}) => {
  const userId = uuid(body.userId, { label: 'a user', required: true })
  const fields = buildFields(body, { partial: false })

  const account = await identity.getAccountState(userId)
  if (!account) throw new PeopleError('Selected user was not found.', 404)
  if (account.status === 'inactive') {
    throw new PeopleError('Inactive users cannot be added to the employee directory.')
  }
  if (await repo.findProfile(todayIn(), userId)) {
    throw new PeopleError('This user is already in the employee directory.', 409)
  }
  await checkManager(fields.reporting_manager_id, userId)
  await checkEmployeeCode(fields.employee_code, userId)

  try {
    await repo.insertProfile(userId, { ...fields, created_by: currentUser.id })
  } catch (err) {
    // Two people saving the same person (or code) at once: the UNIQUE wins.
    if (err.code === '23505') throw new PeopleError('This user or employee code is already in the directory.', 409)
    throw err
  }

  const missing = PROFILE_GAPS.filter(([col]) => !fields[col]).map(([, label]) => label)
  if (missing.length && userId !== currentUser.id) {
    await notifySafely(() => notify.dispatch({
      userId,
      type: notify.TYPES.EMPLOYEE_PROFILE_INCOMPLETE,
      title: 'Complete your employee profile',
      message: `HR added your employee profile. Please add your ${missing.join(' and ')}.`,
      linkTo: '/settings#hr-profile',
      priority: 'low',
    }))
  }
  return loadDetail(userId)
}

exports.updateEmployee = async (currentUser, userId, body = {}) => {
  uuid(userId, { label: 'User', required: true })
  const fields = buildFields(body, { partial: true })
  await checkManager(fields.reporting_manager_id, userId)
  await checkEmployeeCode(fields.employee_code, userId)

  let found
  try {
    found = await repo.updateProfile(userId, { ...fields, updated_by: currentUser.id })
  } catch (err) {
    if (err.code === '23505') throw new PeopleError('That employee code is already in use.', 409)
    throw err
  }
  if (!found) throw new PeopleError('Employee profile not found.', 404)
  return loadDetail(userId)
}

/** Everyone may edit their own two addresses — and nothing else (plan §3.2). */
exports.updateMyAddresses = async (currentUser, body = {}) => {
  const fields = {}
  if ('temporaryAddress' in body) fields.temporary_address = text(body.temporaryAddress, { label: 'Temporary address', max: 1000 })
  if ('permanentAddress' in body) fields.permanent_address = text(body.permanentAddress, { label: 'Permanent address', max: 1000 })
  if (Object.keys(fields).length === 0) throw new PeopleError('Nothing to update.')

  const found = await repo.updateProfile(currentUser.id, { ...fields, updated_by: currentUser.id })
  if (!found) throw new PeopleError('HR has not created your employee profile yet.', 404)
  return loadDetail(currentUser.id)
}

/**
 * The full Aadhaar number, one record per call (plan §7.1). Every reveal is
 * logged with who looked at whose number.
 */
exports.revealAadhaar = async (currentUser, userId) => {
  uuid(userId, { label: 'User', required: true })
  const blob = await repo.findAadhaarBlob(userId)
  if (blob === undefined) throw new PeopleError('Employee profile not found.', 404)
  if (!blob) throw new PeopleError('No Aadhaar number is stored for this employee.', 404)

  const digits = pii.openAadhaar(blob)
  console.info(`[people] aadhaar revealed: actor=${currentUser.id} subject=${userId} ok=${Boolean(digits)}`)
  if (!digits) {
    throw new PeopleError('The stored Aadhaar number could not be decrypted (the PII key may have changed).', 409)
  }
  return { userId, aadhaar: pii.formatAadhaar(digits) }
}

/* ── team directory (all roles, PII-free by construction) ─────────────── */

/**
 * Everyone still employed, grouped by reporting manager. Built from mapSummary,
 * which never reads an address, DOB, guardian, Aadhaar or exit reason column —
 * so this surface cannot leak them whatever the caller's role (plan §7.2).
 */
exports.getTeamDirectory = async () => {
  const today = todayIn()
  const rows = (await repo.listAllProfiles(today)).filter((r) => r.employment_status !== 'exited')
  const members = await enrich(rows, today, mapSummary)

  const groups = new Map()
  for (const m of members) {
    const key = m.reportingManager?.id ?? 'none'
    if (!groups.has(key)) groups.set(key, { manager: m.reportingManager, members: [] })
    // Exit details are HR data; the team view only needs to know "on notice".
    const { exit, accountStatus, ...rest } = m // eslint-disable-line no-unused-vars
    groups.get(key).members.push(rest)
  }
  const list = [...groups.values()]
  for (const g of list) g.members.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  // Named managers first, alphabetically; "no manager" last.
  list.sort((a, b) => {
    if (!a.manager) return 1
    if (!b.manager) return -1
    return (a.manager.name || '').localeCompare(b.manager.name || '')
  })
  return { groups: list, total: members.length }
}

/* ── cross-module accessors (exported through index.js) ──────────────── */

/**
 * Map<userId, managerId|null> — the resolver workforce registers for its org
 * chart port. Batched because it is called for a whole sweep at once, and
 * because the single-id version it replaced was being awaited inside a loop.
 *
 * Built on getEmployeeCards so there is one query and one definition of "the
 * profile in force today". A user with no profile is simply absent.
 */
exports.getReportingManagerIds = async (userIds) => {
  const cards = await exports.getEmployeeCards(userIds)
  return new Map([...cards].map(([userId, c]) => [userId, c.reportingManagerId ?? null]))
}

exports.getTeamMemberIds = async (managerId) => {
  const rows = await repo.listAllProfiles(todayIn())
  return rows
    .filter((r) => r.reporting_manager_id === managerId && r.employment_status !== 'exited')
    .map((r) => r.user_id)
}

exports.getEmployeeCards = async (userIds) => {
  const rows = await repo.findProfilesByUserIds(todayIn(), [...new Set(userIds || [])].filter(Boolean))
  return new Map(rows.map((r) => [r.user_id, {
    designation: r.designation,
    product: r.product,
    dateOfJoining: r.date_of_joining,
    reportingManagerId: r.reporting_manager_id,
    status: r.employment_status,
  }]))
}

exports.HR_ROLES = HR_ROLES

/**
 * Validate profile input without writing anything — candidate conversion
 * checks the profile BEFORE it invites an account, so a bad joining date does
 * not leave an invited user with no profile behind.
 */
exports.validateProfileInput = async (body, userId = null) => {
  const fields = buildFields(body, { partial: false })
  await checkManager(fields.reporting_manager_id, userId)
  await checkEmployeeCode(fields.employee_code, userId)
  return fields
}
