/**
 * Correlation id per request.
 * ---------------------------------------------------------------------------
 * Accepts an inbound `X-Request-Id` (or `X-Correlation-Id`), generates one when
 * absent, echoes it back on the response, and puts it in the async context so
 * every log line produced while handling the request carries it.
 *
 * WHY AN INBOUND ID IS TRUSTED, WITH A LIMIT
 * The frontend and the service worker can send an id so a browser action and
 * the server work it caused share one trace. That means the value is client
 * controlled, so it is length-capped and character-filtered before use — an id
 * ends up in log lines, and an unbounded caller-supplied string in a log line is
 * how log injection and multi-megabyte log entries happen. Anything that fails
 * the check is replaced by a generated id rather than rejected: a malformed
 * trace header is not a reason to fail somebody's request.
 *
 * MOUNT IT FIRST. Anything logged before this runs has no id to carry.
 */

const context = require('../platform/request-context')

// Long enough for a UUID, strict enough that nothing but an id fits.
const VALID = /^[A-Za-z0-9_-]{8,64}$/

const requestId = (req, res, next) => {
  const supplied = req.get('X-Request-Id') || req.get('X-Correlation-Id')
  const id = supplied && VALID.test(supplied) ? supplied : context.newRequestId()

  req.id = id
  res.setHeader('X-Request-Id', id)

  // Everything downstream runs inside this store, including async work, so
  // logger.js can pick the id up without it being passed anywhere.
  context.run({ requestId: id, startedAt: Date.now() }, () => next())
}

module.exports = { requestId, VALID }
