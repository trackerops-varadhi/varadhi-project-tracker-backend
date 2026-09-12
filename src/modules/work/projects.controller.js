// HTTP layer for projects.

const { successResponse, errorResponse, paginatedResponse } = require('../../shared/response')
const repo = require('./repo')
const service = require('./projects.service')
const notify = require('../notify')
const { notifySafely, actorName } = require('./notifications')

const { getProjectWithDetails, getNotificationContext } = service

exports.getAllProjects = async (req, res) => {
  try {
    const { projects, total, page, limit } = await service.list(req.query)
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

    const assignedManagerId = managerId || req.user.id

    const projectId = await repo.insertProject({
      name,
      description,
      managerId: assignedManagerId,
      startDate,
      endDate,
    })

    // The manager is a member of their own project.
    await repo.addMember(projectId, assignedManagerId)
    if (memberIds?.length) {
      for (const uid of memberIds) await repo.addMember(projectId, uid)
    }

    // Notify the manager, then the rest of the team.
    await notifySafely(async () => {
      if (assignedManagerId !== req.user.id) {
        await notify.dispatch({
          userId: assignedManagerId,
          type: notify.TYPES.PROJECT_ASSIGNED,
          title: 'You are managing a new project',
          message: `${actorName(req)} made you the manager of ${name}.`,
          linkTo: `/projects/${projectId}`,
        })
      }
      if (memberIds?.length) {
        await notify.dispatchToUsers({
          userIds: memberIds,
          type: notify.TYPES.PROJECT_ASSIGNED,
          title: 'Added to a project',
          message: `You were added to ${name}.`,
          linkTo: `/projects/${projectId}`,
          excludeUserId: req.user.id,
        })
      }
      // Admin visibility on every new project, regardless of who created it.
      await notify.dispatchToRoles({
        roles: ['admin'],
        type: notify.TYPES.PROJECT_ASSIGNED,
        title: 'New project created',
        message: `${actorName(req)} created ${name}.`,
        linkTo: `/projects/${projectId}`,
        excludeUserId: req.user.id,
      })
    })

    return successResponse(
      res, await getProjectWithDetails(projectId), 'Project created successfully.', 201
    )
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.updateProject = async (req, res) => {
  try {
    const { name, description, status, startDate, endDate, managerId } = req.body

    const previousManagerId = await repo.findProjectManagerId(req.params.id)

    const updated = await repo.updateProject(req.params.id, {
      name, description, status, startDate, endDate,
      managerId: managerId || null,
    })
    if (!updated) return errorResponse(res, 'Project not found.', 404)

    // Manager reassignment gets its own notification (team + admins); a plain
    // field edit falls back to the generic "project updated" ping.
    const managerChanged = Boolean(managerId) && managerId !== previousManagerId

    if (managerChanged) {
      // Manager is a member of their own project going forward.
      await repo.addMember(req.params.id, managerId)
    }

    await notifySafely(async () => {
      const context = await getNotificationContext(req.params.id)
      if (!context) return

      if (managerChanged) {
        if (context.memberIds.length) {
          await notify.dispatchToUsers({
            userIds: context.memberIds,
            type: notify.TYPES.PROJECT_MANAGER_CHANGED,
            title: 'Project manager changed',
            message: `${actorName(req)} set a new manager for ${context.name}.`,
            linkTo: `/projects/${req.params.id}`,
            excludeUserId: req.user.id,
          })
        }
        await notify.dispatchToRoles({
          roles: ['admin'],
          type: notify.TYPES.PROJECT_MANAGER_CHANGED,
          title: 'Project manager changed',
          message: `${actorName(req)} changed the manager of ${context.name}.`,
          linkTo: `/projects/${req.params.id}`,
          excludeUserId: req.user.id,
        })
        if (previousManagerId && previousManagerId !== req.user.id && previousManagerId !== managerId) {
          await notify.dispatch({
            userId: previousManagerId,
            type: notify.TYPES.PROJECT_MANAGER_CHANGED,
            title: 'No longer managing this project',
            message: `${actorName(req)} reassigned management of ${context.name}.`,
            linkTo: `/projects/${req.params.id}`,
          })
        }
        return
      }

      if (!context.memberIds.length) return
      await notify.dispatchToUsers({
        userIds: context.memberIds,
        type: notify.TYPES.PROJECT_UPDATED,
        title: 'Project updated',
        message: `${actorName(req)} updated ${context.name}.`,
        linkTo: `/projects/${req.params.id}`,
        priority: 'low',
        excludeUserId: req.user.id,
      })
    })

    return successResponse(
      res, await getProjectWithDetails(req.params.id), 'Project updated successfully.'
    )
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.archiveProject = async (req, res) => {
  try {
    const archived = await repo.archiveProject(req.params.id)
    if (!archived) return errorResponse(res, 'Project not found.', 404)

    await notifySafely(async () => {
      const context = await getNotificationContext(req.params.id)
      if (!context) return
      if (context.memberIds.length) {
        await notify.dispatchToUsers({
          userIds: context.memberIds,
          type: notify.TYPES.PROJECT_ARCHIVED,
          title: 'Project archived',
          message: `${actorName(req)} archived ${context.name}.`,
          linkTo: `/projects/${req.params.id}`,
          excludeUserId: req.user.id,
        })
      }
      await notify.dispatchToRoles({
        roles: ['admin'],
        type: notify.TYPES.PROJECT_ARCHIVED,
        title: 'Project archived',
        message: `${actorName(req)} archived ${context.name}.`,
        linkTo: `/projects/${req.params.id}`,
        excludeUserId: req.user.id,
      })
    })

    return successResponse(res, null, 'Project archived.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.deleteProject = async (req, res) => {
  try {
    // Read the member list before the row is gone. Failure here must not block
    // the delete, so the context resolves to null instead of throwing.
    const context = await getNotificationContext(req.params.id).catch(() => null)

    const deleted = await repo.deleteProject(req.params.id)
    if (!deleted) return errorResponse(res, 'Project not found.', 404)

    // Link to the list, not the dead id.
    await notifySafely(async () => {
      if (!context) return
      if (context.memberIds.length) {
        await notify.dispatchToUsers({
          userIds: context.memberIds,
          type: notify.TYPES.PROJECT_DELETED,
          title: 'Project deleted',
          message: `${actorName(req)} deleted ${context.name}.`,
          linkTo: '/projects',
          excludeUserId: req.user.id,
        })
      }
      await notify.dispatchToRoles({
        roles: ['admin'],
        type: notify.TYPES.PROJECT_DELETED,
        title: 'Project deleted',
        message: `${actorName(req)} deleted ${context.name}.`,
        linkTo: '/projects',
        excludeUserId: req.user.id,
      })
    })

    return successResponse(res, null, 'Project deleted.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.addMember = async (req, res) => {
  try {
    const { userId } = req.body
    await repo.addMember(req.params.id, userId)

    await notifySafely(async () => {
      const context = await getNotificationContext(req.params.id)
      if (!context) return
      if (userId && userId !== req.user.id) {
        await notify.dispatch({
          userId,
          type: notify.TYPES.PROJECT_ASSIGNED,
          title: 'Added to a project',
          message: `${actorName(req)} added you to ${context.name}.`,
          linkTo: `/projects/${req.params.id}`,
        })
      }
      if (context.managerId && context.managerId !== req.user.id && context.managerId !== userId) {
        await notify.dispatch({
          userId: context.managerId,
          type: notify.TYPES.PROJECT_ASSIGNED,
          title: 'New team member',
          message: `${actorName(req)} added a member to ${context.name}.`,
          linkTo: `/projects/${req.params.id}`,
          priority: 'low',
        })
      }
    })

    return successResponse(res, null, 'Member added.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}

exports.removeMember = async (req, res) => {
  try {
    await repo.removeMember(req.params.id, req.params.userId)

    await notifySafely(async () => {
      const context = await getNotificationContext(req.params.id)
      if (!context) return
      if (req.params.userId && req.params.userId !== req.user.id) {
        await notify.dispatch({
          userId: req.params.userId,
          type: notify.TYPES.PROJECT_MEMBER_REMOVED,
          title: 'Removed from a project',
          message: `${actorName(req)} removed you from ${context.name}.`,
          linkTo: '/projects',
          priority: 'low',
        })
      }
      if (
        context.managerId &&
        context.managerId !== req.user.id &&
        context.managerId !== req.params.userId
      ) {
        await notify.dispatch({
          userId: context.managerId,
          type: notify.TYPES.PROJECT_MEMBER_REMOVED,
          title: 'Team member left',
          message: `${actorName(req)} removed a member from ${context.name}.`,
          linkTo: `/projects/${req.params.id}`,
          priority: 'low',
        })
      }
    })

    return successResponse(res, null, 'Member removed.')
  } catch (err) { return errorResponse(res, err.message, 500) }
}
