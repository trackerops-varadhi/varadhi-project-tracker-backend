// HTTP layer for people. Reads req, writes res, and nothing else — validation
// and business rules live in service.js.

const { successResponse, errorResponse } = require('../../shared/response')
const service = require('./service')

// A PeopleError carries the status the caller should see. Anything else is a
// genuine fault: log it with context and return an opaque 500.
const fail = (res, err, where, fallback) => {
  if (err instanceof service.PeopleError) {
    return errorResponse(res, err.message, err.status)
  }
  console.error(`${where} error:`, err)
  return errorResponse(res, fallback, 500)
}

exports.getDashboard = async (req, res) => {
  try {
    return successResponse(res, await service.getDashboard())
  } catch (err) {
    return fail(res, err, 'people.getDashboard', 'Failed to load HR dashboard.')
  }
}

exports.getEmployees = async (req, res) => {
  try {
    return successResponse(res, await service.listEmployees())
  } catch (err) {
    return fail(res, err, 'people.getEmployees', 'Failed to load employees.')
  }
}

exports.getEligibleUsers = async (req, res) => {
  try {
    return successResponse(res, await service.listEligibleUsers())
  } catch (err) {
    return fail(res, err, 'people.getEligibleUsers', 'Failed to load users.')
  }
}

exports.createEmployee = async (req, res) => {
  try {
    const dto = await service.createEmployee(req.user, req.body)
    return successResponse(res, dto, 'Employee added successfully.', 201)
  } catch (err) {
    return fail(res, err, 'people.createEmployee', 'Failed to add employee.')
  }
}

exports.getExits = async (req, res) => {
  try {
    return successResponse(res, await service.listExits())
  } catch (err) {
    return fail(res, err, 'people.getExits', 'Failed to load attrition records.')
  }
}

exports.createExit = async (req, res) => {
  try {
    const dto = await service.createExit(req.user, req.body)
    return successResponse(res, dto, 'Attrition record saved.', 201)
  } catch (err) {
    return fail(res, err, 'people.createExit', 'Failed to save attrition record.')
  }
}

exports.getInterviews = async (req, res) => {
  try {
    return successResponse(res, await service.listInterviews())
  } catch (err) {
    return fail(res, err, 'people.getInterviews', 'Failed to load interview records.')
  }
}

exports.createInterview = async (req, res) => {
  try {
    const dto = await service.createInterview(req.user, req.body)
    return successResponse(res, dto, 'Interview record saved.', 201)
  } catch (err) {
    return fail(res, err, 'people.createInterview', 'Failed to save interview record.')
  }
}
