/**
 * defects' side of work's events.
 *
 * project.deleted — before the Phase 2 schema split, bugs.project_id and
 * bugs.linked_task_id were ON DELETE SET NULL: deleting a project kept its bugs
 * and cleared both references, including links to tasks the project took with
 * it. Those keys crossed from the defects schema into work's and were dropped;
 * this subscriber is the replacement. Same shape as
 * integrations/work-subscriber.js.
 *
 * task.deleted — the same, for one task: its bug is unlinked, not deleted.
 *
 * task.changed — role workspaces. A developer works an assigned bug through
 * its linked task. Starting the task moves the bug to in_progress; completing
 * it marks the bug fixed, which tells QC it is ready to verify. Changes that
 * defects itself made (source 'defects') are ignored, so bug → task → bug can
 * never loop.
 *
 * bug_attachments.document_id needs nothing here. It pointed at files'
 * documents, and project.deleted does not delete documents — files detaches
 * them and keeps them, so every attachment's document still exists.
 */

const work = require('../work')
const identity = require('../identity')
const repo = require('./repo')
const { TRANSITIONS } = require('./workflow')

// Lazy: service requires task-sync, which requires work; keeping the service
// out of this file's load path avoids an ordering trap at boot.
const service = () => require('./service')

let subscriptions = []

const canMove = (from, to) => (TRANSITIONS[from] || []).includes(to)

/**
 * The developer moved the task behind a bug. Only the developer's two steps
 * are mirrored — in_progress and fixed. Verification, closing and reopening
 * stay with QC in the Bugs module.
 */
const onTaskStatus = async ({ taskId, status, actorId }) => {
  if (status !== 'in_progress' && status !== 'completed') return
  const bugId = await repo.findBugIdByLinkedTask(taskId)
  if (!bugId) return

  const svc = service()
  let bug = await svc.getBugById(bugId)
  if (!bug) return

  // Act as the person who moved the task, so the bug's activity log and the
  // "ready for verification" notification name them.
  const card = actorId ? (await identity.getUserCards([actorId])).get(actorId) : null
  const actor = { id: actorId ?? null, role: card?.role ?? 'employee', name: card?.name ?? null }
  const move = async (to) => {
    bug = await svc.applyStatusChange(actor, bug, to, { source: 'task' })
  }

  if (status === 'in_progress') {
    if (canMove(bug.status, 'in_progress')) await move('in_progress')
    return
  }

  // completed → fixed, stepping through in_progress where the workflow needs
  // it (open and reopened cannot jump straight to fixed).
  if (!canMove(bug.status, 'fixed') && canMove(bug.status, 'in_progress')) await move('in_progress')
  if (canMove(bug.status, 'fixed')) await move('fixed')
}

/**
 * Register the subscriber. Idempotent.
 *
 * NOT behind ENABLE_CRON — this fires on the request path that changed the
 * task or deleted the project.
 */
exports.startWorkSubscriptions = () => {
  if (subscriptions.length) return

  const { PROJECT_DELETED, TASK_DELETED, TASK_CHANGED } = work.events.EVENTS

  subscriptions = [
    work.events.on(PROJECT_DELETED, ({ projectId, taskIds }) =>
      repo.detachDeletedProject(projectId, taskIds)),
    work.events.on(TASK_DELETED, ({ taskId }) => repo.unlinkTask(taskId)),
    work.events.on(TASK_CHANGED, (payload = {}) => {
      if (payload.source === 'defects' || !payload.status) return undefined
      return onTaskStatus(payload)
    }),
  ]

  console.log('[defects] subscribed to work project and task events')
}

exports.stopWorkSubscriptions = () => {
  for (const unsubscribe of subscriptions) unsubscribe()
  subscriptions = []
}

// Test seam.
exports.onTaskStatus = onTaskStatus
