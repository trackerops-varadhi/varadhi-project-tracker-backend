// HTTP layer for leave requests. Reads req, writes res, and nothing else —
// all validation and business rules live in leave.service.js.

const { successResponse, errorResponse } = require('../../shared/response')
const service = require('./leave.service')

// A LeaveError carries the status the caller should see. Anything else is a
// genuine fault: log it with context and return an opaque 500, exactly as the
// legacy controller did.
const fail = (res, err, where, fallback) => {
  if (err instanceof service.LeaveError) {
    return errorResponse(res, err.message, err.status)
  }
  console.error(`${where} error:`, err)
  return errorResponse(res, fallback, 500)
}

exports.getLeaveRequests = async (req, res) => {
  try {
    return successResponse(res, await service.listForUser(req.user, req.query))
  } catch (err) {
    return fail(res, err, 'getLeaveRequests', 'Failed to load leave requests.')
  }
}

exports.createLeaveRequest = async (req, res) => {
  try {
    const dto = await service.create(req.user, req.body)
    return successResponse(res, dto, 'Leave request created successfully.', 201)
  } catch (err) {
    return fail(res, err, 'createLeaveRequest', 'Failed to create leave request.')
  }
}

exports.updateLeaveRequestStatus = async (req, res) => {
  try {
    const dto = await service.updateStatus(req.user, req.params.id, req.body.status)
    return successResponse(res, dto, 'Leave request updated successfully.')
  } catch (err) {
    return fail(res, err, 'updateLeaveRequestStatus', 'Failed to update leave request.')
  }
}
