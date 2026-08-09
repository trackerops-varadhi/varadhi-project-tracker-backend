

// const pool = require('../config/db')
// const supabase = require('../config/supabase')
// const { successResponse, errorResponse } = require('../utils/response')

// // ─── Helpers ───────────────────────────────────────────────────────────────────

// // Upload a memory buffer to Supabase via upload_stream, promisified.
// async function uploadBufferToSupabase(buffer, fileName, mimeType) {
//   const filePath = `documents/${Date.now()}-${fileName}`;

//   const { error } = await supabase.storage
//     .from('documents')
//     .upload(filePath, buffer, {
//       contentType: mimeType,
//       upsert: false,
//     });

//   if (error) throw error;

//   const { data } = supabase.storage
//     .from('documents')
//     .getPublicUrl(filePath);

//   return {
//     path: filePath,
//     url: data.publicUrl,
//   };
// }

// // supabase requires the correct resource_type to destroy an asset.
// // With resource_type 'auto': images and PDFs are stored as 'image';
// // doc/docx/xls/xlsx/zip are stored as 'raw'.
// function resourceTypeForExt(ext) {
//   return ['png', 'jpg', 'jpeg', 'pdf'].includes((ext || '').toLowerCase())
//     ? 'image'
//     : 'raw'
// }


// exports.getAllDocuments = async (req, res) => {
//   try {
//     const { folderId } = req.query
 
//     let where = ''
//     const params = []
//     if (folderId === 'root') {
//       where = 'WHERE d.folder_id IS NULL'
//     } else if (folderId) {
//       params.push(folderId)
//       where = `WHERE d.folder_id = $${params.length}`
//     }
 
//     const result = await pool.query(`
//       SELECT d.id, d.name, d.original_name, d.file_type, d.file_size,
//              d.url, d.description, d.created_at, d.folder_id,
//              f.name AS folder_name,
//              p.id AS project_id, p.name AS project_name,
//              u.id AS uploader_id, u.name AS uploader_name
//       FROM documents d
//       LEFT JOIN folders f ON d.folder_id = f.id
//       LEFT JOIN projects p ON d.project_id = p.id
//       LEFT JOIN users u ON d.uploaded_by = u.id
//       ${where}
//       ORDER BY d.created_at DESC
//     `, params)
 
//     const documents = result.rows.map((d) => ({
//       id: d.id,
//       name: d.name,
//       originalName: d.original_name,
//       fileType: d.file_type,
//       fileSize: parseInt(d.file_size) || 0,
//       url: d.url,
//       description: d.description,
//       createdAt: d.created_at,
//       folder: d.folder_id ? { id: d.folder_id, name: d.folder_name } : null,
//       project: d.project_id ? { id: d.project_id, name: d.project_name } : null,
//       uploadedBy: d.uploader_id ? { id: d.uploader_id, name: d.uploader_name } : null,
//     }))
//     return successResponse(res, documents)
//   } catch (err) {
//     return errorResponse(res, err.message, 500)
//   }
// }



// exports.uploadDocument = async (req, res) => {
//   try {
//     if (!req.file) return errorResponse(res, 'No file uploaded.')
 
//     const { description, projectId, folderId } = req.body
//     const { originalname, size, buffer } = req.file
//     const ext = originalname.split('.').pop()?.toLowerCase() || 'file'
 
//     // Validate folderId if provided (avoid FK error surfacing as a 500)
//     let folder = null
//     if (folderId) {
//       const check = await pool.query('SELECT id FROM folders WHERE id = $1', [folderId])
//       if (!check.rows[0]) return errorResponse(res, 'Folder not found.', 400)
//       folder = folderId
//     }
 
//     const uploaded = await uploadBufferToSupabase(buffer, originalname, req.file.mimetype);
 
//     const result = await pool.query(
//       `INSERT INTO documents
//         (name, original_name, file_type, file_size, url, description, project_id, folder_id, uploaded_by)
//        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
//        RETURNING id`,
//       [
//         originalname,
//         originalname,
//         ext,
//         size,
//         uploaded.url,
//         description || null,
//         projectId || null,
//         folder,
//         req.user.id,
//       ]
//     )
 
