/**
 * Calendar sync engine (Module 4).
 * ---------------------------------------------------------------------------
 * The five boxes in the reference design's "SYNC ENGINE" panel, in order:
 * Mapping & Transformation, Conflict Detection, Deduplication, Real-time Sync,
 * Time Zone Conversion. Each is a named export below and every one of them is
 * a pure function, so the risky logic is testable without a database, a
 * network, or a provider.
 *
 * DIRECTION OF AUTHORITY. The PRD is unambiguous: "The tracker is the system
 * of record; calendar events are a reflection, not an independent editable
 * source." So the default conflict policy is tracker_wins, and even under
 * calendar_wins the inbound pass only ever adjusts the due date — it can never
 * create a task, retitle one, or change its status. A calendar is not allowed
 * to become a back door into the task table.
 *
 * WHY DEDUPE IS TWO LAYERS.
 *   1. Structural — UNIQUE (connection_id, source_type, source_id) in the DB.
 *      Makes a duplicate event impossible even under a concurrent double-sync.
 *   2. Content hash — cheaper and the one that matters operationally. A
 *      5-minute cron over N tasks would otherwise issue N provider writes
 *      every sweep forever. Comparing a hash first means an unchanged task
 *      costs zero API calls, which is what keeps the integration inside
 *      Google/Microsoft quota (the PRD's "API rate limiting" risk).
 */

const crypto = require('crypto')
const pool = require('../config/db')
const {
  dispatchNotification,
  NOTIFICATION_TYPES,
} = require('./notification-engine')
const { resolveProvider } = require('./calendar-providers')
const { decrypt, encrypt } = require('./crypto')

const APP_URL =
  process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000'

/** Refresh a token this long before it actually expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

/** A task due-date event occupies this many minutes on the calendar. */
const DEFAULT_EVENT_DURATION_MINUTES = 60

// ===========================================================================
// TIME ZONE CONVERSION
// ===========================================================================

/**
 * Materialise a date-only due date into a wall-clock instant.
 *
 * This exists because of a real quirk: config/db.js:9 installs a type parser
 * making DATE columns come back as raw 'YYYY-MM-DD' strings, precisely to stop
 * node-postgres from parsing them into a Date at the server's zone and
 * shifting the day. A task due "2026-08-14" is due on that calendar day in the
 * user's zone — it is not an instant. Handing that string to `new Date()`
 * would interpret it as UTC midnight and, for anyone west of Greenwich, put
 * the event on the 13th.
 *
 * So we place it explicitly at a chosen local time in the connection's zone
 * and let the provider resolve the offset, which is also the only correct way
 * to handle DST: we send a wall-clock time plus an IANA zone, never a
 * pre-computed UTC offset that would be wrong half the year.
 *
 * @param {string} dateOnly  'YYYY-MM-DD'
 * @param {string} timeOfDay 'HH:MM' local
 * @returns {{ start: string, end: string }} naive local ISO strings, no Z
 */
function materialiseDueDate(dateOnly, timeOfDay = '09:00', durationMinutes = DEFAULT_EVENT_DURATION_MINUTES) {
  if (!dateOnly) return null

  // Accept a full timestamp too — tasks.due_date is DATE today, but a future
  // schema change to TIMESTAMPTZ shouldn't silently produce garbage.
  const datePart = String(dateOnly).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null

  const [hh, mm] = String(timeOfDay || '09:00')
    .split(':')
    .map((n) => parseInt(n, 10))
  const startH = Number.isFinite(hh) ? Math.min(Math.max(hh, 0), 23) : 9
  const startM = Number.isFinite(mm) ? Math.min(Math.max(mm, 0), 59) : 0

  // Arithmetic is done on a UTC anchor purely so the +duration rollover across
  // midnight is correct; the result is emitted as a naive local string and
  // paired with an IANA timeZone by the provider adapter.
  const anchor = new Date(`${datePart}T00:00:00Z`)
  anchor.setUTCMinutes(anchor.getUTCMinutes() + startH * 60 + startM)
  const start = anchor.toISOString().slice(0, 19)

  const endAnchor = new Date(anchor.getTime() + durationMinutes * 60000)
  const end = endAnchor.toISOString().slice(0, 19)

  return { start, end }
}

