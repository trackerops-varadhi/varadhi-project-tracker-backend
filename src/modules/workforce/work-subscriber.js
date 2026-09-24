/**
 * workforce's side of work's project.deleted event.
 *
 * Before the Phase 2 schema split, time_logs.project_id was ON DELETE CASCADE,
 * so deleting a project took its time logs with it. That key crossed from the
 * workforce schema into work's and was dropped; this subscriber is the
 * replacement. Same shape as integrations/work-subscriber.js.
 *
 * The dependency edge is unchanged: workforce already depended on work (for
 * project cards in time.service.js). work still knows nothing about workforce.
 */

const work = require('../work')
const timeRepo = require('./time.repo')

let subscriptions = []

/**
 * Register the subscriber. Idempotent.
 *
 * NOT behind ENABLE_CRON — this fires on the request path that deletes the
 * project. Turning the sweeps off must not leave time logs pointing at a
 * project that no longer exists.
 */
exports.startWorkSubscriptions = () => {
  if (subscriptions.length) return

  const { PROJECT_DELETED } = work.events.EVENTS

  subscriptions = [
    work.events.on(PROJECT_DELETED, ({ projectId }) => timeRepo.deleteTimeLogsForProject(projectId)),
  ]

  console.log('[workforce] subscribed to work project events')
}

exports.stopWorkSubscriptions = () => {
  for (const unsubscribe of subscriptions) unsubscribe()
  subscriptions = []
}
