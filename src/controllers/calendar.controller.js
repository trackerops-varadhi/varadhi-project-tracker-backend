/**
 * Calendar sync API (Module 4).
 *
 * Follows the house controller conventions: each handler owns its try/catch
 * and returns errorResponse(..., 500) rather than throwing to the error
 * middleware, and role/ownership checks are inline where the rule is
 * ownership-dependent (as tasks.controller.js does) rather than purely
 * role-based.
 *
 * OWNERSHIP IS THE WHOLE ACCESS MODEL HERE. A calendar connection is personal:
 * there is no manager or admin view of someone else's calendar, because the
 * OAuth grant is between that individual and their provider. So every handler
 * that touches a connection resolves it through requireOwnedConnection(),
 * which scopes by user_id — an admin querying another user's connection id
 * gets the same 404 as a stranger.
 */

const pool = require('../config/db')
const { successResponse, errorResponse } = require('../utils/response')
const {
  resolveProvider,
  isConfigured,
  PROVIDER_NAMES,
} = require('../utils/calendar-providers')
const { buildStateToken, verifyStateToken } = require('../utils/oauth-state')
const { encrypt, decrypt, isEncryptionAvailable } = require('../utils/crypto')
const {
  syncConnection,
  mapTaskToEvent,
  mapMilestoneToEvent,
  contentHash,
} = require('../utils/calendar-sync')

const APP_URL = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000'

function redirectUriFor(req, provider) {
  const base =
    process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`
  return `${base}/api/calendar/${provider}/callback`
}

/**
 * Public shape of a connection. Tokens are NEVER included — not even masked.
 * The frontend has no use for them and every field returned here ends up in a
 * browser cache and a service-worker response.
 */
function toPublicConnection(row, settings) {
  return {
    id: row.id,
    provider: row.provider,
    accountEmail: row.account_email,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    settings: settings ? toPublicSettings(settings) : null,
  }
}

function toPublicSettings(s) {
  return {
    syncDirection: s.sync_direction,
    syncTasks: s.sync_tasks,
    syncMeetings: s.sync_meetings,
    syncMilestones: s.sync_milestones,
    syncReminders: s.sync_reminders,
    defaultCalendar: s.default_calendar,
    timeZone: s.time_zone,
    dueTimeOfDay: s.due_time_of_day,
    conflictPolicy: s.conflict_policy,
    projectScope: s.project_scope || null,
  }
}

async function requireOwnedConnection(req, res) {
  const { rows } = await pool.query(
    `SELECT * FROM calendar_connections WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]
  )
  if (!rows[0]) {
    errorResponse(res, 'Calendar connection not found.', 404)
    return null
  }
  return rows[0]
}

