// const pool = require('../config/db')
// const { successResponse, errorResponse, paginatedResponse } = require('../utils/response')

// const getProjectWithDetails = async (projectId) => {
//   const project = await pool.query(`
//     SELECT p.*, u.id AS manager_id, u.name AS manager_name, u.email AS manager_email
//     FROM projects p LEFT JOIN users u ON p.manager_id = u.id
//     WHERE p.id = $1
//   `, [projectId])
//   if (!project.rows[0]) return null
//   const members = await pool.query(`
//     SELECT u.id, u.name, u.email, u.role, u.avatar
//     FROM project_members pm JOIN users u ON pm.user_id = u.id
//     WHERE pm.project_id = $1
//   `, [projectId])
//   const taskCounts = await pool.query(`
//     SELECT COUNT(*) AS total,
//       COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed
//     FROM tasks WHERE project_id = $1
//   `, [projectId])
//   const p = project.rows[0]
//   return {
//     id: p.id, name: p.name, description: p.description,
//     status: p.status, startDate: p.start_date, endDate: p.end_date,
//     createdAt: p.created_at, updatedAt: p.updated_at,
//     manager: p.manager_id ? { id: p.manager_id, name: p.manager_name, email: p.manager_email } : null,
//     members: members.rows,
//     tasksCount: parseInt(taskCounts.rows[0].total),
//     completedTasksCount: parseInt(taskCounts.rows[0].completed),
//     progress: taskCounts.rows[0].total > 0
//       ? Math.round((taskCounts.rows[0].completed / taskCounts.rows[0].total) * 100) : 0
//   }
// }

// exports.getAllProjects = async (req, res) => {
//   try {
//     const { status, search, page = 1, limit = 10 } = req.query
//     let countQ = 'SELECT COUNT(*) FROM projects WHERE 1=1'
//     let dataQ = `SELECT p.id FROM projects p WHERE 1=1`
//     const params = []
//     if (status) { params.push(status); countQ += ` AND status = $${params.length}`; dataQ += ` AND p.status = $${params.length}` }
//     if (search) { params.push(`%${search}%`); countQ += ` AND name ILIKE $${params.length}`; dataQ += ` AND p.name ILIKE $${params.length}` }
//     const countResult = await pool.query(countQ, params)
//     const total = parseInt(countResult.rows[0].count)
//     params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit))
//     dataQ += ` ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`
//     const ids = await pool.query(dataQ, params)
//     const projects = await Promise.all(ids.rows.map(r => getProjectWithDetails(r.id)))
//     return paginatedResponse(res, projects, total, page, limit)
//   } catch (err) { return errorResponse(res, err.message, 500) }
// }

// exports.getProjectById = async (req, res) => {
//   try {
//     const project = await getProjectWithDetails(req.params.id)
//     if (!project) return errorResponse(res, 'Project not found.', 404)
//     return successResponse(res, project)
//   } catch (err) { return errorResponse(res, err.message, 500) }
// }

// exports.createProject = async (req, res) => {
//   try {
//     const { name, description, managerId, memberIds, startDate, endDate } = req.body
//     if (!name) return errorResponse(res, 'Project name is required.')
//     const result = await pool.query(
//       'INSERT INTO projects (name, description, manager_id, start_date, end_date) VALUES ($1,$2,$3,$4,$5) RETURNING id',
//       [name, description, managerId || req.user.id, startDate, endDate]
//     )
//     const projectId = result.rows[0].id
//     // Add manager as member
//     await pool.query('INSERT INTO project_members VALUES ($1,$2) ON CONFLICT DO NOTHING', [projectId, managerId || req.user.id])
//     // Add other members
//     if (memberIds?.length) {
//       for (const uid of memberIds) {
//         await pool.query('INSERT INTO project_members VALUES ($1,$2) ON CONFLICT DO NOTHING', [projectId, uid])
//       }
//     }
//     const project = await getProjectWithDetails(projectId)
//     return successResponse(res, project, 'Project created successfully.', 201)
//   } catch (err) { return errorResponse(res, err.message, 500) }
// }

