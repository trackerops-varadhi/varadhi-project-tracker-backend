// HTTP layer for folders.

const { successResponse, errorResponse } = require('../../shared/response')
const service = require('./folders.service')

// Same contract as documents.controller.js — see the note there about
// err.message on a 500 being pre-existing and deliberately preserved.
const fail = (res, err) => errorResponse(res, err.message, err.status || 500)

exports.getAllFolders = async (req, res) => {
  try {
    return successResponse(res, await service.list())
  } catch (err) {
    return fail(res, err)
  }
}

exports.createFolder = async (req, res) => {
  try {
    const dto = await service.create(req.user, req.body)
    return successResponse(res, dto, 'Folder created successfully.', 201)
  } catch (err) {
    return fail(res, err)
  }
}

exports.renameFolder = async (req, res) => {
  try {
    const row = await service.rename(req.params.id, req.body)
    return successResponse(res, row, 'Folder renamed successfully.')
  } catch (err) {
    return fail(res, err)
  }
}

exports.deleteFolder = async (req, res) => {
  try {
    const dto = await service.remove(req.params.id)
    return successResponse(
      res, dto, 'Folder deleted. Its documents were moved to All Files.'
    )
  } catch (err) {
    return fail(res, err)
  }
}
