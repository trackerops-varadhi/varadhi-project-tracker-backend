// PUBLIC INTERFACE — defects (bugs · bug_comments · bug_attachments ·
// bug_activity_logs · bug_sla_rules)
//
// The only file outside this directory that anything else may require.

const slaCron = require('./sla-cron')
const workSubscriber = require('./work-subscriber')

exports.mount = [
  { path: '/api/bugs', router: require('./routes') },
]

/* ── Event subscriptions ────────────────────────────────────────────────── */
//
// Listens to work's project.deleted and clears bugs' references to the project
// and to the tasks deleted with it — the two ON DELETE SET NULL rules the
// schema split dropped. Called by server.js outside the ENABLE_CRON switch.
// Idempotent.
exports.subscribe = () => workSubscriber.startWorkSubscriptions()
exports.unsubscribe = () => workSubscriber.stopWorkSubscriptions()

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

/**
 * The bug behind each linked task, for the task list and task detail
 * (role workspaces: developers work bugs from their tasks, not the Bugs
 * module). Batched — one query for bugs, one for attachments, one for names.
 *
 * @param {string[]} taskIds
 * @returns {Promise<Map<string, object>>} taskId → bug card
 */
exports.getBugCardsForTasks = async (taskIds) => {
  const repo = require('./repo')
  const identity = require('../identity')
  const { STATUS_LABELS } = require('./workflow')
  const rows = await repo.findBugsByLinkedTasks([...new Set((taskIds || []).filter(Boolean))])
  if (rows.length === 0) return new Map()
  const [attachments, users] = await Promise.all([
    repo.findAttachmentsForBugs(rows.map((r) => r.id)),
    identity.getUserCards(rows.map((r) => r.reporter_id)),
  ])
  return new Map(rows.map((r) => [r.linked_task_id, {
    id: r.id,
    key: `BUG-${r.bug_number}`,
    title: r.title,
    status: r.status,
    statusLabel: STATUS_LABELS[r.status] || r.status,
    severity: r.severity,
    priority: r.priority,
    environment: r.environment,
    stepsToReproduce: r.steps_to_reproduce,
    slaDueAt: r.sla_resolution_due_at,
    slaBreached: r.sla_breached,
    reporter: r.reporter_id ? { id: r.reporter_id, name: users.get(r.reporter_id)?.name ?? null } : null,
    attachments: attachments.filter((a) => a.bug_id === r.id).map((a) => ({
      id: a.id, fileName: a.file_name, fileType: a.file_type, fileSize: a.file_size == null ? null : Number(a.file_size), url: a.url,
    })),
  }]))
}
