// SQL for documents. This module owns the table.
//
// The `LEFT JOIN folders` is kept — files owns both tables, so that join sits
// inside the module boundary and survives a schema split. The two joins that
// crossed a boundary are gone:
//   LEFT JOIN projects p  -> work.getProjectCards()      (was lookup-only)
//   LEFT JOIN users    u  -> identity.getUserCards()     (was lookup-only)

const pool = require('../../platform/db').forSchema('files')

const SELECT_COLUMNS = `
  d.id, d.name, d.original_name, d.file_type, d.file_size,
  d.url, d.description, d.created_at,
  d.folder_id, d.project_id, d.uploaded_by,
  f.name AS folder_name
`

/**
 * @param {string|null|'root'} folderId
 *   'root'  -> only unfiled documents (folder_id IS NULL)
 *   a uuid  -> that folder
 *   absent  -> everything
 */
exports.listDocuments = async ({ folderId } = {}) => {
  const params = []
  let where = ''

  if (folderId === 'root') {
    where = 'WHERE d.folder_id IS NULL'
  } else if (folderId) {
    params.push(folderId)
    where = `WHERE d.folder_id = $${params.length}`
  }

  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS}
       FROM documents d
       LEFT JOIN folders f ON d.folder_id = f.id
       ${where}
      ORDER BY d.created_at DESC`,
    params
  )
  return rows
}

exports.findDocumentById = async (id) => {
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS}
       FROM documents d
       LEFT JOIN folders f ON d.folder_id = f.id
      WHERE d.id = $1`,
    [id]
  )
  return rows[0] || null
}

// Narrow read for the download/delete paths, which need only the url.
exports.findDocumentUrl = async (id) => {
  const { rows } = await pool.query('SELECT id, url FROM documents WHERE id = $1', [id])
  return rows[0] || null
}

exports.insertDocument = async ({
  name, originalName, fileType, fileSize, url, description, projectId, folderId, uploadedBy,
}) => {
  const { rows } = await pool.query(
    `INSERT INTO documents
       (name, original_name, file_type, file_size, url, description, project_id, folder_id, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [name, originalName, fileType, fileSize, url, description, projectId, folderId, uploadedBy]
  )
  return rows[0]
}

exports.updateDocumentFolder = async (id, folderId) => {
  const { rows } = await pool.query(
    'UPDATE documents SET folder_id = $1 WHERE id = $2 RETURNING id, folder_id',
    [folderId, id]
  )
  return rows[0] || null
}

exports.deleteDocument = async (id) => {
  await pool.query('DELETE FROM documents WHERE id = $1', [id])
}

/**
 * Detach every document from a deleted project, keeping the documents.
 *
 * documents.project_id was ON DELETE SET NULL until the Phase 2 schema split
 * dropped the cross-schema key; this is that rule, run from the
 * project.deleted subscriber. The files survive as unscoped documents — the
 * same outcome as deleting a folder, which unfiles rather than loses.
 *
 * Keeping them matters beyond Documents: a bug attachment is mirrored here with
 * its bug's project, and bug_attachments.document_id must still resolve after
 * that project is gone.
 *
 * @returns {Promise<number>} rows detached
 */
exports.detachProject = async (projectId) => {
  const { rowCount } = await pool.query(
    'UPDATE documents SET project_id = NULL WHERE project_id = $1',
    [projectId]
  )
  return rowCount
}
