/**
 * Microsoft Teams Adaptive Card builders (Module 5).
 * ---------------------------------------------------------------------------
 * Pure functions: notification data in, card JSON out. No database, no
 * network, no side effects — which is what lets every card shape be asserted
 * directly in tests without a Teams tenant.
 *
 * WIRE FORMAT. An Incoming Webhook does not accept a bare Adaptive Card; it
 * accepts a message whose `attachments[]` carry cards. We post the
 * `application/vnd.microsoft.card.adaptive` attachment envelope, which is what
 * both classic Connectors and the Workflows (Power Automate) replacement
 * accept. That matters because the PRD flags connector deprecation as its one
 * High risk for this module — keeping to the envelope both platforms
 * understand is what makes that migration a change of URL rather than a
 * rewrite of every card.
 *
 * SCHEMA VERSION 1.4, not the newest. Teams lags the Adaptive Cards spec, and
 * a card declaring a version the client does not implement renders as a blank
 * block rather than degrading. 1.4 is the highest version Teams renders
 * reliably across desktop, web and mobile.
 *
 * TWO ACTIONS MAXIMUM on actionable cards, mirroring the constraint already
 * documented in tasks.controller.js:229-239 for web push. Not a platform limit
 * here, but a deliberate consistency choice: the same event should not offer
 * three choices in Teams and two on a phone.
 */

const APP_URL =
  process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000'

const SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json'
const VERSION = '1.4'

/** Priority/severity → the colour token Teams actually understands. */
const COLOR_BY_PRIORITY = {
  urgent: 'attention',
  critical: 'attention',
  high: 'warning',
  normal: 'default',
  low: 'accent',
}

function absoluteLink(linkTo) {
  if (!linkTo) return APP_URL
  if (/^https?:\/\//i.test(linkTo)) return linkTo
  return `${APP_URL}${linkTo.startsWith('/') ? '' : '/'}${linkTo}`
}

/** Teams renders an empty FactSet as a stray gap; drop empty facts entirely. */
function factSet(facts) {
  const cleaned = (facts || []).filter((f) => f && f.value !== null && f.value !== undefined && f.value !== '')
  if (!cleaned.length) return null
  return {
    type: 'FactSet',
    facts: cleaned.map((f) => ({ title: f.title, value: String(f.value) })),
  }
}

/**
 * Wrap a card body in the attachment envelope a webhook expects.
 * Every builder below returns the result of this, so the delivery layer never
 * has to know card-specific details.
 */
function envelope(body, actions, meta = {}) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: SCHEMA,
          type: 'AdaptiveCard',
          version: VERSION,
          body: body.filter(Boolean),
          ...(actions && actions.length ? { actions } : {}),
          msteams: { width: 'Full' },
        },
      },
    ],
    // Not part of the Teams payload — stripped before posting. Carried so the
    // delivery log can record which card kind was sent without re-deriving it.
    __meta: meta,
  }
}

/** Standard header block: a bold title with an accent colour. */
function header(title, priority = 'normal', subtitle) {
  return [
    {
      type: 'TextBlock',
      text: title,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
      color: COLOR_BY_PRIORITY[priority] || 'default',
    },
    subtitle
      ? { type: 'TextBlock', text: subtitle, isSubtle: true, wrap: true, spacing: 'None' }
      : null,
  ]
}

/** "View Task"-style link button. Always present — a card with no way back
 *  into the tracker forces exactly the app-switching this module removes. */
function openAction(label, linkTo) {
  return { type: 'Action.OpenUrl', title: label, url: absoluteLink(linkTo) }
}

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

/** New Task Assigned — the reference design's primary card. */
function taskAssignedCard({ title, taskTitle, projectName, dueDate, priority, assigneeName, linkTo }) {
  return envelope(
    [
      ...header(title || 'New Task Assigned', priority),
      factSet([
        { title: 'Task', value: taskTitle },
        { title: 'Project', value: projectName },
        { title: 'Assigned to', value: assigneeName },
        { title: 'Due Date', value: dueDate },
        { title: 'Priority', value: priority },
      ]),
    ],
    [openAction('View Task', linkTo)],
    { cardKind: 'task_assigned' }
  )
}

