// Helpers shared by the people services: the error type, business-day date
// arithmetic, input coercion and role predicates. Nothing here touches the
// database or req/res.

// "Today" for an HR screen is the office's calendar day, not the server's.
// Render runs in UTC, so between midnight and 05:30 IST a UTC "today" would
// still be yesterday and every attendance figure would be a day behind.
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'Asia/Kolkata'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Thrown for anything the caller can fix; the controllers map `.status` onto
// the response and turn anything else into an opaque 500.
class PeopleError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

/* ── roles ────────────────────────────────────────────────────────────── */

const roleOf = (user) => String(user?.role || '').toLowerCase()
const hasRole = (user, roles) => roles.includes(roleOf(user))

/* ── dates ────────────────────────────────────────────────────────────── */

const todayIn = (timeZone = BUSINESS_TZ) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())

const toUtc = (ymd) => new Date(`${ymd}T00:00:00Z`)
const addDays = (ymd, n) => {
  const d = toUtc(ymd)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const isValidDate = (s) => {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const d = toUtc(s)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

// Whole months from `from` to `to`, never negative; null when either is unknown.
const monthsBetween = (from, to) => {
  if (!from || !to) return null
  const [y1, m1, d1] = from.split('-').map(Number)
  const [y2, m2, d2] = to.split('-').map(Number)
  const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0)
  return Math.max(0, months)
}

// Completed years — "Age" is derived on read, never stored (plan §2.2).
const yearsBetween = (from, to) => {
  const months = monthsBetween(from, to)
  return months === null ? null : Math.floor(months / 12)
}

/* ── input coercion ───────────────────────────────────────────────────── */

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

const text = (value, { label, max, required = false }) => {
  if (isBlank(value)) {
    if (required) throw new PeopleError(`${label} is required.`)
    return null
  }
  const s = String(value).trim()
  if (s.length > max) throw new PeopleError(`${label} must be ${max} characters or fewer.`)
  return s
}

const date = (value, { label, required = false }) => {
  if (isBlank(value)) {
    if (required) throw new PeopleError(`${label} is required.`)
    return null
  }
  if (!isValidDate(value)) throw new PeopleError(`${label} must be a valid date (YYYY-MM-DD).`)
  return value
}

const int = (value, { label, min = 0, max = 100000, required = false }) => {
  if (isBlank(value)) {
    if (required) throw new PeopleError(`${label} is required.`)
    return null
  }
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new PeopleError(`${label} must be a whole number between ${min} and ${max}.`)
  }
  return n
}

const oneOf = (value, allowed, { label, required = false, fallback = null }) => {
  if (isBlank(value)) {
    if (required) throw new PeopleError(`${label} is required.`)
    return fallback
  }
  const v = String(value)
  if (!allowed.includes(v)) throw new PeopleError(`${label} must be one of: ${allowed.join(', ')}.`)
  return v
}

const uuid = (value, { label, required = false }) => {
  if (isBlank(value)) {
    if (required) throw new PeopleError(`Please select ${label}.`)
    return null
  }
  if (!UUID_RE.test(String(value))) throw new PeopleError(`${label} is not valid.`)
  return String(value)
}

// Accepts a comma-separated string or an array; trimmed, de-duplicated.
const skills = (value, { max = 30 } = {}) => {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',')
  const cleaned = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))]
  if (cleaned.length > max) throw new PeopleError(`At most ${max} skills.`)
  if (cleaned.some((s) => s.length > 60)) throw new PeopleError('Each skill must be 60 characters or fewer.')
  return cleaned
}

// page/limit clamped the house way (plan §4.5).
const pageArgs = ({ page, limit } = {}, defaultLimit = 20) => {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || defaultLimit))
  return { page: p, limit: l, offset: (p - 1) * l }
}

/* ── notifications ────────────────────────────────────────────────────── */

// A notification failure must never turn a successful write into a 500.
const notifySafely = async (fn) => {
  try {
    await fn()
  } catch (err) {
    console.error('[notifications] people:', err.message)
  }
}

module.exports = {
  BUSINESS_TZ, UUID_RE, PeopleError,
  roleOf, hasRole,
  todayIn, toUtc, addDays, isValidDate, monthsBetween, yearsBetween,
  isBlank, text, date, int, oneOf, uuid, skills, pageArgs,
  notifySafely,
}
