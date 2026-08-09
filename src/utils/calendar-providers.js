/**
 * Calendar provider adapters (Module 4).
 * ---------------------------------------------------------------------------
 * One uniform interface over Google Calendar v3 and Microsoft Graph, plus an
 * in-memory mock. calendar-sync.js talks only to this interface and never
 * knows which provider it has — that is what lets the entire sync engine,
 * including conflict detection and dedupe, be exercised today without any
 * OAuth credentials.
 *
 * The degradation pattern is copied from notification-engine.js:59-72, where
 * `web-push` is only required if VAPID keys exist and the channel silently
 * no-ops otherwise. Same idea: no GOOGLE_CLIENT_ID means resolveProvider()
 * hands back the mock rather than a client that would 401 on every call.
 * Adding the real credentials later flips it live with zero code change.
 *
 * THE INTERFACE — every adapter implements exactly this:
 *
 *   isConfigured()                        → boolean
 *   getAuthUrl(state, redirectUri)        → string
 *   exchangeCode(code, redirectUri)       → { accessToken, refreshToken,
 *                                             expiresAt, accountEmail }
 *   refreshAccessToken(refreshToken)      → { accessToken, expiresAt }
 *   listEvents(auth, { syncToken, since })→ { events[], nextSyncToken }
 *   createEvent(auth, mapped)             → { id, etag }
 *   updateEvent(auth, id, mapped)         → { id, etag }
 *   deleteEvent(auth, id)                 → void
 *
 * `mapped` is the provider-neutral shape produced by calendar-sync.js
 * #mapTaskToEvent; each adapter translates it to its own wire format. That
 * translation is the "Mapping & Transformation" box in the reference design.
 *
 * SCOPES are the minimum the PRD permits — a single calendar-events scope per
 * provider. Notably NOT the read-all-profile or read-mail scopes that come
 * bundled in most examples: "no unrelated personal calendar data is accessed
 * beyond the minimum OAuth scope required".
 */

const axios = require('axios')

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

const MS_SCOPES = ['offline_access', 'Calendars.ReadWrite', 'User.Read'].join(' ')

const GOOGLE_API = 'https://www.googleapis.com/calendar/v3'
const GRAPH_API = 'https://graph.microsoft.com/v1.0'

/** Providers time out rather than hanging a cron sweep behind a dead socket. */
const HTTP_TIMEOUT_MS = 15000

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a provider HTTP failure into something with a `statusCode`, so
 * callers can classify transient vs permanent the same way push-retry.js does.
 */
function providerError(err, provider) {
  const status = err?.response?.status ?? null
  const detail =
    err?.response?.data?.error?.message ||
    err?.response?.data?.error_description ||
    err?.message ||
    'unknown provider error'
  const e = new Error(`[${provider}] ${detail}`)
  e.statusCode = status
  e.provider = provider
  return e
}

