/**
 * Refuse to run a pre-split migration against a post-split database.
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS PREVENTS, precisely.
 *
 * The migrations in this directory were written when all 29 tables lived in
 * `public`, and they say things like:
 *
 *     CREATE TABLE IF NOT EXISTS users (...)
 *
 * on the DEFAULT pool, whose search_path is `"$user", public`. After the Phase
 * 2 schema split, `users` lives in `identity`. So `IF NOT EXISTS` does not
 * match — there is no `public.users` any more — and the statement happily
 * creates a SECOND, EMPTY `public.users`.
 *
 * Nothing errors. The migration reports success. The application keeps working,
 * because its module pools read `identity.users`. And the database now carries
 * a shadow copy of up to 29 tables that some future query, dump, or restore
 * will eventually find and believe. That is a far worse outcome than a failed
 * migration, and it is silent, which is why this guard exists.
 *
 * WHAT THE CORRECT SEQUENCE IS
 *
 *   fresh database:      npm run migrate                          (node-pg-migrate,
 *                        which provisions the module schemas directly)
 *                        node src/config/migrate-schema-split.js --apply
 *
 *   already split:       neither. The schema is current; a module that needs a
 *                        new table or column adds it through its own pool, the
 *                        way migrate-user-tokens.js and migrate-sessions.js do.
 *
 * migrate.js is not obsolete — it is the provisioner for the PRE-split layout,
 * and migrate-schema-split.js is what moves that layout into module schemas and
 * drops the 31 cross-module foreign keys. Running them in that order is
 * correct. Running migrate.js after the split is what this file stops.
 */

/**
 * @param {import('pg').Pool} pool   the DEFAULT pool (the one that cannot see module schemas)
 * @param {string} scriptName        shown in the refusal, so the operator knows what stopped
 * @param {object} [opts]
 * @param {boolean} [opts.exit=true] call process.exit(1) rather than returning
 * @returns {Promise<boolean>} true when it is safe to proceed
 */
const assertNotSplit = async (pool, scriptName, { exit = true } = {}) => {
  const MODULE_SCHEMAS = [
    'identity', 'work', 'defects', 'notify', 'integrations', 'files', 'workforce',
  ]

  let present = []
  try {
    const { rows } = await pool.query(
      'SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) ORDER BY 1', [MODULE_SCHEMAS])
    present = rows.map((r) => r.nspname)
  } catch (err) {
    // Cannot tell. Refusing on an unreadable catalogue would block a legitimate
    // fresh provision against an empty database, so proceed and let the
    // migration itself fail if the database is genuinely unusable.
    console.warn(`[split-guard] could not inspect schemas (${err.message}); proceeding`)
    return true
  }

  if (present.length === 0) return true

  console.error(`
REFUSING TO RUN ${scriptName}.

  This database has already had the Phase 2 schema split applied.
  Module schemas present: ${present.join(', ')}

  ${scriptName} creates tables UNQUALIFIED on the default pool, whose
  search_path is "$user", public. Every table it names now lives in a module
  schema, so CREATE TABLE IF NOT EXISTS would not match and would create an
  empty SHADOW copy in public — silently, and reporting success.

  If you need to change a module's schema, add it through that module's pool:
      require('../platform/db').forSchema('<module>')
  as src/config/migrate-user-tokens.js and migrate-sessions.js do.

  Nothing was changed.
`)

  if (exit) process.exit(1)
  return false
}

module.exports = { assertNotSplit }
