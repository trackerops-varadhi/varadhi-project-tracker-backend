/*
 * identity — 0004 qc role
 * ---------------------------------------------------------------------------
 * Widens users_role_check to admit 'qc' (quality control). Additive: every
 * existing row still satisfies the new constraint.
 *
 * What a qc user may do is decided by restrictTo() and the module allow-lists:
 * the Bugs Finder is theirs (create, assign, verify, close, reopen), plus their
 * own leave, time and settings. Everywhere else the allow-lists already treat
 * an unlisted role as restricted to its own rows.
 */

exports.shorthands = undefined

const TABLE = { schema: 'identity', name: 'users' }

exports.up = (pgm) => {
  pgm.dropConstraint(TABLE, 'users_role_check')
  pgm.addConstraint(TABLE, 'users_role_check',
    "CHECK (role IN ('admin', 'manager', 'employee', 'hr', 'qc'))")
}

// Refuses while any qc user exists — demote them first.
exports.down = (pgm) => {
  pgm.dropConstraint(TABLE, 'users_role_check')
  pgm.addConstraint(TABLE, 'users_role_check',
    "CHECK (role IN ('admin', 'manager', 'employee', 'hr'))")
}
