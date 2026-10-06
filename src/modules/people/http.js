// The one controller helper for people: unwrap req, call the service, shape
// the response. A PeopleError carries the status the caller should see;
// anything else is logged with context and returned as an opaque 500 (the
// workforce `fail` pattern — not identity's, which leaks err.message).

const { successResponse, errorResponse } = require('../../shared/response')
const { PeopleError } = require('./shared')

/**
 * @param {(req) => Promise<any>} fn
 * @param {{ where: string, fallback: string, status?: number, message?: string }} opts
 */
exports.handler = (fn, { where, fallback, status = 200, message = 'Success' }) =>
  async (req, res) => {
    try {
      const data = await fn(req)
      if (status === 204) return res.status(204).end()
      return successResponse(res, data ?? null, message, status)
    } catch (err) {
      if (err instanceof PeopleError) return errorResponse(res, err.message, err.status)
      console.error(`people.${where} error:`, err)
      return errorResponse(res, fallback, 500)
    }
  }