/**
 * Approval Request — the only card that carries state-changing actions.
 *
 * `actionToken` is minted by the caller and embedded in the action URLs. It
 * IDENTIFIES; it does not AUTHORIZE — exactly the posture documented in
 * utils/notification-actions.js:9-15. Every permission decision is recomputed
 * from live database rows when the action endpoint is hit, so a card sitting
 * in a channel after the approver was demoted is inert.
 */
function approvalRequestCard({ title, taskTitle, projectName, requestedBy, dueDate, linkTo, actionUrl, actionToken }) {
  const actions = [openAction('View Details', linkTo)]

  if (actionUrl && actionToken) {
    // Action.OpenUrl rather than Action.Http: Incoming Webhooks are one-way,
    // so a card posted through one cannot POST back. Routing through an
    // authenticated confirmation page in the app is the honest option — it
    // also means the approval is re-authenticated as that user rather than
    // trusting whoever can see the channel.
    actions.push({
      type: 'Action.OpenUrl',
      title: 'Approve / Reject',
      url: `${actionUrl}?token=${encodeURIComponent(actionToken)}`,
    })
  }

  return envelope(
    [
      ...header(title || 'Approval Request', 'high'),
      factSet([
        { title: 'Item', value: taskTitle },
        { title: 'Project', value: projectName },
        { title: 'Requested by', value: requestedBy },
        { title: 'Due', value: dueDate },
      ]),
    ],
    actions.slice(0, 2),
    { cardKind: 'approval_request' }
  )
}

/** Deadline Alert — the "⚠ Deadline Approaching" card. */
function deadlineAlertCard({ taskTitle, projectName, dueDate, timeLeft, linkTo }) {
  return envelope(
    [
      ...header('⚠ Deadline Approaching', 'high'),
      factSet([
        { title: 'Task', value: taskTitle },
        { title: 'Project', value: projectName },
        { title: 'Due', value: dueDate },
        { title: 'Time Left', value: timeLeft },
      ]),
    ],
    [openAction('View Details', linkTo)],
    { cardKind: 'deadline_alert' }
  )
}

/** Task status change. */
function statusUpdateCard({ taskTitle, projectName, fromStatus, toStatus, actorName, linkTo }) {
  return envelope(
    [
      ...header('Task Status Updated', 'normal'),
      factSet([
        { title: 'Task', value: taskTitle },
        { title: 'Project', value: projectName },
        { title: 'Status', value: fromStatus && toStatus ? `${fromStatus} → ${toStatus}` : toStatus },
        { title: 'Updated by', value: actorName },
      ]),
    ],
    [openAction('View Task', linkTo)],
    { cardKind: 'status_update' }
  )
}

/** Daily / weekly digest — the "Daily Summary" card. */
function dailySummaryCard({ projectName, period = 'Daily', completed = 0, inProgress = 0, overdue = 0, dueToday = 0, linkTo }) {
  return envelope(
    [
      ...header(
        `${period} Summary`,
        overdue > 0 ? 'high' : 'normal',
        projectName || undefined
      ),
      {
        type: 'ColumnSet',
        columns: [
          summaryColumn('Completed', completed, 'good'),
          summaryColumn('In Progress', inProgress, 'accent'),
          summaryColumn('Due Today', dueToday, 'warning'),
          summaryColumn('Overdue', overdue, overdue > 0 ? 'attention' : 'default'),
        ],
      },
    ],
    [openAction('Open Dashboard', linkTo || '/dashboard')],
    { cardKind: 'daily_summary' }
  )
}

function summaryColumn(label, value, color) {
  return {
    type: 'Column',
    width: 'stretch',
    items: [
      { type: 'TextBlock', text: String(value), size: 'ExtraLarge', weight: 'Bolder', color, horizontalAlignment: 'Center' },
      { type: 'TextBlock', text: label, isSubtle: true, size: 'Small', horizontalAlignment: 'Center', spacing: 'None' },
    ],
  }
}

