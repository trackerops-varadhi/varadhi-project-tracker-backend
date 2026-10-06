// User-directory business logic: listing, team stats, profile and administration.

const crypto = require('crypto')
const repo = require('./repo')
const work = require('../work')
const notify = require('../notify')
const { sendInviteEmail } = require('../../utils/sendEmail')

// Notifications must never turn a successful action into a 500.
const notifySafely = async (fn) => {
  try {
    await fn()
  } catch (err) {
    console.error('[notifications] identity/users:', err.message)
  }
}
exports.notifySafely = notifySafely

class UserError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}
exports.UserError = UserError

/* ── Directory ──────────────────────────────────────────────────────────── */

/**
 * The user list, each row carrying how many tasks that person is assigned.
 *
 * `tasks_count` used to be a correlated subquery over `tasks` in this very
 * statement. It is now one batched call to work — same number, no boundary
 * crossing. Legacy shape preserved exactly: raw snake_case rows plus
 * `tasks_count`.
 */
exports.list = async (query = {}) => {
  const users = await repo.listUsers(query)
  const counts = await work.getTaskCountsByAssignee(users.map((u) => u.id))
  return users.map((u) => ({ ...u, tasks_count: counts.get(u.id)?.total ?? 0 }))
}

/**
 * Team composition + top performers.
 *
 * Top Performers was an INNER JOIN on tasks with ORDER BY / LIMIT in SQL. The
 * ranking now happens here, after work supplies the counts — and reproduces the
 * old semantics exactly: only active users, only those with at least one
 * completed task (which is what the INNER JOIN meant), ordered by completions
 * descending then name, capped at five.
 */
exports.stats = async () => {
  const [totals, activeUsers, recent] = await Promise.all([
    repo.userTotals(),
    repo.findActiveUsers(),
    repo.findRecentlyJoined(5),
  ])

  const counts = await work.getTaskCountsByAssignee(activeUsers.map((u) => u.id))

  const topPerformers = activeUsers
    .map((u) => {
      const c = counts.get(u.id) || { total: 0, completed: 0 }
      return { user: u, completedTasks: c.completed, totalTasks: c.total }
    })
    .filter((r) => r.completedTasks > 0)
    .sort((a, b) =>
      b.completedTasks - a.completedTasks ||
      String(a.user.name ?? '').localeCompare(String(b.user.name ?? ''))
    )
    .slice(0, 5)
    .map(({ user, completedTasks, totalTasks }) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      avatar: user.avatar,
      completedTasks,
      totalTasks,
      // Share of their own assigned work that is finished.
      score: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
    }))

  return {
    totals,
    topPerformers,
    recentlyJoined: recent.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      avatar: r.avatar,
      status: r.status,
      createdAt: r.created_at,
    })),
  }
}

exports.getById = async (id) => {
  const user = await repo.findDirectoryUser(id)
  if (!user) throw new UserError('User not found.', 404)
  return user
}

/* ── Profile ────────────────────────────────────────────────────────────── */

exports.updateProfile = async (currentUser, { name, email }) => {
  if (!name || !email) throw new UserError('Name and email are required.')
  if (await repo.findEmailOwnedByAnother(email, currentUser.id)) {
    throw new UserError('Email already in use.')
  }
  return repo.updateProfile(currentUser.id, name, email)
}

/* ── Administration ─────────────────────────────────────────────────────── */

// 'hr' (Module 9) can be granted here, but invite/role/deactivate stay admin-only.
const VALID_ROLES = ['admin', 'manager', 'employee', 'hr']

// `name` is optional: the Users screen invites by email alone, while people's
// candidate conversion already knows the person's name.
exports.invite = async (currentUser, { email, role, name }) => {
  if (!email) throw new UserError('Email is required.')
  if (role && !VALID_ROLES.includes(role)) throw new UserError('Invalid role.')
  if (await repo.findByEmail(email)) throw new UserError('User already exists.')

  const inviteToken = crypto.randomBytes(32).toString('hex')
  const placeholderName = (name && String(name).trim()) || email.split('@')[0]

  const created = await repo.insertInvitedUser({
    name: placeholderName,
    email,
    role: role || 'employee',
    inviteToken,
  })

  const appUrl = process.env.FRONTEND_URL || 'http://localhost:3000'
  await sendInviteEmail(email, `${appUrl}/auth/accept-invite?token=${inviteToken}`)

  await notifySafely(async () => {
    await notify.dispatchToRoles({
      roles: ['admin'],
      type: notify.TYPES.USER_INVITED,
      title: 'User invited',
      message: `${currentUser.name} invited ${email} as ${role || 'employee'}.`,
      linkTo: '/users',
      priority: 'low',
      excludeUserId: currentUser.id,
    })
  })

  return { id: created.id, email, role: role || 'employee' }
}

exports.updateRole = async (currentUser, targetId, role) => {
  if (!VALID_ROLES.includes(role)) throw new UserError('Invalid role.')
  if (targetId === currentUser.id) throw new UserError('Cannot change your own role.')

  const updated = await repo.updateRole(targetId, role)
  if (!updated) throw new UserError('User not found.', 404)

  await notifySafely(async () => {
    await notify.dispatchToRoles({
      roles: ['admin'],
      type: notify.TYPES.USER_ROLE_CHANGED,
      title: 'User role changed',
      message: `${currentUser.name} changed ${updated.name}'s role to ${role}.`,
      linkTo: '/users',
      priority: 'low',
      excludeUserId: currentUser.id,
    })
  })

  return updated
}

// A toggle, not a one-way deactivate — an inactive user is reactivated by the
// same endpoint. Note it does NOT revoke the user's live sessions; `protect`
// refuses them on the next request because it reads `status` on every call.
exports.toggleActive = async (currentUser, targetId) => {
  if (targetId === currentUser.id) throw new UserError('Cannot deactivate yourself.')

  const current = await repo.findNameAndStatus(targetId)
  if (!current) throw new UserError('User not found.', 404)

  const newStatus = current.status === 'active' ? 'inactive' : 'active'
  const updated = await repo.updateStatus(targetId, newStatus)

  if (newStatus === 'inactive') {
    await notifySafely(async () => {
      await notify.dispatchToRoles({
        roles: ['admin'],
        type: notify.TYPES.USER_REMOVED,
        title: 'User deactivated',
        message: `${currentUser.name} deactivated ${current.name}.`,
        linkTo: '/users',
        priority: 'low',
        excludeUserId: currentUser.id,
      })
    })
  }

  return { updated, newStatus }
}