// exports.updateProject = async (req, res) => {
//   try {
//     const { name, description, status, startDate, endDate } = req.body
//     const result = await pool.query(
//       'UPDATE projects SET name=COALESCE($1,name), description=COALESCE($2,description), status=COALESCE($3,status), start_date=COALESCE($4,start_date), end_date=COALESCE($5,end_date), updated_at=NOW() WHERE id=$6 RETURNING id',
//       [name, description, status, startDate, endDate, req.params.id]
//     )
//     if (!result.rows[0]) return errorResponse(res, 'Project not found.', 404)
//     const project = await getProjectWithDetails(req.params.id)
//     return successResponse(res, project, 'Project updated successfully.')
//   } catch (err) { return errorResponse(res, err.message, 500) }
// }

// exports.archiveProject = async (req, res) => {
//   try {
//     const result = await pool.query(
//       "UPDATE projects SET status='archived', updated_at=NOW() WHERE id=$1 RETURNING id",
//       [req.params.id]
//     )
//     if (!result.rows[0]) return errorResponse(res, 'Project not found.', 404)
//     return successResponse(res, null, 'Project archived.')
//   } catch (err) { return errorResponse(res, err.message, 500) }
// }

// exports.deleteProject = async (req, res) => {
//   try {
//     const result = await pool.query('DELETE FROM projects WHERE id=$1 RETURNING id', [req.params.id])
//     if (!result.rows[0]) return errorResponse(res, 'Project not found.', 404)
//     return successResponse(res, null, 'Project deleted.')
//   } catch (err) { return errorResponse(res, err.message, 500) }
// }

// exports.addMember = async (req, res) => {
//   try {
//     const { userId } = req.body
//     await pool.query('INSERT INTO project_members VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, userId])
//     return successResponse(res, null, 'Member added.')
//   } catch (err) { return errorResponse(res, err.message, 500) }
// }

// exports.removeMember = async (req, res) => {
//   try {
//     await pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [req.params.id, req.params.userId])
//     return successResponse(res, null, 'Member removed.')
//   } catch (err) { return errorResponse(res, err.message, 500) }
// }

const pool = require('../config/db')
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response')
const {
  dispatchNotification,
  dispatchToMany,
  notifyByRoles,
  NOTIFICATION_TYPES,
} = require('../utils/notification-engine')

const actorName = (req) => (req.user && req.user.name) || 'A team member'

// Reads the project name plus its member ids for notification copy.
// Purely additive — no existing query or response depends on it.
const getProjectNotificationContext = async (projectId) => {
  const [project, members] = await Promise.all([
    pool.query('SELECT name, manager_id FROM projects WHERE id = $1', [projectId]),
    pool.query('SELECT user_id FROM project_members WHERE project_id = $1', [projectId])
  ])
  if (!project.rows[0]) return null
  return {
    name: project.rows[0].name,
    managerId: project.rows[0].manager_id,
    memberIds: members.rows.map(r => r.user_id)
  }
}

// Notifications must never turn a successful action into a 500, so every
// dispatch block runs inside this guard instead of the handler's try/catch.
const notifySafely = async (fn) => {
  try {
    await fn()
  } catch (err) {
    console.error('[notifications] projects.controller:', err.message)
  }
}

