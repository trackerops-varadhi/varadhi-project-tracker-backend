/**
 * Encryption at rest for integration secrets (Modules 4 & 5).
 * ---------------------------------------------------------------------------
 * Two PRD business rules land here:
 *
 *   Module 4 — "Access tokens are stored encrypted and refreshed automatically"
 *   Module 5 — "Webhook URLs are treated as sensitive credentials — stored
 *               encrypted, never exposed in logs or the UI after initial entry"
 *
 * Nothing in this codebase encrypted anything before now. Passwords are bcrypt
 * (one-way, not applicable), and push subscription keys are stored in plaintext
 * — acceptable there because a push endpoint is a capability URL scoped to one
 * browser, whereas an OAuth refresh token is a long-lived key to a user's whole
 * calendar. So this is new, and deliberately narrow.
 *
 * AES-256-GCM, not CBC. GCM is authenticated: decrypt() fails loudly if the
 * ciphertext was altered, rather than returning plausible garbage that would
 * then be posted to a third party as if it were a webhook URL.
 *
 * KEY DERIVATION — mirrors the house style.
 * notification-actions.js:42-46 established the pattern: prefer a dedicated
 * env var, else derive from JWT_SECRET with a distinct, purpose-naming salt.
 * The derivation means Render needs no new environment variable to ship, while
 * a deployment that *does* set ENCRYPTION_KEY gets proper key separation. The
 * salt differs from notification-actions' so the two secrets can never collide.
 *
 * ROTATION CAVEAT: with the derived key, rotating JWT_SECRET makes every stored
 * token undecryptable. Callers treat a failed decrypt as "connection needs
 * reauthorising" rather than crashing, so the failure mode is a reconnect
 * prompt, not an outage — but production should set ENCRYPTION_KEY explicitly.
 *
 * DEGRADATION: with no key material at all, encrypt() returns null rather than
 * throwing, exactly as notification-actions.js#buildActionToken does. A caller
 * that cannot encrypt must refuse to store the secret — never fall back to
 * plaintext.
 */

const crypto = require('crypto')

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32 // 256 bits
const IV_LENGTH = 12 // 96 bits — the GCM-recommended nonce size
const VERSION = 'v1' // lets a future scheme change be detected, not guessed at

/** Distinct from notification-actions.js's `::notif-action` on purpose. */
const DERIVATION_SALT = 'varadhi-integrations'

let cachedKey
let cachedKeySource // remembers which input produced cachedKey

/**
 * Resolve the 32-byte key, memoised.
 *
 * ENCRYPTION_KEY may be supplied as 64 hex chars (exactly 32 bytes) or as an
 * arbitrary passphrase, which is stretched with scrypt. Anything else falls
 * back to deriving from JWT_SECRET.
 *
 * @returns {Buffer|null} null when no key material is configured at all.
 */
function getKey() {
  const explicit = process.env.ENCRYPTION_KEY
  const fallback = process.env.JWT_SECRET
  const source = explicit ? `explicit:${explicit}` : `derived:${fallback || ''}`

  // Memoise, but re-derive if the env changed under us (tests do this).
  if (cachedKey && cachedKeySource === source) return cachedKey

  let key = null

  if (explicit) {
    if (/^[0-9a-fA-F]{64}$/.test(explicit)) {
      key = Buffer.from(explicit, 'hex')
    } else {
      key = crypto.scryptSync(explicit, DERIVATION_SALT, KEY_LENGTH)
    }
  } else if (fallback) {
    key = crypto.scryptSync(fallback, DERIVATION_SALT, KEY_LENGTH)
  }

  cachedKey = key
  cachedKeySource = source
  return key
}

/** True when secrets can actually be protected. Callers gate storage on this. */
function isEncryptionAvailable() {
  return getKey() !== null
}

/**
 * Encrypt a UTF-8 string.
 *
 * @param {string} plaintext
 * @returns {string|null} `v1:<iv>:<authTag>:<ciphertext>` (base64url parts),
 *                        or null if there is no key or nothing to encrypt.
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null

  const key = getKey()
  if (!key) {
    console.error(
      '[crypto] refusing to encrypt: neither ENCRYPTION_KEY nor JWT_SECRET is set. ' +
      'The secret was NOT stored — storing it in plaintext is never an acceptable fallback.'
    )
    return null
  }

  try {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    const ciphertext = Buffer.concat([
      cipher.update(String(plaintext), 'utf8'),
      cipher.final(),
    ])
    const authTag = cipher.getAuthTag()

    return [
      VERSION,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':')
  } catch (err) {
    // Never log the plaintext — that would defeat the entire point.
    console.error('[crypto] encryption failed:', err.message)
    return null
  }
}

/**
 * Decrypt a blob produced by encrypt().
 *
 * Returns null — never throws, never returns partial data — on any failure:
 * wrong key (rotated JWT_SECRET), tampered ciphertext (GCM auth tag mismatch),
 * or a malformed blob. Callers treat null as "this secret is unusable, ask the
 * user to reconnect".
 *
 * @param {string} blob
 * @returns {string|null}
 */
function decrypt(blob) {
  if (!blob || typeof blob !== 'string') return null

  const key = getKey()
  if (!key) return null

  const parts = blob.split(':')
  if (parts.length !== 4) return null

  const [version, ivB64, tagB64, dataB64] = parts
  if (version !== VERSION) {
    console.error(`[crypto] unknown ciphertext version "${version}"; refusing to guess.`)
    return null
  }

  try {
    const iv = Buffer.from(ivB64, 'base64url')
    const authTag = Buffer.from(tagB64, 'base64url')
    const ciphertext = Buffer.from(dataB64, 'base64url')

    if (iv.length !== IV_LENGTH) return null

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    // Expected whenever the key rotated or the blob was altered. Deliberately
    // terse: the message adds nothing and the blob must not be logged.
    return null
  }
}

/**
 * A display-safe remnant of a secret, for UI and logs.
 *
 * Module 5 requires the webhook URL never be shown again after entry, but an
 * admin managing several channels still needs to tell them apart. For a URL we
 * keep the origin (which identifies the tenant, not the credential) plus the
 * last four characters; for anything else, just the tail.
 *
 * @param {string} secret
 * @returns {string} e.g. "https://acme.webhook.office.com/…b3f9"
 */
function maskSecret(secret) {
  if (!secret || typeof secret !== 'string') return ''

  const tail = secret.slice(-4)

  try {
    const url = new URL(secret)
    return `${url.origin}/…${tail}`
  } catch {
    // Not a URL — mask everything but the tail.
    if (secret.length <= 4) return '…'
    return `…${tail}`
  }
}

/**
 * Test seam. getKey() memoises, so a test that mutates process.env mid-run
 * needs a way to force re-derivation.
 */
function __resetKeyCache() {
  cachedKey = undefined
  cachedKeySource = undefined
}

module.exports = {
  encrypt,
  decrypt,
  maskSecret,
  isEncryptionAvailable,
  __resetKeyCache,
  VERSION,
}
