// PUBLIC INTERFACE — people (employee_profiles · employee_exits · candidates ·
// interviews · candidate_resumes)
//
// The only file outside this directory that anything else may require.
// Module 9 — see docs/Module-9-People-Plan.md.
//
// people owns WHO a person is (profile, exit, candidacy); workforce owns WHAT a
// person did on a given day. people reads identity and workforce through their
// interfaces.
//
// Workforce does NOT read people back. It used to, for one thing — the
// reporting manager to escalate to — and that made the two modules a cycle,
// which cannot be extracted into separate services. Workforce now declares the
// question as a port and this module answers it in subscribe() below. The
// dependency points one way: people -> workforce.

const employees = require('./employees.service')
const jobs = require('./jobs')

// Lazy: required only when subscribe() wires the resolver, so loading people
// does not pull workforce in with it.
const workforce = () => require('../workforce')

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

/** Map<userId, managerId|null>. Also the resolver registered in subscribe(). */
exports.getReportingManagerIds = (userIds) => employees.getReportingManagerIds(userIds)

/** User ids of everyone still employed who reports to `managerId`. */
exports.getTeamMemberIds = (managerId) => employees.getTeamMemberIds(managerId)

/** Map<userId, { designation, product, dateOfJoining, reportingManagerId, status }> */
exports.getEmployeeCards = (userIds) => employees.getEmployeeCards(userIds)

/* ── Boot wiring ─────────────────────────────────────────────────────────── */
//
// Not an event subscription, but the same hook and the same contract: called
// once by server.js for every module, outside the ENABLE_CRON switch, and
// idempotent. It lives here rather than in server.js so it travels with the
// module — when people is extracted, this is where registering its HTTP
// endpoint as the resolver belongs.
exports.subscribe = () => {
  workforce().setReportingManagerResolver(employees.getReportingManagerIds)
  console.log('[people] subscribed — reporting-manager resolver registered with workforce')
}

// Test seam, like defects' runSlaSweepNow.
exports.runInterviewFeedbackReminderNow = () => jobs.runInterviewFeedbackReminderNow()

/* ── What this module consumes ───────────────────────────────────────────── */
//
// GENERATED, and checked by `npm run lint:contracts`. Every name here is read
// from another module's index.js, so this list IS this module's half of the
// future HTTP contract: extract it and these become the calls its client makes.
// Do not hand-edit — change the code, then run `npm run lint:contracts -- --write`.
exports.consumes = {
  files: ['getFileExtension', 'sanitizeFileName'],
  identity: ['InviteError', 'getAccountState', 'getActiveUserCount', 'getActiveUsers', 'getUserCards', 'inviteUser', 'searchUserIds'],
  notify: ['TYPES', 'dispatch', 'dispatchToRoles'],
  workforce: ['getLeaveOverlapping', 'getPresenceByDate', 'setReportingManagerResolver'],
}
