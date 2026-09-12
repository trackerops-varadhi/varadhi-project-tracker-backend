/**
 * Per-request context, carried without threading it through every signature.
 * ---------------------------------------------------------------------------
 * One AsyncLocalStorage holding the correlation id (and whatever else a request
 * needs to make available to code far below it). Anything running inside a
 * request — a controller, a repo, a `console.log` six frames down — can ask for
 * the current request id without being handed it.
 *
 * WHY NOT A REQUEST-SCOPED LOGGER PASSED AS AN ARGUMENT
 * That is the cleaner design in a greenfield codebase. Here it would mean
 * editing 257 existing `console.*` call sites across eight modules to accept and
 * forward a logger, which is a large diff whose only purpose is plumbing — and
 * every one of those edits is a chance to change behaviour in code this work is
 * supposed to leave alone. AsyncLocalStorage gets the same result with no call
 * site changes at all.
 *
 * THE ONE THING TO KNOW ABOUT IT
 * The context follows `await` and promise chains, but it does NOT survive a
 * hop through something that breaks the async chain — a `setTimeout` scheduled
 * outside a request, an EventEmitter listener registered at startup, a cron
 * tick. Those genuinely have no request to belong to, so `getRequestId()`
 * returning null there is correct rather than a bug to work around.
 */

const { AsyncLocalStorage } = require('async_hooks')
const crypto = require('crypto')

const storage = new AsyncLocalStorage()

/** Run `fn` with `context` available to everything it awaits. */
const run = (context, fn) => storage.run(context, fn)

/** The current request's context, or an empty object outside a request. */
const get = () => storage.getStore() || {}

/** The current correlation id, or null outside a request. */
const getRequestId = () => get().requestId || null

/**
 * Add a field to the current request's context.
 * No-op outside a request, so callers never need to guard.
 */
const set = (key, value) => {
  const store = storage.getStore()
  if (store) store[key] = value
}

/**
 * A new correlation id.
 *
 * Not a UUID: these appear on every log line and in response headers, and a
 * 16-hex-char id is short enough to read aloud off a screen while still being
 * 64 bits of randomness — collision odds are irrelevant at any traffic this
 * system will see.
 */
const newRequestId = () => crypto.randomBytes(8).toString('hex')

module.exports = { run, get, set, getRequestId, newRequestId, storage }
