// Business-day helpers for workforce. "Today" for attendance and leave is the
// office's calendar day (BUSINESS_TZ, default Asia/Kolkata), not the server's:
// Render runs in UTC, so between 00:00 and 05:30 IST a UTC date is yesterday.

const BUSINESS_TZ = process.env.BUSINESS_TZ || 'Asia/Kolkata'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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

const daysBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / 86400000)

const isYmd = (s) => typeof s === 'string' && DATE_RE.test(s) && toUtc(s).toISOString().slice(0, 10) === s

const isWeekend = (ymd) => [0, 6].includes(toUtc(ymd).getUTCDay())

// Previous Monday–Friday day.
const previousWorkingDay = (ymd) => {
  let d = addDays(ymd, -1)
  while (isWeekend(d)) d = addDays(d, -1)
  return d
}

module.exports = { BUSINESS_TZ, todayIn, toUtc, addDays, daysBetween, isYmd, isWeekend, previousWorkingDay }
