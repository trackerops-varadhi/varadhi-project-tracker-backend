// HTTP layer for the user directory.

const { successResponse, errorResponse } = require('../../shared/response')
const service = require('./users.service')

// Preserves the legacy behaviour: a UserError carries its own status, anything
// else is a 500 carrying err.message.
const fail = (res, err) => errorResponse(res, err.message, err.status || 500)

exports.getAllUsers = async (req, res) => {
  try {
    return successResponse(res, await service.list(req.query))
  } catch (err) { return fail(res, err) }
}

exports.getUserStats = async (req, res) => {
  try {
    return successResponse(res, await service.stats())
  } catch (err) {
    console.error('getUserStats error:', err)
    return errorResponse(res, 'Failed to load user stats.', 500)
  }
}

exports.getUserById = async (req, res) => {
  try {
    return successResponse(res, await service.getById(req.params.id))
  } catch (err) { return fail(res, err) }
}

exports.updateProfile = async (req, res) => {
  try {
    const user = await service.updateProfile(req.user, req.body)
    return successResponse(res, user, 'Profile updated successfully.')
  } catch (err) { return fail(res, err) }
}

exports.inviteUser = async (req, res) => {
  try {
    const dto = await service.invite(req.user, req.body)
    return successResponse(res, dto, 'Invite email sent successfully.', 201)
  } catch (err) { return fail(res, err) }
}

exports.updateRole = async (req, res) => {
  try {
    const updated = await service.updateRole(req.user, req.params.id, req.body.role)
    return successResponse(res, updated, 'Role updated successfully.')
  } catch (err) { return fail(res, err) }
}

exports.deactivateUser = async (req, res) => {
  try {
    const { updated, newStatus } = await service.toggleActive(req.user, req.params.id)
    return successResponse(
      res,
      updated,
      `User ${newStatus === 'active' ? 'activated' : 'deactivated'} successfully.`
    )
  } catch (err) { return fail(res, err) }
}
