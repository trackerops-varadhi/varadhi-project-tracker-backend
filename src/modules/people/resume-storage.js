// Resume vault (docs/Module-9-People-Plan.md §7.3).
//
// Resumes do NOT go in the shared `documents` bucket: that bucket is public,
// and a public object URL bypasses every role check the moment the link leaks.
// They live in a PRIVATE bucket, the row keeps only the object path, and a
// download is a short-lived signed URL issued after the caller passed
// restrictTo('admin','hr').
//
// The bucket is created on first use if it does not exist. If it exists but
// is public, uploads are refused rather than silently exposing resumes.

const crypto = require('crypto')
const supabase = require('../../platform/supabase')
const files = require('../files')
const { PeopleError } = require('./shared')

const BUCKET = process.env.HR_PRIVATE_BUCKET || 'hr-private'
const SIGNED_URL_SECONDS = 60
const MAX_BYTES = 10 * 1024 * 1024

let ready = null

const ensureBucket = () => {
  if (!ready) {
    ready = (async () => {
      const { data, error } = await supabase.storage.getBucket(BUCKET)
      if (!error && data) {
        if (data.public) {
          throw new Error(`Storage bucket "${BUCKET}" is public; refusing to store resumes in it.`)
        }
        return
      }
      const created = await supabase.storage.createBucket(BUCKET, {
        public: false,
        fileSizeLimit: MAX_BYTES,
      })
      // A concurrent first upload may have created it a moment ago.
      if (created.error && !/already exists/i.test(created.error.message)) {
        throw new Error(`Could not create storage bucket "${BUCKET}": ${created.error.message}`)
      }
    })().catch((err) => {
      ready = null // let the next call retry
      throw err
    })
  }
  return ready
}

exports.upload = async ({ buffer, fileName, mimeType, candidateId }) => {
  await ensureBucket()
  const safe = await files.sanitizeFileName(fileName)
  const path = `resumes/${candidateId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safe}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new Error(`Resume upload failed: ${error.message}`)
  return path
}

exports.signedUrl = async (path, downloadName) => {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS, { download: downloadName || true })
  if (error || !data?.signedUrl) {
    throw new PeopleError('The resume file could not be found in storage.', 404)
  }
  return { url: data.signedUrl, expiresInSeconds: SIGNED_URL_SECONDS }
}

/** Best-effort; a stale object must not block a database delete. */
exports.remove = async (paths) => {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean)
  if (!list.length) return
  const { error } = await supabase.storage.from(BUCKET).remove(list)
  if (error) console.error('[people] resume cleanup failed:', error.message)
}

exports.BUCKET = BUCKET
