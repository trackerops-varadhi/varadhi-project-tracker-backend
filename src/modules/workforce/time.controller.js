// HTTP layer for time logs.

const { successResponse, errorResponse } = require('../../shared/response')
const service = require('./time.service')

const fail = (res, err, where, fallback) => {
  if (err instanceof service.TimeError) {
    return errorResponse(res, err.message, err.status)
  }
  console.error(`${where} error:`, err)
  return errorResponse(res, fallback, 500)
}

exports.getTimeLogs = async (req, res) => {
  try {
    return successResponse(res, await service.listForUser(req.user, req.query))
  } catch (err) {
    return fail(res, err, 'getTimeLogs', 'Failed to load time logs.')
  }
}

exports.createTimeLog = async (req, res) => {
  try {
    const dto = await service.create(req.user, req.body)
    return successResponse(res, dto, 'Time log created successfully.', 201)
  } catch (err) {
    return fail(res, err, 'createTimeLog', 'Failed to create time log.')
  }
}

exports.checkIn = async (req, res) => {
  try {
    return successResponse(res, await service.checkIn(req.user, req.body), 'Checked in.', 201)
  } catch (err) {
    return fail(res, err, 'checkIn', 'Failed to check in.')
  }
}

exports.checkOut = async (req, res) => {
  try {
    return successResponse(res, await service.checkOut(req.user, req.body), 'Checked out.')
  } catch (err) {
    return fail(res, err, 'checkOut', 'Failed to check out.')
  }
}
