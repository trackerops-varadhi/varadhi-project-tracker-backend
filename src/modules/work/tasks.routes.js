const router = require('express').Router()
const ctrl = require('./tasks.controller')
const { protect } = require('../../middleware/auth.middleware')

router.use(protect)

router.get('/', ctrl.getAllTasks)
router.post('/', ctrl.createTask)

// Static paths must precede '/:id', otherwise Express matches them as an id.
router.get('/stats', ctrl.getTaskStats)
router.get('/priority-breakdown', ctrl.getPriorityBreakdown)
router.get('/upcoming', ctrl.getUpcomingTasks)

// No restrictTo on this router: every role may reach these endpoints, and the
// employee rules (own tasks only, status-only edits, no create/delete) are
// row-level and live in tasks.controller.js.
router.get('/:id', ctrl.getTaskById)
router.put('/:id', ctrl.updateTask)
router.patch('/:id/status', ctrl.updateTaskStatus)
router.delete('/:id', ctrl.deleteTask)
router.post('/:id/comments', ctrl.addComment)
router.delete('/:id/comments/:commentId', ctrl.deleteComment)

module.exports = router