/** Project health roll-up — the bot-style "Project Health" card. */
function projectHealthCard({ projectName, health, schedule, progressPercent, completed, inProgress, blocked, linkTo }) {
  return envelope(
    [
      ...header(`Project Health — ${projectName || 'Project'}`, health === 'At Risk' ? 'high' : 'normal'),
      factSet([
        { title: 'Overall Health', value: health },
        { title: 'Schedule', value: schedule },
        { title: 'Progress', value: progressPercent != null ? `${progressPercent}%` : null },
        { title: 'Completed', value: completed },
        { title: 'In Progress', value: inProgress },
        { title: 'Blocked', value: blocked },
      ]),
    ],
    [openAction('View Full Report', linkTo || '/reports')],
    { cardKind: 'project_health' }
  )
}

/** Comment added. */
function commentCard({ taskTitle, projectName, authorName, excerpt, linkTo }) {
  return envelope(
    [
      ...header('New Comment', 'normal'),
      factSet([
        { title: 'Task', value: taskTitle },
        { title: 'Project', value: projectName },
        { title: 'By', value: authorName },
      ]),
      excerpt
        ? { type: 'TextBlock', text: truncate(excerpt, 300), wrap: true, spacing: 'Small' }
        : null,
    ],
    [openAction('View Task', linkTo)],
    { cardKind: 'comment_added' }
  )
}

/** Connectivity probe fired by the "Send test message" button. */
function testCard({ projectName, actorName }) {
  return envelope(
    [
      ...header('✅ Varadhi Project Tracker connected', 'normal'),
      {
        type: 'TextBlock',
        wrap: true,
        text:
          `This channel is now receiving project events` +
          `${projectName ? ` for **${projectName}**` : ''}.` +
          `${actorName ? ` Configured by ${actorName}.` : ''}`,
      },
    ],
    [openAction('Open Tracker', '/dashboard')],
    { cardKind: 'test' }
  )
}

/**
 * Fallback for any notification type without a bespoke card.
 *
 * Its existence is what makes the notificationEvents fan-out safe: a new
 * notification type added later still produces a correct, useful Teams post
 * instead of either crashing the subscriber or being silently dropped.
 */
function genericCard({ title, message, linkTo, priority = 'normal' }) {
  return envelope(
    [
      ...header(title || 'Update', priority),
      message ? { type: 'TextBlock', text: truncate(message, 500), wrap: true } : null,
    ],
    [openAction('Open in Tracker', linkTo)],
    { cardKind: 'generic' }
  )
}

function truncate(text, max) {
  const s = String(text || '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * Choose a card for a dispatched notification.
 *
 * Deliberately total: every input yields a card. `context` carries the extra
 * detail the notification row does not have (project name, due date), and is
 * optional throughout — a card with fewer facts is fine, a thrown error in a
 * notification listener is not.
 */
function cardForNotification(notification, context = {}) {
  const n = notification || {}
  const common = {
    title: n.title,
    taskTitle: context.taskTitle || n.title,
    projectName: context.projectName,
    dueDate: context.dueDate,
    priority: n.priority || 'normal',
    linkTo: n.link_to || n.linkTo,
  }

  switch (n.type) {
    case 'task_assigned':
    case 'task_reassigned':
      return taskAssignedCard({ ...common, assigneeName: context.assigneeName })
    case 'review_requested':
      return approvalRequestCard({
        ...common,
        requestedBy: context.actorName,
        actionUrl: context.actionUrl,
        actionToken: context.actionToken,
      })
    case 'task_reminder':
    case 'task_due_today':
    case 'task_overdue':
    case 'task_escalation':
      return deadlineAlertCard({ ...common, timeLeft: context.timeLeft })
    case 'task_status_changed':
      return statusUpdateCard({
        ...common,
        fromStatus: context.fromStatus,
        toStatus: context.toStatus,
        actorName: context.actorName,
      })
    case 'task_comment':
      return commentCard({ ...common, authorName: context.actorName, excerpt: n.message })
    case 'project_milestone':
      return projectHealthCard({ ...common, health: context.health, schedule: context.schedule })
    default:
      return genericCard({ title: n.title, message: n.message, linkTo: common.linkTo, priority: common.priority })
  }
}

module.exports = {
  taskAssignedCard,
  approvalRequestCard,
  deadlineAlertCard,
  statusUpdateCard,
  dailySummaryCard,
  projectHealthCard,
  commentCard,
  testCard,
  genericCard,
  cardForNotification,
  // exported for tests
  envelope,
  absoluteLink,
  SCHEMA,
  VERSION,
}
