// HTTP layer for the dashboard.
//
// Error handling is preserved per-endpoint exactly as it was: some of these
// echoed err.message on a 500, others returned a fixed message and logged.
// Inconsistent, but this phase is behaviour-preserving.

const { successResponse, errorResponse } = require('../../shared/response')
const service = require('./dashboard.service')

exports.getStats = async (req, res) => {
  try {
    return successResponse(res, await service.stats(req.user))
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.getProjectHealth = async (req, res) => {
  try {
    return successResponse(res, await service.projectHealth(req.user))
  } catch (err) {
    console.error('getProjectHealth error:', err)
    return errorResponse(res, 'Failed to load project health.', 500)
  }
}

exports.getGantt = async (req, res) => {
  try {
    return successResponse(res, await service.gantt(req.user))
  } catch (err) {
    console.error('getGantt error:', err)
    return errorResponse(res, 'Failed to load gantt data.', 500)
  }
}

exports.getActivity = async (req, res) => {
  try {
    return successResponse(res, await service.activity(req.user))
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.getProjectProgress = async (req, res) => {
  try {
    return successResponse(res, await service.projectProgress(req.user))
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.getBurndown = async (req, res) => {
  try {
    const data = await service.burndown(req.params.projectId)
    if (!data) return errorResponse(res, 'Project not found.', 404)
    return successResponse(res, data)
  } catch (err) { return errorResponse(res, err.message, 500) }
}