//     return successResponse(
//       res,
//       {
//         id: result.rows[0].id,
//         url: uploaded.url,
//         name: originalname,
//         fileType: ext,
//         fileSize: size,
//       },
//       'Document uploaded successfully.',
//       201
//     )
//   } catch (err) {
//     return errorResponse(res, err.message, 500)
//   }
// }

// exports.moveDocument = async (req, res) => {
//   try {
//     if (req.user.role.toLowerCase() === 'employee') {
//       return errorResponse(res, 'You are not authorized to move documents.', 403)
//     }
 
//     const { folderId } = req.body
//     let target = null
//     if (folderId) {
//       const check = await pool.query('SELECT id FROM folders WHERE id = $1', [folderId])
//       if (!check.rows[0]) return errorResponse(res, 'Folder not found.', 400)
//       target = folderId
//     }
 
//     const result = await pool.query(
//       'UPDATE documents SET folder_id = $1 WHERE id = $2 RETURNING id, folder_id',
//       [target, req.params.id]
//     )
//     if (!result.rows[0]) return errorResponse(res, 'Document not found.', 404)
//     return successResponse(res, result.rows[0], 'Document moved successfully.')
//   } catch (err) {
//     return errorResponse(res, err.message, 500)
//   }
// }

// exports.downloadDocument = async (req, res) => {
//   try {
//     if (req.user.role.toLowerCase() === 'employee') {
//       return errorResponse(
//         res,
//         'You are not authorized to download documents.',
//         403
//       );
//     }

//     const { id } = req.params;

//     const result = await pool.query(
//       'SELECT url FROM documents WHERE id = $1',
//       [id]
//     );

//     const doc = result.rows[0];

//     if (!doc) return errorResponse(res, 'Document not found.', 404);

//     return res.redirect(doc.url);
//   } catch (err) {
//     return errorResponse(res, err.message, 500);
//   }
// };

// exports.deleteDocument = async (req, res) => {
//   try {
//     if (req.user.role.toLowerCase() === 'employee') {
//       return errorResponse(
//         res,
//         'You are not authorized to delete documents.',
//         403
//       );
//     }

//     const { id } = req.params;

//     const result = await pool.query(
//       'SELECT * FROM documents WHERE id = $1',
//       [id]
//     );

//     const doc = result.rows[0];

//     if (!doc)
//       return errorResponse(res, 'Document not found.', 404);

//     // Extract storage path from public URL
//     const path = decodeURIComponent(
//       doc.url.split('/storage/v1/object/public/documents/')[1]
//     );

//     if (path) {
//       await supabase.storage.from('documents').remove([path]);
//     }

//     await pool.query('DELETE FROM documents WHERE id = $1', [id]);

//     return successResponse(
//       res,
//       { id },
//       'Document deleted successfully.'
//     );
//   } catch (err) {
//     return errorResponse(res, err.message, 500);
//   }
// };

const crypto = require('crypto')

const pool = require('../config/db')
const supabase = require('../config/supabase')
const { successResponse, errorResponse } = require('../utils/response')
const { dispatchToMany, NOTIFICATION_TYPES } = require('../utils/notification-engine')

// Notifications must never turn a successful action into a 500, so every
// dispatch block runs inside this guard instead of the handler's try/catch.
const notifySafely = async (fn) => {
  try {
    await fn()
  } catch (err) {
    console.error('[notifications] documents.controller:', err.message)
  }
}

// ─── Storage constants ─────────────────────────────────────────────────────────

const STORAGE_BUCKET = 'documents'

// Objects are kept under this prefix inside the bucket. Unchanged on purpose so
// existing rows and any storage policies scoped to this prefix keep working.
const STORAGE_FOLDER = 'documents'

const PUBLIC_URL_MARKER = `/storage/v1/object/public/${STORAGE_BUCKET}/`

const DEFAULT_MIME_TYPE = 'application/octet-stream'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isEmployee(user) {
  return String(user?.role || '').toLowerCase() === 'employee'
}

function getExtension(fileName) {
  const parts = String(fileName || '').split('.')
  return parts.length > 1 ? String(parts.pop()).toLowerCase() : ''
}

