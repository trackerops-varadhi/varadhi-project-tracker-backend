/**
 * Domain events emitted by work.
 *
 * WHY THIS EXISTS
 * tasks.controller.js used to call calendar-sync's markSourceDirty/purgeSource
 * directly, which made work depend on integrations: the module that owns the
 * work depended on the module that mirrors it somewhere else. Inverting it
 * means work announces what happened and does not care who listens, so
 * integrations can be removed, replaced or extracted without work changing.
 *
 * Same shape as notify's `notificationEvents` — one EventEmitter, subscribers
 * registered at startup, failures contained.
 *
 * EMIT AWAITS ITS SUBSCRIBERS, deliberately. Both call sites this replaced were
 * already awaited (`await notifySafely(() => markSourceDirty(...))`), and one of
 * them depends on it — see TASK_DELETED. A fire-and-forget emit would change
 * request timing and, for the delete path, the failure ordering.
 *
 * emit() never throws. A subscriber that rejects is logged and ignored: a
 * calendar that is unreachable must not turn a successful task edit into a 500,
 * exactly as a failed notification never does. That guard used to live at the
 * call site as notifySafely; it lives here now so every subscriber gets it.
 */

const { EventEmitter } = require('events')

const emitter = new EventEmitter()

// Node warns at 10 listeners. Integrations registers two; the ceiling is raised
// a little so adding a subscriber later is not a surprise warning in the log.
emitter.setMaxListeners(25)

const EVENTS = {
  /** A task's fields changed — title, status, dates, assignee. */
  TASK_CHANGED: 'task.changed',

  /**
   * A task is being removed.
   *
   * ORDERING: emitted BEFORE the row is deleted, and awaited.
   *
   * calendar_event_links has no foreign key to tasks (a link's source may be a
   * task, a milestone or a meeting), so nothing cascades. If the row were
   * deleted first and the purge then failed, the remote calendar event would
   * survive as a phantom deadline with no task left to reconcile it against —
   * and nothing would clean it up, because the sweep only looks at live tasks.
   * Purging first inverts the failure: a purge that succeeds before a delete
   * that fails just means the next sweep re-creates the event.
   *
   * That ordering was deliberate in the code this replaced, and it is the one
   * thing the inversion must not quietly change.
   */
  TASK_DELETED: 'task.deleted',
}

/**
 * Announce an event and wait for every subscriber to finish.
 * Never throws — each subscriber's failure is isolated and logged.
 */
const emit = async (event, payload) => {
  await Promise.all(
    emitter.listeners(event).map((fn) =>
      Promise.resolve()
        .then(() => fn(payload))
        .catch((err) => {
          console.error(`[work.events] ${event} subscriber failed:`, err.message)
        })
    )
  )
}

/**
 * Register a subscriber. Returns an unsubscribe function.
 *
 * Subscribers should be idempotent: nothing here guarantees exactly-once, and
 * a retried request re-emits.
 */
const on = (event, handler) => {
  emitter.on(event, handler)
  return () => emitter.off(event, handler)
}

module.exports = { EVENTS, emit, on }