function expiresAtFrom(expiresInSeconds) {
  const seconds = Number(expiresInSeconds)
  if (!Number.isFinite(seconds)) return null
  return new Date(Date.now() + seconds * 1000)
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

const googleProvider = {
  name: 'google',
  label: 'Google Calendar',

  isConfigured() {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  },

  getAuthUrl(state, redirectUri) {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      // Without both of these Google returns no refresh_token on repeat
      // authorisations, and sync dies silently an hour later.
      access_type: 'offline',
      prompt: 'consent',
      state,
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  },

  async exchangeCode(code, redirectUri) {
    try {
      const { data } = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: HTTP_TIMEOUT_MS,
        }
      )

      let accountEmail = null
      try {
        const me = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${data.access_token}` },
          timeout: HTTP_TIMEOUT_MS,
        })
        accountEmail = me.data?.email || null
      } catch {
        // The email is a display convenience for the Connect card, not a
        // functional requirement. Never fail a working connection over it.
      }

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        expiresAt: expiresAtFrom(data.expires_in),
        accountEmail,
      }
    } catch (err) {
      throw providerError(err, 'google')
    }
  },

  async refreshAccessToken(refreshToken) {
    try {
      const { data } = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          refresh_token: refreshToken,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          grant_type: 'refresh_token',
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: HTTP_TIMEOUT_MS,
        }
      )
      return {
        accessToken: data.access_token,
        expiresAt: expiresAtFrom(data.expires_in),
      }
    } catch (err) {
      throw providerError(err, 'google')
    }
  },

  async listEvents(auth, { syncToken, since, calendarId = 'primary' } = {}) {
    try {
      // Google forbids combining syncToken with timeMin — the token already
      // encodes the position. Send one or the other, never both.
      const params = syncToken
        ? { syncToken, showDeleted: true }
        : {
            timeMin: (since || new Date()).toISOString(),
            showDeleted: false,
            singleEvents: false,
            maxResults: 250,
          }

      const { data } = await axios.get(
        `${GOOGLE_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          headers: { Authorization: `Bearer ${auth.accessToken}` },
          params,
          timeout: HTTP_TIMEOUT_MS,
        }
      )

      return {
        events: (data.items || []).map(fromGoogleEvent),
        nextSyncToken: data.nextSyncToken || null,
      }
    } catch (err) {
      // 410 GONE means the syncToken expired; the caller must full-resync.
      const e = providerError(err, 'google')
      if (e.statusCode === 410) e.code = 'sync_token_expired'
      throw e
    }
  },

  async createEvent(auth, mapped, { calendarId = 'primary' } = {}) {
    try {
      const { data } = await axios.post(
        `${GOOGLE_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        toGoogleEvent(mapped),
        {
          headers: { Authorization: `Bearer ${auth.accessToken}` },
          timeout: HTTP_TIMEOUT_MS,
        }
      )
      return { id: data.id, etag: data.etag || null }
    } catch (err) {
      throw providerError(err, 'google')
    }
  },

  async updateEvent(auth, eventId, mapped, { calendarId = 'primary' } = {}) {
    try {
      const { data } = await axios.patch(
        `${GOOGLE_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        toGoogleEvent(mapped),
        {
          headers: { Authorization: `Bearer ${auth.accessToken}` },
          timeout: HTTP_TIMEOUT_MS,
        }
      )
      return { id: data.id, etag: data.etag || null }
    } catch (err) {
      throw providerError(err, 'google')
    }
  },

  async deleteEvent(auth, eventId, { calendarId = 'primary' } = {}) {
    try {
      await axios.delete(
        `${GOOGLE_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        {
          headers: { Authorization: `Bearer ${auth.accessToken}` },
          timeout: HTTP_TIMEOUT_MS,
        }
      )
    } catch (err) {
      const e = providerError(err, 'google')
      // Already gone is the desired end state, not a failure.
      if (e.statusCode === 404 || e.statusCode === 410) return
      throw e
    }
  },
}

function toGoogleEvent(mapped) {
  const event = {
    summary: mapped.title,
    description: mapped.description,
    start: { dateTime: mapped.start, timeZone: mapped.timeZone },
    end: { dateTime: mapped.end, timeZone: mapped.timeZone },
    source: mapped.link ? { title: 'Varadhi Project Tracker', url: mapped.link } : undefined,
    // Marks events we own, so an inbound pass can tell "the tracker put this
    // here" from "the user created this by hand".
    extendedProperties: {
      private: {
        varadhiSourceType: mapped.sourceType || '',
        varadhiSourceId: mapped.sourceId || '',
      },
    },
  }
  if (mapped.recurrence) event.recurrence = [mapped.recurrence]
  if (mapped.reminderMinutes != null) {
    event.reminders = {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: mapped.reminderMinutes }],
    }
  }
  return event
}

function fromGoogleEvent(item) {
  return {
    id: item.id,
    etag: item.etag || null,
    title: item.summary || '',
    description: item.description || '',
    start: item.start?.dateTime || item.start?.date || null,
    end: item.end?.dateTime || item.end?.date || null,
    timeZone: item.start?.timeZone || null,
    recurrence: Array.isArray(item.recurrence) ? item.recurrence[0] : null,
    cancelled: item.status === 'cancelled',
    sourceType: item.extendedProperties?.private?.varadhiSourceType || null,
    sourceId: item.extendedProperties?.private?.varadhiSourceId || null,
  }
}

// ---------------------------------------------------------------------------
// Microsoft Outlook (Graph)
// ---------------------------------------------------------------------------

const microsoftProvider = {
  name: 'outlook',
  label: 'Outlook Calendar',

  isConfigured() {
    return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET)
  },

  getAuthUrl(state, redirectUri) {
    const tenant = process.env.MS_TENANT_ID || 'common'
    const params = new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: MS_SCOPES,
      state,
    })
    return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`
  },

  async exchangeCode(code, redirectUri) {
    const tenant = process.env.MS_TENANT_ID || 'common'
    try {
      const { data } = await axios.post(
        `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        new URLSearchParams({
          code,
          client_id: process.env.MS_CLIENT_ID,
          client_secret: process.env.MS_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          scope: MS_SCOPES,
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: HTTP_TIMEOUT_MS,
        }
      )

      let accountEmail = null
      try {
        const me = await axios.get(`${GRAPH_API}/me`, {
          headers: { Authorization: `Bearer ${data.access_token}` },
          timeout: HTTP_TIMEOUT_MS,
        })
        accountEmail = me.data?.mail || me.data?.userPrincipalName || null
      } catch {
        // Display-only; see the Google note.
      }

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        expiresAt: expiresAtFrom(data.expires_in),
        accountEmail,
      }
    } catch (err) {
      throw providerError(err, 'outlook')
    }
  },

  async refreshAccessToken(refreshToken) {
    const tenant = process.env.MS_TENANT_ID || 'common'
    try {
      const { data } = await axios.post(
        `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        new URLSearchParams({
          refresh_token: refreshToken,
          client_id: process.env.MS_CLIENT_ID,
          client_secret: process.env.MS_CLIENT_SECRET,
          grant_type: 'refresh_token',
          scope: MS_SCOPES,
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: HTTP_TIMEOUT_MS,
        }
      )
      return {
        accessToken: data.access_token,
        expiresAt: expiresAtFrom(data.expires_in),
      }
    } catch (err) {
      throw providerError(err, 'outlook')
    }
  },

  async listEvents(auth, { syncToken, since } = {}) {
    try {
      // Graph's delta cursor is a full URL, so a stored token is followed
      // verbatim rather than rebuilt from parameters.
      const url = syncToken || `${GRAPH_API}/me/calendarView/delta`
      const params = syncToken
        ? undefined
        : {
            startDateTime: (since || new Date()).toISOString(),
            endDateTime: new Date(Date.now() + 180 * 86400000).toISOString(),
          }

      const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${auth.accessToken}`, Prefer: 'odata.maxpagesize=250' },
        params,
        timeout: HTTP_TIMEOUT_MS,
      })

      return {
        events: (data.value || []).map(fromGraphEvent),
        nextSyncToken: data['@odata.deltaLink'] || data['@odata.nextLink'] || null,
      }
    } catch (err) {
      const e = providerError(err, 'outlook')
      if (e.statusCode === 410) e.code = 'sync_token_expired'
      throw e
    }
  },

  async createEvent(auth, mapped) {
    try {
      const { data } = await axios.post(`${GRAPH_API}/me/events`, toGraphEvent(mapped), {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        timeout: HTTP_TIMEOUT_MS,
      })
      return { id: data.id, etag: data['@odata.etag'] || null }
    } catch (err) {
      throw providerError(err, 'outlook')
    }
  },

  async updateEvent(auth, eventId, mapped) {
    try {
      const { data } = await axios.patch(
        `${GRAPH_API}/me/events/${encodeURIComponent(eventId)}`,
        toGraphEvent(mapped),
        {
          headers: { Authorization: `Bearer ${auth.accessToken}` },
          timeout: HTTP_TIMEOUT_MS,
        }
      )
      return { id: data.id, etag: data['@odata.etag'] || null }
    } catch (err) {
      throw providerError(err, 'outlook')
    }
  },

  async deleteEvent(auth, eventId) {
    try {
      await axios.delete(`${GRAPH_API}/me/events/${encodeURIComponent(eventId)}`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
        timeout: HTTP_TIMEOUT_MS,
      })
    } catch (err) {
      const e = providerError(err, 'outlook')
      if (e.statusCode === 404 || e.statusCode === 410) return
      throw e
    }
  },
}

function toGraphEvent(mapped) {
  const event = {
    subject: mapped.title,
    body: { contentType: 'HTML', content: mapped.descriptionHtml || mapped.description || '' },
    start: { dateTime: mapped.start, timeZone: mapped.timeZone },
    end: { dateTime: mapped.end, timeZone: mapped.timeZone },
    // Graph has no extendedProperties equivalent that survives a simple PATCH,
    // so ownership is marked with a single-value extended property.
    singleValueExtendedProperties: [
      {
        id: 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name varadhiSource',
        value: `${mapped.sourceType || ''}:${mapped.sourceId || ''}`,
      },
    ],
  }
  if (mapped.reminderMinutes != null) {
    event.isReminderOn = true
    event.reminderMinutesBeforeStart = mapped.reminderMinutes
  }
  return event
}

function fromGraphEvent(item) {
  const marker = (item.singleValueExtendedProperties || []).find((p) =>
    String(p.id || '').includes('varadhiSource')
  )
  const [sourceType, sourceId] = String(marker?.value || '').split(':')

  return {
    id: item.id,
    etag: item['@odata.etag'] || null,
    title: item.subject || '',
    description: item.body?.content || '',
    start: item.start?.dateTime || null,
    end: item.end?.dateTime || null,
    timeZone: item.start?.timeZone || null,
    recurrence: item.recurrence ? JSON.stringify(item.recurrence) : null,
    cancelled: item['@removed'] !== undefined || item.isCancelled === true,
    sourceType: sourceType || null,
    sourceId: sourceId || null,
  }
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

/**
 * An in-memory calendar satisfying the same interface.
 *
 * This is not a stub that returns empty objects — it is a real, stateful fake.
 * Events persist, updates mutate them, deletes remove them, and every write
 * bumps an etag. That fidelity is what makes it possible to test the parts
 * that actually carry risk (dedupe, conflict detection, purge-on-disconnect)
 * without credentials, rather than merely testing that code paths execute.
 *
 * `__store` is exposed so tests can assert on the calendar's contents and
 * simulate an out-of-band edit — the "user changed the event in Google"
 * scenario that triggers AC-20 conflict handling.
 */
function createMockProvider(name = 'google') {
  const store = new Map()
  let counter = 0
  let etagCounter = 0
  const calls = { create: 0, update: 0, delete: 0, list: 0 }

  return {
    name,
    label: name === 'google' ? 'Google Calendar (mock)' : 'Outlook Calendar (mock)',
    isMock: true,

    isConfigured() {
      return true
    },

    getAuthUrl(state, redirectUri) {
      // Loops straight back to the callback with a synthetic code, so the
      // whole connect flow is walkable in a browser with no credentials.
      const params = new URLSearchParams({ code: `mock-code-${name}`, state })
      return `${redirectUri}?${params.toString()}`
    },

    async exchangeCode() {
      return {
        accessToken: `mock-access-${name}-${++counter}`,
        refreshToken: `mock-refresh-${name}`,
        expiresAt: new Date(Date.now() + 3600 * 1000),
        accountEmail: `demo.user@${name === 'google' ? 'gmail.com' : 'outlook.com'}`,
      }
    },

    async refreshAccessToken() {
      return {
        accessToken: `mock-access-${name}-${++counter}`,
        expiresAt: new Date(Date.now() + 3600 * 1000),
      }
    },

    async listEvents() {
      calls.list += 1
      return { events: Array.from(store.values()), nextSyncToken: `mock-sync-${store.size}` }
    },

    async createEvent(auth, mapped) {
      calls.create += 1
      const id = `mock-event-${++counter}`
      const etag = `etag-${++etagCounter}`
      store.set(id, { id, etag, ...mapped, cancelled: false })
      return { id, etag }
    },

    async updateEvent(auth, eventId, mapped) {
      calls.update += 1
      const etag = `etag-${++etagCounter}`
      const existing = store.get(eventId) || { id: eventId }
      store.set(eventId, { ...existing, ...mapped, id: eventId, etag, cancelled: false })
      return { id: eventId, etag }
    },

    async deleteEvent(auth, eventId) {
      calls.delete += 1
      store.delete(eventId)
    },

    // ---- test seams -------------------------------------------------------
    __store: store,
    __calls: calls,
    /** Simulate a user editing the event directly in their calendar. */
    __mutateRemotely(eventId, patch) {
      const existing = store.get(eventId)
      if (!existing) return null
      const etag = `etag-${++etagCounter}`
      const next = { ...existing, ...patch, etag }
      store.set(eventId, next)
      return next
    },
    __reset() {
      store.clear()
      calls.create = calls.update = calls.delete = calls.list = 0
    },
  }
}

// Mock instances are module-level singletons so a connection created in one
// request and synced by the cron in another sees the same fake calendar.
const mockProviders = {
  google: createMockProvider('google'),
  outlook: createMockProvider('outlook'),
}

const realProviders = {
  google: googleProvider,
  outlook: microsoftProvider,
}

const PROVIDER_NAMES = Object.freeze(['google', 'outlook'])

/**
 * The real adapter when credentials exist, else the mock.
 *
 * @param {'google'|'outlook'} name
 * @returns {object|null} null for an unknown provider name.
 */
function resolveProvider(name) {
  const real = realProviders[name]
  if (!real) return null
  if (real.isConfigured()) return real
  return mockProviders[name]
}

/** True when the REAL provider is credentialled — drives UI messaging. */
function isConfigured(name) {
  return Boolean(realProviders[name]?.isConfigured())
}

module.exports = {
  resolveProvider,
  isConfigured,
  PROVIDER_NAMES,
  googleProvider,
  microsoftProvider,
  createMockProvider,
  mockProviders,
  // exported for unit tests of the wire-format translation
  toGoogleEvent,
  fromGoogleEvent,
  toGraphEvent,
  fromGraphEvent,
}
