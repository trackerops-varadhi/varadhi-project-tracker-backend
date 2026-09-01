/**
 * Bugs Finder — SLA engine.
 * ---------------------------------------------------------------------------
 * The single place SLA rules live. Nothing else in the codebase may hardcode a
 * response/resolution duration: controllers and the cron sweep both come
 * through here, so changing a target is a one-place change (or, at runtime, an
 * edit to the `bug_sla_rules` table).
 *
 * Times are always computed from the SERVER clock. The frontend renders a
 * countdown, but it renders it against `slaResolutionDueAt` returned by the
 * API — it never decides on its own whether something has breached.
 *
 * Business-time: "1 business day" in the spec means one working day, not 24
 * wall-clock hours. addBusinessMinutes below walks the clock forward skipping
 * weekends and non-working hours, so a Medium bug filed at 16:00 on Friday is
 * not silently breached by Monday morning.
 */

const pool = require('../config/db')

// ─── Working calendar ────────────────────────────────────────────────────────
// Deliberately simple and centralized: an 8-hour day, Mon–Fri. Public holidays
// are not modelled (there is no holidays table in this schema); if one is added
// later, HOLIDAYS below is the only place that needs to consult it.
const WORK_DAY_START_HOUR = 9
const WORK_DAY_END_HOUR = 17
const WORK_MINUTES_PER_DAY = (WORK_DAY_END_HOUR - WORK_DAY_START_HOUR) * 60 // 480

// Severity levels and priorities, in descending order of urgency. Exported so
// controllers validate against this list rather than restating it.
const SEVERITIES = ['critical', 'high', 'medium', 'low']
const PRIORITIES = ['p0', 'p1', 'p2', 'p3']
const ENVIRONMENTS = ['production', 'staging', 'qa', 'development', 'local']

// Fallback used only when the bug_sla_rules table is unreachable or a severity
// somehow has no row. Mirrors the seeded defaults so behaviour degrades to
// "correct but not admin-editable" rather than to "no SLA at all".
const DEFAULT_RULES = {
  critical: { responseMinutes: 60, resolutionMinutes: 240, atRiskThreshold: 0.75 },
  high: { responseMinutes: 240, resolutionMinutes: 480, atRiskThreshold: 0.75 },
  medium: { responseMinutes: 480, resolutionMinutes: 1440, atRiskThreshold: 0.75 },
  low: { responseMinutes: 960, resolutionMinutes: 2400, atRiskThreshold: 0.75 },
}

// SLA status vocabulary — shared with the frontend via the API payload.
const SLA_STATUS = {
  WITHIN: 'within_sla',
  AT_RISK: 'at_risk',
  BREACHED: 'breached',
  RESOLVED_WITHIN: 'resolved_within_sla',
  RESOLVED_AFTER: 'resolved_after_sla',
  // Terminal states that never had a meaningful resolution clock
  // (duplicate/rejected/wont_fix/deferred).
  NOT_APPLICABLE: 'not_applicable',
}

// Statuses at which the SLA resolution clock stops running.
const SLA_STOPPED_STATUSES = new Set([
  'fixed',
  'qa_verification',
  'closed',
  'duplicate',
  'rejected',
  'wont_fix',
  'deferred',
])

// Statuses where the SLA never meaningfully applied — a duplicate or a
// won't-fix was never going to be "resolved within 4 hours".
const SLA_VOID_STATUSES = new Set(['duplicate', 'rejected', 'wont_fix', 'deferred'])

/* -------------------------------------------------------------------------- */
/* Business-time arithmetic                                                   */
/* -------------------------------------------------------------------------- */

function isWorkingDay(date) {
  const day = date.getDay()
  return day !== 0 && day !== 6 // Sunday=0, Saturday=6
}

/**
 * Advance `date` to the next instant inside working hours, if it is not
 * already. Returns a new Date; never mutates the input.
 */
