/**
 * files' side of work's project.deleted event.
 *
 * Before the Phase 2 schema split, documents.project_id was ON DELETE SET
 * NULL: deleting a project kept its documents and cleared the reference. That
 * key crossed from the files schema into work's and was dropped; this
 * subscriber is the replacement. Same shape as integrations/work-subscriber.js.
 *
 * The dependency edge is unchanged: files already depended on work (for
 * project cards in documents.service.js). work still knows nothing about files.
 */

const work = require('../work')
const documentsRepo = require('./documents.repo')

let subscriptions = []

/**
 * Register the subscriber. Idempotent.
 *
 * NOT behind ENABLE_CRON — this fires on the request path that deletes the
 * project, so a document never outlives the check that its project exists.
 */
exports.startWorkSubscriptions = () => {
  if (subscriptions.length) return

  const { PROJECT_DELETED } = work.events.EVENTS

  subscriptions = [
    work.events.on(PROJECT_DELETED, ({ projectId }) => documentsRepo.detachProject(projectId)),
  ]

  console.log('[files] subscribed to work project events')
}

exports.stopWorkSubscriptions = () => {
  for (const unsubscribe of subscriptions) unsubscribe()
  subscriptions = []
}
