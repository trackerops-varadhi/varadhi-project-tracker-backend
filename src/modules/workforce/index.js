// PUBLIC INTERFACE — workforce (leave_requests · time_logs)
//
// The only file outside this directory that anything else may require.
//
// `mount` is the module's HTTP surface, consumed by server.js. Declaring the
// base paths here rather than in server.js means a module owns its own routing:
// when workforce is extracted to its own service, this array becomes that
// service's route table and the gateway rewrite rules are derived from the same
// paths.
//
// Cross-module API in two halves:
//   - the two read accessors below, consumed by people's HR dashboard.
//     Accessors, not joins — people never sees these tables.
//   - setReportingManagerResolver, which is the opposite direction: a question
//     this module asks and does not answer. workforce needs to know who a
//     person reports to in order to escalate to them, and that is an HR fact.
//     Requiring `people` back for it made the two modules a cycle, so the
//     question is declared here and whoever owns the org chart plugs itself in
//     at boot. See org.js.

const org = require('./org')
const workSubscriber = require('./work-subscriber')
const jobs = require('./jobs')
const timeRepo = require('./time.repo')
const leaveRepo = require('./leave.repo')

exports.mount = [
  { path: '/api/leave-management', router: require('./leave.routes') },
  { path: '/api/time-management', router: require('./time.routes') },
]

/* ── Background jobs (Module 9, Phase 3) ─────────────────────────────────── */
//
// This module says WHAT its jobs are; server.js decides WHETHER they run
// (ENABLE_CRON and the leader lock), as for every other module.
exports.jobs = [jobs.workStatusNudge, jobs.workStatusEscalate, jobs.leaveNoticeReminder]
  .map((j) => ({ name: j.name, start: j.start, stop: j.stop }))

// Test seams, like defects' runSlaSweepNow.
exports.runWorkStatusNudgeNow = () => jobs.workStatusNudge.runNow()
exports.runWorkStatusEscalateNow = () => jobs.workStatusEscalate.runNow()

/* ── Event subscriptions ────────────────────────────────────────────────── */
//
// Listens to work's project.deleted and removes the project's time logs — the
// ON DELETE CASCADE the schema split dropped. Called by server.js outside the
// ENABLE_CRON switch, like every module's subscribe(). Idempotent.
exports.subscribe = () => workSubscriber.startWorkSubscriptions()

/* ── The org chart, asked for rather than reached for ────────────────────── */
//
// Registered once at boot by the module that owns reporting lines (people).
// Until it is, manager escalations are skipped and org.js logs a warning —
// deliberately not a throw: an unwired composition must not turn a successful
// leave request into a 500.
exports.setReportingManagerResolver = org.setReportingManagerResolver
exports.hasReportingManagerResolver = org.hasReportingManagerResolver
exports.unsubscribe = () => workSubscriber.stopWorkSubscriptions()

/* ── Attendance accessors ───────────────────────────────────────────────── */

/**
 * Users who logged time on each date in [from, to] (YYYY-MM-DD, inclusive).
 * @returns {Promise<Map<string, Set<string>>>} date → user ids; days with no
 *          logs are absent from the map.
 */
exports.getPresenceByDate = async (from, to) => {
  const rows = await timeRepo.findPresenceByDate(from, to)
  return new Map(rows.map((r) => [r.date, new Set(r.user_ids)]))
}

/**
 * Leave requests overlapping [from, to], any status, as plain records.
 * `appliedOn` is the day the request was raised in `timeZone`, so a caller
 * can tell leave planned in advance from leave raised on the day.
 */
exports.getLeaveOverlapping = async (from, to, timeZone) => {
  const rows = await leaveRepo.findLeaveOverlapping(from, to, timeZone)
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status,
    dayType: r.day_type,
    type: r.type,
    planningType: r.planning_type,
    appliedOn: r.applied_on,
  }))
}

/* ── What this module consumes ───────────────────────────────────────────── */
//
// GENERATED, and checked by `npm run lint:contracts`. Every name here is read
// from another module's index.js, so this list IS this module's half of the
// future HTTP contract: extract it and these become the calls its client makes.
// Do not hand-edit — change the code, then run `npm run lint:contracts -- --write`.
exports.consumes = {
  identity: ['getAccountState', 'getActiveUsers', 'getUserCards'],
  notify: ['TYPES', 'dispatch', 'dispatchToRoles', 'dispatchToUsers'],
  work: ['events', 'getProjectCards'],
}
