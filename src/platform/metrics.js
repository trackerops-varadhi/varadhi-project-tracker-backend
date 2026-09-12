/**
 * Metrics.
 * ---------------------------------------------------------------------------
 * A counter/histogram registry and a Prometheus-format `/metrics` endpoint,
 * with no dependency and no network calls.
 *
 * WHY NOT prom-client
 * This is a hook, not a metrics stack. Nothing here is scraped yet, and the
 * decision about which backend to use — Prometheus, Grafana Cloud, whatever
 * Render offers — has not been made. Adding a dependency and an exposition
 * library before there is a scraper commits to an answer prematurely and puts a
 * second bill on a project that is deliberately running on one database. When
 * something does scrape this, swapping the internals for prom-client is a
 * contained change because the call sites only use `inc` and `observe`.
 *
 * OFF BY DEFAULT. `/metrics` 404s unless METRICS_ENABLED=true, so this cannot
 * expose operational shape to the internet by accident. Recording still happens
 * either way — it is a Map increment, and having the numbers already collected
 * the moment someone enables the endpoint is worth more than the few bytes.
 *
 * CARDINALITY IS THE WHOLE RISK
 * A label set containing a user id, a task id or a raw URL path turns one series
 * into millions and is how metrics systems fall over. `labelKey` sorts and joins
 * labels, and the route label is the express route PATTERN (`/api/tasks/:id`),
 * never `req.url`. Keep it that way.
 */

const counters = new Map()   // name -> Map(labelKey -> count)
const histograms = new Map() // name -> Map(labelKey -> { sum, count, buckets })

const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]

const isEnabled = () => process.env.METRICS_ENABLED === 'true'

const labelKey = (labels = {}) =>
  Object.keys(labels).sort().map((k) => `${k}="${String(labels[k]).replace(/"/g, "'")}"`).join(',')

/** Increment a counter. */
const inc = (name, labels = {}, by = 1) => {
  if (!counters.has(name)) counters.set(name, new Map())
  const series = counters.get(name)
  const key = labelKey(labels)
  series.set(key, (series.get(key) || 0) + by)
}

/** Record an observation (milliseconds) into a histogram. */
const observe = (name, value, labels = {}) => {
  if (!histograms.has(name)) histograms.set(name, new Map())
  const series = histograms.get(name)
  const key = labelKey(labels)
  let h = series.get(key)
  if (!h) {
    h = { sum: 0, count: 0, buckets: new Array(BUCKETS.length).fill(0) }
    series.set(key, h)
  }
  h.sum += value
  h.count += 1
  for (let i = 0; i < BUCKETS.length; i += 1) if (value <= BUCKETS[i]) h.buckets[i] += 1
}

/** Everything recorded so far, as a plain object. For tests and debugging. */
const snapshot = () => ({
  counters: Object.fromEntries(
    [...counters].map(([n, s]) => [n, Object.fromEntries(s)])),
  histograms: Object.fromEntries(
    [...histograms].map(([n, s]) => [n, Object.fromEntries(
      [...s].map(([k, h]) => [k, { sum: h.sum, count: h.count }]))])),
})

const reset = () => { counters.clear(); histograms.clear() }

/** Prometheus text exposition format. */
const render = () => {
  const lines = []
  for (const [name, series] of counters) {
    lines.push(`# TYPE ${name} counter`)
    for (const [key, value] of series) {
      lines.push(`${name}${key ? `{${key}}` : ''} ${value}`)
    }
  }
  for (const [name, series] of histograms) {
    lines.push(`# TYPE ${name} histogram`)
    for (const [key, h] of series) {
      const base = key ? `{${key},` : '{'
      let cumulative = 0
      for (let i = 0; i < BUCKETS.length; i += 1) {
        cumulative = h.buckets[i]
        lines.push(`${name}_bucket${base}le="${BUCKETS[i]}"} ${cumulative}`)
      }
      lines.push(`${name}_bucket${base}le="+Inf"} ${h.count}`)
      lines.push(`${name}_sum${key ? `{${key}}` : ''} ${h.sum}`)
      lines.push(`${name}_count${key ? `{${key}}` : ''} ${h.count}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Per-request metrics. Mount after the router so `req.route` is populated —
 * that is what gives the low-cardinality route pattern rather than the raw URL.
 */
const httpMiddleware = (req, res, next) => {
  const started = Date.now()
  res.on('finish', () => {
    const route = (req.route && req.baseUrl + req.route.path)
      || req.baseUrl
      || 'unmatched'
    const labels = { method: req.method, route, status: String(res.statusCode) }
    inc('http_requests_total', labels)
    observe('http_request_duration_ms', Date.now() - started,
      { method: req.method, route })
  })
  next()
}

/** GET /metrics. 404s unless METRICS_ENABLED=true. */
const handler = (req, res) => {
  if (!isEnabled()) return res.status(404).json({ success: false, message: 'Not found' })
  res.set('Content-Type', 'text/plain; version=0.0.4')
  res.set('Cache-Control', 'no-store')
  return res.send(render())
}

module.exports = {
  inc, observe, snapshot, reset, render, handler, httpMiddleware, isEnabled, BUCKETS,
}
