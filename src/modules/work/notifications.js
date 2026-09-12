// Notification helpers shared by the projects and tasks halves of work.

const repo = require('./repo')
const identity = require('../identity')
const notify = require('../notify')

// Notifications must never turn a successful action into a 500, so every
// dispatch block runs inside this guard instead of the handler's try/catch.
const notifySafely = async (fn) => {
  try {
    await fn()
  } catch (err) {
    console.error('[notifications] work:', err.message)
  }
}
exports.notifySafely = notifySafely

exports.actorName = (req) => (req.user && req.user.name) || 'A team member'

/**
 * Role-based routing for task-workflow events: when an Employee acts, every
 * Admin/Manager needs to know (they have no other way to see it); when an
 * Admin/Manager acts, only the specific affected Employee needs to know.
 *
 * The recipient list used to come from `SELECT id FROM users WHERE role IN
 * (...) AND status = 'active'` right here; it now comes from identity.
 */
exports.notifyAdminsAndManagers = async (
  excludeUserId, type, title, message, linkTo, priority, options = {}
) => {
  const ids = await identity.getActiveUserIdsByRoles(['admin', 'manager'])
  // `options` is spread first but excludeUserId is re-applied after it, so a
  // caller passing { actions } can never accidentally widen the recipient set.
  await notify.dispatchToUsers({
    userIds: ids, type, title, message, linkTo, priority,
    ...options,
    excludeUserId,
  })
}

// Inline action buttons offered on actionable notifications. Two is the hard
// ceiling: Notification.maxActions is 2 on Chrome/Android (and 0 on iOS
// Safari, where the body-tap deep link is the only affordance).
exports.REVIEW_ACTIONS = [
  { action: 'approve', title: 'Approve' },
  { action: 'reject', title: 'Reject' },
]

// The push surface gets Accept + a single Snooze; the full duration menu
// (1h / 3h / tomorrow) is in-app only, where there is room for it.
exports.ASSIGN_ACTIONS = [
  { action: 'accept', title: 'Accept' },
  { action: 'snooze_1h', title: 'Snooze 1h' },
]

/**
 * Best-effort project-completion milestone check: fires when the recomputed
 * % complete exactly equals 25/50/75/100 right after this call.
 *
 * There is no persistent "last milestone notified" column on `projects`, so
 * this relies on the engine's 24h dedupe window rather than real
 * crossing-detection — if the % later drops out of and back into the same
 * milestone within a day it will not refire, and if a project revisits e.g.
 * 50% weeks apart it will refire. Both are the desired behaviour.
 */
const MILESTONE_THRESHOLDS = [25, 50, 75, 100]

exports.checkProjectMilestone = async (projectId, excludeUserId) => {
  if (!projectId) return

  const { total, completed } = await repo.findProjectTaskCounts(projectId)
  if (!total) return

  const pct = Math.round((completed / total) * 100)
  if (!MILESTONE_THRESHOLDS.includes(pct)) return

  const p = await repo.findProjectNameAndManager(projectId)
  if (!p || !p.manager_id || p.manager_id === excludeUserId) return

  await notify.dispatch({
    userId: p.manager_id,
    type: notify.TYPES.PROJECT_MILESTONE,
    title: `${p.name} reached ${pct}%`,
    message: `${p.name} is now ${pct}% complete.`,
    linkTo: `/projects/${projectId}`,
    priority: pct === 100 ? 'high' : 'normal',
    dedupeWindowMinutes: 24 * 60,
  })
}
