const router = require('express').Router()
const ctrl = require('./projects.controller')
const tasksCtrl = require('./tasks.controller')
const { protect, restrictTo } = require('../../middleware/auth.middleware')

// Resolved per-request, not at load time. `defects` and `work` form a require
// cycle — defects/index.js -> controller.js -> '../work' -> work/index.js ->
// this file -> '../defects' — so whichever module is required first sees the
// other half-built. Reading `.projectBugsHandler` at load time captures
// `undefined` by value and express throws "requires a callback function".
// server.js happens to require identity and defects before work, which is why
// the server boots; anything entering through work first (the bugs test suite)
// hits it. Deferring the lookup to request time removes the ordering dependency
// instead of relying on it.
const defects = () => require('../defects')

router.use(protect)

router.get('/', ctrl.getAllProjects)
router.post('/', restrictTo('admin', 'manager'), ctrl.createProject)
router.get('/:id', ctrl.getProjectById)
router.put('/:id', restrictTo('admin', 'manager'), ctrl.updateProject)
router.patch('/:id/archive', restrictTo('admin', 'manager'), ctrl.archiveProject)
router.delete('/:id', restrictTo('admin'), ctrl.deleteProject)
router.post('/:id/members', restrictTo('admin', 'manager'), ctrl.addMember)
router.delete('/:id/members/:userId', restrictTo('admin', 'manager'), ctrl.removeMember)

// The project detail page's Tasks tab. Now an in-module call rather than the
// route file importing a sibling controller.
router.get('/:id/tasks', tasksCtrl.getTasksByProject)

// The Bugs tab. Paginated and role-scoped by the same service /api/bugs uses,
// so it cannot widen visibility. Reached through the defects module's public
// interface — still a cross-domain edge, but no longer a deep import.
// Role workspaces: bugs are QC's, so only admin and qc reach this tab.
router.get('/:id/bugs', restrictTo('admin', 'qc'), (req, res, next) => defects().projectBugsHandler(req, res, next))

module.exports = router
