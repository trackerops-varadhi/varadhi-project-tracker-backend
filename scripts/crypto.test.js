/*
 * Encryption-at-rest tests (Modules 4 & 5).
 *
 * No database and no network — this is pure crypto, and the properties being
 * asserted are exactly the ones the PRD's "stored encrypted" business rules
 * depend on.
 *
 *   node scripts/crypto.test.js
 */
require('dotenv').config()

const crypto = require('../src/platform/crypto')

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n} ${e}`))
}

// Guarantee key material regardless of the developer's .env, then reset the
// memoised key so the module picks it up.
const ORIGINAL_JWT = process.env.JWT_SECRET
const ORIGINAL_ENC = process.env.ENCRYPTION_KEY
process.env.JWT_SECRET = ORIGINAL_JWT || 'test-jwt-secret-for-crypto-suite'
delete process.env.ENCRYPTION_KEY
crypto.__resetKeyCache()

const SECRET = 'https://acme.webhook.office.com/webhookb2/abc-123/IncomingWebhook/deadbeef/cafeb3f9'

console.log('\n1. Round trip')
{
  const blob = crypto.encrypt(SECRET)
  check('encrypt returns a string', typeof blob === 'string', String(blob))
  check('decrypt recovers the exact plaintext', crypto.decrypt(blob) === SECRET)
  check('ciphertext does not contain the plaintext',
    !blob.includes('webhookb2') && !blob.includes('cafeb3f9'), blob)
  check('versioned envelope', blob.startsWith(`${crypto.VERSION}:`), blob.slice(0, 12))
  check('four colon-separated parts', blob.split(':').length === 4)
}

console.log('\n2. Randomised IV — the same input never produces the same blob')
{
  const a = crypto.encrypt(SECRET)
  const b = crypto.encrypt(SECRET)
  check('two encryptions differ', a !== b)
  check('both still decrypt correctly',
    crypto.decrypt(a) === SECRET && crypto.decrypt(b) === SECRET)
  // This is precisely why teams_webhooks enforces uniqueness on url_hint
  // rather than on the ciphertext column.
  check('so a UNIQUE index on ciphertext could never detect duplicates', a !== b)
}

console.log('\n3. Tamper detection (GCM auth tag)')
{
  const blob = crypto.encrypt(SECRET)
  const [v, iv, tag, data] = blob.split(':')

  /*
   * TAMPER WITH BYTES, NOT WITH CHARACTERS.
   *
   * This used to swap the last base64url character ('A' <-> 'B'), which is not
   * reliably a change at all: base64url carries DON'T-CARE BITS whenever the
   * payload length is not a multiple of 3. A 2-byte final group spends 3
   * characters on 16 bits, so the last character's low 2 bits are padding that
   * the decoder discards, and 'A' (0) and 'B' (1) differ only in those bits.
   * The "altered" blob then decoded to the ORIGINAL bytes, GCM verified it
   * happily, decrypt returned the plaintext and the assertion failed -- while
   * the code under test had behaved perfectly.
   *
   * It was flaky rather than broken, which is worse: measured at 2000
   * iterations, the ciphertext case slipped through 7.3% of the time (the last
   * character is 'A' once every 16 blobs) and the 16-byte auth tag, whose final
   * group is a single byte with 4 don't-care bits, 25.5% of the time. The suite
   * as a whole failed about 31% of runs. CI run 12 on 2026-10-15 was one of
   * them, and the two green runs before it were luck.
   *
   * Flipping every bit of the last decoded byte cannot be a no-op: 0 of 2000.
   */
  const tamper = (b64url) => {
    const bytes = Buffer.from(b64url, 'base64url')
    bytes[bytes.length - 1] ^= 0xff
    return bytes.toString('base64url')
  }

  check('altered ciphertext returns null, never garbage',
    crypto.decrypt([v, iv, tag, tamper(data)].join(':')) === null)
  check('altered auth tag returns null',
    crypto.decrypt([v, iv, tamper(tag), data].join(':')) === null)
  check('altered IV returns null',
    crypto.decrypt([v, tamper(iv), tag, data].join(':')) === null)
  check('unknown version refused rather than guessed',
    crypto.decrypt(['v99', iv, tag, data].join(':')) === null)
  check('malformed blob returns null', crypto.decrypt('not-a-blob') === null)
  check('empty input returns null', crypto.decrypt('') === null)
  check('null input returns null', crypto.decrypt(null) === null)
}

console.log('\n4. Wrong key cannot decrypt (rotation behaviour)')
{
  const blob = crypto.encrypt(SECRET)

  process.env.JWT_SECRET = 'a-completely-different-secret'
  crypto.__resetKeyCache()
  check('a rotated key yields null, not an exception', crypto.decrypt(blob) === null)

  process.env.JWT_SECRET = ORIGINAL_JWT || 'test-jwt-secret-for-crypto-suite'
  crypto.__resetKeyCache()
  check('restoring the key restores access', crypto.decrypt(blob) === SECRET)
}

console.log('\n5. Explicit ENCRYPTION_KEY takes precedence')
{
  process.env.ENCRYPTION_KEY = 'f'.repeat(64) // 64 hex chars = 32 bytes
  crypto.__resetKeyCache()
  const withExplicit = crypto.encrypt(SECRET)
  check('hex key works', crypto.decrypt(withExplicit) === SECRET)

  process.env.ENCRYPTION_KEY = 'a passphrase, not hex'
  crypto.__resetKeyCache()
  const withPassphrase = crypto.encrypt(SECRET)
  check('passphrase key works (scrypt-stretched)', crypto.decrypt(withPassphrase) === SECRET)
  check('a blob from the hex key does NOT decrypt under the passphrase key',
    crypto.decrypt(withExplicit) === null)

  delete process.env.ENCRYPTION_KEY
  crypto.__resetKeyCache()
}

console.log('\n6. No key material — refuses rather than falling back to plaintext')
{
  const savedJwt = process.env.JWT_SECRET
  delete process.env.JWT_SECRET
  delete process.env.ENCRYPTION_KEY
  crypto.__resetKeyCache()

  check('isEncryptionAvailable() reports false', crypto.isEncryptionAvailable() === false)

  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  const result = crypto.encrypt(SECRET)
  console.error = orig

  check('encrypt returns null, NOT the plaintext', result === null)
  check('and never returns the secret itself', result !== SECRET)
  check('logs a clear refusal', errs.some((l) => /refusing to encrypt/i.test(l)),
    JSON.stringify(errs))
  check('the refusal log does not contain the secret',
    !errs.some((l) => l.includes('cafeb3f9')), JSON.stringify(errs))

  process.env.JWT_SECRET = savedJwt
  crypto.__resetKeyCache()
  check('isEncryptionAvailable() true once a key exists', crypto.isEncryptionAvailable() === true)
}

console.log('\n7. Masking — identifiable but not usable')
{
  const masked = crypto.maskSecret(SECRET)
  check('keeps the origin so channels are distinguishable',
    masked.startsWith('https://acme.webhook.office.com'), masked)
  check('keeps only the last four characters', masked.endsWith('b3f9'), masked)
  check('drops the credential path',
    !masked.includes('webhookb2') && !masked.includes('deadbeef'), masked)
  check('is much shorter than the original', masked.length < SECRET.length)

  check('non-URL secrets mask to a tail only', crypto.maskSecret('abcdefghij') === '…ghij')
  check('very short secrets reveal nothing', crypto.maskSecret('ab') === '…')
  check('empty input is safe', crypto.maskSecret('') === '')
  check('null input is safe', crypto.maskSecret(null) === '')
}

console.log('\n8. Edge cases')
{
  check('empty string encrypts to null (nothing to protect)', crypto.encrypt('') === null)
  check('null encrypts to null', crypto.encrypt(null) === null)
  check('undefined encrypts to null', crypto.encrypt(undefined) === null)

  const unicode = 'https://例え.test/webhook/🔐/ünïcødé'
  check('unicode survives the round trip', crypto.decrypt(crypto.encrypt(unicode)) === unicode)

  const long = 'x'.repeat(10000)
  check('long values survive the round trip', crypto.decrypt(crypto.encrypt(long)) === long)
}

// Restore the developer's environment.
if (ORIGINAL_JWT === undefined) delete process.env.JWT_SECRET
else process.env.JWT_SECRET = ORIGINAL_JWT
if (ORIGINAL_ENC === undefined) delete process.env.ENCRYPTION_KEY
else process.env.ENCRYPTION_KEY = ORIGINAL_ENC

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
