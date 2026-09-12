// Project business logic: shaping, progress maths and notification context.

const repo = require('./repo')
const identity = require('../identity')

/**
 * One project with its manager, participants and progress.
 *
 * The `LEFT JOIN users` for the manager and the `SELECT ... FROM users` for the
 * member list are gone. work resolves participant IDS from its own tables (see
 * repo.findProjectParticipantIds for why that is a UNION, not just
 * project_members) and identity turns them into people.
 */
async function getProjectWithDetails(projectId) {
  const p = await repo.findProject(projectId)
  if (!p) return null

  const [participantIds, counts] = await Promise.all([
    repo.findProjectParticipantIds(projectId),
    repo.findProjectTaskCounts(projectId),
  ])

  const cards = await identity.getUserCards([...participantIds, p.manager_id])

  // Legacy shape and ordering: the five columns the old query selected, sorted
  // by name. Sorted here rather than in SQL because the names now arrive from
  // another module.
  const members = participantIds
    .map((id) => cards.get(id))
    .filter(Boolean)
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, avatar: u.avatar }))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))

  const manager = cards.get(p.manager_id)

  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    startDate: p.start_date,
    endDate: p.end_date,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    manager: p.manager_id
      ? { id: p.manager_id, name: manager?.name ?? null, email: manager?.email ?? null }
      : null,
    members,
    tasksCount: counts.total,
    completedTasksCount: counts.completed,
    progress: counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0,
  }
}
exports.getProjectWithDetails = getProjectWithDetails

exports.list = async ({ status, search, page = 1, limit = 10 }) => {
  const spec = { status, search }
  const total = await repo.countProjects(spec)
  const ids = await repo.listProjectIds(spec, {
    limit: parseInt(limit),
    offset: (parseInt(page) - 1) * parseInt(limit),
  })
  const projects = await Promise.all(ids.map((id) => getProjectWithDetails(id)))
  return { projects, total, page, limit }
}

/**
 * Project name plus its member ids, for notification copy.
 * Returns null when the project does not exist.
 */
exports.getNotificationContext = async (projectId) => {
  const [project, memberIds] = await Promise.all([
    repo.findProjectNameAndManager(projectId),
    repo.findProjectMemberIds(projectId),
  ])
  if (!project) return null
  return { name: project.name, managerId: project.manager_id, memberIds }
}
