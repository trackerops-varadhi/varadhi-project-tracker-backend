/**
 * defects' side of work's project.deleted event.
 *
 * Before the Phase 2 schema split, bugs.project_id and bugs.linked_task_id were
 * ON DELETE SET NULL: deleting a project kept its bugs and cleared both
 * references, including links to tasks the project took with it. Those keys
 * crossed from the defects schema into work's and were dropped; this
 * subscriber is the replacement. Same shape as integrations/work-subscriber.js.
 *
 * bug_attachments.document_id needs nothing here. It pointed at files'
 * documents, and project.deleted does not delete documents — files detaches
 * them and keeps them, so every attachment's document still exists.
 *
 * The dependency edge is unchanged: defects already depended on work for
 * project and task cards. work still knows nothing about defects' tables.
 */

const work = require('../work')
const repo = require('./repo')

let subscriptions = []

/**
 * Register the subscriber. Idempotent.
 *
 * NOT behind ENABLE_CRON — this fires on the request path that deletes the
 * project, so a bug never renders a project or task that no longer exists.
 */
exports.startWorkSubscriptions = () => {
  if (subscriptions.length) return

  const { PROJECT_DELETED } = work.events.EVENTS

  subscriptions = [
    work.events.on(PROJECT_DELETED, ({ projectId, taskIds }) =>
      repo.detachDeletedProject(projectId, taskIds)),
  ]

  console.log('[defects] subscribed to work project events')
}

exports.stopWorkSubscriptions = () => {
  for (const unsubscribe of subscriptions) unsubscribe()
  subscriptions = []
}
