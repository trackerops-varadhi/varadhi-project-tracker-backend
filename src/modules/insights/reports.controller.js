// HTTP layer for reports. Per-endpoint error handling preserved exactly.

const { successResponse, errorResponse } = require('../../shared/response')
const service = require('./reports.service')

exports.getRoleUtilization = async (req, res) => {
  try {
    return successResponse(res, await service.roleUtilization())
  } catch (err) {
    console.error('getRoleUtilization error:', err)
    return errorResponse(res, 'Failed to load role utilization.', 500)
  }
}

exports.getBusinessIntelligence = async (req, res) => {
  try {
    return successResponse(res, await service.businessIntelligence())
  } catch (err) {
    console.error('getBusinessIntelligence error:', err)
    return errorResponse(res, 'Failed to load business intelligence.', 500)
  }
}

exports.getRiskAnalysis = async (req, res) => {
  try {
    return successResponse(res, await service.riskAnalysis())
  } catch (err) {
    console.error('getRiskAnalysis error:', err)
    return errorResponse(res, 'Failed to load risk analysis.', 500)
  }
}

exports.getTaskStatus = async (req, res) => {
  try {
    return successResponse(res, await service.taskStatus())
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.getMemberWorkload = async (req, res) => {
  try {
    return successResponse(res, await service.memberWorkload())
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.getProjectCompletion = async (req, res) => {
  try {
    return successResponse(res, await service.projectCompletion())
  } catch (err) { return errorResponse(res, err.message, 500) }
}
