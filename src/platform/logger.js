/**
 * Structured logging.
 * ---------------------------------------------------------------------------
 *   LOG_FORMAT=json     one JSON object per line, for a log collector
 *   LOG_FORMAT=pretty   today's human output, unchanged
 *   (unset)             pretty in development, json in production
 *
 *   LOG_LEVEL=debug|info|warn|error   default info (debug in development)
 *
 * WHY console.* IS BRIDGED RATHER THAN REWRITTEN
 * There are 257 `console.log/warn/error` calls across eight modules. Rewriting
 * them would be a very large diff whose entire purpose is plumbing, in code this
 * change is otherwise supposed to leave alone — and every edit is a chance to
 * change behaviour by accident. So `install()` replaces the console methods
 * instead: existing calls keep working, and in json mode they come out as
 * structured lines carrying the correlation id of whatever request they happened
 * inside. No call site changes, no behaviour change, and the 257 sites can be
 * migrated to `logger.info(...)` later, one at a time, with no deadline.
 *
 * In pretty mode the bridge passes straight through to the original console, so
 * a developer's terminal looks exactly as it did before this file existed.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No log shipping, no transport, no rotation. This writes lines to stdout and
 * stderr, which is what a container runtime expects; whatever collects them is
 * an infrastructure decision, not an application one.
 */

const context = require('./request-context')

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

const isProd = () => process.env.NODE_ENV === 'production'

const format = () => process.env.LOG_FORMAT || (isProd() ? 'json' : 'pretty')
const threshold = () =>
  LEVELS[process.env.LOG_LEVEL] || (isProd() ? LEVELS.info : LEVELS.debug)

// Captured before install() replaces them, so the bridge cannot recurse.
const real = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
}

/**
 * Errors do not survive JSON.stringify — `{}` is all you get. Unwrap them into
 * something a log search can actually match on.
 */
const serialise = (value) => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.code ? { code: value.code } : {}),
      stack: value.stack,
    }
  }
  return value
}

const emit = (level, msg, fields = {}) => {
  if (LEVELS[level] < threshold()) return

  const requestId = context.getRequestId()
  const stream = level === 'error' || level === 'warn' ? real.error : real.log

  if (format() === 'json') {
    const line = {
      ts: new Date().toISOString(),
      level,
      msg: typeof msg === 'string' ? msg : String(msg),
      ...(requestId ? { requestId } : {}),
      ...Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, serialise(v)])
      ),
    }
    // A field that cannot be serialised (a cycle, a BigInt) must not take the
    // process down or swallow the line.
    try { stream(JSON.stringify(line)) } catch {
      stream(JSON.stringify({ ts: line.ts, level, msg: line.msg, requestId,
        logError: 'fields were not serialisable' }))
    }
    return
  }

  const tag = requestId ? ` [${requestId}]` : ''
  const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields, (k, v) =>
    v instanceof Error ? v.message : v)}` : ''
  stream(`${msg}${tag}${extra}`)
}

const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),

  /** The real console, for output that must never be reformatted (banners). */
  raw: real,

  /** Current effective settings — used by tests and the startup banner. */
  settings: () => ({ format: format(), level: Object.keys(LEVELS)
    .find((k) => LEVELS[k] === threshold()) || 'info' }),
}

/**
 * Route the global console through this logger.
 *
 * Idempotent, and a no-op in pretty mode: there is nothing to gain from
 * re-formatting a line that is already in its final shape, and passing through
 * keeps a developer's terminal byte-identical to before.
 */
let installed = false
const install = () => {
  if (installed) return
  installed = true
  if (format() !== 'json') return

  const bridge = (level) => (...args) => {
    const [first, ...rest] = args
    const msg = typeof first === 'string' ? first : String(first)
    const fields = rest.length
      ? { args: rest.map(serialise) }
      : (first instanceof Error ? { err: serialise(first) } : {})
    emit(level, msg, fields)
  }

  console.log = bridge('info')
  console.info = bridge('info')
  console.debug = bridge('debug')
  console.warn = bridge('warn')
  console.error = bridge('error')
}

/** Restore the real console. For tests. */
const uninstall = () => {
  console.log = real.log
  console.info = real.info
  console.debug = real.debug
  console.warn = real.warn
  console.error = real.error
  installed = false
}

module.exports = { logger, install, uninstall, LEVELS }
