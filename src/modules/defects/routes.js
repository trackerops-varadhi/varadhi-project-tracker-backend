/**
 * Defects routes.
 *
 * `router.use(protect)` once, then `restrictTo(...)` per endpoint where the
 * role matters. Finer-grained rules that depend on the bug ROW (its assignee,
 * its reporter) cannot be expressed by restrictTo and live in the controller.
 */

const router = require('express').Router()
const ctrl = require('./controller')
const { protect, restrictTo } = require('../../middleware/auth.middleware')
const upload = require('../../middleware/upload')

router.use(protect)
// The Bugs Finder is QC's workspace (role workspaces). Admin and qc only —
// developers work their bugs through the linked task in their task list, so
// employees and managers have no reason to reach this API at all.
router.use(restrictTo('admin', 'qc'))

// ─── Static paths first ───────────────────────────────────────────────────────
// Express matches in order, so these must precede '/:id' or they are swallowed
// as an id.
router.get('/options', ctrl.getOptions)
// Defect metrics feed the Reports page, which is admin/manager-only in the
// sidebar. Same boundary here.
router.get('/reports', ctrl.getReports)
router.get('/sla-rules', ctrl.getSlaRules)
// Editing an SLA target changes a team-wide commitment — admin only.
router.put('/sla-rules/:severity', restrictTo('admin'), ctrl.updateSlaRule)

// ─── Collection ───────────────────────────────────────────────────────────────
router.get('/', ctrl.getAllBugs)
// Admin/manager only, matching how every other creatable resource works — an
// employee has no create-or-assign access anywhere in the tracker. Reporting a
// bug creates an assignable work item with an SLA attached, so it belongs on
// the same side of that line rather than being the one exception.
router.post('/', ctrl.createBug)

// ─── Single bug ───────────────────────────────────────────────────────────────
router.get('/:id', ctrl.getBugById)
router.put('/:id', ctrl.updateBug)
router.delete('/:id', restrictTo('admin'), ctrl.deleteBug)

router.get('/:id/activity', ctrl.getActivity)

// Workflow. Row-level rules (assignee-only for employees, which statuses each
// role may set) are enforced in the controller.
router.patch('/:id/status', ctrl.updateStatus)
router.patch('/:id/assign', ctrl.assignBug)

// Task integration.
router.post('/:id/task', ctrl.createTaskFromBug)

// Comments.
router.get('/:id/comments', ctrl.getComments)
router.post('/:id/comments', ctrl.addComment)
router.put('/:id/comments/:commentId', ctrl.updateComment)
router.delete('/:id/comments/:commentId', ctrl.deleteComment)

// Attachments — same multer middleware and 10MB/type allow-list as documents,
// so there is one upload policy rather than two.
router.post('/:id/attachments', upload.single('file'), ctrl.uploadAttachment)
router.delete('/:id/attachments/:attachmentId', ctrl.deleteAttachment)

module.exports = router