/**
 * Inverse: a provider instant back to the 'YYYY-MM-DD' the tasks table wants.
 * Used by the inbound pass when the calendar side wins a conflict.
 */
function toTrackerDate(instant, timeZone) {
  if (!instant) return null
  const d = new Date(instant)
  if (Number.isNaN(d.getTime())) return null

  try {
    // en-CA formats as YYYY-MM-DD, which is exactly the column format.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
  } catch {
    // Unknown IANA zone — fall back to UTC rather than throwing mid-sweep.
    return d.toISOString().slice(0, 10)
  }
}

// ===========================================================================
// MAPPING & TRANSFORMATION
// ===========================================================================

/**
 * Task → provider-neutral event.
 *
 * The field set is deliberately minimal, per the PRD business rule: "Only
 * task/project fields explicitly mapped (title, due date/time, description,
 * and link back to tracker) are synced". Assignee names, comments, tags and
 * internal status are NOT sent — a personal calendar is frequently shared or
 * visible to colleagues, and leaking task internals into it would be a privacy
 * regression the user never consented to.
 *
 * @returns {object|null} null when the task has nothing syncable (no due date).
 */
function mapTaskToEvent(task, settings = {}) {
  if (!task || !task.due_date) return null

  const timeOfDay = settings.due_time_of_day || '09:00'
  const window = materialiseDueDate(task.due_date, timeOfDay)
  if (!window) return null

  const link = `${APP_URL}/tasks/${task.id}`
  const projectLine = task.project_name ? `Project: ${task.project_name}\n` : ''
  const priorityLine = task.priority ? `Priority: ${task.priority}\n` : ''

  return {
    sourceType: 'task',
    sourceId: task.id,
    title: `${task.title}`,
    description:
      `${projectLine}${priorityLine}\n` +
      `${task.description ? `${task.description}\n\n` : ''}` +
      `Open in Varadhi Project Tracker: ${link}`,
    descriptionHtml:
      `${projectLine ? `<p><b>Project:</b> ${escapeHtml(task.project_name)}</p>` : ''}` +
      `${priorityLine ? `<p><b>Priority:</b> ${escapeHtml(task.priority)}</p>` : ''}` +
      `${task.description ? `<p>${escapeHtml(task.description)}</p>` : ''}` +
      `<p><a href="${link}">Open in Varadhi Project Tracker</a></p>`,
    start: window.start,
    end: window.end,
    timeZone: settings.time_zone || 'Asia/Kolkata',
    link,
    reminderMinutes: settings.sync_reminders === false ? null : 60,
    recurrence: task.recurrence_rule || null,
  }
}

/**
 * Project milestone → event. Milestones are the project's end_date, surfaced
 * for the PM persona ("wants milestones to auto-appear on her Outlook
 * calendar"). Zero-duration in spirit; given a nominal 30 minutes so it renders
 * as a visible block rather than a point both providers draw inconsistently.
 */
function mapMilestoneToEvent(project, settings = {}) {
  if (!project || !project.end_date) return null

  const window = materialiseDueDate(project.end_date, settings.due_time_of_day || '09:00', 30)
  if (!window) return null

  const link = `${APP_URL}/projects/${project.id}`
  return {
    sourceType: 'milestone',
    sourceId: project.id,
    title: `Milestone: ${project.name}`,
    description: `Project milestone.\n\nOpen in Varadhi Project Tracker: ${link}`,
    descriptionHtml: `<p>Project milestone.</p><p><a href="${link}">Open in Varadhi Project Tracker</a></p>`,
    start: window.start,
    end: window.end,
    timeZone: settings.time_zone || 'Asia/Kolkata',
    link,
    reminderMinutes: settings.sync_reminders === false ? null : 1440,
    recurrence: null,
  }
}