// Make a filename safe for object storage: drop any path segments, strip accents,
// collapse everything outside [a-z0-9._-] and cap the length.
function sanitizeFileName(fileName) {
  const base = String(fileName || '').split(/[\\/]/).pop()
  const ext = getExtension(base)
  const stem = ext ? base.slice(0, -(ext.length + 1)) : base

  const safeStem =
    stem
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .slice(0, 100)
      .toLowerCase() || 'file'

  const safeExt = ext.replace(/[^a-z0-9]/g, '').slice(0, 10)

  return safeExt ? `${safeStem}.${safeExt}` : safeStem
}

// documents/<timestamp>-<random>-<sanitized-name>
function buildStoragePath(fileName) {
  const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  return `${STORAGE_FOLDER}/${unique}-${sanitizeFileName(fileName)}`
}

// Public URL -> object path inside the bucket. Returns null when the URL is
// missing, malformed, or does not point at this bucket.
function storagePathFromUrl(url) {
  if (typeof url !== 'string') return null

  const index = url.indexOf(PUBLIC_URL_MARKER)
  if (index === -1) return null

  const raw = url.slice(index + PUBLIC_URL_MARKER.length).split('?')[0]
  if (!raw) return null

  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

async function uploadBufferToStorage(buffer, originalName, mimeType) {
  const path = buildStoragePath(originalName)

  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, {
      contentType: mimeType || DEFAULT_MIME_TYPE,
      cacheControl: '3600',
      upsert: false,
    })

  if (error) {
    throw new Error(`Failed to upload file to storage: ${error.message}`)
  }

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path)
  const url = data?.publicUrl

  if (!url) {
    await removeFromStorage(path)
    throw new Error('File uploaded but no public URL was returned by storage.')
  }

  return { path, url }
}

// Best-effort removal. Never throws: a stale object must not block the DB write.
async function removeFromStorage(path) {
  if (!path) return false

  try {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([path])
    if (error) {
      console.error(`[documents] Storage remove failed for "${path}":`, error.message)
      return false
    }
    return true
  } catch (err) {
    console.error(`[documents] Storage remove threw for "${path}":`, err.message)
    return false
  }
}

// Resolves a folder id, or null. Throws a 400-flagged error when it is invalid.
async function resolveFolderId(folderId) {
  if (!folderId) return null

  const check = await pool.query('SELECT id FROM folders WHERE id = $1', [folderId])
  if (!check.rows[0]) {
    const err = new Error('Folder not found.')
    err.status = 400
    throw err
  }

  return folderId
}

function mapDocumentRow(d) {
  return {
    id: d.id,
    name: d.name,
    originalName: d.original_name,
    fileType: d.file_type,
    fileSize: parseInt(d.file_size) || 0,
    url: d.url,
    description: d.description,
    createdAt: d.created_at,
    folder: d.folder_id ? { id: d.folder_id, name: d.folder_name } : null,
    project: d.project_id ? { id: d.project_id, name: d.project_name } : null,
    uploadedBy: d.uploader_id ? { id: d.uploader_id, name: d.uploader_name } : null,
  }
}

// ─── Controllers ───────────────────────────────────────────────────────────────

exports.getAllDocuments = async (req, res) => {
  try {
    const { folderId } = req.query

    let where = ''
    const params = []

    if (folderId === 'root') {
      where = 'WHERE d.folder_id IS NULL'
    } else if (folderId) {
      params.push(folderId)
      where = `WHERE d.folder_id = $${params.length}`
    }

    const result = await pool.query(
      `
      SELECT d.id, d.name, d.original_name, d.file_type, d.file_size,
             d.url, d.description, d.created_at, d.folder_id,
             f.name AS folder_name,
             p.id AS project_id, p.name AS project_name,
             u.id AS uploader_id, u.name AS uploader_name
      FROM documents d
      LEFT JOIN folders f ON d.folder_id = f.id
      LEFT JOIN projects p ON d.project_id = p.id
      LEFT JOIN users u ON d.uploaded_by = u.id
      ${where}
      ORDER BY d.created_at DESC
      `,
      params
    )

    return successResponse(res, result.rows.map(mapDocumentRow))
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500)
  }
}

