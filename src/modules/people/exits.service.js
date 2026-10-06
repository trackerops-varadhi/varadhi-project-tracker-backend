// Attrition: recording and correcting exits, and the analytics that answer
// "why are people leaving?". Knows nothing about req/res.

const repo = require('./exits.repo')
const employeesRepo = require('./employees.repo')
const identity = require('../identity')
const notify = require('../notify')
const {
  PeopleError, todayIn, addDays, monthsBetween, text, date, oneOf, uuid,
  notifySafely, UUID_RE,
} = require('./shared')

const EXIT_TYPES = ['resignation', 'termination', 'absconded', 'contract_end']
const REASON_CATEGORIES = [
  'better_opportunity', 'compensation', 'relocation', 'higher_studies',
  'personal', 'health', 'work_environment', 'performance', 'other',
]

const mapExit = (row, cards) => {
  const person = cards.get(row.user_id)
  const recorder = cards.get(row.recorded_by)
  return {
    id: row.id,
    userId: row.user_id,
    name: person?.name ?? null,
    email: person?.email ?? null,
    exitType: row.exit_type,
    designation: row.designation,
    product: row.product,
    resignationDate: row.resignation_date,
    lastWorkingDate: row.last_working_date,
    reasonCategory: row.reason_category,
    reasonDetail: row.reason_detail,
    exitFeedback: row.exit_feedback,
    tenureMonths: row.tenure_months,
    recordedBy: recorder ? { id: recorder.id, name: recorder.name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const withCards = async (rows) => {
  const cards = await identity.getUserCards(rows.flatMap((r) => [r.user_id, r.recorded_by]))
  return rows.map((r) => mapExit(r, cards))
}

exports.listExits = async () => withCards(await repo.listExits())

exports.createExit = async (currentUser, body = {}) => {
  const userId = uuid(body.userId, { label: 'an employee', required: true })
  const exitType = oneOf(body.exitType, EXIT_TYPES, { label: 'Exit type', fallback: 'resignation' })
  const resignationDate = date(body.resignationDate, { label: 'Resignation date', required: true })
  const lastWorkingDate = date(body.lastWorkingDate, { label: 'Last working day', required: true })
  if (lastWorkingDate < resignationDate) {
    throw new PeopleError('Last working day cannot be before the resignation date.')
  }
  const reasonCategory = oneOf(body.reasonCategory, REASON_CATEGORIES, { label: 'Reason category', required: true })
  const reasonDetail = text(body.reasonDetail, { label: 'Reason', max: 2000, required: true })
  const exitFeedback = text(body.exitFeedback, { label: 'Exit feedback', max: 2000 })

  const profile = await employeesRepo.findProfile(todayIn(), userId)
  if (!profile) {
    throw new PeopleError('Add this person to the employee directory before recording an exit.', 404)
  }
  if (profile.date_of_joining && resignationDate < profile.date_of_joining) {
    throw new PeopleError('Resignation date cannot be before the date of joining.')
  }
  // The profile CTE only reports exits after the (re)joining date.
  if (profile.exit_id) throw new PeopleError('An exit is already recorded for this employee.', 409)

  const row = await repo.insertExit({
    userId,
    exitType,
    // Snapshots: a later profile edit must not rewrite an attrition report.
    designation: profile.designation,
    product: profile.product,
    resignationDate,
    lastWorkingDate,
    reasonCategory,
    reasonDetail,
    exitFeedback,
    // Materialised now, like bug SLA deadlines (plan §2.3).
    tenureMonths: monthsBetween(profile.date_of_joining, lastWorkingDate),
    recordedBy: currentUser.id,
  })
  const [dto] = await withCards([row])

  await notifySafely(() => notify.dispatchToRoles({
    roles: ['admin', 'hr'],
    type: notify.TYPES.RESIGNATION_RECORDED,
    title: 'Exit recorded',
    message: `${dto.name ?? 'An employee'} (${dto.designation}) — last working day ${dto.lastWorkingDate}.`,
    linkTo: '/people?tab=attrition',
    priority: 'high',
    excludeUserId: currentUser.id,
  }))
  return dto
}

exports.updateExit = async (currentUser, id, body = {}) => {
  if (!UUID_RE.test(String(id || ''))) throw new PeopleError('Exit record not found.', 404)
  const existing = await repo.findExit(id)
  if (!existing) throw new PeopleError('Exit record not found.', 404)

  const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
  const f = {}
  if (has('exitType')) f.exit_type = oneOf(body.exitType, EXIT_TYPES, { label: 'Exit type', required: true })
  if (has('resignationDate')) f.resignation_date = date(body.resignationDate, { label: 'Resignation date', required: true })
  if (has('lastWorkingDate')) f.last_working_date = date(body.lastWorkingDate, { label: 'Last working day', required: true })
  if (has('reasonCategory')) f.reason_category = oneOf(body.reasonCategory, REASON_CATEGORIES, { label: 'Reason category', required: true })
  if (has('reasonDetail')) f.reason_detail = text(body.reasonDetail, { label: 'Reason', max: 2000, required: true })
  if (has('exitFeedback')) f.exit_feedback = text(body.exitFeedback, { label: 'Exit feedback', max: 2000 })

  const resignation = f.resignation_date ?? existing.resignation_date
  const lastDay = f.last_working_date ?? existing.last_working_date
  if (lastDay < resignation) throw new PeopleError('Last working day cannot be before the resignation date.')

  // A corrected last working day is a correction of the exit itself, so the
  // tenure snapshot follows it — still from the joining date on file today.
  if (f.last_working_date) {
    const profile = await employeesRepo.findProfile(todayIn(), existing.user_id)
    f.tenure_months = monthsBetween(profile?.date_of_joining ?? null, lastDay)
  }

  const row = await repo.updateExit(id, f)
  const [dto] = await withCards([row])
  return dto
}

/**
 * Attrition analytics for [from, to] (default: the last 12 months). Counts by
 * reason, exit type, month and product, plus the attrition rate against the
 * current headcount.
 */
exports.analytics = async (query = {}) => {
  const today = todayIn()
  const to = date(query.to, { label: 'To' }) || today
  const from = date(query.from, { label: 'From' }) || addDays(to, -365)
  if (from > to) throw new PeopleError('"From" must be on or before "To".')

  const [data, headcount] = await Promise.all([
    repo.analytics(from, to),
    identity.getActiveUserCount(),
  ])
  const exits = data.totals.exits
  return {
    from,
    to,
    totalExits: exits,
    averageTenureMonths: data.totals.avg_tenure_months,
    headcount,
    // Exits in the window over current headcount — a simple, explainable rate.
    attritionRate: headcount > 0 ? Math.round((exits / headcount) * 1000) / 10 : 0,
    byReason: data.byReason,
    byType: data.byType,
    byMonth: data.byMonth,
    byProduct: data.byProduct,
  }
}

exports.EXIT_TYPES = EXIT_TYPES
exports.REASON_CATEGORIES = REASON_CATEGORIES