function escapeHtml(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ===========================================================================
// DEDUPLICATION
// ===========================================================================

/**
 * Stable fingerprint of the fields we actually push.
 *
 * Only mapped fields participate, and they are serialised in a fixed key order
 * — JSON.stringify over an object literal would otherwise make the hash depend
 * on property insertion order, and an unrelated refactor of mapTaskToEvent
 * would silently invalidate every stored hash and trigger a full re-push of
 * every event for every user.
 */
function contentHash(mapped) {
  if (!mapped) return null
  const canonical = [
    mapped.title || '',
    mapped.description || '',
    mapped.start || '',
    mapped.end || '',
    mapped.timeZone || '',
    mapped.recurrence || '',
    mapped.reminderMinutes == null ? '' : String(mapped.reminderMinutes),
  ].join(' ')

  return crypto.createHash('sha256').update(canonical).digest('hex')
}

/**
 * The dedupe decision. Returns true when a provider write can be skipped
 * entirely — the single most important optimisation in this module.
 */
function isUnchanged(link, freshHash) {
  return Boolean(
    link &&
    link.provider_event_id &&
    link.content_hash &&
    freshHash &&
    link.content_hash === freshHash
  )
}

// ===========================================================================
// CONFLICT DETECTION
// ===========================================================================

/**
 * A conflict is BOTH sides changing since the last successful push.
 *
 * Only the tracker changed → not a conflict, just an update to push.
 * Only the calendar changed → not a conflict under tracker_wins; it is an
 *   overwrite the user should be told about, which is why the detected
 *   conflict is still recorded even when policy resolves it automatically
 *   (AC-20: "the user is notified of the overwrite").
 * Both changed → a genuine conflict.
 *
 * @param {object} link       stored calendar_event_links row
 * @param {string} freshHash  hash of the current tracker state
 * @param {object} remote     the provider's current version of the event
 * @returns {null|{conflictType, field, trackerValue, providerValue}}
 */
function detectConflict(link, freshHash, remote) {
  if (!link || !remote) return null

  // Never pushed yet — there is no shared history to disagree about.
  if (!link.provider_event_id || !link.content_hash) return null

  const trackerChanged = Boolean(freshHash) && freshHash !== link.content_hash
  const remoteChanged = Boolean(remote.etag) && Boolean(link.remote_etag) && remote.etag !== link.remote_etag

  if (remote.cancelled && trackerChanged) {
    return {
      conflictType: 'deletion',
      field: 'existence',
      trackerValue: 'active',
      providerValue: 'deleted',
    }
  }

  if (!trackerChanged || !remoteChanged) return null

  // Report the most user-meaningful field that actually differs.
  return {
    conflictType: 'update',
    field: 'schedule',
    trackerValue: link.content_hash,
    providerValue: remote.etag,
  }
}

/**
 * What to do about a detected conflict, given the connection's policy.
 *
 * @returns {'push_tracker'|'pull_calendar'|'await_user'}
 */
function resolveConflict(conflict, policy = 'tracker_wins') {
  if (!conflict) return 'push_tracker'
  if (policy === 'calendar_wins') return 'pull_calendar'
  if (policy === 'manual') return 'await_user'
  return 'push_tracker'
}

// ===========================================================================
// RECURRENCE
// ===========================================================================

/**
 * Expand an RRULE into concrete occurrences within a window.
 *
 * Deliberately supports only the subset a task tracker produces — DAILY,
 * WEEKLY, MONTHLY with INTERVAL/COUNT/UNTIL. Full RFC 5545 (BYSETPOS, BYDAY
 * with ordinals, EXDATE...) is a library's job, and both providers expand
 * recurrence server-side anyway, so this exists for previewing and for the
 * inbound reconciliation path rather than as a scheduling authority.
 *
 * @returns {Date[]} occurrence starts, bounded by `limit`.
 */
function expandRecurrence(rule, { from, until, limit = 100 } = {}) {
  if (!rule) return []

  const body = String(rule).replace(/^RRULE:/i, '')
  const parts = {}
  for (const segment of body.split(';')) {
    const [k, v] = segment.split('=')
    if (k) parts[k.toUpperCase()] = v
  }

  const freq = (parts.FREQ || '').toUpperCase()
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return []

  const interval = Math.max(parseInt(parts.INTERVAL, 10) || 1, 1)
  const count = parts.COUNT ? parseInt(parts.COUNT, 10) : null
  const untilDate = parts.UNTIL ? parseRRuleDate(parts.UNTIL) : null

  const start = from instanceof Date ? new Date(from) : new Date()
  const hardStop = until instanceof Date ? until : new Date(start.getTime() + 365 * 86400000)
  const stop = untilDate && untilDate < hardStop ? untilDate : hardStop

  const out = []
  const cursor = new Date(start)

  while (out.length < limit && cursor <= stop) {
    out.push(new Date(cursor))
    if (count && out.length >= count) break

    if (freq === 'DAILY') cursor.setUTCDate(cursor.getUTCDate() + interval)
    else if (freq === 'WEEKLY') cursor.setUTCDate(cursor.getUTCDate() + 7 * interval)
    else cursor.setUTCMonth(cursor.getUTCMonth() + interval)
  }

  return out
}

function parseRRuleDate(value) {
  // RRULE UNTIL is basic ISO8601: 20260814T090000Z
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/)
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
}