// ---------------------------------------------------------------------------
// GET /api/calendar/providers — what can be connected, and is it real?
// ---------------------------------------------------------------------------
exports.getProviders = async (req, res) => {
  try {
    // Production never falls back to the demo calendar (see
    // calendar-providers.js#resolveProvider), so `mock` must report that
    // honestly — otherwise the UI would offer a demo that cannot run.
    const isProduction = process.env.NODE_ENV === 'production'

    const providers = PROVIDER_NAMES.map((name) => ({
      name,
      label: name === 'google' ? 'Google Calendar' : 'Outlook Calendar',
      configured: isConfigured(name),
      // Demo is only available off-production AND without real credentials.
      mock: !isConfigured(name) && !isProduction,
      // Unconfigured in production = genuinely unavailable, not a demo.
      unavailable: !isConfigured(name) && isProduction,
    }))
    return successResponse(res, {
      providers,
      encryptionAvailable: isEncryptionAvailable(),
    })
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/calendar/connections
// ---------------------------------------------------------------------------
exports.getConnections = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, s.sync_direction, s.sync_tasks, s.sync_meetings, s.sync_milestones,
              s.sync_reminders, s.default_calendar, s.time_zone, s.due_time_of_day,
              s.conflict_policy, s.project_scope
         FROM calendar_connections c
         LEFT JOIN calendar_sync_settings s ON s.connection_id = c.id
        WHERE c.user_id = $1
        ORDER BY c.created_at ASC`,
      [req.user.id]
    )

    const connections = rows.map((r) =>
      toPublicConnection(r, r.sync_direction ? r : null)
    )
    return successResponse(res, { connections })
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/calendar/:provider/auth-url
// ---------------------------------------------------------------------------
exports.getAuthUrl = async (req, res) => {
  try {
    const { provider: name } = req.params
    if (!PROVIDER_NAMES.includes(name)) {
      return errorResponse(res, 'Unknown calendar provider.', 400)
    }

    // Refuse to start a flow whose tokens we could not protect. Storing an
    // OAuth refresh token in plaintext is never an acceptable degradation.
    if (!isEncryptionAvailable()) {
      return errorResponse(
        res,
        'Calendar sync is unavailable: the server has no encryption key configured. Contact your administrator.',
        503
      )
    }

    const provider = resolveProvider(name)
    // In production resolveProvider returns null for an uncredentialled
    // provider rather than silently handing back the demo calendar, so this
    // needs to say what is actually wrong instead of "unknown provider".
    if (!provider) {
      if (!isConfigured(name)) {
        return errorResponse(
          res,
          `${name === 'google' ? 'Google' : 'Outlook'} Calendar is not configured on this server yet. Contact your administrator.`,
          503
        )
      }
      return errorResponse(res, 'Unknown calendar provider.', 400)
    }

    const state = buildStateToken({ userId: req.user.id, provider: name })
    if (!state) return errorResponse(res, 'Unable to start the authorisation flow.', 500)

    const url = provider.getAuthUrl(state, redirectUriFor(req, name))
    return successResponse(res, { url, mock: Boolean(provider.isMock) })
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/calendar/:provider/callback
//
// Unauthenticated by necessity — it is a browser redirect from the provider,
// carrying no Authorization header. The signed `state` is what identifies the
// user; see utils/oauth-state.js for why it must be signed.
//
// Always redirects back to the SPA rather than rendering JSON, so the user
// lands somewhere useful whether it worked or not.
// ---------------------------------------------------------------------------
exports.oauthCallback = async (req, res) => {
  const backTo = (status, detail) => {
    const params = new URLSearchParams({ status })
    if (detail) params.set('detail', detail)
    return res.redirect(`${APP_URL}/calendar?${params.toString()}`)
  }

  try {
    const { provider: name } = req.params
    const { code, state, error: providerError } = req.query

    if (providerError) return backTo('denied', String(providerError).slice(0, 120))
    if (!PROVIDER_NAMES.includes(name)) return backTo('error', 'unknown_provider')
    if (!code || !state) return backTo('error', 'missing_code')

    const verified = verifyStateToken(state)
    if (!verified.ok) return backTo('error', verified.code)
    // The state names its provider; a callback arriving on a different
    // provider's path is a mismatch we refuse rather than reconcile.
    if (verified.claims.prov !== name) return backTo('error', 'state_mismatch')

    const userId = verified.claims.sub
    const provider = resolveProvider(name)
    if (!provider) return backTo('error', 'unknown_provider')

    const tokens = await provider.exchangeCode(code, redirectUriFor(req, name))

    const encAccess = encrypt(tokens.accessToken)
    // A missing refresh token is survivable only if we already hold one from a
    // previous grant — Google omits it on re-consent without prompt=consent.
    const encRefresh = tokens.refreshToken ? encrypt(tokens.refreshToken) : null

    if (!encAccess) return backTo('error', 'encryption_unavailable')

    const { rows } = await pool.query(
      `INSERT INTO calendar_connections
         (user_id, provider, account_email, access_token, refresh_token,
          token_expires_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,'connected')
       ON CONFLICT (user_id, provider) DO UPDATE
         SET account_email    = EXCLUDED.account_email,
             access_token     = EXCLUDED.access_token,
             refresh_token    = COALESCE(EXCLUDED.refresh_token, calendar_connections.refresh_token),
             token_expires_at = EXCLUDED.token_expires_at,
             status           = 'connected',
             last_error       = NULL,
             updated_at       = NOW()
       RETURNING id`,
      [
        userId,
        name,
        tokens.accountEmail || null,
        encAccess,
        encRefresh,
        tokens.expiresAt || null,
      ]
    )

    // Default settings on first connect. DO NOTHING on conflict so a
    // reconnect never silently resets a user's configured scope.
    await pool.query(
      `INSERT INTO calendar_sync_settings (connection_id, default_calendar)
       VALUES ($1, $2)
       ON CONFLICT (connection_id) DO NOTHING`,
      [rows[0].id, name]
    )

    return backTo('connected', name)
  } catch (err) {
    console.error('[calendar] OAuth callback failed:', err.message)
    return backTo('error', 'exchange_failed')
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/calendar/connections/:id?purgeEvents=true  (AC-19)
// ---------------------------------------------------------------------------
exports.disconnect = async (req, res) => {
  try {
    const connection = await requireOwnedConnection(req, res)
    if (!connection) return

    const purge =
      req.query.purgeEvents === 'true' || req.query.purgeEvents === '1'
    let removed = 0

    if (purge) {
      const provider = resolveProvider(connection.provider)
      const accessToken = decrypt(connection.access_token)

      if (provider && accessToken) {
        const { rows: links } = await pool.query(
          `SELECT id, provider_event_id FROM calendar_event_links
            WHERE connection_id = $1 AND provider_event_id IS NOT NULL`,
          [connection.id]
        )
        for (const link of links) {
          try {
            await provider.deleteEvent({ accessToken }, link.provider_event_id, {
              calendarId: connection.calendar_id || 'primary',
            })
            removed += 1
          } catch (err) {
            // Best effort: one undeletable event must not block disconnection.
            // The user asked to disconnect; that has to succeed regardless.
            console.error('[calendar] purge failed for one event:', err.message)
          }
        }
      }
    }

    // CASCADE clears links, settings and conflicts.
    await pool.query(`DELETE FROM calendar_connections WHERE id = $1`, [connection.id])

    return successResponse(
      res,
      { id: connection.id, purged: purge, eventsRemoved: removed },
      purge
        ? `Disconnected. ${removed} calendar event(s) removed.`
        : 'Disconnected. Previously synced events were left on your calendar.'
    )
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// GET / PUT  /api/calendar/connections/:id/settings
// ---------------------------------------------------------------------------
exports.getSettings = async (req, res) => {
  try {
    const connection = await requireOwnedConnection(req, res)
    if (!connection) return

    const { rows } = await pool.query(
      `SELECT * FROM calendar_sync_settings WHERE connection_id = $1`,
      [connection.id]
    )
    if (!rows[0]) return successResponse(res, { settings: null })
    return successResponse(res, { settings: toPublicSettings(rows[0]) })
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

const SYNC_DIRECTIONS = ['two_way', 'to_calendar', 'from_calendar']
const CONFLICT_POLICIES = ['tracker_wins', 'calendar_wins', 'manual']

exports.updateSettings = async (req, res) => {
  try {
    const connection = await requireOwnedConnection(req, res)
    if (!connection) return

    const b = req.body || {}

    // Validate enums here rather than relying on the CHECK constraint: a
    // constraint violation surfaces as a 500 with a Postgres message, which
    // is both a worse UX and a small information leak about the schema.
    if (b.syncDirection && !SYNC_DIRECTIONS.includes(b.syncDirection)) {
      return errorResponse(res, 'Invalid sync direction.', 400)
    }
    if (b.conflictPolicy && !CONFLICT_POLICIES.includes(b.conflictPolicy)) {
      return errorResponse(res, 'Invalid conflict policy.', 400)
    }
    if (b.dueTimeOfDay && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.dueTimeOfDay)) {
      return errorResponse(res, 'Invalid time of day; expected HH:MM.', 400)
    }
    if (b.timeZone) {
      try {
        new Intl.DateTimeFormat('en-CA', { timeZone: b.timeZone })
      } catch {
        return errorResponse(res, 'Unknown time zone.', 400)
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO calendar_sync_settings
         (connection_id, sync_direction, sync_tasks, sync_meetings, sync_milestones,
          sync_reminders, default_calendar, time_zone, due_time_of_day,
          conflict_policy, project_scope)
       VALUES ($1,
               COALESCE($2,'two_way'), COALESCE($3,TRUE), COALESCE($4,TRUE),
               COALESCE($5,TRUE), COALESCE($6,TRUE), COALESCE($7,'google'),
               COALESCE($8,'Asia/Kolkata'), COALESCE($9,'09:00'),
               COALESCE($10,'tracker_wins'), $11)
       ON CONFLICT (connection_id) DO UPDATE SET
         sync_direction   = COALESCE($2,  calendar_sync_settings.sync_direction),
         sync_tasks       = COALESCE($3,  calendar_sync_settings.sync_tasks),
         sync_meetings    = COALESCE($4,  calendar_sync_settings.sync_meetings),
         sync_milestones  = COALESCE($5,  calendar_sync_settings.sync_milestones),
         sync_reminders   = COALESCE($6,  calendar_sync_settings.sync_reminders),
         default_calendar = COALESCE($7,  calendar_sync_settings.default_calendar),
         time_zone        = COALESCE($8,  calendar_sync_settings.time_zone),
         due_time_of_day  = COALESCE($9,  calendar_sync_settings.due_time_of_day),
         conflict_policy  = COALESCE($10, calendar_sync_settings.conflict_policy),
         project_scope    = $11,
         updated_at       = NOW()
       RETURNING *`,
      [
        connection.id,
        b.syncDirection ?? null,
        typeof b.syncTasks === 'boolean' ? b.syncTasks : null,
        typeof b.syncMeetings === 'boolean' ? b.syncMeetings : null,
        typeof b.syncMilestones === 'boolean' ? b.syncMilestones : null,
        typeof b.syncReminders === 'boolean' ? b.syncReminders : null,
        b.defaultCalendar ?? null,
        b.timeZone ?? null,
        b.dueTimeOfDay ?? null,
        b.conflictPolicy ?? null,
        Array.isArray(b.projectScope) && b.projectScope.length ? b.projectScope : null,
      ]
    )

    // Changing what syncs changes what the mapped payload should be, so every
    // link is marked dirty — otherwise the content hash would match and the
    // next sweep would skip exactly the events the user just reconfigured.
    await pool.query(
      `UPDATE calendar_event_links SET state = 'dirty', updated_at = NOW()
        WHERE connection_id = $1 AND state = 'synced'`,
      [connection.id]
    )

    return successResponse(res, { settings: toPublicSettings(rows[0]) }, 'Sync settings saved.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// POST /api/calendar/connections/:id/sync — manual "Sync now"
// ---------------------------------------------------------------------------
exports.syncNow = async (req, res) => {
  try {
    const connection = await requireOwnedConnection(req, res)
    if (!connection) return

    const result = await syncConnection(connection)
    return successResponse(res, { result }, 'Sync complete.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/calendar/events — upcoming synced events (dashboard widget + preview)
//
// Reads from the tracker, not the provider: these are the items we sync, and
// hitting Google on every dashboard render would burn quota for no benefit.
// ---------------------------------------------------------------------------
exports.getUpcomingEvents = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 8, 50)
    const days = Math.min(parseInt(req.query.days, 10) || 14, 90)

    const { rows: connRows } = await pool.query(
      `SELECT c.*, s.time_zone, s.due_time_of_day, s.sync_tasks, s.sync_milestones,
              s.sync_reminders, s.project_scope
         FROM calendar_connections c
         LEFT JOIN calendar_sync_settings s ON s.connection_id = c.id
        WHERE c.user_id = $1 AND c.status = 'connected'`,
      [req.user.id]
    )

    const settings = connRows[0] || {}

    const { rows: tasks } = await pool.query(
      `SELECT t.id, t.title, t.description, t.due_date, t.priority, t.status,
              p.name AS project_name
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.assignee_id = $1
          AND t.due_date IS NOT NULL
          AND t.status NOT IN ('completed')
          AND t.due_date >= CURRENT_DATE
          AND t.due_date <= CURRENT_DATE + ($2 || ' days')::interval
        ORDER BY t.due_date ASC
        LIMIT $3`,
      [req.user.id, String(days), limit]
    )

    // Which of these are actually mirrored on a calendar right now.
    const { rows: links } = await pool.query(
      `SELECT l.source_id, l.state, l.provider_event_id, c.provider
         FROM calendar_event_links l
         JOIN calendar_connections c ON c.id = l.connection_id
        WHERE c.user_id = $1 AND l.source_type = 'task'`,
      [req.user.id]
    )
    const linkBySource = new Map(links.map((l) => [l.source_id, l]))

    const events = tasks.map((t) => {
      const mapped = mapTaskToEvent(t, settings)
      const link = linkBySource.get(t.id)
      return {
        sourceId: t.id,
        sourceType: 'task',
        title: t.title,
        projectName: t.project_name,
        priority: t.priority,
        dueDate: t.due_date,
        start: mapped?.start || null,
        end: mapped?.end || null,
        timeZone: mapped?.timeZone || settings.time_zone || 'Asia/Kolkata',
        link: `/tasks/${t.id}`,
        synced: Boolean(link?.provider_event_id),
        provider: link?.provider || null,
      }
    })

    return successResponse(res, {
      events,
      connected: connRows.length > 0,
      lastSyncedAt: connRows[0]?.last_synced_at || null,
      providers: connRows.map((c) => c.provider),
    })
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

// ---------------------------------------------------------------------------
// GET /api/calendar/conflicts
// ---------------------------------------------------------------------------
exports.getConflicts = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cf.*, l.source_type, l.source_id, c.provider
         FROM calendar_sync_conflicts cf
         JOIN calendar_event_links l ON l.id = cf.link_id
         JOIN calendar_connections c ON c.id = cf.connection_id
        WHERE c.user_id = $1
        ORDER BY cf.detected_at DESC
        LIMIT 50`,
      [req.user.id]
    )

    const conflicts = rows.map((r) => ({
      id: r.id,
      conflictType: r.conflict_type,
      field: r.field,
      provider: r.provider,
      sourceType: r.source_type,
      sourceId: r.source_id,
      resolution: r.resolution,
      resolvedAt: r.resolved_at,
      detectedAt: r.detected_at,
    }))
    return successResponse(res, { conflicts })
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

const RESOLUTIONS = [
  'use_tracker', 'use_calendar', 'keep_both',
  'reschedule', 'delete_everywhere', 'keep_event',
]

// ---------------------------------------------------------------------------
// POST /api/calendar/conflicts/:id/resolve
// ---------------------------------------------------------------------------
exports.resolveConflictById = async (req, res) => {
  try {
    const { resolution } = req.body || {}
    if (!RESOLUTIONS.includes(resolution)) {
      return errorResponse(res, 'Invalid resolution.', 400)
    }

    // Ownership is enforced through the join, not a separate check — a
    // conflict on someone else's connection simply does not match.
    const { rows } = await pool.query(
      `SELECT cf.*, l.id AS link_id
         FROM calendar_sync_conflicts cf
         JOIN calendar_connections c ON c.id = cf.connection_id
         JOIN calendar_event_links l ON l.id = cf.link_id
        WHERE cf.id = $1 AND c.user_id = $2`,
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return errorResponse(res, 'Conflict not found.', 404)

    await pool.query(
      `UPDATE calendar_sync_conflicts
          SET resolution = $2, resolved_by = $3, resolved_at = NOW()
        WHERE id = $1`,
      [req.params.id, resolution, req.user.id]
    )

    // Translate the choice into link state so the next sweep enacts it.
    if (resolution === 'use_tracker' || resolution === 'reschedule') {
      await pool.query(
        `UPDATE calendar_event_links
            SET state = 'dirty', content_hash = NULL, updated_at = NOW()
          WHERE id = $1`,
        [rows[0].link_id]
      )
    } else if (resolution === 'delete_everywhere') {
      await pool.query(
        `UPDATE calendar_event_links SET state = 'deleted', updated_at = NOW() WHERE id = $1`,
        [rows[0].link_id]
      )
    } else if (resolution === 'use_calendar' || resolution === 'keep_event') {
      // Adopt the remote as the new baseline so it stops being flagged.
      await pool.query(
        `UPDATE calendar_event_links
            SET state = 'synced', updated_at = NOW()
          WHERE id = $1`,
        [rows[0].link_id]
      )
    }

    return successResponse(res, { id: req.params.id, resolution }, 'Conflict resolved.')
  } catch (err) {
    return errorResponse(res, err.message, 500)
  }
}

exports.__internals = { toPublicConnection, toPublicSettings, contentHash, mapMilestoneToEvent }
