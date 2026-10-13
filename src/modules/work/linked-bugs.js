/**
 * The bug a task came from — a fact work shows and does not own.
 *
 * WHY THIS FILE EXISTS — IT BREAKS THE OTHER HALF OF A CYCLE
 * Under role workspaces a developer works bugs from their own task list rather
 * than from the Bugs module, so a task created for a bug carries that bug's
 * severity, steps and attachments. The data is defects': `bugs.linked_task_id`
 * is its column and `getBugCardsForTasks` is its query.
 *
 * `work/tasks.service.js` used to call that function directly, which was the
 * second half of `work -> defects`. With `defects -> work` already there (its
 * task-sync creates the task, its work-subscriber mirrors status back), the two
 * modules formed a cycle: behind a network, two services that each need the
 * other to start. The lazy `require('../defects')` form hid it from Node
 * without removing it.
 *
 * The data did not move and should not: defects owns the bug. What was wrong is
 * that work was asking a MODULE when all it needed was an ANSWER. So work
 * declares the question here, and `defects` — which already depends on work —
 * registers itself as the answer in its subscribe(). Extracted later, the same
 * seam takes an HTTP client instead of a function.
 *
 * Same shape as workforce/org.js, deliberately: one codebase should have one
 * way of doing this.
 *
 * FAILS SOFT, AND THAT IS THE RIGHT CALL HERE
 * With no provider registered, every task simply renders without its bug badge.
 * A task list that refuses to load because a sibling module is unavailable
 * would be a worse outcome than a task list missing one ornament — and when
 * defects is a separate service one day, "unavailable" stops being
 * hypothetical. The warning is logged once so the misconfiguration is still
 * findable.
 */

const { logger } = require('../../platform/logger')

let provider = null
let warned = false

/**
 * Called once at boot by whoever owns bugs.
 * Idempotent: re-registering replaces, so a double subscribe is harmless.
 *
 * @param {(taskIds: string[]) => Promise<Map<string, object>>} fn
 */
exports.setBugCardProvider = (fn) => {
  if (typeof fn !== 'function') throw new TypeError('Bug card provider must be a function.')
  provider = fn
}

/** Whether anyone has answered for linked bugs. Used by the boot banner. */
exports.hasBugCardProvider = () => provider !== null

/**
 * Map<taskId, bugCard> for the tasks that came from a bug. Tasks with no bug
 * are absent, which is the normal case — most tasks are not bugs.
 */
exports.bugCardsFor = async (taskIds) => {
  const ids = [...new Set(taskIds || [])].filter(Boolean)
  if (ids.length === 0) return new Map()

  if (!provider) {
    if (!warned) {
      warned = true
      logger.warn(
        '[work] no bug-card provider registered — tasks will render without their bug details',
        { hint: 'defects.subscribe() registers it; is the defects module mounted?' }
      )
    }
    return new Map()
  }

  return (await provider(ids)) || new Map()
}