// ===========================================================================
// TOKEN LIFECYCLE
// ===========================================================================

/**
 * Usable credentials for a connection, refreshing if near expiry.
 *
 * On refresh failure the connection is marked disconnected and the user is
 * notified — the PRD's mitigation for "OAuth token expiry/revocation silently
 * breaking sync". Silence is the failure mode being designed against, so this
 * path must always produce a user-visible signal.
 *
 * @returns {{auth}|{error}} never throws.
 */
async function ensureFreshAuth(connection, deps = {}) {
  const provider = deps.provider || resolveProvider(connection.provider)
  if (!provider) return { error: 'unknown_provider' }

  const accessToken = decrypt(connection.access_token)
  const refreshToken = decrypt(connection.refresh_token)

  const expiresAt = connection.token_expires_at
    ? new Date(connection.token_expires_at).getTime()
    : 0
  const needsRefresh = !accessToken || expiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS

  if (!needsRefresh) return { auth: { accessToken } }

  if (!refreshToken) {
    await markConnectionBroken(connection, 'No refresh token stored; reconnect required.')
    return { error: 'no_refresh_token' }
  }

  try {
    const refreshed = await provider.refreshAccessToken(refreshToken)
    await pool.query(
      `UPDATE calendar_connections
          SET access_token = $2, token_expires_at = $3,
              status = 'connected', last_error = NULL, updated_at = NOW()
        WHERE id = $1`,
      [connection.id, encrypt(refreshed.accessToken), refreshed.expiresAt || null]
    )
    return { auth: { accessToken: refreshed.accessToken } }
  } catch (err) {
    await markConnectionBroken(connection, err.message)
    return { error: 'refresh_failed' }
  }
}

async function markConnectionBroken(connection, reason) {
  await pool.query(
    `UPDATE calendar_connections
        SET status = 'disconnected', last_error = $2, updated_at = NOW()
      WHERE id = $1`,
    [connection.id, String(reason || '').slice(0, 500)]
  ).catch(() => {})

  // Wrapped: a failed notification must never mask the underlying sync error.
  try {
    await dispatchNotification(
      connection.user_id,
      NOTIFICATION_TYPES.CALENDAR_SYNC_FAILED,
      'Calendar sync disconnected',
      `Your ${connection.provider === 'google' ? 'Google' : 'Outlook'} Calendar connection stopped working and sync has paused. Reconnect to resume.`,
      '/calendar',
      'high',
      { dedupeWindowMinutes: 720 }
    )
  } catch (err) {
    console.error('[calendar-sync] failed to notify about broken connection:', err.message)
  }
}

