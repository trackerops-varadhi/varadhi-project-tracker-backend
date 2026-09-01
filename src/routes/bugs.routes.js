/**
 * Bugs Finder routes.
 *
 * Follows the convention every other route file here uses: `router.use(protect)`
 * once, then `restrictTo(...)` per endpoint where the role matters. Finer-
 * grained rules that depend on the bug ROW (its assignee, its reporter) cannot
 * be expressed by restrictTo and live in the controller instead — the same
 * split tasks.controller.js uses.
 */

const router = require('express').Router()
const ctrl = require('../controllers/bugs.controller')
const { protect, restrictTo } = require('../middleware/auth.middleware')
const upload = require('../middleware/upload')

router.use(protect)

// ─── Static paths first ───────────────────────────────────────────────────────
// Express matches in order, so these must precede '/:id' or they are swallowed
// as an id — the same note tasks.routes.js carries.
router.get('/options', ctrl.getOptions)
// Defect metrics feed the Reports page, which is admin/manager-only in the
// sidebar and on /api/reports. Same boundary here.
router.get('/reports', restrictTo('admin', 'manager'), ctrl.getReports)
router.get('/sla-rules', ctrl.getSlaRules)
// Editing an SLA target changes a team-wide commitment — admin only.
router.put('/sla-rules/:severity', restrictTo('admin'), ctrl.updateSlaRule)

// ─── Collection ───────────────────────────────────────────────────────────────
router.get('/', ctrl.getAllBugs)
// Admin/manager only, matching how every other creatable resource in this app
// works: projects.routes.js gates POST / with restrictTo('admin','manager')
// and tasks.controller.js#createTask refuses employees outright. Reporting a
// bug creates an assignable work item with an SLA attached, so it belongs on
// the same side of that line rather than being the one exception.
router.post('/', restrictTo('admin', 'manager'), ctrl.createBug)

// ─── Single bug ───────────────────────────────────────────────────────────────
router.get('/:id', ctrl.getBugById)
router.put('/:id', ctrl.updateBug)
router.delete('/:id', restrictTo('admin'), ctrl.deleteBug)

router.get('/:id/activity', ctrl.getActivity)

// Workflow. Row-level rules (assignee-only for employees, which statuses each
// role may set) are enforced in the controller.
router.patch('/:id/status', ctrl.updateStatus)
router.patch('/:id/assign', restrictTo('admin', 'manager'), ctrl.assignBug)

// Task integration (§16).
router.post('/:id/task', restrictTo('admin', 'manager'), ctrl.createTaskFromBug)

// Comments (§13).
router.get('/:id/comments', ctrl.getComments)
router.post('/:id/comments', ctrl.addComment)
router.put('/:id/comments/:commentId', ctrl.updateComment)
router.delete('/:id/comments/:commentId', ctrl.deleteComment)

// Attachments (§14) — same multer middleware and 10MB/type allow-list as the
// documents module, so there is one upload policy rather than two.
router.post('/:id/attachments', upload.single('file'), ctrl.uploadAttachment)
router.delete('/:id/attachments/:attachmentId', ctrl.deleteAttachment)

module.exports = router
