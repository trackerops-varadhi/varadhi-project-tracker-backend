// Bug ↔ task synchronisation (role workspaces).
//
// QC owns the Bugs module. Developers never open it: the moment a bug has an
// assignee, it gets a linked task (type 'bug') in work, and the developer
// works it from their ordinary task list, where it is badged as a bug.
//
//   bug → task (here):           assignee and status follow the bug.
//   task → bug (work-subscriber): the developer starting or completing the task
//                                 moves the bug to in_progress / fixed.
//
// Writes here carry source 'defects' on work's TASK_CHANGED event, and the
// subscriber ignores those, so the two directions cannot ping-pong.

const work = require('../work')
const repo = require('./repo')
const { BUG_ACTIONS, logBugActivity } = require('./workflow')

// Bug priority (p0..p3) onto the tasks table's own scale.
const TASK_PRIORITY = { p0: 'critical', p1: 'high', p2: 'medium', p3: 'low' }

// What the developer's task should show for each bug status. Anything QC has
// finished with — fixed onward, or a side exit — is off the developer's plate.
const TASK_STATUS_FOR_BUG = {
  open: 'todo',
  assigned: 'todo',
  reopened: 'todo',
  in_progress: 'in_progress',
  fixed: 'completed',
  qa_verification: 'completed',
  closed: 'completed',
  duplicate: 'completed',
  rejected: 'completed',
  wont_fix: 'completed',
  deferred: 'completed',
}

const dueDateOf = (bug) => (bug.sla?.dueAt ? new Date(bug.sla.dueAt).toISOString().slice(0, 10) : null)

const descriptionOf = (bug) => [
  `Fix for ${bug.key} (${bug.severity} severity, ${bug.environment}).`,
  bug.description,
  bug.stepsToReproduce ? `Steps to reproduce:\n${bug.stepsToReproduce}` : null,
].filter(Boolean).join('\n\n')

/**
 * Make the bug's task match its assignee, creating the task on first
 * assignment. Returns the linked task id, or null when there is none (no
 * assignee yet, or no project — tasks need one).
 */
exports.ensureTask = async (bug, actorId) => {
  const linkedId = bug.linkedTask?.id ?? null
  if (linkedId) {
    await work.updateBugTask(linkedId, { assigneeId: bug.assignee?.id ?? null })
    return linkedId
  }
  if (!bug.assignee?.id || !bug.project?.id) return null

  const taskId = await work.createTaskForBug({
    title: `${bug.key}: ${bug.title}`,
    description: descriptionOf(bug),
    priority: TASK_PRIORITY[bug.priority] || 'medium',
    projectId: bug.project.id,
    assigneeId: bug.assignee.id,
    reporterId: actorId,
    dueDate: dueDateOf(bug),
  })
  await repo.linkTask(bug.id, taskId)
  const status = TASK_STATUS_FOR_BUG[bug.status]
  if (status && status !== 'todo') await work.updateBugTask(taskId, { status })
  await logBugActivity({
    bugId: bug.id, actorId, action: BUG_ACTIONS.TASK_CREATED, field: 'linkedTask', newValue: taskId,
  })
  return taskId
}

/** After QC moves the bug, move the developer's task to match. */
exports.pushStatus = async (bug) => {
  const taskId = bug.linkedTask?.id
  const status = TASK_STATUS_FOR_BUG[bug.status]
  if (!taskId || !status) return
  await work.updateBugTask(taskId, { status })
}

exports.TASK_STATUS_FOR_BUG = TASK_STATUS_FOR_BUG
