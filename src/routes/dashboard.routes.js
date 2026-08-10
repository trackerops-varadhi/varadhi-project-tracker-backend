const router = require('express').Router()
const ctrl = require('../controllers/dashboard.controller')
const { protect } = require('../middleware/auth.middleware')

router.use(protect)

router.get('/stats', ctrl.getStats)
router.get('/activity', ctrl.getActivity)
router.get('/burndown/:projectId', ctrl.getBurndown)
router.get('/projects', ctrl.getProjectProgress)
router.get('/project-health', ctrl.getProjectHealth)
router.get('/gantt', ctrl.getGantt)

module.exports = router