function nextWorkingInstant(date) {
  const d = new Date(date.getTime())

  // Walk forward at most a couple of weeks — a bounded loop rather than a
  // `while (true)`, so a bad input can never hang a request.
  for (let guard = 0; guard < 21; guard += 1) {
    if (!isWorkingDay(d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(WORK_DAY_START_HOUR, 0, 0, 0)
      continue
    }
    if (d.getHours() < WORK_DAY_START_HOUR) {
      d.setHours(WORK_DAY_START_HOUR, 0, 0, 0)
      return d
    }
    if (d.getHours() >= WORK_DAY_END_HOUR) {
      d.setDate(d.getDate() + 1)
      d.setHours(WORK_DAY_START_HOUR, 0, 0, 0)
      continue
    }
    return d
  }
  return d
}

/**
 * Add `minutes` of WORKING time to `start`, skipping evenings and weekends.
 *
 * Critical severity is the deliberate exception (see slaDeadlines below): a
 * 4-hour resolution target on a production-down defect is a wall-clock
 * promise, and stretching it across a weekend would defeat the point.
 */
function addBusinessMinutes(start, minutes) {
  let remaining = Math.max(0, Math.round(minutes))
  let cursor = nextWorkingInstant(new Date(start.getTime()))

  // Bounded: 400 iterations covers well over a year of working days for any
  // realistic SLA target.
  for (let guard = 0; guard < 400 && remaining > 0; guard += 1) {
    const endOfDay = new Date(cursor.getTime())
    endOfDay.setHours(WORK_DAY_END_HOUR, 0, 0, 0)

    const availableToday = Math.floor((endOfDay - cursor) / 60000)

    if (remaining <= availableToday) {
      cursor = new Date(cursor.getTime() + remaining * 60000)
      remaining = 0
      break
    }

    remaining -= availableToday
    cursor = nextWorkingInstant(new Date(endOfDay.getTime() + 60000))
  }

  return cursor
}

/* -------------------------------------------------------------------------- */
/* Rule lookup                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Load every SLA rule, keyed by severity. Falls back to DEFAULT_RULES for any
 * severity the table does not cover, so a partially-seeded table still yields
 * a complete rule set.
 */
async function getSlaRules() {
  const rules = {}
  try {
    const { rows } = await pool.query(
      `SELECT id, severity, response_minutes, resolution_minutes, at_risk_threshold, description
         FROM bug_sla_rules`
    )
    for (const r of rows) {
      rules[r.severity] = {
        id: r.id,
        severity: r.severity,
        responseMinutes: r.response_minutes,
        resolutionMinutes: r.resolution_minutes,
        // NUMERIC comes back as a JS number thanks to the OID 1700 parser in
        // config/db.js, but coerce defensively — a NaN threshold would make
        // every bug read as "at risk".
        atRiskThreshold: Number(r.at_risk_threshold) || 0.75,
        description: r.description,
      }
    }
  } catch (err) {
    console.error('[bug-sla] could not load rules, using defaults:', err.message)
  }

  for (const severity of SEVERITIES) {
    if (!rules[severity]) {
      rules[severity] = { id: null, severity, ...DEFAULT_RULES[severity] }
    }
  }
  return rules
}

/** Single rule for one severity. */
async function getSlaRule(severity) {
  const rules = await getSlaRules()
  return rules[severity] || rules.medium
}

/* -------------------------------------------------------------------------- */
/* Deadline computation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Compute the response + resolution deadlines for a bug.
 *
 * @param {string} severity
 * @param {Date}   [startedAt] SLA clock start — defaults to now.
 * @returns {Promise<{rule, startedAt: Date, responseDueAt: Date, resolutionDueAt: Date}>}
 */
async function slaDeadlines(severity, startedAt = new Date()) {
  const rule = await getSlaRule(severity)
  const start = new Date(startedAt)

  // Critical is measured in wall-clock time — a production outage does not
  // wait for Monday. Everything else runs on the business calendar.
  const advance =
    severity === 'critical'
      ? (from, minutes) => new Date(from.getTime() + minutes * 60000)
      : addBusinessMinutes

  return {
    rule,
    startedAt: start,
    responseDueAt: advance(start, rule.responseMinutes),
    resolutionDueAt: advance(start, rule.resolutionMinutes),
  }
}

/* -------------------------------------------------------------------------- */
/* Live status                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Derive the SLA status of a bug row as of `now` (server time).
 *
 * Pure and synchronous — it reads only the columns already on the row, so the
 * list endpoint can compute this for a whole page without extra queries. The
 * `atRiskThreshold` comes from the rule map the caller already loaded.
 *
 * @param {object} bug   raw `bugs` row (snake_case columns)
 * @param {object} rules result of getSlaRules()
 * @param {Date}   [now] server clock
 */
function computeSlaState(bug, rules, now = new Date()) {
  const rule = rules[bug.severity] || rules.medium
  const dueAt = bug.sla_resolution_due_at ? new Date(bug.sla_resolution_due_at) : null
  const startedAt = bug.sla_started_at ? new Date(bug.sla_started_at) : null

  const base = {
    status: SLA_STATUS.WITHIN,
    dueAt: dueAt ? dueAt.toISOString() : null,
    startedAt: startedAt ? startedAt.toISOString() : null,
    responseDueAt: bug.sla_response_due_at
      ? new Date(bug.sla_response_due_at).toISOString()
      : null,
    // Positive = time left, negative = overdue by. Milliseconds, so the client
    // can render either a countdown or a "breached by" without re-deriving.
    remainingMs: null,
    breached: Boolean(bug.sla_breached),
    ruleSeverity: rule.severity,
    responseMinutes: rule.responseMinutes,
    resolutionMinutes: rule.resolutionMinutes,
    // True once the clock has stopped — the UI renders a static result rather
    // than a ticking countdown.
    clockStopped: SLA_STOPPED_STATUSES.has(bug.status),
    firstResponseAt: bug.first_response_at
      ? new Date(bug.first_response_at).toISOString()
      : null,
    resolvedAt: bug.resolved_at ? new Date(bug.resolved_at).toISOString() : null,
  }

  // Statuses where the SLA was never a real commitment.
  if (SLA_VOID_STATUSES.has(bug.status)) {
    return { ...base, status: SLA_STATUS.NOT_APPLICABLE, remainingMs: null }
  }

  // No deadline recorded (e.g. a row created before this module, or a rules
  // failure at creation) — report honestly rather than inventing a state.
  if (!dueAt) {
    return { ...base, status: SLA_STATUS.NOT_APPLICABLE }
  }

  // Resolved / closed: the outcome is fixed, decided by when it was resolved.
  if (bug.resolved_at) {
    const resolvedAt = new Date(bug.resolved_at)
    const within = !bug.sla_breached && resolvedAt <= dueAt
    return {
      ...base,
      status: within ? SLA_STATUS.RESOLVED_WITHIN : SLA_STATUS.RESOLVED_AFTER,
      remainingMs: dueAt - resolvedAt,
      breached: !within,
    }
  }

  // Still running.
  const remainingMs = dueAt - now
  if (remainingMs <= 0) {
    return { ...base, status: SLA_STATUS.BREACHED, remainingMs, breached: true }
  }

  // "At risk" once the configured fraction of the window has elapsed.
  const totalMs = startedAt ? dueAt - startedAt : null
  if (totalMs && totalMs > 0) {
    const elapsedFraction = 1 - remainingMs / totalMs
    if (elapsedFraction >= rule.atRiskThreshold) {
      return { ...base, status: SLA_STATUS.AT_RISK, remainingMs }
    }
  }

  return { ...base, status: SLA_STATUS.WITHIN, remainingMs }
}

/**
 * Human-readable form of a remaining/overdue duration, e.g. "01h 24m
 * remaining" or "Breached by 42m". Rendered server-side so notification and
 * email bodies phrase it identically to the UI.
 */
function formatSlaRemaining(remainingMs) {
  if (remainingMs === null || remainingMs === undefined) return '—'

  const overdue = remainingMs < 0
  const totalMinutes = Math.floor(Math.abs(remainingMs) / 60000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60

  const parts = []
  if (days) parts.push(`${days}d`)
  if (hours || days) parts.push(`${String(hours).padStart(2, '0')}h`)
  parts.push(`${String(minutes).padStart(2, '0')}m`)

  return overdue ? `Breached by ${parts.join(' ')}` : `${parts.join(' ')} remaining`
}

module.exports = {
  SEVERITIES,
  PRIORITIES,
  ENVIRONMENTS,
  SLA_STATUS,
  SLA_STOPPED_STATUSES,
  SLA_VOID_STATUSES,
  WORK_MINUTES_PER_DAY,
  DEFAULT_RULES,
  getSlaRules,
  getSlaRule,
  slaDeadlines,
  computeSlaState,
  formatSlaRemaining,
  addBusinessMinutes,
  nextWorkingInstant,
}