// ===========================================================================
// SYNC PASSES
// ===========================================================================

/**
 * Which items this connection should sync, honouring the scope settings.
 * Employee scoping is inherent: a connection belongs to one user and we only
 * ever select tasks assigned to that user, so a user can never sync a task
 * they cannot see ("Sync respects task-level visibility/permissions").
 */
async function collectSyncableItems(connection, settings) {
  const items = []

  if (settings.sync_tasks !== false) {
    const params = [connection.user_id]
    let scopeClause = ''
    if (Array.isArray(settings.project_scope) && settings.project_scope.length > 0) {
      params.push(settings.project_scope)
      scopeClause = ` AND t.project_id = ANY($${params.length}::uuid[])`
    }

    const { rows } = await pool.query(
      `SELECT t.id, t.title, t.description, t.due_date, t.priority, t.status,
              p.name AS project_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.assignee_id = $1
          AND t.due_date IS NOT NULL
          AND t.status NOT IN ('completed')${scopeClause}`,
      params
    )
    for (const row of rows) items.push({ kind: 'task', row })
  }

  if (settings.sync_milestones !== false) {
    const { rows } = await pool.query(
      `SELECT DISTINCT p.id, p.name, p.end_date
         FROM projects p
         LEFT JOIN project_members pm ON pm.project_id = p.id
        WHERE p.end_date IS NOT NULL
          AND p.status = 'active'
          AND (p.manager_id = $1 OR pm.user_id = $1)`,
      [connection.user_id]
    )
    for (const row of rows) items.push({ kind: 'milestone', row })
  }

  return items
}

/**
 * Outbound: tracker → calendar.
 *
 * Every write is preceded by the dedupe check, so a steady-state sweep over an
 * unchanged workload issues zero provider calls.
 */
