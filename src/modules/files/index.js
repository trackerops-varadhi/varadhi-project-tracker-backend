// PUBLIC INTERFACE — files (documents · folders)
//
// The only file outside this directory that anything else may require.

const storage = require('./storage')
const documentsRepo = require('./documents.repo')
const workSubscriber = require('./work-subscriber')

exports.mount = [
  { path: '/api/documents', router: require('./documents.routes') },
  { path: '/api/folders', router: require('./folders.routes') },
]

/* ── Event subscriptions ────────────────────────────────────────────────── */
//
// Listens to work's project.deleted and clears documents' reference to the
// project, keeping the documents — the ON DELETE SET NULL the schema split
// dropped. Called by server.js outside the ENABLE_CRON switch. Idempotent.
exports.subscribe = () => workSubscriber.startWorkSubscriptions()
exports.unsubscribe = () => workSubscriber.stopWorkSubscriptions()

/* ── Object storage ─────────────────────────────────────────────────────── */

/**
 * Put a buffer in the shared bucket and return its path and public URL.
 *
 * `folder` is the prefix inside the bucket — defects passes 'bugs' so
 * attachments sit beside documents rather than in a second bucket. Exposing
 * this means there is one upload pipeline (one sanitiser, one path scheme, one
 * cleanup rule) instead of the near-identical copy defects used to carry.
 *
 * Throws on upload failure; the caller decides whether that is fatal.
 */
exports.storeFile = async ({ buffer, fileName, mimeType, folder }) =>
  storage.uploadBuffer(buffer, fileName, mimeType, folder)

/**
 * Remove an object by storage path, or by public URL if that is all the caller
 * has. Best-effort and never throws: a stale object must not block a DB write.
 */
exports.removeStoredFile = async (pathOrUrl) => {
  if (!pathOrUrl) return false
  const path = pathOrUrl.includes('://') ? storage.storagePathFromUrl(pathOrUrl) : pathOrUrl
  return storage.removeFromStorage(path)
}

exports.getFileExtension = async (fileName) => storage.getExtension(fileName)

/* ── Document mirroring ─────────────────────────────────────────────────── */

/**
 * Create a `documents` row mirroring a file another module owns.
 *
 * This is the contract behind bug_attachments.document_id -> documents.id, the
 * one foreign key that crosses the files boundary. Bug attachments are mirrored
 * so they also appear in the Documents module rather than being invisible
 * outside Bugs Finder.
 *
 * NEVER THROWS — returns null instead. That is the existing contract, not a new
 * decision: the mirror is a convenience, and losing it must not fail the
 * attachment upload that triggered it.
 *
 * @returns {Promise<string|null>} the new document id, or null if it failed
 */
exports.createMirroredDocument = async ({
  fileName, fileType, fileSize, url, description = null, projectId = null, uploadedBy = null,
}) => {
  try {
    const row = await documentsRepo.insertDocument({
      name: fileName,
      originalName: fileName,
      fileType,
      fileSize,
      url,
      description,
      projectId,
      folderId: null, // mirrored files are unfiled; they belong to their bug
      uploadedBy,
    })
    return row.id
  } catch (err) {
    console.error('[files] could not mirror a file into documents:', err.message)
    return null
  }
}

/**
 * Remove a mirrored document row, so Documents stops listing a file whose
 * object has been deleted elsewhere. Best-effort, matching the legacy
 * `.catch()`-swallowed delete.
 */
exports.removeDocument = async (documentId) => {
  if (!documentId) return
  try {
    await documentsRepo.deleteDocument(documentId)
  } catch (err) {
    console.error('[files] could not remove a mirrored document:', err.message)
  }
}
