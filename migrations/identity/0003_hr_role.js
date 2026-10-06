/*
 * identity — 0003 hr role
 * ---------------------------------------------------------------------------
 * Widens users_role_check to admit 'hr' (Module 9, docs/Module-9-People-Plan.md §3.1).
 *
 * Widening a CHECK is additive: every existing row (admin/manager/employee)
 * still satisfies the new constraint, so this is safe on a live database.
 *
 * The constraint alone grants nothing. What an hr user may do is decided by
 * restrictTo() and the per-module scoping, which were flipped from a
 * deny-list ("is this an employee?") to an allow-list ("is this admin or
 * manager?") in the same change — otherwise a new role would have fallen
 * through to manager-level access everywhere.
 */

exports.shorthands = undefined

const TABLE = { schema: 'identity', name: 'users' }

exports.up = (pgm) => {
  pgm.dropConstraint(TABLE, 'users_role_check')
  pgm.addConstraint(TABLE, 'users_role_check',
    "CHECK (role IN ('admin', 'manager', 'employee', 'hr'))")
}

// Refuses (constraint violation) while any hr user exists, which is the right
// outcome: demote them first rather than have a rollback rewrite roles.
exports.down = (pgm) => {
  pgm.dropConstraint(TABLE, 'users_role_check')
  pgm.addConstraint(TABLE, 'users_role_check',
    "CHECK (role IN ('admin', 'manager', 'employee'))")
}