async function pushPass(connection, settings, auth, provider, result) {
  if (settings.sync_direction === 'from_calendar') return

  const items = await collectSyncableItems(connection, settings)
  const seen = new Set()

  for (const item of items) {
    const mapped =
      item.kind === 'task'
        ? mapTaskToEvent(item.row, settings)
        : mapMilestoneToEvent(item.row, settings)
    if (!mapped) continue

    seen.add(`${mapped.sourceType}:${mapped.sourceId}`)
    const hash = contentHash(mapped)
    result.scanned += 1

    // Upsert the link first so a crash mid-push cannot orphan a provider event.
    const { rows: linkRows } = await pool.query(
      `INSERT INTO calendar_event_links
         (connection_id, source_type, source_id, state)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (connection_id, source_type, source_id) DO UPDATE
         SET updated_at = NOW()
       RETURNING *`,
      [connection.id, mapped.sourceType, mapped.sourceId]
    )
    const link = linkRows[0]

    // ---- DEDUPE: the early exit that keeps us inside API quota -------------
    if (isUnchanged(link, hash) && link.state === 'synced') {
      result.skipped += 1
      continue
    }

    try {
      let written
      if (link.provider_event_id) {
        // ---- CONFLICT DETECTION -------------------------------------------
        const remote = await fetchRemote(provider, auth, link.provider_event_id, connection)
        const conflict = detectConflict(link, hash, remote)

        if (conflict) {
          const action = resolveConflict(conflict, settings.conflict_policy)
          await recordConflict(connection, link, conflict, action)
          result.conflicts += 1

          if (action === 'await_user') continue
          if (action === 'pull_calendar') {
            await applyRemoteToTracker(link, remote, settings)
            result.pulled += 1
            continue
          }
          // push_tracker falls through — the tracker overwrites, as designed.
        }
      }

      if (link.provider_event_id) {
        written = await provider.updateEvent(auth, link.provider_event_id, mapped, {
          calendarId: connection.calendar_id || 'primary',
        })
        result.updated += 1
      } else {
        written = await provider.createEvent(auth, mapped, {
          calendarId: connection.calendar_id || 'primary',
        })
        result.created += 1
      }

      await pool.query(
        `UPDATE calendar_event_links
            SET provider_event_id = $2, content_hash = $3, remote_etag = $4,
                state = 'synced', last_pushed_at = NOW(), last_error = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [link.id, written.id, hash, written.etag || null]
      )
    } catch (err) {
      result.failed += 1
      await pool.query(
        `UPDATE calendar_event_links
            SET state = 'error', last_error = $2, updated_at = NOW()
          WHERE id = $1`,
        [link.id, String(err.message || '').slice(0, 500)]
      ).catch(() => {})
    }
  }

  // AC-18: an item that dropped out of scope (deleted, completed, unassigned)
  // must have its calendar event removed rather than left as a phantom
  // deadline the user will keep seeing.
  await reapOrphanedLinks(connection, settings, auth, provider, seen, result)
}

async function fetchRemote(provider, auth, eventId, connection) {
  try {
    const { events } = await provider.listEvents(auth, {
      calendarId: connection.calendar_id || 'primary',
    })
    return events.find((e) => e.id === eventId) || null
  } catch {
    // If we cannot read the remote we cannot claim a conflict; proceed as a
    // plain update rather than inventing one.
    return null
  }
}

async function reapOrphanedLinks(connection, settings, auth, provider, seen, result) {
  const { rows } = await pool.query(
    `SELECT * FROM calendar_event_links
      WHERE connection_id = $1 AND state <> 'deleted'`,
    [connection.id]
  )

  for (const link of rows) {
    const key = `${link.source_type}:${link.source_id}`
    if (seen.has(key)) continue

    if (link.provider_event_id) {
      try {
        await provider.deleteEvent(auth, link.provider_event_id, {
          calendarId: connection.calendar_id || 'primary',
        })
      } catch (err) {
        result.failed += 1
        continue
      }
    }
    await pool.query(`DELETE FROM calendar_event_links WHERE id = $1`, [link.id])
    result.removed += 1
  }
}

/**
 * Inbound: calendar → tracker.
 *
 * Strictly bounded. It walks only events the tracker itself created (they
 * carry our source marker) and, of those, adjusts only the due date. It never
 * creates tasks and never touches title, status, assignee or priority. A
 * calendar must not become an unaudited write path into the task table.
 */
async function pullPass(connection, settings, auth, provider, result) {
  if (settings.sync_direction === 'to_calendar') return
  if (settings.conflict_policy !== 'calendar_wins') {
    // Under tracker_wins the inbound pass has nothing it is permitted to
    // apply; conflicts were already recorded during the push pass.
    return
  }

  let remote
  try {
    remote = await provider.listEvents(auth, {
      syncToken: connection.sync_token || undefined,
      calendarId: connection.calendar_id || 'primary',
    })
  } catch (err) {
    if (err.code === 'sync_token_expired') {
      await pool.query(
        `UPDATE calendar_connections SET sync_token = NULL, updated_at = NOW() WHERE id = $1`,
        [connection.id]
      )
    }
    return
  }

  for (const event of remote.events || []) {
    if (!event.sourceId || event.sourceType !== 'task') continue

    const { rows } = await pool.query(
      `SELECT * FROM calendar_event_links
        WHERE connection_id = $1 AND provider_event_id = $2`,
      [connection.id, event.id]
    )
    const link = rows[0]
    if (!link) continue
    if (link.remote_etag && event.etag === link.remote_etag) continue

    await applyRemoteToTracker(link, event, settings)
    result.pulled += 1
  }

  if (remote.nextSyncToken) {
    await pool.query(
      `UPDATE calendar_connections SET sync_token = $2, updated_at = NOW() WHERE id = $1`,
      [connection.id, remote.nextSyncToken]
    )
  }
}

/**
 * Apply a calendar-side change back to the task. Due date only — see pullPass.
 */
async function applyRemoteToTracker(link, remote, settings) {
  if (!remote || !remote.start || link.source_type !== 'task') return

  const nextDue = toTrackerDate(remote.start, settings.time_zone)
  if (!nextDue) return

  await pool.query(
    `UPDATE tasks SET due_date = $2, updated_at = NOW() WHERE id = $1`,
    [link.source_id, nextDue]
  )
  await pool.query(
    `UPDATE calendar_event_links
        SET remote_etag = $2, content_hash = NULL, state = 'dirty',
            last_pulled_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [link.id, remote.etag || null]
  )
}

async function recordConflict(connection, link, conflict, action) {
  const resolution =
    action === 'push_tracker' ? 'use_tracker' : action === 'pull_calendar' ? 'use_calendar' : null

  const { rows } = await pool.query(
    `INSERT INTO calendar_sync_conflicts
       (link_id, connection_id, conflict_type, field, tracker_value, provider_value,
        resolution, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7::varchar IS NULL THEN NULL ELSE NOW() END)
     RETURNING id`,
    [
      link.id,
      connection.id,
      conflict.conflictType,
      conflict.field,
      String(conflict.trackerValue || '').slice(0, 500),
      String(conflict.providerValue || '').slice(0, 500),
      resolution,
    ]
  )

  // AC-20 requires the user be told even when policy resolved it silently.
  try {
    await dispatchNotification(
      connection.user_id,
      NOTIFICATION_TYPES.CALENDAR_CONFLICT_DETECTED,
      'Calendar sync conflict',
      action === 'await_user'
        ? 'An event was changed in both the tracker and your calendar. Choose which version to keep.'
        : 'An event was changed in both places. The tracker version was kept, as configured.',
      '/calendar',
      'normal',
      { dedupeWindowMinutes: 60 }
    )
  } catch (err) {
    console.error('[calendar-sync] conflict notification failed:', err.message)
  }

  return rows[0]?.id || null
}

/**
 * Sync one connection. Never throws — a single broken connection must not
 * abort the sweep for every other user.
 */
async function syncConnection(connection, deps = {}) {
  const result = {
    connectionId: connection.id,
    scanned: 0, created: 0, updated: 0, skipped: 0,
    removed: 0, pulled: 0, conflicts: 0, failed: 0,
  }

  const provider = deps.provider || resolveProvider(connection.provider)
  if (!provider) {
    result.failed += 1
    return result
  }

  const { rows: settingsRows } = await pool.query(
    `SELECT * FROM calendar_sync_settings WHERE connection_id = $1`,
    [connection.id]
  )
  const settings = settingsRows[0] || {}

  if (settings.sync_direction === 'off' || connection.status === 'paused') return result

  const authResult = await ensureFreshAuth(connection, { provider })
  if (authResult.error) {
    result.failed += 1
    result.error = authResult.error
    return result
  }

  try {
    await pushPass(connection, settings, authResult.auth, provider, result)
    await pullPass(connection, settings, authResult.auth, provider, result)

    await pool.query(
      `UPDATE calendar_connections
          SET last_synced_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE id = $1`,
      [connection.id]
    )
  } catch (err) {
    result.failed += 1
    result.error = err.message
    await pool.query(
      `UPDATE calendar_connections SET last_error = $2, updated_at = NOW() WHERE id = $1`,
      [connection.id, String(err.message || '').slice(0, 500)]
    ).catch(() => {})
  }

  return result
}

/**
 * Sweep every connected calendar.
 *
 * @param {object} deps  { provider } injectable, mirroring
 *                       push-retry.js#runPushRetriesNow({ send }).
 */
async function runCalendarSyncNow(deps = {}) {
  const summary = { connections: 0, created: 0, updated: 0, skipped: 0, removed: 0, pulled: 0, conflicts: 0, failed: 0 }

  const { rows } = await pool.query(
    `SELECT * FROM calendar_connections
      WHERE status = 'connected'
      ORDER BY COALESCE(last_synced_at, 'epoch'::timestamptz) ASC
      LIMIT 100`
  )

  for (const connection of rows) {
    const r = await syncConnection(connection, deps)
    summary.connections += 1
    summary.created += r.created
    summary.updated += r.updated
    summary.skipped += r.skipped
    summary.removed += r.removed
    summary.pulled += r.pulled
    summary.conflicts += r.conflicts
    summary.failed += r.failed
  }

  if (summary.connections) {
    console.log(
      `[calendar-sync] ${summary.connections} connection(s) · created ${summary.created} ` +
      `· updated ${summary.updated} · unchanged ${summary.skipped} · removed ${summary.removed} ` +
      `· pulled ${summary.pulled} · conflicts ${summary.conflicts} · failed ${summary.failed}`
    )
  }
  return summary
}

/**
 * Mark a task's links dirty so the next sweep re-pushes it (AC-17).
 * Called from the task controller; must never throw into a request.
 */
async function markSourceDirty(sourceType, sourceId) {
  if (!sourceType || !sourceId) return 0
  // `state = 'dirty'` alone is enough to defeat the dedupe early-exit, which
  // requires state === 'synced'. The stored content_hash is deliberately KEPT:
  // it is the baseline recording what the calendar last agreed with, and
  // detectConflict needs it to tell "the tracker changed" from "nothing is
  // known". Clearing it here silently disabled conflict detection for exactly
  // the edits most likely to conflict — the ones a user just made.
  const { rowCount } = await pool.query(
    `UPDATE calendar_event_links
        SET state = 'dirty', updated_at = NOW()
      WHERE source_type = $1 AND source_id = $2 AND state <> 'deleted'`,
    [sourceType, sourceId]
  )
  return rowCount
}

/**
 * Remove a source's calendar events across every connection (AC-18).
 * Best-effort per connection: one provider failure must not block the others.
 */
async function purgeSource(sourceType, sourceId, deps = {}) {
  if (!sourceType || !sourceId) return 0

  const { rows } = await pool.query(
    `SELECT l.*, c.provider, c.calendar_id, c.access_token, c.refresh_token,
            c.token_expires_at, c.user_id, c.id AS conn_id, c.status
       FROM calendar_event_links l
       JOIN calendar_connections c ON c.id = l.connection_id
      WHERE l.source_type = $1 AND l.source_id = $2`,
    [sourceType, sourceId]
  )

  let removed = 0
  for (const row of rows) {
    if (row.provider_event_id && row.status === 'connected') {
      const provider = deps.provider || resolveProvider(row.provider)
      if (provider) {
        const authResult = await ensureFreshAuth(
          {
            id: row.conn_id,
            user_id: row.user_id,
            provider: row.provider,
            access_token: row.access_token,
            refresh_token: row.refresh_token,
            token_expires_at: row.token_expires_at,
          },
          { provider }
        )
        if (authResult.auth) {
          try {
            await provider.deleteEvent(authResult.auth, row.provider_event_id, {
              calendarId: row.calendar_id || 'primary',
            })
          } catch (err) {
            console.error('[calendar-sync] purge delete failed:', err.message)
          }
        }
      }
    }
    await pool.query(`DELETE FROM calendar_event_links WHERE id = $1`, [row.id])
    removed += 1
  }
  return removed
}

module.exports = {
  // mapping & transformation
  mapTaskToEvent,
  mapMilestoneToEvent,
  // time zone conversion
  materialiseDueDate,
  toTrackerDate,
  // deduplication
  contentHash,
  isUnchanged,
  // conflict detection & resolution
  detectConflict,
  resolveConflict,
  // recurrence
  expandRecurrence,
  // sync
  runCalendarSyncNow,
  syncConnection,
  ensureFreshAuth,
  collectSyncableItems,
  markSourceDirty,
  purgeSource,
  DEFAULT_EVENT_DURATION_MINUTES,
}
