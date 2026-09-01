const router = require('express').Router()
const ctrl = require('../controllers/projects.controller')
const tasksCtrl = require('../controllers/tasks.controller')
const bugsCtrl = require('../controllers/bugs.controller')
const { protect, restrictTo } = require('../middleware/auth.middleware')
router.use(protect)
router.get('/', ctrl.getAllProjects)
router.post('/', restrictTo('admin','manager'), ctrl.createProject)
router.get('/:id', ctrl.getProjectById)
router.put('/:id', restrictTo('admin','manager'), ctrl.updateProject)
router.patch('/:id/archive', restrictTo('admin','manager'), ctrl.archiveProject)
router.delete('/:id', restrictTo('admin'), ctrl.deleteProject)
router.post('/:id/members', restrictTo('admin','manager'), ctrl.addMember)
router.delete('/:id/members/:userId', restrictTo('admin','manager'), ctrl.removeMember)
router.get('/:id/tasks', tasksCtrl.getTasksByProject)
// Module 8: the project detail page's Bugs tab. Paginated and role-scoped by
// the same service the /api/bugs list uses, so it cannot widen visibility.
router.get('/:id/bugs', bugsCtrl.getBugsByProject)
module.exports = router