const getProjectWithDetails = async (projectId) => {
  const project = await pool.query(`
    SELECT p.*, u.id AS manager_id, u.name AS manager_name, u.email AS manager_email
    FROM projects p LEFT JOIN users u ON p.manager_id = u.id
    WHERE p.id = $1
  `, [projectId])
  if (!project.rows[0]) return null
  // Explicit project_members rows aren't the whole picture — a task can be
  // assigned to someone who was never formally added to the project (no
  // sync exists between task assignment and project_members), so the
  // Members tab was silently dropping real participants. Union in anyone
  // with at least one task in this project so it reflects actual
  // participation, not just explicit membership.
  const members = await pool.query(`
    SELECT u.id, u.name, u.email, u.role, u.avatar
    FROM users u
    WHERE u.id IN (
      SELECT user_id FROM project_members WHERE project_id = $1
      UNION
      SELECT assignee_id FROM tasks WHERE project_id = $1 AND assignee_id IS NOT NULL
    )
    ORDER BY u.name
  `, [projectId])
  const taskCounts = await pool.query(`
    SELECT COUNT(*) AS total,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed
    FROM tasks WHERE project_id = $1
  `, [projectId])
  const p = project.rows[0]
  return {
    id: p.id, name: p.name, description: p.description,
    status: p.status, startDate: p.start_date, endDate: p.end_date,
    createdAt: p.created_at, updatedAt: p.updated_at,
    manager: p.manager_id ? { id: p.manager_id, name: p.manager_name, email: p.manager_email } : null,
    members: members.rows,
    tasksCount: parseInt(taskCounts.rows[0].total),
    completedTasksCount: parseInt(taskCounts.rows[0].completed),
    progress: taskCounts.rows[0].total > 0
      ? Math.round((taskCounts.rows[0].completed / taskCounts.rows[0].total) * 100) : 0
  }
}

