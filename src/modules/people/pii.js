// Aadhaar handling (docs/Module-9-People-Plan.md §7.1).
//
// The number is encrypted with its OWN key, PII_ENCRYPTION_KEY, and never with
// a key derived from JWT_SECRET: under a derived key, rotating JWT_SECRET would
// make every stored Aadhaar permanently undecryptable. For an OAuth token that
// is a reconnect prompt; for Aadhaar it is data loss. So without an explicit
// key, Aadhaar writes are refused with a 400 — never stored in plaintext.
//
// A separate key (rather than ENCRYPTION_KEY) also means setting it cannot
// disturb the calendar and Teams secrets integrations already encrypted.

const { forPurpose } = require('../../platform/crypto')
const { PeopleError } = require('./shared')

const cipher = forPurpose({
  envVar: 'PII_ENCRYPTION_KEY',
  salt: 'varadhi-people-pii',
  allowDerived: false,
})

const AADHAAR_RE = /^\d{12}$/

/** Strip the spaces/dashes people type, then require exactly 12 digits. */
const normaliseAadhaar = (value) => {
  const digits = String(value ?? '').replace(/[\s-]/g, '')
  if (!AADHAAR_RE.test(digits)) throw new PeopleError('Aadhaar number must be 12 digits.')
  return digits
}

/**
 * @returns {{ aadhaarEncrypted: string, aadhaarLast4: string }}
 */
const sealAadhaar = (value) => {
  const digits = normaliseAadhaar(value)
  if (!cipher.isEncryptionAvailable()) {
    throw new PeopleError(
      'Aadhaar cannot be saved: PII encryption is not configured on the server (PII_ENCRYPTION_KEY).'
    )
  }
  const aadhaarEncrypted = cipher.encrypt(digits)
  if (!aadhaarEncrypted) throw new PeopleError('Aadhaar could not be encrypted, so it was not saved.')
  return { aadhaarEncrypted, aadhaarLast4: digits.slice(-4) }
}

/** null when the stored value cannot be decrypted (wrong/rotated key). */
const openAadhaar = (blob) => cipher.decrypt(blob)

const maskAadhaar = (last4) => (last4 ? `XXXX XXXX ${last4}` : null)

const formatAadhaar = (digits) =>
  digits ? `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}` : null

module.exports = {
  sealAadhaar, openAadhaar, maskAadhaar, formatAadhaar, normaliseAadhaar,
  isPiiEncryptionAvailable: () => cipher.isEncryptionAvailable(),
}
