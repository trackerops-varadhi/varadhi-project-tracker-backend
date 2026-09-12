// Document business logic: authorisation, storage orchestration, display
// enrichment and notification fan-out.

const repo = require('./documents.repo')
const foldersRepo = require('./folders.repo')
const storage = require('./storage')
const identity = require('../identity')
const work = require('../work')
const notify = require('../notify')
const { FilesError } = require('./errors')

const isEmployee = (user) => String(user?.role || '').toLowerCase() === 'employee'

// Notifications must never turn a successful action into a 500, so every
// dispatch runs inside this guard rather than the caller's try/catch.
const notifySafely = async (fn) => {
  try {
    await fn()
  } catch (err) {
    console.error('[notifications] files/documents:', err.message)
  }
}

// ── mapping ──────────────────────────────────────────────────────────────
// `folder` comes from the in-module join; `project` and `uploadedBy` come from
// the two cross-module card lookups. All three keep their legacy nested shape.
const mapDocument = (d, projectCard, userCard) => ({
  id: d.id,
  name: d.name,
  originalName: d.original_name,
  fileType: d.file_type,
  fileSize: parseInt(d.file_size) || 0,
  url: d.url,
  description: d.description,
  createdAt: d.created_at,
  folder: d.folder_id ? { id: d.folder_id, name: d.folder_name } : null,
  project: d.project_id ? { id: d.project_id, name: projectCard?.name ?? null } : null,
  uploadedBy: d.uploaded_by ? { id: d.uploaded_by, name: userCard?.name ?? null } : null,
})

const withCards = async (rows) => {
  if (rows.length === 0) return []
  const [projects, users] = await Promise.all([
    work.getProjectCards(rows.map((r) => r.project_id)),
    identity.getUserCards(rows.map((r) => r.uploaded_by)),
  ])
  return rows.map((r) => mapDocument(r, projects.get(r.project_id), users.get(r.uploaded_by)))
}

// Resolves a folder id, or null. Throws a 400 when it is invalid, so a bad id
// never reaches the FK and surfaces as an opaque 500.
const resolveFolderId = async (folderId) => {
  if (!folderId) return null
  if (!(await foldersRepo.folderExists(folderId))) {
    throw new FilesError('Folder not found.', 400)
  }
  return folderId
}

// ── reads ────────────────────────────────────────────────────────────────
exports.list = async (_currentUser, { folderId } = {}) => {
  return withCards(await repo.listDocuments({ folderId }))
}

exports.getDownloadUrl = async (currentUser, id) => {
  if (isEmployee(currentUser)) {
    throw new FilesError('You are not authorized to download documents.', 403)
  }

  const doc = await repo.findDocumentUrl(id)
  if (!doc) throw new FilesError('Document not found.', 404)
  if (!doc.url) throw new FilesError('Document file is unavailable.', 404)

  return doc.url
}

// ── writes ───────────────────────────────────────────────────────────────
exports.upload = async (currentUser, file, { description, projectId, folderId } = {}) => {
  if (!file) throw new FilesError('No file uploaded.')

  const { originalname, size, buffer, mimetype } = file
  if (!buffer || !buffer.length) throw new FilesError('Uploaded file is empty.')

  const ext = storage.getExtension(originalname) || 'file'

  // Validate the folder FIRST, so a bad id never leaves an orphaned object in
  // storage with no row pointing at it.
  const folder = await resolveFolderId(folderId)

  let uploaded = null
  try {
    uploaded = await storage.uploadBuffer(buffer, originalname, mimetype)

    const row = await repo.insertDocument({
      name: originalname,
      originalName: originalname,
      fileType: ext,
      fileSize: size,
      url: uploaded.url,
      description: description || null,
      projectId: projectId || null,
      folderId: folder,
      uploadedBy: currentUser.id,
    })

    // Notify the project team. This single broadcast covers both "shared with
    // the employee" and "manager sees the upload" — the manager is a project
    // member from project creation — so no separate manager call is needed.
    //
    // The member list now comes from work.getProjectMemberIds() rather than
    // this module selecting from project_members itself. That was the one
    // genuine cross-module read in the old controller.
    if (projectId) {
      await notifySafely(async () => {
        const memberIds = await work.getProjectMemberIds(projectId)
        await notify.dispatchToUsers({
          userIds: memberIds,
          type: notify.TYPES.DOCUMENT_UPLOADED,
          title: 'New document shared',
          message: `${currentUser.name} uploaded "${originalname}".`,
          linkTo: `/documents?projectId=${projectId}`,
          excludeUserId: currentUser.id,
        })
      })
    }

    return { id: row.id, url: uploaded.url, name: originalname, fileType: ext, fileSize: size }
  } catch (err) {
    // The DB write failed after the object landed in storage — clean it up so
    // the bucket does not accumulate files nothing references.
    if (uploaded) await storage.removeFromStorage(uploaded.path)
    throw err
  }
}

exports.move = async (currentUser, id, { folderId } = {}) => {
  if (isEmployee(currentUser)) {
    throw new FilesError('You are not authorized to move documents.', 403)
  }

  const target = await resolveFolderId(folderId)

  const row = await repo.updateDocumentFolder(id, target)
  if (!row) throw new FilesError('Document not found.', 404)

  // Legacy shape: the raw { id, folder_id } row.
  return row
}

exports.remove = async (currentUser, id) => {
  if (isEmployee(currentUser)) {
    throw new FilesError('You are not authorized to delete documents.', 403)
  }

  const doc = await repo.findDocumentUrl(id)
  if (!doc) throw new FilesError('Document not found.', 404)

  const path = storage.storagePathFromUrl(doc.url)
  if (path) {
    await storage.removeFromStorage(path)
  } else {
    console.warn(
      `[files] Could not derive a storage path for document ${id}; skipping storage removal.`
    )
  }

  await repo.deleteDocument(id)
  return { id }
}