exports.uploadDocument = async (req, res) => {
  let uploaded = null

  try {
    if (!req.file) return errorResponse(res, 'No file uploaded.')

    const { description, projectId, folderId } = req.body
    const { originalname, size, buffer, mimetype } = req.file

    if (!buffer || !buffer.length) {
      return errorResponse(res, 'Uploaded file is empty.')
    }

    const ext = getExtension(originalname) || 'file'

    // Validate folderId first so a bad id never leaves an orphaned object behind.
    const folder = await resolveFolderId(folderId)

    uploaded = await uploadBufferToStorage(buffer, originalname, mimetype)

    const result = await pool.query(
      `INSERT INTO documents
        (name, original_name, file_type, file_size, url, description, project_id, folder_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        originalname,
        originalname,
        ext,
        size,
        uploaded.url,
        description || null,
        projectId || null,
        folder,
        req.user.id,
      ]
    )

    // Notify the project team — this single broadcast covers both "shared
    // with the employee" and "manager sees the upload" (the manager is a
    // project member from project creation), so no separate manager-specific
    // call is needed.
    if (projectId) {
      await notifySafely(async () => {
        const members = await pool.query(
          'SELECT user_id FROM project_members WHERE project_id = $1',
          [projectId]
        )
        await dispatchToMany(
          members.rows.map((m) => m.user_id),
          NOTIFICATION_TYPES.DOCUMENT_UPLOADED,
          'New document shared',
          `${req.user.name} uploaded "${originalname}".`,
          `/documents?projectId=${projectId}`,
          'normal',
          { excludeUserId: req.user.id }
        )
      })
    }

    return successResponse(
      res,
      {
        id: result.rows[0].id,
        url: uploaded.url,
        name: originalname,
        fileType: ext,
        fileSize: size,
      },
      'Document uploaded successfully.',
      201
    )
  } catch (err) {
    // The DB write failed after the object landed in storage — clean it up.
    if (uploaded) await removeFromStorage(uploaded.path)
    return errorResponse(res, err.message, err.status || 500)
  }
}

exports.moveDocument = async (req, res) => {
  try {
    if (isEmployee(req.user)) {
      return errorResponse(res, 'You are not authorized to move documents.', 403)
    }

    const target = await resolveFolderId(req.body.folderId)

    const result = await pool.query(
      'UPDATE documents SET folder_id = $1 WHERE id = $2 RETURNING id, folder_id',
      [target, req.params.id]
    )

    if (!result.rows[0]) return errorResponse(res, 'Document not found.', 404)

    return successResponse(res, result.rows[0], 'Document moved successfully.')
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500)
  }
}

exports.downloadDocument = async (req, res) => {
  try {
    if (isEmployee(req.user)) {
      return errorResponse(res, 'You are not authorized to download documents.', 403)
    }

    const result = await pool.query('SELECT url FROM documents WHERE id = $1', [
      req.params.id,
    ])

    const doc = result.rows[0]
    if (!doc) return errorResponse(res, 'Document not found.', 404)
    if (!doc.url) return errorResponse(res, 'Document file is unavailable.', 404)

    return res.redirect(doc.url)
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500)
  }
}

exports.deleteDocument = async (req, res) => {
  try {
    if (isEmployee(req.user)) {
      return errorResponse(res, 'You are not authorized to delete documents.', 403)
    }

    const { id } = req.params

    const result = await pool.query('SELECT id, url FROM documents WHERE id = $1', [id])

    const doc = result.rows[0]
    if (!doc) return errorResponse(res, 'Document not found.', 404)

    const path = storagePathFromUrl(doc.url)

    if (path) {
      await removeFromStorage(path)
    } else {
      console.warn(
        `[documents] Could not derive a storage path for document ${id}; skipping storage removal.`
      )
    }

    await pool.query('DELETE FROM documents WHERE id = $1', [id])

    return successResponse(res, { id }, 'Document deleted successfully.')
  } catch (err) {
    return errorResponse(res, err.message, err.status || 500)
  }
}