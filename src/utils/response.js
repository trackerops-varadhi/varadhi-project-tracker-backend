exports.successResponse = (res, data, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json({ success: true, message, data })
}
// `details` is optional and purely additive — omitted, the body is exactly
// `{ success, message }` as every existing caller expects. Used by the 409
// concurrency conflict (AC-15) to carry the current server task so the client
// can render Mine vs Server without another round-trip.
exports.errorResponse = (res, message = 'Error', statusCode = 400, details) => {
  const body = { success: false, message }
  if (details !== undefined) body.details = details
  return res.status(statusCode).json(body)
}
exports.paginatedResponse = (res, data, total, page, limit) => {
  return res.status(200).json({
    success: true, message: 'Success',
    data: { data, total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / limit) }
  })
}
