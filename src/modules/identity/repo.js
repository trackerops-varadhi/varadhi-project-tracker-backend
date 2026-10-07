// SQL for the identity module (users · user_sessions · user_tokens).
// This module owns all three tables. No other module may require this file.
//
// The session and token tables are handled by session.service.js and
// token.service.js, which carry their own SQL — they moved here verbatim and
// were already the single authority for that logic.
//
// WHAT CHANGED
// users.controller.js measured `tasks` in two places: a scalar subquery for the
// per-user task count, and an aggregate JOIN behind Top Performers. Both are
// gone; work.getTaskCountsByAssignee() supplies those numbers now.

const pool = require('../../platform/db').forSchema('identity')

// Columns safe to return to a browser. Spelled out rather than SELECT * so a
// column added later (a reset token, an MFA secret) cannot leak by default.
const SAFE_USER_COLUMNS = 'id, name, email, role, status, avatar, created_at'
exports.SAFE_USER_COLUMNS = SAFE_USER_COLUMNS

/* ── Cross-module lookups ───────────────────────────────────────────────── */

// `role` and `status` are on the card because two callers need them for logic,
// not display: the project Members tab renders a role, and the @mention
// resolver must skip deactivated accounts.
exports.findUserCards = async (ids) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, avatar, role, status
       FROM users WHERE id = ANY($1::uuid[])`,
    [ids]
  )
  return rows
}

// Name substring match. Returns ids only — the caller filters its own rows by
// them rather than joining to this table.
exports.searchUserIds = async (likeTerm) => {
  const { rows } = await pool.query(`SELECT id FROM users WHERE name ILIKE $1`, [likeTerm])
  return rows.map((r) => r.id)
}

exports.findActiveIdsByRoles = async (roles) => {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role = ANY($1) AND status = 'active'`,
    [roles]
  )
  return rows.map((r) => r.id)
}

exports.findAccountState = async (id) => {
  const { rows } = await pool.query('SELECT id, status FROM users WHERE id = $1', [id])
  return rows[0] || null
}

/* ── Directory ──────────────────────────────────────────────────────────── */

exports.listUsers = async ({ role, status, search }) => {
  const params = []
  let query = `SELECT ${SAFE_USER_COLUMNS} FROM users WHERE 1=1`
  if (role) { params.push(role); query += ` AND role = $${params.length}` }
  if (status) { params.push(status); query += ` AND status = $${params.length}` }
  if (search) {
    params.push(`%${search}%`)
    query += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`
  }
  query += ' ORDER BY created_at DESC'
  const { rows } = await pool.query(query, params)
  return rows
}

exports.userTotals = async () => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(CASE WHEN status = 'active'   THEN 1 END)::int AS active,
      COUNT(CASE WHEN status = 'inactive' THEN 1 END)::int AS inactive,
      COUNT(CASE WHEN status = 'invited'  THEN 1 END)::int AS invited,
      COUNT(CASE WHEN role   = 'admin'    THEN 1 END)::int AS admins,
      COUNT(CASE WHEN role   = 'manager'  THEN 1 END)::int AS managers,
      COUNT(CASE WHEN role   = 'employee' THEN 1 END)::int AS employees,
      COUNT(CASE WHEN role   = 'hr'       THEN 1 END)::int AS hr,
      COUNT(CASE WHEN role   = 'qc'       THEN 1 END)::int AS qc
    FROM users
  `)
  return rows[0]
}

// Candidates for the Top Performers ranking. The ordering and the top-5 cut
// used to happen in SQL against a JOIN on tasks; they now happen in the service
// once work has supplied the counts.
// ORDER BY name is in SQL, not the caller: insights' member-workload report
// used to get its ordering from `ORDER BY u.name ASC` here, and Postgres
// collation and JS localeCompare do not agree on non-ASCII names.
exports.findActiveUsers = async () => {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, avatar FROM users WHERE status = 'active' ORDER BY name ASC`
  )
  return rows
}

exports.countActiveUsers = async () => {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS total FROM users WHERE status='active'`)
  return rows[0].total
}

