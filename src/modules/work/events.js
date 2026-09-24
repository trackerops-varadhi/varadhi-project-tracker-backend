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

// Node warns at 10 listeners per event. PROJECT_DELETED has the most — one per
// owning module concern, currently five — and the ceiling is raised so adding a
// subscriber later is not a surprise warning in the log.
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

  /**
   * A project, and every task in it, has been removed.
   *
   * Payload: `{ projectId, taskIds }`.
   *
   * WHAT THIS REPLACES
   * Before the Phase 2 schema split, deleting a project was one statement and
   * foreign keys did the rest: time_logs and teams_webhooks CASCADEd;
   * documents.project_id, bugs.project_id and bugs.linked_task_id were SET
   * NULL. Those keys crossed module schemas, so the split dropped them, and
   * this event is what each owning module now listens to instead.
   *
   * ORDERING: emitted AFTER the delete has committed — the reverse of
   * TASK_DELETED, and for the reverse reason. task.deleted's only consumer
   * removes a calendar mirror, which the next sweep can recreate, so running it
   * early is harmless. This event's consumers destroy tracker data: a project's
   * time logs and its Teams webhooks. Running them before a delete that then
   * failed would leave a live project with its time logs gone. Afterwards is the
   * only point at which the project is known to be gone.
   *
   * WHY IT CARRIES taskIds
   * work.tasks cascades from work.projects inside the database, and a cascade
   * does not go through deleteTask, so TASK_DELETED is NOT emitted for a task
   * that goes with its project. Once the row is gone, nothing but this payload
   * records which ids went. A subscriber that reacts to deleted tasks must
   * therefore handle both events — task.deleted for a single task, and this
   * event's taskIds for tasks removed with their project.
   */
  PROJECT_DELETED: 'project.deleted',
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
