// PUBLIC INTERFACE — defects (bugs · bug_comments · bug_attachments ·
// bug_activity_logs · bug_sla_rules)
//
// The only file outside this directory that anything else may require.

const slaCron = require('./sla-cron')

exports.mount = [
  { path: '/api/bugs', router: require('./routes') },
]

/* ── Background jobs ────────────────────────────────────────────────────── */
//
// The SLA sweep belongs to this module, so the module starts it rather than
// server.js reaching into utils/. server.js still owns the ENABLE_CRON switch
// and the ordering — a module says WHAT its jobs are, the platform decides
// WHETHER to run them. That split is what makes the sweep move with the module
// when it is extracted.
exports.jobs = [
  { name: 'bug-sla', start: slaCron.startBugSlaCron, stop: slaCron.stopBugSlaCron },
]

// Exposed for the integration tests, which drive a sweep directly rather than
// waiting five minutes for a tick.
exports.runSlaSweepNow = slaCron.runBugSlaSweepNow

/* ── Cross-module API ───────────────────────────────────────────────────── */

/**
 * The project detail page's Bugs tab, served under /api/projects/:id/bugs.
 *
 * TEMPORARY SHAPE: this is an express handler rather than a data function
 * because routes/projects.routes.js currently imports the bugs controller
 * directly — one of the cross-controller couplings this restructure exists to
 * remove. Exposing it here at least routes that coupling through a public
 * interface instead of a deep import.
 *
 * When work migrates, its routes should call an async data accessor here
 * instead and own the response shaping themselves.
 */
exports.projectBugsHandler = require('./controller').getBugsByProject
