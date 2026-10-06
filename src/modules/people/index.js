// PUBLIC INTERFACE — people (employee_profiles · employee_exits · candidates ·
// interviews · candidate_resumes)
//
// The only file outside this directory that anything else may require.
// Module 9 — see docs/Module-9-People-Plan.md.
//
// people owns WHO a person is (profile, exit, candidacy); workforce owns WHAT a
// person did on a given day. people reads identity and workforce through their
// interfaces; workforce reads reporting managers back through the accessors
// below (lazily, to avoid a require cycle).

const employees = require('./employees.service')
const jobs = require('./jobs')

// More specific prefixes first: express matches mounts in order.
exports.mount = [
  { path: '/api/people/exits', router: require('./exits.routes') },
  { path: '/api/people/candidates', router: require('./candidates.routes') },
  { path: '/api/people/interviews', router: require('./interviews.routes') },
  { path: '/api/people', router: require('./employees.routes') },
]

exports.jobs = [
  { name: 'interview-feedback', start: jobs.start, stop: jobs.stop },
]

/* ── Cross-module accessors — async, batched, never a join ──────────────── */

/** The person's reporting manager's user id, or null. */
exports.getReportingManagerId = (userId) => employees.getReportingManagerId(userId)

/** User ids of everyone still employed who reports to `managerId`. */
exports.getTeamMemberIds = (managerId) => employees.getTeamMemberIds(managerId)

/** Map<userId, { designation, product, dateOfJoining, reportingManagerId, status }> */
exports.getEmployeeCards = (userIds) => employees.getEmployeeCards(userIds)

// Test seam, like defects' runSlaSweepNow.
exports.runInterviewFeedbackReminderNow = () => jobs.runInterviewFeedbackReminderNow()
