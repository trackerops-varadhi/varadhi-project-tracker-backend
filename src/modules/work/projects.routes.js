const router = require('express').Router()
const ctrl = require('./projects.controller')
const tasksCtrl = require('./tasks.controller')
const { protect, restrictTo } = require('../../middleware/auth.middleware')

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

// GET /:id/bugs — the Bugs tab — is NOT declared here. It lives in
// defects/project-bugs.routes.js, mounted on /api/projects by the module that
// owns bugs. This file reaching for defects.projectBugsHandler was half of the
// work <-> defects cycle, and it also needed a lazy require because whichever
// of the two modules loaded first saw the other half-built. Express tries
// routers in mount order and defects mounts before work, so the URL is
// unchanged.

module.exports = router
