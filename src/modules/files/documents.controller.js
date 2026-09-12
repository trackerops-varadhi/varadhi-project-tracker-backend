// HTTP layer for documents.

const { successResponse, errorResponse } = require('../../shared/response')
const service = require('./documents.service')

// Preserves the legacy behaviour exactly: a FilesError carries its own status,
// anything else is a 500 carrying err.message.
//
// NOTE: echoing err.message on a 500 leaks internal detail (Postgres and
// Supabase messages reach the client verbatim). That is pre-existing in both
// documents.controller.js and folders.controller.js and is preserved here
// deliberately, because this phase is behaviour-preserving. Worth fixing as its
// own change — see the fallback-message pattern in modules/workforce.
const fail = (res, err) => errorResponse(res, err.message, err.status || 500)

exports.getAllDocuments = async (req, res) => {
  try {
    return successResponse(res, await service.list(req.user, req.query))
  } catch (err) {
    return fail(res, err)
  }
}

exports.uploadDocument = async (req, res) => {
  try {
    const dto = await service.upload(req.user, req.file, req.body)
    return successResponse(res, dto, 'Document uploaded successfully.', 201)
  } catch (err) {
    return fail(res, err)
  }
}

exports.moveDocument = async (req, res) => {
  try {
    const row = await service.move(req.user, req.params.id, req.body)
    return successResponse(res, row, 'Document moved successfully.')
  } catch (err) {
    return fail(res, err)
  }
}

exports.downloadDocument = async (req, res) => {
  try {
    // A redirect to the public storage URL, not a proxied stream — unchanged.
    return res.redirect(await service.getDownloadUrl(req.user, req.params.id))
  } catch (err) {
    return fail(res, err)
  }
}

exports.deleteDocument = async (req, res) => {
  try {
    const dto = await service.remove(req.user, req.params.id)
    return successResponse(res, dto, 'Document deleted successfully.')
  } catch (err) {
    return fail(res, err)
  }
}