exports.getAllProjects = async (req, res) => {
  try {
    const { status, search, page = 1, limit = 10 } = req.query
    let countQ = 'SELECT COUNT(*) FROM projects WHERE 1=1'
    let dataQ = `SELECT p.id FROM projects p WHERE 1=1`
    const params = []
    if (status) { params.push(status); countQ += ` AND status = $${params.length}`; dataQ += ` AND p.status = $${params.length}` }
    if (search) { params.push(`%${search}%`); countQ += ` AND name ILIKE $${params.length}`; dataQ += ` AND p.name ILIKE $${params.length}` }
    const countResult = await pool.query(countQ, params)
    const total = parseInt(countResult.rows[0].count)
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit))
    dataQ += ` ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`
    const ids = await pool.query(dataQ, params)
    const projects = await Promise.all(ids.rows.map(r => getProjectWithDetails(r.id)))
    return paginatedResponse(res, projects, total, page, limit)
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.getProjectById = async (req, res) => {
  try {
    const project = await getProjectWithDetails(req.params.id)
    if (!project) return errorResponse(res, 'Project not found.', 404)
    return successResponse(res, project)
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.createProject = async (req, res) => {
  try {
    const { name, description, managerId, memberIds, startDate, endDate } = req.body
    if (!name) return errorResponse(res, 'Project name is required.')
    const result = await pool.query(
      'INSERT INTO projects (name, description, manager_id, start_date, end_date) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, description, managerId || req.user.id, startDate, endDate]
    )
    const projectId = result.rows[0].id
    // Add manager as member
    await pool.query('INSERT INTO project_members VALUES ($1,$2) ON CONFLICT DO NOTHING', [projectId, managerId || req.user.id])
    // Add other members
    if (memberIds?.length) {
      for (const uid of memberIds) {
        await pool.query('INSERT INTO project_members VALUES ($1,$2) ON CONFLICT DO NOTHING', [projectId, uid])
      }
    }
    // Notify the manager, then the rest of the team
    await notifySafely(async () => {
      const assignedManagerId = managerId || req.user.id
      if (assignedManagerId !== req.user.id) {
        await dispatchNotification(
          assignedManagerId,
          NOTIFICATION_TYPES.PROJECT_ASSIGNED,
          'You are managing a new project',
          `${actorName(req)} made you the manager of ${name}.`,
          `/projects/${projectId}`,
          'normal'
        )
      }
      if (memberIds?.length) {
        await dispatchToMany(
          memberIds,
          NOTIFICATION_TYPES.PROJECT_ASSIGNED,
          'Added to a project',
          `You were added to ${name}.`,
          `/projects/${projectId}`,
          'normal',
          { excludeUserId: req.user.id }
        )
      }
      // Admin visibility on every new project, regardless of who created it.
      await notifyByRoles(
        ['admin'],
        NOTIFICATION_TYPES.PROJECT_ASSIGNED,
        'New project created',
        `${actorName(req)} created ${name}.`,
        `/projects/${projectId}`,
        'normal',
        { excludeUserId: req.user.id }
      )
    })
    const project = await getProjectWithDetails(projectId)
    return successResponse(res, project, 'Project created successfully.', 201)
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.updateProject = async (req, res) => {
  try {
    const { name, description, status, startDate, endDate, managerId } = req.body

    const previous = await pool.query('SELECT manager_id FROM projects WHERE id = $1', [req.params.id])
    const previousManagerId = previous.rows[0]?.manager_id

    const result = await pool.query(
      'UPDATE projects SET name=COALESCE($1,name), description=COALESCE($2,description), status=COALESCE($3,status), start_date=COALESCE($4,start_date), end_date=COALESCE($5,end_date), manager_id=COALESCE($6,manager_id), updated_at=NOW() WHERE id=$7 RETURNING id',
      [name, description, status, startDate, endDate, managerId || null, req.params.id]
    )
    if (!result.rows[0]) return errorResponse(res, 'Project not found.', 404)

    // Manager reassignment gets its own notification (team + admins); a plain
    // field edit falls back to the existing generic "project updated" ping.
    const managerChanged = Boolean(managerId) && managerId !== previousManagerId

    if (managerChanged) {
      // Manager is now a member of their own project going forward.
      await pool.query('INSERT INTO project_members VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, managerId])
    }

    await notifySafely(async () => {
      const context = await getProjectNotificationContext(req.params.id)
      if (!context) return

      if (managerChanged) {
        if (context.memberIds.length) {
          await dispatchToMany(
            context.memberIds,
            NOTIFICATION_TYPES.PROJECT_MANAGER_CHANGED,
            'Project manager changed',
            `${actorName(req)} set a new manager for ${context.name}.`,
            `/projects/${req.params.id}`,
            'normal',
            { excludeUserId: req.user.id }
          )
        }
        await notifyByRoles(
          ['admin'],
          NOTIFICATION_TYPES.PROJECT_MANAGER_CHANGED,
          'Project manager changed',
          `${actorName(req)} changed the manager of ${context.name}.`,
          `/projects/${req.params.id}`,
          'normal',
          { excludeUserId: req.user.id }
        )
        if (previousManagerId && previousManagerId !== req.user.id && previousManagerId !== managerId) {
          await dispatchNotification(
            previousManagerId,
            NOTIFICATION_TYPES.PROJECT_MANAGER_CHANGED,
            'No longer managing this project',
            `${actorName(req)} reassigned management of ${context.name}.`,
            `/projects/${req.params.id}`,
            'normal'
          )
        }
        return
      }

      // Notify the team that the project changed
      if (!context.memberIds.length) return
      await dispatchToMany(
        context.memberIds,
        NOTIFICATION_TYPES.PROJECT_UPDATED,
        'Project updated',
        `${actorName(req)} updated ${context.name}.`,
        `/projects/${req.params.id}`,
        'low',
        { excludeUserId: req.user.id }
      )
    })
    const project = await getProjectWithDetails(req.params.id)
    return successResponse(res, project, 'Project updated successfully.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.archiveProject = async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE projects SET status='archived', updated_at=NOW() WHERE id=$1 RETURNING id",
      [req.params.id]
    )
    if (!result.rows[0]) return errorResponse(res, 'Project not found.', 404)
    // Notify the team and admins that the project was archived
    await notifySafely(async () => {
      const context = await getProjectNotificationContext(req.params.id)
      if (!context) return
      if (context.memberIds.length) {
        await dispatchToMany(
          context.memberIds,
          NOTIFICATION_TYPES.PROJECT_ARCHIVED,
          'Project archived',
          `${actorName(req)} archived ${context.name}.`,
          `/projects/${req.params.id}`,
          'normal',
          { excludeUserId: req.user.id }
        )
      }
      await notifyByRoles(
        ['admin'],
        NOTIFICATION_TYPES.PROJECT_ARCHIVED,
        'Project archived',
        `${actorName(req)} archived ${context.name}.`,
        `/projects/${req.params.id}`,
        'normal',
        { excludeUserId: req.user.id }
      )
    })
    return successResponse(res, null, 'Project archived.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.deleteProject = async (req, res) => {
  try {
    // Read the member list before the row is gone. Failure here must not block
    // the delete, so the context is resolved to null instead of throwing.
    const context = await getProjectNotificationContext(req.params.id).catch(() => null)
    const result = await pool.query('DELETE FROM projects WHERE id=$1 RETURNING id', [req.params.id])
    if (!result.rows[0]) return errorResponse(res, 'Project not found.', 404)
    // Notify the team and admins that the project is gone — link to the list, not the dead id
    await notifySafely(async () => {
      if (!context) return
      if (context.memberIds.length) {
        await dispatchToMany(
          context.memberIds,
          NOTIFICATION_TYPES.PROJECT_DELETED,
          'Project deleted',
          `${actorName(req)} deleted ${context.name}.`,
          '/projects',
          'normal',
          { excludeUserId: req.user.id }
        )
      }
      await notifyByRoles(
        ['admin'],
        NOTIFICATION_TYPES.PROJECT_DELETED,
        'Project deleted',
        `${actorName(req)} deleted ${context.name}.`,
        '/projects',
        'normal',
        { excludeUserId: req.user.id }
      )
    })
    return successResponse(res, null, 'Project deleted.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.addMember = async (req, res) => {
  try {
    const { userId } = req.body
    await pool.query('INSERT INTO project_members VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, userId])
    // Notify the person who was added, and the project manager
    await notifySafely(async () => {
      const context = await getProjectNotificationContext(req.params.id)
      if (!context) return
      if (userId && userId !== req.user.id) {
        await dispatchNotification(
          userId,
          NOTIFICATION_TYPES.PROJECT_ASSIGNED,
          'Added to a project',
          `${actorName(req)} added you to ${context.name}.`,
          `/projects/${req.params.id}`,
          'normal'
        )
      }
      if (context.managerId && context.managerId !== req.user.id && context.managerId !== userId) {
        await dispatchNotification(
          context.managerId,
          NOTIFICATION_TYPES.PROJECT_ASSIGNED,
          'New team member',
          `${actorName(req)} added a member to ${context.name}.`,
          `/projects/${req.params.id}`,
          'low'
        )
      }
    })
    return successResponse(res, null, 'Member added.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.removeMember = async (req, res) => {
  try {
    await pool.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [req.params.id, req.params.userId])
    // Notify the person who was removed, and the project manager
    await notifySafely(async () => {
      const context = await getProjectNotificationContext(req.params.id)
      if (!context) return
      if (req.params.userId && req.params.userId !== req.user.id) {
        await dispatchNotification(
          req.params.userId,
          NOTIFICATION_TYPES.PROJECT_MEMBER_REMOVED,
          'Removed from a project',
          `${actorName(req)} removed you from ${context.name}.`,
          '/projects',
          'low'
        )
      }
      if (context.managerId && context.managerId !== req.user.id && context.managerId !== req.params.userId) {
        await dispatchNotification(
          context.managerId,
          NOTIFICATION_TYPES.PROJECT_MEMBER_REMOVED,
          'Team member left',
          `${actorName(req)} removed a member from ${context.name}.`,
          `/projects/${req.params.id}`,
          'low'
        )
      }
    })
    return successResponse(res, null, 'Member removed.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}