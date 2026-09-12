/**
 * Optimistic concurrency control for task mutations (AC-15 / US-4).
 *
 * Offline edits are queued client-side and replayed later, so by the time a
 * mutation lands the server row may have moved on. `updated_at` is the version
 * token: the client sends the value it last saw as `baseUpdatedAt`, and the
 * write only applies if the row still carries that timestamp.
 *
 * WHY updated_at RATHER THAN A NEW VERSION COLUMN
 * Every task-mutating controller already sets `updated_at = NOW()` by hand and
 * `getTaskWithDetails` already returns it as `updatedAt`. It is therefore a
 * correct, already-maintained, already-exposed token — a dedicated column would
 * add a migration and a second thing to keep in sync for no extra safety.
 *
 * STRICTLY OPT-IN. Omit `baseUpdatedAt` and behaviour is byte-identical to
 * before: no guard, no 409. Every pre-existing caller (task detail page,
 * notification-actions, internal writes) keeps working untouched.
 */

/**
 * SQL fragment comparing a stored `updated_at` to a client-supplied token.
 *
 * Two traps make naive `updated_at = $n` wrong here, and both silently reject
 * every legitimate write rather than failing loudly:
 *
 *  1. PRECISION. Postgres `timestamp` keeps microseconds (…:47.784379); a JS
 *     Date keeps milliseconds (…:47.784). Any value that has travelled through
 *     JSON has already been truncated, so exact equality never matches.
 *
 *  2. TIME ZONE. The column is `timestamp WITHOUT time zone`. Casting the
 *     parameter to `timestamptz` makes Postgres apply the server's UTC offset,
 *     shifting the comparison by hours.
 *
 * Comparing both sides truncated to milliseconds, as plain `timestamp`, is
 * exact enough to detect a real concurrent edit (two writes inside the same
 * millisecond are indistinguishable, and the row-level UPDATE still serialises
 * them) while surviving the JSON round-trip.
 */
const UPDATED_AT_MATCHES = `
  ($$N$$::text IS NULL
   OR abs(EXTRACT(EPOCH FROM (updated_at - $$N$$::timestamp))) < 0.002)
`.trim()

/** Build the guard for a given parameter index, e.g. matchesClause(4) -> uses $4. */
function matchesClause(index) {
  return UPDATED_AT_MATCHES.replace(/\$\$N\$\$/g, `$${index}`)
}

/**
 * Normalise a Date into a value Postgres will read as a bare `timestamp` in the
 * same frame the column uses.
 *
 * node-postgres reads this offset-free column by interpreting its bare digits
 * as LOCAL time. So a stored `16:46:47` becomes a Date whose LOCAL parts read
 * back as `16:46:47` — regardless of what timezone the row was written in.
 * Rebuilding the string from LOCAL parts therefore reproduces the exact
 * wall-clock text Postgres holds, and round-trips correctly for both rows
 * written under the current DB timezone and older rows written under a
 * different one. Using UTC parts here would work only for the former, which is
 * the bug this replaced.
 */
function toTimestampParam(d) {
  if (!d) return null
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  )
}

/**
 * Parse and validate a client-supplied `baseUpdatedAt`.
 *
 * Anything unparseable is rejected rather than ignored: silently dropping a
 * malformed token would turn a guarded write into an unguarded one, which is
 * precisely the overwrite this feature exists to prevent.
 *
 * @returns {{ ok: true, value: Date|null } | { ok: false, message: string }}
 *          `value === null` means "not supplied" — run unguarded.
 */
function parseBaseUpdatedAt(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null }
  }
  if (typeof raw !== 'string' && !(raw instanceof Date) && typeof raw !== 'number') {
    return { ok: false, message: 'baseUpdatedAt must be an ISO timestamp.' }
  }
  const d = raw instanceof Date ? raw : new Date(raw)
  if (Number.isNaN(d.getTime())) {
    return { ok: false, message: 'baseUpdatedAt is not a valid timestamp.' }
  }
  return { ok: true, value: d }
}

/**
 * Did this write lose a concurrency race, or is the row simply gone?
 *
 * A guarded UPDATE that matches zero rows is ambiguous — the id may not exist,
 * or it may exist with a different `updated_at`. Re-read to tell them apart, so
 * the client gets 404 vs 409 correctly.
 *
 * @returns {Promise<{ kind: 'missing' } | { kind: 'conflict', currentUpdatedAt: Date }>}
 */
async function classifyFailedGuardedUpdate(pool, taskId) {
  const { rows } = await pool.query('SELECT updated_at FROM tasks WHERE id = $1', [taskId])
  if (!rows[0]) return { kind: 'missing' }
  return { kind: 'conflict', currentUpdatedAt: rows[0].updated_at }
}

/**
 * The 409 body.
 *
 * Carries the complete current server task so the client can render Mine vs
 * Server without a second round-trip — important when the conflict surfaces
 * during replay, where the user may not even be looking at that task.
 *
 * `conflictFields` lists only the fields the client actually tried to change
 * AND that differ from the server, which is what decides whether a Merge is
 * genuinely safe to offer.
 */
function buildConflictPayload({ serverTask, attempted, baseUpdatedAt }) {
  const attemptedFields = Object.keys(attempted || {}).filter(
    (k) => attempted[k] !== undefined && attempted[k] !== null
  )

  const conflictFields = attemptedFields.filter((field) => {
    const mine = attempted[field]
    const theirs = serverTask ? serverTask[field] : undefined
    return normalize(mine) !== normalize(theirs)
  })

  return {
    reason: 'version_conflict',
    baseUpdatedAt: baseUpdatedAt ? new Date(baseUpdatedAt).toISOString() : null,
    currentUpdatedAt: serverTask?.updatedAt
      ? new Date(serverTask.updatedAt).toISOString()
      : null,
    // Only the fields this request tried to set — never the whole payload, so
    // the client isn't invited to re-send fields it never touched.
    attempted,
    conflictFields,
    serverTask,
  }
}

/** Compare loosely so a Date and its ISO string, or 5 and '5', aren't a false conflict. */
function normalize(v) {
  if (v === undefined || v === null) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'number') return String(v)
  return v
}

module.exports = {
  parseBaseUpdatedAt,
  classifyFailedGuardedUpdate,
  buildConflictPayload,
  matchesClause,
  toTimestampParam,
}
