/**
 * The integrations side of the work event inversion.
 *
 * work used to call calendar-sync's markSourceDirty/purgeSource directly. It
 * now announces `task.changed` and `task.deleted` and knows nothing about the
 * calendar; this file is what turns those announcements into sync work.
 *
 * The dependency edge that remains points the right way: integrations depends
 * on work, work depends on nothing here. Deleting this module would leave the
 * tracker fully functional, with tasks simply no longer mirrored — which is the
 * property the inversion exists to give.
 *
 * Modelled on teams-fanout.js, which subscribes to notify's emitter for the
 * same reason: the producer should not have to know every consumer.
 */

const work = require('../work')
const { markSourceDirty, purgeSource } = require('./calendar-sync')

let subscriptions = []

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

  const { TASK_CHANGED, TASK_DELETED } = work.events.EVENTS

  subscriptions = [
    // Flip the link to 'dirty' so the next sweep re-pushes it instead of taking
    // the content-hash early exit. A single UPDATE — no provider call here.
    work.events.on(TASK_CHANGED, ({ taskId }) => markSourceDirty('task', taskId)),

    // Delete the remote event and its link row. work awaits this before
    // removing the task, which is what stops a phantom deadline being left on
    // someone's calendar.
    work.events.on(TASK_DELETED, ({ taskId }) => purgeSource('task', taskId)),
  ]

  console.log('[integrations] subscribed to work task events')
}

exports.stopWorkSubscriptions = () => {
  for (const unsubscribe of subscriptions) unsubscribe()
  subscriptions = []
}
