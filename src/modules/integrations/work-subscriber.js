/**
 * The integrations side of the work event inversion.
 *
 * work used to call calendar-sync's markSourceDirty/purgeSource directly. It
 * now announces `task.changed`, `task.deleted` and `project.deleted` and knows
 * nothing about the calendar or Teams; this file is what turns those
 * announcements into sync work.
 *
 * The dependency edge that remains points the right way: integrations depends
 * on work, work depends on nothing here. Deleting this module would leave the
 * tracker fully functional, with tasks simply no longer mirrored — which is the
 * property the inversion exists to give.
 *
 * Modelled on teams-fanout.js, which subscribes to notify's emitter for the
 * same reason: the producer should not have to know every consumer.
 */

const pool = require('../../platform/db').forSchema('integrations')
const work = require('../work')
const { markSourceDirty, purgeSource, purgeSources } = require('./calendar-sync')

let subscriptions = []

/**
 * Remove a deleted project's Teams webhooks.
 *
 * teams_webhooks.project_id was ON DELETE CASCADE to projects until the schema
 * split dropped it, so this is that cascade, moved to the module that owns the
 * table. Delivery history goes with each webhook through teams_delivery_log's
 * own cascade, which is inside this schema and survived the split.
 *
 * Org-wide webhooks have a NULL project_id and are never matched.
 */
const deleteProjectWebhooks = async (projectId) => {
  if (!projectId) return 0
  const { rowCount } = await pool.query(
    'DELETE FROM teams_webhooks WHERE project_id = $1',
    [projectId]
  )
  return rowCount
}

/**
 * Register the subscribers. Idempotent — calling twice is a no-op, so a
 * double-start cannot double-purge.
 *
 * Deliberately NOT behind ENABLE_CRON. These fire on the request path, not on
 * a schedule: turning the sweeps off must not silently stop a deleted task's
 * calendar event from being reaped. Same reasoning that kept startTeamsFanout
 * outside the cron switch.
 */
exports.startWorkSubscriptions = () => {
  if (subscriptions.length) return

  const { TASK_CHANGED, TASK_DELETED, PROJECT_DELETED } = work.events.EVENTS

  subscriptions = [
    // Flip the link to 'dirty' so the next sweep re-pushes it instead of taking
    // the content-hash early exit. A single UPDATE — no provider call here.
    work.events.on(TASK_CHANGED, ({ taskId }) => markSourceDirty('task', taskId)),

    // Delete the remote event and its link row. work awaits this before
    // removing the task, which is what stops a phantom deadline being left on
    // someone's calendar.
    work.events.on(TASK_DELETED, ({ taskId }) => purgeSource('task', taskId)),

    // A deleted project's webhooks, and the calendar events for the project's
    // milestone and for every task that went with it — task.deleted is not
    // emitted for those, so this is the only chance to reap them.
    //
    // Two subscribers rather than one, so emit() isolates their failures: a
    // calendar provider that is down must not leave the webhooks behind, or
    // the reverse.
    //
    // Unlike task.deleted this runs after the rows are gone. If the purge
    // fails, the calendar sweep is the backstop: it reaps every link whose
    // source is no longer in the syncable set, which a deleted project's
    // milestone and tasks never are.
    work.events.on(PROJECT_DELETED, ({ projectId }) => deleteProjectWebhooks(projectId)),
    work.events.on(PROJECT_DELETED, async ({ projectId, taskIds }) => {
      await purgeSource('milestone', projectId)
      await purgeSources('task', taskIds)
    }),
  ]

  console.log('[integrations] subscribed to work task and project events')
}

exports.stopWorkSubscriptions = () => {
  for (const unsubscribe of subscriptions) unsubscribe()
  subscriptions = []
}