exports.findRecentlyJoined = async (limit = 5) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, avatar, status, created_at
       FROM users WHERE status <> 'invited'
      ORDER BY created_at DESC LIMIT $1`,
    [limit]
  )
  return rows
}

exports.findSafeUserById = async (id) => {
  const { rows } = await pool.query(
    `SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = $1`, [id]
  )
  return rows[0] || null
}

// The directory's detail read returns a narrower set than SAFE_USER_COLUMNS
// did historically — preserved exactly.
exports.findDirectoryUser = async (id) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, role, status, avatar, created_at FROM users WHERE id = $1',
    [id]
  )
  return rows[0] || null
}

/* ── Profile / administration ───────────────────────────────────────────── */

exports.findByEmail = async (email) => {
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email])
  return rows[0] || null
}

exports.findEmailOwnedByAnother = async (email, excludeId) => {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE email = $1 AND id != $2', [email, excludeId]
  )
  return rows[0] || null
}

exports.updateProfile = async (id, name, email) => {
  const { rows } = await pool.query(
    `UPDATE users SET name=$1, email=$2, updated_at=NOW() WHERE id=$3
     RETURNING id, name, email, role, status, avatar`,
    [name, email, id]
  )
  return rows[0]
}

exports.insertInvitedUser = async ({ name, email, role, inviteToken }) => {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, role, status, invite_token)
          VALUES ($1, $2, $3, 'invited', $4)
       RETURNING id`,
    [name, email, role, inviteToken]
  )
  return rows[0]
}

exports.updateRole = async (id, role) => {
  const { rows } = await pool.query(
    'UPDATE users SET role=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, email, role',
    [role, id]
  )
  return rows[0] || null
}

exports.findNameAndStatus = async (id) => {
  const { rows } = await pool.query('SELECT name, status FROM users WHERE id = $1', [id])
  return rows[0] || null
}

exports.updateStatus = async (id, status) => {
  const { rows } = await pool.query(
    'UPDATE users SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING id, name, status',
    [status, id]
  )
  return rows[0] || null
}

/* ── Credentials ────────────────────────────────────────────────────────── */

exports.insertUser = async ({ name, email, passwordHash }) => {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password, role, status)
          VALUES ($1, $2, $3, 'employee', 'active')
       RETURNING ${SAFE_USER_COLUMNS}`,
    [name, email, passwordHash]
  )
  return rows[0]
}

// The one place `password` is selected. Callers strip it before responding.
exports.findUserForLogin = async (email) => {
  const { rows } = await pool.query(
    `SELECT ${SAFE_USER_COLUMNS}, password FROM users WHERE email = $1`, [email]
  )
  return rows[0] || null
}

exports.findPasswordHash = async (id) => {
  const { rows } = await pool.query('SELECT password FROM users WHERE id = $1', [id])
  return rows[0] || null
}

exports.setResetToken = async (email, token, expires) => {
  await pool.query(
    'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE email = $3',
    [token, expires, email]
  )
}

exports.findByLiveResetToken = async (token) => {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
    [token]
  )
  return rows[0] || null
}

exports.setPasswordAndClearReset = async (id, passwordHash) => {
  await pool.query(
    `UPDATE users
        SET password = $1, reset_token = NULL, reset_token_expires = NULL, updated_at = NOW()
      WHERE id = $2`,
    [passwordHash, id]
  )
}

exports.setPassword = async (id, passwordHash) => {
  await pool.query(
    'UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2',
    [passwordHash, id]
  )
}

/* ── Invites ────────────────────────────────────────────────────────────── */

exports.findInviteByToken = async (token) => {
  const { rows } = await pool.query(
    `SELECT email, role FROM users WHERE invite_token = $1 AND status = 'invited'`,
    [token]
  )
  return rows[0] || null
}

exports.findInvitedIdByToken = async (token) => {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE invite_token = $1 AND status = 'invited'`,
    [token]
  )
  return rows[0] || null
}

exports.acceptInvite = async (id, name, passwordHash) => {
  const { rows } = await pool.query(
    `UPDATE users
        SET name = $1, password = $2, status = 'active',
            invite_token = NULL, updated_at = NOW()
      WHERE id = $3
      RETURNING ${SAFE_USER_COLUMNS}`,
    [name, passwordHash, id]
  )
  return rows[0]
}
