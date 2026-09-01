/**
 * Bugs Finder — status workflow + activity log.
 * ---------------------------------------------------------------------------
 * The transition table is the authority on which status moves are legal. It
 * lives here rather than in the controller so the API, the cron sweep and the
 * tests all agree on one definition.
 *
 * Primary flow:
 *   open -> assigned -> in_progress -> fixed -> qa_verification -> closed
 * QA rejection:
 *   qa_verification -> reopened -> in_progress
 * Terminal side-exits (reachable from any live status):
 *   duplicate, rejected, wont_fix, deferred
 */

const pool = require('../config/db')

const BUG_STATUSES = [
  'open',
  'assigned',
  'in_progress',
  'fixed',
  'qa_verification',
  'closed',
  'reopened',
  'duplicate',
  'rejected',
  'wont_fix',
  'deferred',
]

// Statuses a bug can be triaged out to from anywhere still live. Kept separate
// so they can be appended to every row of the table below without repetition.
const SIDE_EXITS = ['duplicate', 'rejected', 'wont_fix', 'deferred']

// Statuses from which no further movement is allowed except an explicit
// reopen. 'closed' is included: closing is final until somebody reopens.
const TERMINAL_STATUSES = new Set(['closed', 'duplicate', 'rejected', 'wont_fix'])

/**
 * Legal next statuses for each current status. A move to the SAME status is
 * always allowed (and treated as a no-op by the controller) so an idempotent
 * client retry is never a 400.
 */
const TRANSITIONS = {
  open: ['assigned', 'in_progress', ...SIDE_EXITS],
  // Straight to fixed is allowed: a developer who picks up and fixes a
  // one-liner should not have to click through in_progress to record it.
  assigned: ['in_progress', 'fixed', 'open', ...SIDE_EXITS],
  in_progress: ['fixed', 'assigned', ...SIDE_EXITS],
  // Fixed work goes to QA. Straight-to-closed is permitted for a manager/admin
  // who is also the verifier — the role check for that lives in the controller.
  fixed: ['qa_verification', 'closed', 'in_progress', ...SIDE_EXITS],
  // QA either accepts (closed) or rejects (reopened).
  qa_verification: ['closed', 'reopened', 'in_progress', ...SIDE_EXITS],
  // A reopened bug goes back into the development flow.
  reopened: ['assigned', 'in_progress', ...SIDE_EXITS],
  // Closed is terminal — reopening is the only way out, and it is the same
  // transition QA rejection uses.
  closed: ['reopened'],
  duplicate: ['reopened', 'open'],
  rejected: ['reopened', 'open'],
  wont_fix: ['reopened', 'open'],
  // Deferred work comes back into the queue when it is scheduled.
  deferred: ['open', 'assigned', 'in_progress', ...SIDE_EXITS],
}

// Human labels, mirrored in the frontend constants. Used in notification and
// activity-log copy so the wording matches what the user sees on screen.
const STATUS_LABELS = {
  open: 'Open',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  fixed: 'Fixed',
  qa_verification: 'QA Verification',
  closed: 'Closed',
  reopened: 'Reopened',
  duplicate: 'Duplicate',
  rejected: 'Rejected',
  wont_fix: "Won't Fix",
  deferred: 'Deferred',
}

/**
 * Statuses an employee/developer may set on a bug assigned to them. They drive
 * the development side of the workflow but cannot close their own bug or
 * dismiss it as rejected/won't-fix — those are triage and verification calls.
 */
const EMPLOYEE_ALLOWED_STATUSES = new Set(['in_progress', 'fixed', 'qa_verification'])

/**
 * Validate a status transition.
 * @returns {{ok: true} | {ok: false, message: string}}
 */
function canTransition(from, to) {
  if (!BUG_STATUSES.includes(to)) {
    return { ok: false, message: `Invalid status "${to}".` }
  }
  if (from === to) return { ok: true }

  const allowed = TRANSITIONS[from] || []
  if (!allowed.includes(to)) {
    return {
      ok: false,
      message: `Cannot move a bug from "${STATUS_LABELS[from] || from}" to "${
        STATUS_LABELS[to] || to
      }". Allowed from here: ${allowed.map((s) => STATUS_LABELS[s] || s).join(', ') || 'none'}.`,
    }
  }
  return { ok: true }
}

/* -------------------------------------------------------------------------- */
/* Activity log                                                               */
/* -------------------------------------------------------------------------- */

// Canonical action names, matching §25 of the spec. Controllers use these
// constants rather than free-form strings so the timeline's icon/label mapping
// on the frontend stays exhaustive.
const BUG_ACTIONS = {
  CREATED: 'BUG_CREATED',
  ASSIGNED: 'BUG_ASSIGNED',
  REASSIGNED: 'BUG_REASSIGNED',
  UNASSIGNED: 'BUG_UNASSIGNED',
  STATUS_CHANGED: 'BUG_STATUS_CHANGED',
  PRIORITY_CHANGED: 'BUG_PRIORITY_CHANGED',
  SEVERITY_CHANGED: 'BUG_SEVERITY_CHANGED',
  COMMENT_ADDED: 'BUG_COMMENT_ADDED',
  COMMENT_EDITED: 'BUG_COMMENT_EDITED',
  COMMENT_DELETED: 'BUG_COMMENT_DELETED',
  ATTACHMENT_ADDED: 'BUG_ATTACHMENT_ADDED',
  ATTACHMENT_DELETED: 'BUG_ATTACHMENT_DELETED',
  SLA_BREACHED: 'BUG_SLA_BREACHED',
  SLA_AT_RISK: 'BUG_SLA_AT_RISK',
  REOPENED: 'BUG_REOPENED',
  CLOSED: 'BUG_CLOSED',
  RESOLVED: 'BUG_RESOLVED',
  UPDATED: 'BUG_UPDATED',
  TASK_LINKED: 'BUG_TASK_LINKED',
  TASK_CREATED: 'BUG_TASK_CREATED',
  TASK_UNLINKED: 'BUG_TASK_UNLINKED',
}

/**
 * Append one entry to a bug's activity timeline.
 *
 * Never throws. An audit-write failure must not turn a successful mutation
 * into a 500 — the same rule the notification dispatch calls follow across
 * this codebase. Accepts an optional `client` so a caller inside a transaction
 * logs on the same connection.
 */
async function logBugActivity(
  { bugId, actorId, action, field = null, oldValue = null, newValue = null, detail = null },
  client = pool
) {
  try {
    await client.query(
      `INSERT INTO bug_activity_logs (bug_id, actor_id, action, field, old_value, new_value, detail)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        bugId,
        actorId || null,
        action,
        field,
        oldValue === null || oldValue === undefined ? null : String(oldValue),
        newValue === null || newValue === undefined ? null : String(newValue),
        detail ? JSON.stringify(detail) : null,
      ]
    )
  } catch (err) {
    console.error('[bug-activity] failed to log', action, '-', err.message)
  }
}

module.exports = {
  BUG_STATUSES,
  TRANSITIONS,
  TERMINAL_STATUSES,
  SIDE_EXITS,
  STATUS_LABELS,
  EMPLOYEE_ALLOWED_STATUSES,
  BUG_ACTIONS,
  canTransition,
  logBugActivity,
}
