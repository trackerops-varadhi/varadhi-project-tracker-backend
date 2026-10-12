/**
 * The one organisational fact workforce needs and does not own: who a person
 * reports to.
 *
 * WHY THIS FILE EXISTS — IT BREAKS A DEPENDENCY CYCLE
 * `people` requires `workforce` for attendance and leave, so the HR views can
 * show who is in and who is away. That direction is right: HR screens enrich
 * themselves with workforce's data.
 *
 * `workforce` used to require `people` back, for exactly one function, in two
 * places: `getReportingManagerId(userId)`, to find out who to notify about a
 * short-notice leave request or a missing work status. Those two requires made
 * `people <-> workforce` a cycle, and a cycle cannot be extracted into its own
 * service: behind a network it is two services that each need the other to
 * start, and neither can be deployed alone. The lazy
 * `const people = () => require('../people')` form hid that from Node without
 * removing it.
 *
 * The fix is not to move the data. A reporting line is an HR fact and
 * `people.employee_profiles.reporting_manager_id` is the right home for it.
 * What was wrong is that workforce was asking a *module* when all it needed was
 * an *answer*: nothing here cares where the org chart lives.
 *
 * So workforce declares the question and `people` — which already depends on
 * workforce — plugs itself in at boot (`people.subscribe()`). The static
 * dependency now points one way. Extracted later, the same seam takes an HTTP
 * client instead of a function, and workforce still does not know who answers.
 *
 * BATCHED, UNLIKE WHAT IT REPLACES
 * `people.getReportingManagerId` took a single user id, and sweepEscalate
 * called it once per missing person inside a loop — N queries where the
 * identity lookup beside it already did one for everyone. The resolver here
 * takes a list, which is what `people`'s own stated contract for cross-module
 * accessors says they should be ("async, batched, never a join").
 */

const { logger } = require('../../platform/logger')

let resolver = null
let warned = false

/**
 * Called once at boot by whoever owns the org chart.
 * Idempotent: re-registering replaces, so a double subscribe is harmless.
 *
 * @param {(userIds: string[]) => Promise<Map<string, string|null>>} fn
 */
exports.setReportingManagerResolver = (fn) => {
  if (typeof fn !== 'function') throw new TypeError('Reporting-manager resolver must be a function.')
  resolver = fn
}

/** Whether anyone has answered for the org chart. Used by the boot banner. */
exports.hasReportingManagerResolver = () => resolver !== null

/**
 * Map<userId, managerId>. A user with no profile, no manager, or who is their
 * own manager is simply absent from the map — every caller here is routing a
 * notification, and "nobody to tell" is a normal outcome, not an error.
 *
 * FAILS SOFT, LOUDLY. With no resolver registered this returns an empty map
 * rather than throwing: an unwired composition must not turn a successful leave
 * request into a 500. But it is a real misconfiguration — escalations would
 * stop silently — so it is logged as a warning the first time it happens.
 */
exports.reportingManagersFor = async (userIds) => {
  const ids = [...new Set(userIds || [])].filter(Boolean)
  if (ids.length === 0) return new Map()

  if (!resolver) {
    if (!warned) {
      warned = true
      logger.warn(
        '[workforce] no reporting-manager resolver registered — manager escalations will not be sent',
        { hint: 'people.subscribe() registers it; is the people module mounted?' }
      )
    }
    return new Map()
  }

  const resolved = await resolver(ids)
  const out = new Map()
  for (const [userId, managerId] of resolved || []) {
    // Self-management is how a single-person reporting line is recorded; there
    // is no point telling somebody about themselves.
    if (managerId && managerId !== userId) out.set(userId, managerId)
  }
  return out
}

/** One person. Convenience over reportingManagersFor; same rules. */
exports.reportingManagerFor = async (userId) => {
  const map = await exports.reportingManagersFor([userId])
  return map.get(userId) ?? null
}
