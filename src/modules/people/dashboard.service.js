// Figures for the HR Management page. Knows nothing about req/res.
//
// The roster is every ACTIVE tracker account minus anyone whose recorded exit
// is behind them. It is not limited to people with an HR profile: attendance
// and leave are logged by every account, and a headcount that read zero until
// HR had keyed in every profile would be wrong for weeks.

const employeesRepo = require('./employees.repo')
const recruitmentRepo = require('./recruitment.repo')
const identity = require('../identity')
const workforce = require('../workforce')
const { BUSINESS_TZ, todayIn, toUtc, addDays } = require('./shared')
const { CANDIDATE_STATUSES } = require('./recruitment.service')

// Still somewhere in the funnel — neither placed, turned away nor gone.
const ACTIVE_CANDIDATE_STATUSES = [
  'applied', 'screening', 'interview_scheduled', 'interviewed', 'hold', 'offered',
]
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

exports.getDashboard = async () => {
  const today = todayIn()
  // Monday..Friday of the current week. On a weekend, the week just finished.
  const dow = toUtc(today).getUTCDay()
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow)
  const friday = addDays(monday, 4)

  const [users, profiles, presence, leave, pipelineRows, interviewsToday] = await Promise.all([
    identity.getActiveUsers(),
    employeesRepo.listAllProfiles(today),
    workforce.getPresenceByDate(monday, friday),
    // Today onward: today's absences plus every still-pending request.
    workforce.getLeaveOverlapping(today, '9999-12-31', BUSINESS_TZ),
    recruitmentRepo.countCandidatesByStatus(),
    recruitmentRepo.countInterviewsOn(today),
  ])

  const profileByUser = new Map(profiles.map((p) => [p.user_id, p]))
  const roster = new Set(
    users
      .filter((u) => profileByUser.get(u.id)?.employment_status !== 'exited')
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
  // Planned/unplanned comes from the request itself when it says so; older
  // requests fall back to "applied before the leave began".
  const isPlanned = (l) => (l.planningType ? l.planningType === 'planned' : l.appliedOn < l.startDate)
  const planned = [...leaveByUser.values()].filter(isPlanned).length
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
      onNotice: profiles.filter((p) => p.employment_status === 'notice_period').length,
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
