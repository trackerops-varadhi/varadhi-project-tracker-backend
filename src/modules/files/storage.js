// Object-storage helpers for the files module.
//
// Everything that knows the shape of a Supabase object path lives here, so the
// repo layer stays pure SQL and the service layer never builds a URL by hand.

const crypto = require('crypto')
const supabase = require('../../platform/supabase')

const STORAGE_BUCKET = 'documents'

// Objects are kept under this prefix inside the bucket. Unchanged on purpose so
// existing rows and any storage policies scoped to this prefix keep working.
const STORAGE_FOLDER = 'documents'

const PUBLIC_URL_MARKER = `/storage/v1/object/public/${STORAGE_BUCKET}/`
const DEFAULT_MIME_TYPE = 'application/octet-stream'

exports.STORAGE_BUCKET = STORAGE_BUCKET

exports.getExtension = (fileName) => {
  const parts = String(fileName || '').split('.')
  return parts.length > 1 ? String(parts.pop()).toLowerCase() : ''
}

// Make a filename safe for object storage: drop any path segments, strip
// accents, collapse everything outside [a-z0-9._-] and cap the length.
const sanitizeFileName = (fileName) => {
  const base = String(fileName || '').split(/[\\/]/).pop()
  const ext = exports.getExtension(base)
  const stem = ext ? base.slice(0, -(ext.length + 1)) : base

  const safeStem =
    stem
      .normalize('NFKD')
      // Strip the combining marks NFKD just split off, so "café" -> "cafe"
      // rather than "cafe" plus an invisible accent byte in the object key.
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .slice(0, 100)
      .toLowerCase() || 'file'

  const safeExt = ext.replace(/[^a-z0-9]/g, '').slice(0, 10)

  return safeExt ? `${safeStem}.${safeExt}` : safeStem
}
exports.sanitizeFileName = sanitizeFileName

// <folder>/<timestamp>-<random>-<sanitized-name>
//
// The folder is a parameter because bug attachments share this bucket under a
// 'bugs/' prefix. One upload pipeline, two prefixes — rather than the defects
// module carrying a second, drifting copy of this logic (which is exactly what
// it had before it moved here).
const buildStoragePath = (fileName, folder = STORAGE_FOLDER) => {
  const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  return `${folder}/${unique}-${sanitizeFileName(fileName)}`
}

// Public URL -> object path inside the bucket. Returns null when the URL is
// missing, malformed, or does not point at this bucket.
exports.storagePathFromUrl = (url) => {
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

// Best-effort removal. Never throws: a stale object must not block the DB write.
const removeFromStorage = async (path) => {
  if (!path) return false

  try {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([path])
    if (error) {
      console.error(`[files] Storage remove failed for "${path}":`, error.message)
      return false
    }
    return true
  } catch (err) {
    console.error(`[files] Storage remove threw for "${path}":`, err.message)
    return false
  }
}
exports.removeFromStorage = removeFromStorage

exports.uploadBuffer = async (buffer, originalName, mimeType, folder = STORAGE_FOLDER) => {
  const path = buildStoragePath(originalName, folder)

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
    // Roll the object back rather than leaving one nothing points at.
    await removeFromStorage(path)
    throw new Error('File uploaded but no public URL was returned by storage.')
  }

  return { path, url }
}
